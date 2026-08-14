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
# Using whisper-tiny for speed on CPU (39M params vs 769M for medium)
LANG_TO_MODEL = {
    "en-NG": "openai/whisper-tiny",
    "yo":    "NCAIR1/Yoruba-ASR",
    "ha":    "NCAIR1/Hausa-ASR",
    "ig":    "NCAIR1/Igbo-ASR",
    # Pidgin (pcm) has no dedicated model — use whisper-tiny as fallback
    "pcm":   "openai/whisper-tiny",
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
    "en-NG": ["the", "is", "are", "was", "were", "have", "has", "please", "account", "balance",
              "transfer", "limit", "money", "bank", "error", "morning", "afternoon",
              "hello", "want", "need", "check", "would", "could", "should", "thank",
              "welcome", "help", "card", "pin", "loan", "savings", "deposit",
              "withdraw", "statement"],
    "pcm":   ["abeg", "na", "dey", "wan", "wahala", "naija", "wetin", "far", "don",
              "one-time", "show", "sabi", "papa", "mama", "chop", "gos", "beta",
              "oga", "madam", "broda", "sista", "pikin", "no", "fit", "make",
              "wey", "say", "go", "come", "see", "know", "give", "tell", "ask",
              "work", "good", "bad", "big", "small"],
    "yo":    ["bawo", "e", "ka", "aro", "kabo", "soro", "ede", "owo", "akanti", "kuro",
              "se", "fowo", "ranse", "yin", "mo", "fe", "ni", "wa", "nkan", "nwon",
              "kilode", "da", "lo", "ti", "n", "a", "wa", "e", "o", "un", "an",
              "iru", "eyi", "naa", "mi", "re", "wa", "yin", "won", "nbe", "si",
              "lati", "si", "fun", "pelu", "nipin", "le", "lori", "abe", "leyin",
              "iwaju", "ehin", "okunrin", "obinrin", "omode", "agba", "ile", "oko",
              "ose", "ose", "aaro", "osan", "iro", "ale", "orun", "ojo", "osu",
              "odu", "odun"],
    "ig":    ["daalu", "ndewo", "biko", "nna", "nne", "unu", "anyi", "mu", "gi", "ya",
              "ha", "ndi", "ole", "kedu", "mma", "ojo", "ego", "ahu", "ulo",
              "akwukwo", "mmiri", "oru", "ubochi", "abali", "ututu", "ehihie",
              "ugbo", "udu", "ahu", "ime", "ime", "nke", "ukwuu", "obere",
              "nnukwu", "na", "na", "ga", "ga", "cho", "cho", "ma", "ma",
              "were", "were", "bịa", "bịa", "gaa", "gaa", "sị", "sị",
              "mara", "mara", "ma", "ma", "bịa", "nụ", "nụ", "ọma", "ọjọ",
              "ego", "ụlọ", "akwụkwọ", "mmiri", "ọrụ", "ụbọchị"],
    "ha":    ["ina", "sanin", "son", "adadin", "kudin", "cikin", "asusun", "na", "ba",
              "ko", "da", "ga", "na", "ka", "ki", "ke", "ku", "su", "mu", "ta",
              "ya", "yi", "ce", "ta", "sai", "amince", "gaba", "kawai", "take",
              "ji", "mana", "zan", "aika", "mata", "sako", "tabbatarwa", "karbi",
              "daga", "komai", "shirye", "yake", "madalla", "iya", "ci", "za",
              "hausa", "mahaifiyata", "gida", "kudi", "asusu", "bashin", "rancen",
              "adaka", "makubban", "satar", "banci", "ceto", "kwaso", "riba",
              "kudi", "kudi"],
}


def detect_language_from_text(text: str) -> dict:
    """Detect language from text using keyword matching with word boundaries."""
    lower = text.lower()
    words = set(re.split(r'[\s,.;:!?\'"\-()]+', lower))
    words = {w for w in words if w}

    # Pidgin catchphrase override: if any Pidgin marker is present, it's Pidgin
    PCM_MARKERS = ["abeg", "dey", "wan", "wahala", "naija", "wetin", "sabi",
                   "howfar", "watin", "oga", "madam", "broda", "sista", "pikin",
                   "wey", "gos", "beta", "chop"]
    for marker in PCM_MARKERS:
        if marker in lower:
            return {"language": "pcm", "confidence": 0.95}

    scores = {lang: 0 for lang in LANGUAGE_KEYWORDS}

    for lang, keywords in LANGUAGE_KEYWORDS.items():
        for kw in keywords:
            kw_lower = kw.lower()
            if len(kw_lower) <= 3:
                if kw_lower in words:
                    scores[lang] += 1
            else:
                if kw_lower in lower:
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


