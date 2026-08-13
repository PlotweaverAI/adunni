"""
asr_engine.py — Python ASR microservice for Àdùnní

Wraps NCAIR1 (Yoruba/Hausa/Igbo) and OpenAI Whisper (English/French/Swahili/Chinese)
HuggingFace models behind a REST API compatible with Adunni's asr-service.

Endpoints:
  GET  /health            — service health + provider info
  GET  /info              — provider info + supported languages
  POST /detect-language   — { text } -> { language, confidence }
  POST /transcribe        — { audio_path | audio_base64, language } -> { text, language, confidence }

Models are downloaded from HuggingFace on first use (cached locally).
Set HF_TOKEN env var if any models require gated access.
"""

import os
import re
import base64
import tempfile
import logging
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

# ── Logging ──
logging.basicConfig(level=logging.INFO, format="%(asctime)s [asr-engine] %(message)s")
log = logging.getLogger("asr-engine")

# ── Config ──
PORT = int(os.getenv("PORT", "3010"))
HF_TOKEN = os.getenv("HF_TOKEN", "")


def _torch_cuda_available() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except ImportError:
        return False


DEVICE = "cuda" if _torch_cuda_available() else "cpu"

# Model registry — mirrors the Plotweaver-AI-Models repo
# Language code mapping: Adunni LanguageCode -> human language name -> HF model
LANG_TO_MODEL = {
    "en-NG": "openai/whisper-medium",
    "yo":    "NCAIR1/Yoruba-ASR",
    "ha":    "NCAIR1/Hausa-ASR",
    "ig":    "NCAIR1/Igbo-ASR",
    # Pidgin (pcm) has no dedicated model — use whisper-medium as fallback
    "pcm":   "openai/whisper-medium",
}

# Reverse map: human language name -> Adunni LanguageCode
HUMAN_TO_CODE = {
    "English": "en-NG",
    "Yoruba":  "yo",
    "Hausa":   "ha",
    "Igbo":    "ig",
    "French":  "en-NG",  # no French LanguageCode in Adunni, fallback
    "Swahili": "en-NG",
    "Chinese": "en-NG",
}

SUPPORTED_LANGUAGES = list(LANG_TO_MODEL.keys())

# ── Lazy-loaded model cache ──
_loaded_models: dict[str, object] = {}
_transformers_pipeline = None
_stable_whisper = None


def _get_transformers_pipeline():
    global _transformers_pipeline
    if _transformers_pipeline is None:
        from transformers import pipeline as hf_pipeline
        _transformers_pipeline = hf_pipeline
    return _transformers_pipeline


def _load_model(model_id: str):
    """Load a HuggingFace ASR model (cached after first load)."""
    if model_id in _loaded_models:
        return _loaded_models[model_id]

    log.info(f"Loading ASR model: {model_id} (device={DEVICE})")

    if "openai/whisper" in model_id:
        # Use stable_whisper for Whisper models (better word timing)
        import stable_whisper
        model_size = model_id.split("/")[-1].replace("whisper-", "")  # e.g. "medium"
        model = stable_whisper.load_model(model_size, device=DEVICE)
    else:
        # Use HuggingFace transformers pipeline for NCAIR1 models
        hf_pipeline = _get_transformers_pipeline()
        import torch
        model = hf_pipeline(
            "automatic-speech-recognition",
            model=model_id,
            chunk_length_s=30,
            device=0 if DEVICE == "cuda" else -1,
            token=HF_TOKEN or None,
        )

    _loaded_models[model_id] = model
    log.info(f"Model loaded: {model_id}")
    return model


# ── Language detection from text ──
# Keyword-based detection (same approach as the mock, but as fallback)
# The real detection happens via ASR model output language metadata
LANGUAGE_KEYWORDS = {
    "en-NG": ["the", "is", "are", "was", "have", "please", "account", "balance",
              "transfer", "limit", "money", "bank", "error", "morning", "afternoon"],
    "pcm":   ["abeg", "na", "dey", "wan", "give", "my", "mama", "wahala", "make",
              "i", "naija", "wetin", "how", "far", "e", "don", "one-time", "show"],
    "yo":    ["ẹ", "káàbọ̀", "sọ̀rọ̀", "èdè", "owó", "àkántì", "kúrò", "ṣé", "rárã",
              "fọwọ́", "ránṣẹ́", "pátápátá", "léṣẹ̀kẹṣẹ̀", "yín"],
    "ig":    ["daalụ", "ị", "na-asụ", "igbo", "ego", "ahụ", "eruola", "ọma", "a",
              "na", "m", "asụ", "nke", "ukwuu"],
    "ha":    ["madalla", "za", "ka", "iya", "ci", "gaba", "da", "hausa",
              "mahaifiyata", "kawai", "take", "ji", "ī", "mana", "zan", "aika",
              "mata", "saƙon", "tabbatarwa", "karɓi", "daga", "komai", "shirye",
              "yake", "sai", "amince"],
}


