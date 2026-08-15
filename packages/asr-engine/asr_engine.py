"""
asr_engine.py — Python ASR microservice for Àdùnní

Uses faster-whisper (CTranslate2 backend) with STORM-OS-ASR-SMALL:
  - STORM-OS-ASR-SMALL is a LoRA-fine-tuned whisper-small for Nigerian languages
  - faster-whisper provides 4x faster CPU inference via int8 quantization
  - Model is converted to CTranslate2 format on first run (cached in /models)

Endpoints:
  GET  /health            — service health + provider info
  GET  /info              — provider info + supported languages
  POST /detect-language   — { text } -> { language, confidence } (keyword-based router)
  POST /transcribe        — { audio_path | audio_base64, language } -> { text, language, confidence }
  POST /transcribe/partial — { audio_base64, encoding, language } -> interim transcript
  POST /vad               — { audio_base64 } -> { has_speech, speech_ratio, segments }
  POST /translate         — { text, source_language, target_language } -> translated text

Set HF_TOKEN_STORM for wolethereader org models (STORM-OS-ASR-SMALL).
"""

import os
import re
import base64
import tempfile
import logging
import numpy as np
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
HF_TOKEN_STORM = os.getenv("HF_TOKEN_STORM", HF_TOKEN)
# Directory for cached CTranslate2 models
MODEL_CACHE_DIR = os.getenv("MODEL_CACHE_DIR", "/models")


def _torch_cuda_available() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except ImportError:
        return False


DEVICE = "cuda" if _torch_cuda_available() else "cpu"
# int8 for CPU (4x faster), float16 for GPU
COMPUTE_TYPE = "float16" if DEVICE == "cuda" else "int8"


# ── Model registry ──
# Per-language ASR models from NCAIR1 (dedicated, fine-tuned for each language)
# These are MORE accurate than STORM for pure Yoruba/Igbo/Hausa.
NCAIR_MODELS = {
    "yo": "NCAIR1/Yoruba-ASR",
    "ig": "NCAIR1/Igbo-ASR",
    "ha": "NCAIR1/Hausa-ASR",
}

# STORM-OS-ASR-SMALL: single model for all languages (fallback + en-NG/pcm)
STORM_MODEL_ID = "wolethereader/STORM-OS-ASR-SMALL"

# CTranslate2 converted model cache paths
STORM_CT2_PATH = os.path.join(MODEL_CACHE_DIR, "storm-ct2")
NCAIR_CT2_PATHS = {
    "yo": os.path.join(MODEL_CACHE_DIR, "ncair-yo-ct2"),
    "ig": os.path.join(MODEL_CACHE_DIR, "ncair-ig-ct2"),
    "ha": os.path.join(MODEL_CACHE_DIR, "ncair-ha-ct2"),
}

# Adunni LanguageCode -> Whisper language code
LANG_TO_WHISPER_CODE = {
    "en-NG": "en",
    "yo":    "yo",
    "ha":    "ha",
    "ig":    "ig",
    "pcm":   "pcm",
}

SUPPORTED_LANGUAGES = list(LANG_TO_WHISPER_CODE.keys())

# ── Lazy-loaded faster-whisper models ──
_asr_model = None       # STORM model (faster_whisper.WhisperModel)
_ncair_models = {}      # lang -> faster_whisper.WhisperModel


def _convert_model_to_ct2(model_id: str, ct2_path: str, token: str = None):
    """Convert a HuggingFace Whisper model to CTranslate2 format.
    
    This runs once on first use. The converted model is cached and reused.
    """
    if os.path.exists(os.path.join(ct2_path, "model.bin")):
        log.info(f"CT2 model already exists at {ct2_path}, skipping conversion")
        return

    log.info(f"Converting {model_id} to CTranslate2 format ({COMPUTE_TYPE})...")
    import ctranslate2
    
    os.makedirs(ct2_path, exist_ok=True)
    
    converter = ctranslate2.converters.TransformersConverter(
        model_id,
        token=token,
    )
    converter.convert(
        ct2_path,
        quantization=COMPUTE_TYPE,
        force=True,
    )
    log.info(f"Model converted and saved to {ct2_path}")