# ── Translation (Meta NLLB — No Language Left Behind) ──
# Single model handles all 200 languages bidirectionally
# https://huggingface.co/facebook/nllb-200-distilled-600M

NLLB_MODEL = "facebook/nllb-200-distilled-600M"

# Adunni LanguageCode -> NLLB FLORES-200 code
NLLB_LANG_MAP = {
    "en-NG": "eng_Latn",
    "yo":    "yor_Latn",
    "ha":    "hau_Latn",
    "ig":    "ibo_Latn",
    "pcm":   "pcm_Latn",  # Nigerian Pidgin
}

_nllb_translator = None


def _load_nllb():
    """Load the NLLB translation pipeline (cached singleton)."""
    global _nllb_translator
    if _nllb_translator is None:
        from transformers import pipeline as hf_pipeline
        log.info(f"Loading NLLB translation model: {NLLB_MODEL} (device={DEVICE})")
        _nllb_translator = hf_pipeline(
            "translation",
            model=NLLB_MODEL,
            device=0 if DEVICE == "cuda" else -1,
            max_length=512,
        )
    return _nllb_translator


def translate_text(text: str, source_lang: str, target_lang: str) -> dict:
    """
    Translate text from source_lang to target_lang using NLLB.

    Returns:
        { translated_text, source_language, target_language, model }
    """
    # No translation needed if same language
    if source_lang == target_lang:
        return {
            "translated_text": text,
            "source_language": source_lang,
            "target_language": target_lang,
            "model": "none",
        }

    # Map Adunni codes to NLLB FLORES-200 codes
    src_flores = NLLB_LANG_MAP.get(source_lang, "eng_Latn")
    tgt_flores = NLLB_LANG_MAP.get(target_lang, "eng_Latn")

    translator = _load_nllb()
    result = translator(
        text,
        src_lang=src_flores,
        tgt_lang=tgt_flores,
    )
    translated = result[0]["translation_text"].strip() if result else text

    return {
        "translated_text": translated,
        "source_language": source_lang,
        "target_language": target_lang,
        "model": NLLB_MODEL,
    }


class TranslateRequest(BaseModel):
    text: str
    source_language: str
    target_language: str


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


@app.post("/translate")
async def translate(req: TranslateRequest):
    if not req.text:
        raise HTTPException(status_code=400, detail="text is required")
    if not req.source_language or not req.target_language:
        raise HTTPException(status_code=400, detail="source_language and target_language are required")
    result = translate_text(req.text, req.source_language, req.target_language)
    return result


@app.post("/transcribe")
async def transcribe(req: TranscribeRequest):
    if not req.audio_path and not req.audio_base64:
        raise HTTPException(status_code=400, detail="audio_path or audio_base64 is required")

    audio_path = req.audio_path
    cleanup_files = []

    # Decode base64 audio to temp file if needed
    if req.audio_base64:
        audio_bytes = base64.b64decode(req.audio_base64)
        encoding = req.encoding or "wav"
        suffix = f".{encoding}"
        raw_file = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        raw_file.write(audio_bytes)
        raw_file.close()
        cleanup_files.append(raw_file.name)
        audio_path = raw_file.name

        # Convert to WAV if not already (whisper/transformers need wav)
        if encoding != "wav":
            wav_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
            wav_file.close()
            cleanup_files.append(wav_file.name)
            import subprocess
            result = subprocess.run(
                ["ffmpeg", "-y", "-i", audio_path, "-ar", "16000", "-ac", "1", wav_file.name],
                capture_output=True, timeout=30
            )
            if result.returncode != 0:
                raise HTTPException(
                    status_code=400,
                    detail=f"FFmpeg conversion failed: {result.stderr.decode()[:200]}"
                )
            audio_path = wav_file.name

    try:
        result = transcribe_audio(audio_path, req.language)
        return result
    except Exception as e:
        log.error(f"Transcription failed: {e}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {str(e)}")
    finally:
        for f in cleanup_files:
            if os.path.exists(f):
                os.unlink(f)


@app.on_event("startup")
async def startup():
    log.info(f"ASR Engine starting on port {PORT} (device={DEVICE})")
    log.info(f"Supported languages: {SUPPORTED_LANGUAGES}")
    log.info(f"Models: {LANG_TO_MODEL}")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