def detect_language_from_text(text: str) -> dict:
    """Detect language from text using keyword matching."""
    lower = text.lower()
    scores = {lang: 0 for lang in LANGUAGE_KEYWORDS}

    for lang, keywords in LANGUAGE_KEYWORDS.items():
        for kw in keywords:
            if kw.lower() in lower:
                scores[lang] += 1

    best_lang = max(scores, key=scores.get)
    total = sum(scores.values())
    confidence = (scores[best_lang] / total) if total > 0 else 0.5
    confidence = max(0.5, min(0.99, confidence))

    return {"language": best_lang, "confidence": confidence}


# ── Transcribe audio file ──
def transcribe_audio(audio_path: str, language: Optional[str] = None) -> dict:
    """
    Transcribe an audio file using the appropriate model.

    Args:
        audio_path: Path to audio file (wav, mp3, etc.)
        language: Adunni LanguageCode (e.g. "yo", "en-NG"). If None, auto-detect.

    Returns:
        { text, language, confidence }
    """
    if language is None or language not in LANG_TO_MODEL:
        # Default to English/Whisper for auto-detect
        language = "en-NG"

    model_id = LANG_TO_MODEL[language]
    model = _load_model(model_id)

    if "openai/whisper" in model_id:
        # stable_whisper model
        result = model.transcribe(audio_path)
        text = result.text.strip()
    else:
        # HuggingFace pipeline
        prediction = model(audio_path, return_timestamps=False)
        text = prediction["text"].strip()

    # Detect language from the transcribed text
    detected = detect_language_from_text(text)

    return {
        "text": text,
        "language": detected["language"],
        "confidence": detected["confidence"],
    }


# ── FastAPI app ──
app = FastAPI(title="Àdùnní ASR Engine", version="1.0.0")


class DetectRequest(BaseModel):
    text: str


class TranscribeRequest(BaseModel):
    audio_path: Optional[str] = None
    audio_base64: Optional[str] = None
    language: Optional[str] = None
    encoding: Optional[str] = "wav"


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "provider": {
            "name": "ncair1-whisper",
            "supportedLanguages": SUPPORTED_LANGUAGES,
            "device": DEVICE,
            "modelsLoaded": list(_loaded_models.keys()),
        },
    }


@app.get("/info")
async def info():
    return {
        "provider": {
            "name": "ncair1-whisper",
            "supportedLanguages": SUPPORTED_LANGUAGES,
            "device": DEVICE,
        },
        "supportedLanguages": SUPPORTED_LANGUAGES,
        "models": LANG_TO_MODEL,
    }


@app.post("/detect-language")
async def detect_language(req: DetectRequest):
    if not req.text:
        raise HTTPException(status_code=400, detail="text is required")
    result = detect_language_from_text(req.text)
    return result


@app.post("/transcribe")
async def transcribe(req: TranscribeRequest):
    if not req.audio_path and not req.audio_base64:
        raise HTTPException(status_code=400, detail="audio_path or audio_base64 is required")

    audio_path = req.audio_path

    # Decode base64 audio to temp file if needed
    cleanup = None
    if req.audio_base64:
        audio_bytes = base64.b64decode(req.audio_base64)
        suffix = f".{req.encoding or 'wav'}"
        cleanup = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        cleanup.write(audio_bytes)
        cleanup.close()
        audio_path = cleanup.name

    try:
        result = transcribe_audio(audio_path, req.language)
        return result
    except Exception as e:
        log.error(f"Transcription failed: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
    finally:
        if cleanup and os.path.exists(cleanup.name):
            os.unlink(cleanup.name)


@app.on_event("startup")
async def startup():
    log.info(f"ASR Engine starting on port {PORT} (device={DEVICE})")
    log.info(f"Supported languages: {SUPPORTED_LANGUAGES}")
    log.info(f"Models: {LANG_TO_MODEL}")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