def _load_asr_model():
    """Load the STORM faster-whisper model (cached singleton)."""
    global _asr_model
    if _asr_model is not None:
        return _asr_model

    from faster_whisper import WhisperModel

    _convert_model_to_ct2(STORM_MODEL_ID, STORM_CT2_PATH, HF_TOKEN_STORM or None)

    log.info(f"Loading faster-whisper STORM model from {STORM_CT2_PATH} (device={DEVICE}, compute_type={COMPUTE_TYPE})")
    _asr_model = WhisperModel(
        STORM_CT2_PATH,
        device=DEVICE,
        compute_type=COMPUTE_TYPE,
        num_workers=2,
    )
    log.info("faster-whisper STORM model loaded")
    return _asr_model


def _load_ncair_model(lang: str):
    """Load a per-language NCAIR1 model as faster-whisper (cached per language).
    
    NCAIR1 models are MORE accurate than STORM for pure Yoruba/Igbo/Hausa
    because they're fine-tuned on dedicated per-language datasets.
    """
    if lang in _ncair_models:
        return _ncair_models[lang]

    model_id = NCAIR_MODELS.get(lang)
    if not model_id:
        return None

    ct2_path = NCAIR_CT2_PATHS.get(lang)
    if not ct2_path:
        return None

    try:
        from faster_whisper import WhisperModel

        _convert_model_to_ct2(model_id, ct2_path, HF_TOKEN or None)

        log.info(f"Loading faster-whisper NCAIR1 model for {lang} from {ct2_path}")
        model = WhisperModel(
            ct2_path,
            device=DEVICE,
            compute_type=COMPUTE_TYPE,
            num_workers=2,
        )
        _ncair_models[lang] = model
        log.info(f"NCAIR1 faster-whisper model loaded for {lang}")
        return model
    except Exception as e:
        log.warning(f"Failed to load NCAIR1 model {model_id}: {e}, will use STORM fallback")
        return None


# ── Language detection from text (keyword-based router) ──
# Used to determine which language to force on the model.
# Per the technical guide: never rely on Whisper's auto-detection.
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
    "yo":    ["bawo", "kabo", "soro", "ede", "owo", "akanti", "kuro",
              "fowo", "ranse", "mo", "fe", "nkan", "nwon",
              "kilode", "iru", "eyi", "naa", "nbe",
              "lati", "pelu", "nipin", "lori", "leyin",
              "iwaju", "ehin", "okunrin", "obinrin", "omode", "agba",
              "aaro", "osan", "odu", "odun"],
    "ig":    ["daalu", "ndewo", "biko", "nna", "nne", "unu", "anyi",
              "ndi", "kedu", "mma", "ojo", "ego", "ahu", "ulo",
              "akwukwo", "mmiri", "oru", "ubochi", "abali", "ututu", "ehihie",
              "ugbo", "udu", "nke", "ukwuu", "obere", "nnukwu",
              "bia", "gaa", "mara", "nma", "njo",
              "ulo", "akwukwo", "oru", "ubochi"],
    "ha":    ["ina", "sanin", "adadin", "kudin", "cikin", "asusun",
              "amince", "gaba", "kawai", "take",
              "mana", "zan", "aika", "mata", "sako", "tabbatarwa", "karbi",
              "daga", "komai", "shirye", "yake", "madalla",
              "hausa", "mahaifiyata", "gida", "kudi", "asusu", "bashin", "rancen",
              "adaka", "makubban", "satar", "banci", "ceto", "kwaso", "riba"],
}


def detect_language_from_text(text: str) -> dict:
    """Detect language from text using keyword matching with word boundaries.

    This is the language router — it determines which language to force
    on the STORM-OS-ASR-SMALL model. Per the technical guide, Whisper's
    auto-detection is unreliable for these languages.
    """
    lower = text.lower()
    words = set(re.split(r'[\s,.;:!?\'"\-()]+', lower))
    words = {w for w in words if w}

    # Pidgin catchphrase override: if any Pidgin marker is present as a whole word, it's Pidgin
    PCM_MARKERS = ["abeg", "dey", "wan", "wahala", "naija", "wetin", "sabi",
                   "howfar", "watin", "oga", "madam", "broda", "sista", "pikin",
                   "wey", "gos", "beta", "chop"]
    for marker in PCM_MARKERS:
        if marker in words:
            return {"language": "pcm", "confidence": 0.95}

    scores = {lang: 0 for lang in LANGUAGE_KEYWORDS}

    for lang, keywords in LANGUAGE_KEYWORDS.items():
        for kw in keywords:
            kw_lower = kw.lower()
            if len(kw_lower) <= 3:
                # Short keywords: match as whole words only
                if kw_lower in words:
                    scores[lang] += 1
            else:
                # Long keywords: match as whole words to avoid false substring matches
                if kw_lower in words:
                    scores[lang] += 1

    best_lang = max(scores, key=scores.get)
    total = sum(scores.values())
    confidence = (scores[best_lang] / total) if total > 0 else 0.5
    confidence = max(0.5, min(0.99, confidence))

    return {"language": best_lang, "confidence": confidence}


# ── Strip Whisper special tokens from output ──
_SPECIAL_TOKEN_RE = re.compile(r"<\|[^|]+\|>")


def _clean_transcript(text: str) -> str:
    """Remove Whisper special tokens like <|startoftranscript|> from output."""
    text = _SPECIAL_TOKEN_RE.sub("", text)
    return text.strip()


def _transcribe_with_language(audio_path: str, language: str) -> str:
    """Transcribe with a specific forced language using faster-whisper.
    
    Uses NCAIR1 per-language model for yo/ig/ha (more accurate),
    falls back to STORM for en-NG/pcm or if NCAIR1 fails.
    """
    whisper_lang = LANG_TO_WHISPER_CODE.get(language, "en")
    
    # Try NCAIR1 per-language model first for pure Nigerian languages
    if language in ("yo", "ig", "ha"):
        ncair_model = _load_ncair_model(language)
        if ncair_model is not None:
            try:
                segments, _info = ncair_model.transcribe(
                    audio_path,
                    language=whisper_lang,
                    beam_size=2,
                    max_new_tokens=225,
                    vad_filter=True,
                    vad_parameters=dict(min_silence_duration_ms=500),
                )
                text = " ".join([seg.text for seg in segments])
                text = _clean_transcript(text)
                if text:
                    return text
            except Exception as e:
                log.warning(f"NCAIR1 failed for {language}: {e}, falling back to STORM")
    
    # Fall back to STORM model
    model = _load_asr_model()
    segments, _info = model.transcribe(
        audio_path,
        language=whisper_lang,
        beam_size=2,
        max_new_tokens=225,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
    )
    text = " ".join([seg.text for seg in segments])
    return _clean_transcript(text)


def _transcribe_auto(audio_path: str) -> str:
    """Transcribe without forcing a language — let Whisper auto-detect."""
    model = _load_asr_model()
    segments, _info = model.transcribe(
        audio_path,
        beam_size=2,
        max_new_tokens=225,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
    )
    text = " ".join([seg.text for seg in segments])
    return _clean_transcript(text)


def _detect_language_acoustic(audio_path: str) -> str:
    """Use faster-whisper's built-in language detection to identify the spoken language.
    
    Returns a LanguageCode (en-NG, yo, ha, ig, pcm).
    """
    model = _load_asr_model()
    import librosa
    audio, sr = librosa.load(audio_path, sr=16000)
    
    # faster-whisper's detect_language takes a numpy array
    segments, info = model.transcribe(
        audio_path,
        beam_size=1,
        language_detection=True,
    )
    detected_lang = info.language
    
    # Map back to our LanguageCode
    for adunni_code, whisper_code in LANG_TO_WHISPER_CODE.items():
        if whisper_code == detected_lang:
            return adunni_code
    return "en-NG"


def transcribe_audio(audio_path: str, language: Optional[str] = None) -> dict:
    """
    Transcribe audio using faster-whisper with STORM-OS-ASR-SMALL.

    Flow:
      - If language is known: transcribe with forced language
      - If language is unknown: auto-detect, then keyword-based re-transcribe if needed

    Args:
        audio_path: Path to audio file (wav, 16kHz mono preferred)
        language: Adunni LanguageCode (e.g. "yo", "en-NG"). If None, auto-detect.

    Returns:
        { text, language, confidence, provider }
    """
    if language is not None and language in LANG_TO_WHISPER_CODE:
        # Language known — transcribe with forced language
        # _transcribe_with_language tries NCAIR1 first for yo/ig/ha, then STORM
        text = _transcribe_with_language(audio_path, language)
        detected = detect_language_from_text(text) if text else {"language": language, "confidence": 0.5}
        # Determine provider: NCAIR1 if it was used for yo/ig/ha, else STORM
        provider = "ncair1-ct2" if language in ("yo", "ig", "ha") and language in _ncair_models else "storm-ct2"
        return {
            "text": text,
            "language": detected["language"],
            "confidence": detected["confidence"],
            "provider": provider,
        }

    # Language unknown — auto-detect
    log.info("ASR: language unknown, transcribing with auto-detection")
    text = _transcribe_auto(audio_path)

    text_detected = detect_language_from_text(text) if text else {"language": "en-NG", "confidence": 0.5}
    detected_lang = text_detected["language"]

    # If keyword detection suggests a Nigerian language with high confidence,
    # re-transcribe with that language forced (NCAIR1 for yo/ig/ha, STORM for others)
    if detected_lang != "en-NG" and text_detected["confidence"] > 0.6:
        log.info(f"ASR: keyword detected {detected_lang} (conf={text_detected['confidence']:.2f}), re-transcribing")
        text2 = _transcribe_with_language(audio_path, detected_lang)
        if text2 and len(text2) >= len(text) * 0.3:
            text = text2

    final_detected = detect_language_from_text(text) if text else {"language": detected_lang, "confidence": 0.5}
    provider = "ncair1-ct2" if detected_lang in ("yo", "ig", "ha") and detected_lang in _ncair_models else "storm-ct2"

    return {
        "text": text,
        "language": final_detected["language"],
        "confidence": final_detected["confidence"],
        "provider": provider,
    }


# ── Energy-based VAD (Voice Activity Detection) ──
# Simple but effective: computes RMS energy and detects speech vs silence
# No additional model download needed — uses numpy only

VAD_FRAME_MS = 30  # 30ms frames
VAD_ENERGY_THRESHOLD = 0.01  # RMS threshold for speech detection
VAD_SILENCE_FRAMES = 50  # ~1.5s of silence to mark end of speech


def detect_speech_segments(audio_bytes: bytes, sample_rate: int = 16000) -> dict:
    """
    Energy-based VAD: detect if audio contains speech and where speech segments are.

    Returns:
        { has_speech, speech_ratio, segments: [{start_ms, end_ms}] }
    """
    try:
        if len(audio_bytes) < 4:
            return {"has_speech": False, "speech_ratio": 0.0, "segments": []}

        audio_array = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0

        if len(audio_array) == 0:
            return {"has_speech": False, "speech_ratio": 0.0, "segments": []}

        frame_size = int(sample_rate * VAD_FRAME_MS / 1000)
        num_frames = len(audio_array) // frame_size

        if num_frames == 0:
            rms = float(np.sqrt(np.mean(audio_array ** 2)))
            return {
                "has_speech": rms > VAD_ENERGY_THRESHOLD,
                "speech_ratio": 1.0 if rms > VAD_ENERGY_THRESHOLD else 0.0,
                "segments": [{"start_ms": 0, "end_ms": int(len(audio_array) / sample_rate * 1000)}] if rms > VAD_ENERGY_THRESHOLD else [],
            }

        energies = []
        for i in range(num_frames):
            frame = audio_array[i * frame_size : (i + 1) * frame_size]
            rms = float(np.sqrt(np.mean(frame ** 2)))
            energies.append(rms)

        segments = []
        in_speech = False
        seg_start = 0
        silence_count = 0

        for i, energy in enumerate(energies):
            if energy > VAD_ENERGY_THRESHOLD:
                if not in_speech:
                    in_speech = True
                    seg_start = i
                silence_count = 0
            else:
                if in_speech:
                    silence_count += 1
                    if silence_count >= VAD_SILENCE_FRAMES:
                        seg_end = i - silence_count
                        segments.append({
                            "start_ms": seg_start * VAD_FRAME_MS,
                            "end_ms": seg_end * VAD_FRAME_MS,
                        })
                        in_speech = False
                        silence_count = 0

        if in_speech:
            segments.append({
                "start_ms": seg_start * VAD_FRAME_MS,
                "end_ms": num_frames * VAD_FRAME_MS,
            })

        speech_frames = sum(1 for e in energies if e > VAD_ENERGY_THRESHOLD)
        speech_ratio = speech_frames / num_frames if num_frames > 0 else 0.0

        return {
            "has_speech": speech_ratio > 0.05,
            "speech_ratio": speech_ratio,
            "segments": segments,
        }
    except Exception as e:
        log.error(f"VAD error: {e}")
        return {"has_speech": True, "speech_ratio": 1.0, "segments": []}


# ── Partial transcription for streaming ──
def transcribe_partial(audio_bytes: bytes, encoding: str = "webm", language: Optional[str] = None) -> dict:
    """
    Partial transcription for streaming display using STORM/NCAIR1 models.

    Returns:
        { text, language, confidence, is_partial: True }
    """
    if len(audio_bytes) < 200:
        return {"text": "", "language": "en-NG", "confidence": 0.5, "is_partial": True}

    suffix = f".{encoding}" if encoding else ".webm"
    raw_file = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    raw_file.write(audio_bytes)
    raw_file.close()

    wav_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    wav_file.close()

    cleanup = [raw_file.name, wav_file.name]

    try:
        import subprocess
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", raw_file.name, "-ar", "16000", "-ac", "1", wav_file.name],
            capture_output=True, timeout=10
        )
        if result.returncode != 0:
            return {"text": "", "language": "en-NG", "confidence": 0.5, "is_partial": True}

        # Determine which language to force
        use_lang = language if (language and language in LANG_TO_WHISPER_CODE) else "en-NG"
        do_two_pass = language is None or language not in LANG_TO_WHISPER_CODE

        text = _transcribe_with_language(wav_file.name, use_lang)

        if do_two_pass and text:
            detected = detect_language_from_text(text)
            # Only re-transcribe if strong non-English signal (confidence > 0.7)
            if detected["language"] != "en-NG" and detected["confidence"] > 0.7:
                log.info(f"Partial two-pass: detected {detected['language']}, re-transcribing")
                text = _transcribe_with_language(wav_file.name, detected["language"])
                detected = detect_language_from_text(text) if text else detected
                return {
                    "text": text,
                    "language": detected["language"],
                    "confidence": detected["confidence"],
                    "is_partial": True,
                }

        if text:
            detected = detect_language_from_text(text)
            return {
                "text": text,
                "language": detected["language"],
                "confidence": detected["confidence"],
                "is_partial": True,
            }
        return {"text": "", "language": "en-NG", "confidence": 0.5, "is_partial": True}
    except Exception as e:
        log.error(f"Partial transcription failed: {e}")
        return {"text": "", "language": "en-NG", "confidence": 0.5, "is_partial": True}
    finally:
        for f in cleanup:
            if os.path.exists(f):
                os.unlink(f)


# ── FastAPI app ──
app = FastAPI(title="Àdùnní ASR Engine", version="2.0.0")


class DetectRequest(BaseModel):
    text: str


class TranscribeRequest(BaseModel):
    audio_path: Optional[str] = None
    audio_base64: Optional[str] = None
    language: Optional[str] = None
    encoding: Optional[str] = "wav"


class VadRequest(BaseModel):
    audio_base64: str
    encoding: Optional[str] = "pcm16"
    sample_rate: Optional[int] = 16000


class PartialTranscribeRequest(BaseModel):
    audio_base64: str
    encoding: Optional[str] = "webm"
    language: Optional[str] = None


# ── Translation (Meta NLLB — No Language Left Behind) ──
NLLB_MODEL = "facebook/nllb-200-distilled-600M"

NLLB_LANG_MAP = {
    "en-NG": "eng_Latn",
    "yo":    "yor_Latn",
    "ha":    "hau_Latn",
    "ig":    "ibo_Latn",
    "pcm":   "pcm_Latn",
}

_nllb_translator = None


def _load_nllb():
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
    if source_lang == target_lang:
        return {
            "translated_text": text,
            "source_language": source_lang,
            "target_language": target_lang,
            "model": "none",
        }

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
            "name": "ncair1-storm",
            "model": STORM_MODEL_ID,
            "supportedLanguages": SUPPORTED_LANGUAGES,
            "device": DEVICE,
            "pipelineLoaded": _asr_model is not None,
            "ncairModelsLoaded": list(_ncair_models.keys()),
            "computeType": COMPUTE_TYPE,
        },
    }


@app.get("/info")
async def info():
    return {
        "provider": {
            "name": "storm-os-asr-small",
            "model": STORM_MODEL_ID,
            "supportedLanguages": SUPPORTED_LANGUAGES,
            "device": DEVICE,
        },
        "supportedLanguages": SUPPORTED_LANGUAGES,
        "languageCodes": LANG_TO_WHISPER_CODE,
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

    if req.audio_base64:
        audio_bytes = base64.b64decode(req.audio_base64)
        encoding = req.encoding or "wav"
        suffix = f".{encoding}"
        raw_file = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        raw_file.write(audio_bytes)
        raw_file.close()
        cleanup_files.append(raw_file.name)
        audio_path = raw_file.name

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


@app.post("/vad")
async def vad_endpoint(req: VadRequest):
    """Voice Activity Detection — check if audio chunk contains speech."""
    if not req.audio_base64:
        raise HTTPException(status_code=400, detail="audio_base64 is required")
    audio_bytes = base64.b64decode(req.audio_base64)
    result = detect_speech_segments(audio_bytes, req.sample_rate or 16000)
    return result


@app.post("/transcribe/partial")
async def transcribe_partial_endpoint(req: PartialTranscribeRequest):
    """Partial (streaming) transcription — returns interim results for display."""
    if not req.audio_base64:
        raise HTTPException(status_code=400, detail="audio_base64 is required")
    audio_bytes = base64.b64decode(req.audio_base64)
    result = transcribe_partial(audio_bytes, req.encoding or "webm", req.language)
    return result


@app.on_event("startup")
async def startup():
    log.info(f"ASR Engine starting on port {PORT} (device={DEVICE}, compute_type={COMPUTE_TYPE})")
    log.info(f"Primary ASR: NCAIR1 (yo/ig/ha) + {STORM_MODEL_ID} (en-NG/pcm) — via faster-whisper (CTranslate2)")
    log.info(f"Supported languages: {SUPPORTED_LANGUAGES}")
    log.info(f"Language codes: {LANG_TO_WHISPER_CODE}")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
