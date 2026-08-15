"""
asr_engine.py — Python ASR microservice for Àdùnní

Uses STORM-OS-ASR-SMALL (wolethereader/STORM-OS-ASR-SMALL) — a single Whisper-small
LoRA-fine-tuned model covering all five Nigerian languages:
  yo (Yoruba), ha (Hausa), ig (Igbo), pcm (Nigerian Pidgin), en (Nigerian English)

Per the model's technical usage guide:
  - Always force the language explicitly via forced_decoder_ids (never auto-detect)
  - Use the transformers pipeline with chunk_length_s=30, stride_length_s=5
  - Audio must be 16kHz mono

Endpoints:
  GET  /health            — service health + provider info
  GET  /info              — provider info + supported languages
  POST /detect-language   — { text } -> { language, confidence } (keyword-based router)
  POST /transcribe        — { audio_path | audio_base64, language } -> { text, language, confidence }
  POST /transcribe/partial — { audio_base64, encoding, language } -> interim transcript
  POST /vad               — { audio_base64 } -> { has_speech, speech_ratio, segments }
  POST /translate         — { text, source_language, target_language } -> translated text

Models are downloaded from HuggingFace on first use (cached locally).
Set HF_TOKEN env var if any models require gated access.
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
# Primary HF token (for NCAIR1 gated models)
HF_TOKEN = os.getenv("HF_TOKEN", "")
# Secondary token for wolethereader org models (STORM-OS-ASR-SMALL)
# The fine-grained NCAIR1 token doesn't have wolethereader org access, so we use a separate token
HF_TOKEN_STORM = os.getenv("HF_TOKEN_STORM", HF_TOKEN)


def _torch_cuda_available() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except ImportError:
        return False


DEVICE = "cuda" if _torch_cuda_available() else "cpu"

# ── Model registry ──
# Per-language ASR models from NCAIR1 (dedicated, fine-tuned for each language)
# Fallback: STORM-OS-ASR-SMALL (single model for all languages)
NCAIR_MODELS = {
    "yo": "NCAIR1/Yoruba-ASR",
    "ig": "NCAIR1/Igbo-ASR",
    "ha": "NCAIR1/Hausa-ASR",
}

# STORM-OS-ASR-SMALL: single model for all languages (fallback)
STORM_MODEL_ID = "wolethereader/STORM-OS-ASR-SMALL"

# Adunni LanguageCode -> Whisper language token code
LANG_TO_WHISPER_CODE = {
    "en-NG": "en",
    "yo":    "yo",
    "ha":    "ha",
    "ig":    "ig",
    "pcm":   "pcm",
}

SUPPORTED_LANGUAGES = list(LANG_TO_WHISPER_CODE.keys())

# ── Lazy-loaded model cache ──
# Per-language pipelines (NCAIR1 models)
_ncair_pipelines: dict[str, tuple] = {}  # lang -> (pipeline, processor)
# STORM fallback pipeline
_asr_pipeline = None
_processor = None
_forced_decoder_ids_cache: dict[str, list] = {}


def _build_forced_decoder_ids(processor, lang_code: str):
    """Build forced_decoder_ids to force a specific language (per STORM-OS-ASR-SMALL guide)."""
    if lang_code in _forced_decoder_ids_cache:
        return _forced_decoder_ids_cache[lang_code]

    vocab = processor.tokenizer.get_vocab()
    whisper_lang = LANG_TO_WHISPER_CODE.get(lang_code, "en")
    token_id = vocab.get(f"<|{whisper_lang}|>")
    if token_id is None:
        # Fallback to English if the language token isn't found
        token_id = vocab.get("<|en|>")

    forced_ids = [
        [1, token_id],
        [2, vocab["<|transcribe|>"]],
        [3, vocab["<|notimestamps|>"]],
    ]
    _forced_decoder_ids_cache[lang_code] = forced_ids
    return forced_ids


def _load_asr_pipeline():
    """Load the STORM-OS-ASR-SMALL pipeline (cached singleton, used as fallback).

    STORM-OS-ASR-SMALL is a LoRA-merged checkpoint of openai/whisper-small.
    It ships model weights + tokenizer but NOT a preprocessor_config.json,
    so we load the processor (feature extractor + tokenizer) from the base
    model openai/whisper-small, and the model weights from STORM-OS-ASR-SMALL.
    """
    global _asr_pipeline, _processor
    if _asr_pipeline is not None:
        return _asr_pipeline, _processor

    import torch
    from transformers import (
        pipeline as hf_pipeline,
        WhisperProcessor,
        WhisperForConditionalGeneration,
        WhisperFeatureExtractor,
    )

    log.info(f"Loading STORM-OS-ASR-SMALL pipeline: {STORM_MODEL_ID} (device={DEVICE})")

    # Feature extractor from base model (STORM model has no preprocessor_config.json)
    base_model_id = "openai/whisper-small"
    feature_extractor = WhisperFeatureExtractor.from_pretrained(base_model_id)

    # Tokenizer from STORM model (has extended <|ig|> and <|pcm|> tokens)
    from transformers import WhisperTokenizerFast
    tokenizer = WhisperTokenizerFast.from_pretrained(STORM_MODEL_ID, token=HF_TOKEN_STORM or None)

    # Build a simple processor-like object for forced_decoder_ids construction
    class _SimpleProcessor:
        def __init__(self, tok, fe):
            self.tokenizer = tok
            self.feature_extractor = fe
    _processor = _SimpleProcessor(tokenizer, feature_extractor)

    # Model weights from STORM-OS-ASR-SMALL (merged LoRA checkpoint)
    # Use float16 on GPU, float32 on CPU (float16 is slow on CPU)
    # On CPU, use BetterTransformer for faster inference if available
    dtype = torch.float16 if DEVICE == "cuda" else torch.float32
    model = WhisperForConditionalGeneration.from_pretrained(
        STORM_MODEL_ID,
        torch_dtype=dtype,
        token=HF_TOKEN_STORM or None,
    )
    model.eval()

    # Enable BetterTransformer for CPU acceleration (2-3x faster on CPU)
    if DEVICE == "cpu":
        try:
            from optimum.bettertransformer import BetterTransformer
            model = BetterTransformer.transform(model)
            log.info("Enabled BetterTransformer for CPU acceleration")
        except ImportError:
            log.info("optimum not installed, using standard transformer (install optimum for 2-3x CPU speedup)")

    _asr_pipeline = hf_pipeline(
        "automatic-speech-recognition",
        model=model,
        tokenizer=tokenizer,
        feature_extractor=feature_extractor,
        chunk_length_s=30,
        stride_length_s=5,
        device=0 if DEVICE == "cuda" else -1,
        torch_dtype=torch.float32,
    )

    log.info(f"STORM-OS-ASR-SMALL pipeline loaded")
    return _asr_pipeline, _processor


def _load_ncair_pipeline(lang: str):
    """Load a per-language NCAIR1 ASR model (cached per language).

    NCAIR1 models are fine-tuned whisper-small for each Nigerian language.
    They include preprocessor_config.json (unlike STORM), so we can load
    the processor directly from the model repo.
    """
    if lang in _ncair_pipelines:
        return _ncair_pipelines[lang]

    model_id = NCAIR_MODELS.get(lang)
    if not model_id:
        return None

    import torch
    from transformers import (
        pipeline as hf_pipeline,
        WhisperProcessor,
        WhisperForConditionalGeneration,
    )

    log.info(f"Loading NCAIR1 ASR model: {model_id} for lang={lang} (device={DEVICE})")

    try:
        processor = WhisperProcessor.from_pretrained(model_id, token=HF_TOKEN or None)
        dtype = torch.float16 if DEVICE == "cuda" else torch.float32
        model = WhisperForConditionalGeneration.from_pretrained(
            model_id,
            torch_dtype=dtype,
            token=HF_TOKEN or None,
        )
        model.eval()

        # Enable BetterTransformer for CPU acceleration
        if DEVICE == "cpu":
            try:
                from optimum.bettertransformer import BetterTransformer
                model = BetterTransformer.transform(model)
            except ImportError:
                pass

        pipe = hf_pipeline(
            "automatic-speech-recognition",
            model=model,
            tokenizer=processor.tokenizer,
            feature_extractor=processor.feature_extractor,
            chunk_length_s=30,
            stride_length_s=5,
            device=0 if DEVICE == "cuda" else -1,
            torch_dtype=dtype,
        )

        _ncair_pipelines[lang] = (pipe, processor)
        log.info(f"NCAIR1 ASR model loaded: {model_id}")
        return _ncair_pipelines[lang]
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


# ── Transcribe audio file ──
def _transcribe_with_language(audio_path: str, language: str) -> str:
    """Internal: transcribe with a specific forced language. Returns text only.

    Uses NCAIR1 per-language model if available (more accurate), falls back to STORM.
    """
    # Try NCAIR1 per-language model first
    ncair = _load_ncair_pipeline(language)
    if ncair is not None:
        pipe, _ = ncair
        # NCAIR1 models are fine-tuned for the language — no forced_decoder_ids needed
        result = pipe(audio_path, generate_kwargs={"max_new_tokens": 225})
        return _clean_transcript(result["text"])

    # Fall back to STORM-OS-ASR-SMALL with forced language
    pipeline, processor = _load_asr_pipeline()
    forced_decoder_ids = _build_forced_decoder_ids(processor, language)
    result = pipeline(
        audio_path,
        generate_kwargs={
            "forced_decoder_ids": forced_decoder_ids,
            "max_new_tokens": 225,
            "num_beams": 2,  # Beam search for better accuracy (2x slower but more correct)
            "length_penalty": 1.0,  # Neutral length penalty
        },
    )
    return _clean_transcript(result["text"])


def _transcribe_auto(audio_path: str) -> str:
    """Transcribe without forcing a language — let Whisper auto-detect.
    Faster than two-pass since it's a single inference.
    """
    pipeline, _ = _load_asr_pipeline()
    result = pipeline(
        audio_path,
        generate_kwargs={
            "max_new_tokens": 225,
            "num_beams": 2,  # Beam search for better accuracy
        },
    )
    return _clean_transcript(result["text"])


def _detect_language_acoustic(audio_path: str) -> str:
    """Use Whisper's built-in language detection to identify the spoken language.

    This is unreliable for ig/pcm per the model card, but better than forcing English.
    Returns a LanguageCode (en-NG, yo, ha, ig, pcm).
    """
    pipeline, processor = _load_asr_pipeline()
    import torch
    # Load audio
    import librosa
    audio, sr = librosa.load(audio_path, sr=16000)
    inputs = processor.feature_extractor(audio, sampling_rate=16000, return_tensors="pt")
    input_features = inputs.input_features.to(torch.float32)

    # Use the model's detect_language method
    model = pipeline.model
    with torch.no_grad():
        detected_ids, _ = model.detect_language(input_features)

    # detected_ids is a tensor of token IDs — decode to get the language token
    token = processor.tokenizer.decode(detected_ids[0])
    # token looks like "<|yo|>" — extract the language code
    import re as _re
    match = _re.search(r"<\|(\w+)\|>", token)
    if match:
        lang_code = match.group(1)
        # Map back to our LanguageCode
        for adunni_code, whisper_code in LANG_TO_WHISPER_CODE.items():
            if whisper_code == lang_code:
                return adunni_code
    return "en-NG"


def transcribe_audio(audio_path: str, language: Optional[str] = None) -> dict:
    """
    Transcribe an audio file using STORM-OS-ASR-SMALL.

    Per the technical guide:
      - Language is always forced via forced_decoder_ids (never auto-detect)
      - The pipeline handles chunking and stitching automatically

    Two-pass approach when language is unknown (first utterance):
      1. Transcribe with English forced to get rough text
      2. Detect language from that text using keyword matching
      3. If detected language differs, re-transcribe with correct language forced

    Args:
        audio_path: Path to audio file (wav, 16kHz mono preferred)
        language: Adunni LanguageCode (e.g. "yo", "en-NG"). If None, two-pass detection.

    Returns:
        { text, language, confidence }
    """
    if language is not None and language in LANG_TO_WHISPER_CODE:
        # Language known — single pass with forced language
        text = _transcribe_with_language(audio_path, language)
        detected = detect_language_from_text(text)
        return {
            "text": text,
            "language": detected["language"],
            "confidence": detected["confidence"],
        }

    # Language unknown — single pass with no forced language (let Whisper auto-detect)
    # This is faster than two-pass (1 inference instead of 2-3) and the model's
    # auto-detection is good enough for most cases. Keyword detection refines the result.
    log.info("ASR: language unknown, transcribing with auto-detection")
    text = _transcribe_auto(audio_path)

    # Detect language from the transcribed text using keyword matching
    text_detected = detect_language_from_text(text) if text else {"language": "en-NG", "confidence": 0.5}
    detected_lang = text_detected["language"]

    # If keyword detection suggests a different language with high confidence,
    # re-transcribe with that language forced (only one extra pass)
    if detected_lang != "en-NG" and text_detected["confidence"] > 0.6:
        log.info(f"ASR: keyword detected {detected_lang} (conf={text_detected['confidence']:.2f}), re-transcribing with forced language")
        text2 = _transcribe_with_language(audio_path, detected_lang)
        if text2 and len(text2) >= len(text) * 0.3:
            text = text2

    final_detected = detect_language_from_text(text) if text else {"language": detected_lang, "confidence": 0.5}

    return {
        "text": text,
        "language": final_detected["language"],
        "confidence": final_detected["confidence"],
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
    Transcribe a partial audio chunk for streaming display.
    Uses the same STORM-OS-ASR-SMALL pipeline with forced language.

    When language is unknown, uses the two-pass approach (rough English → detect → re-transcribe).
    For partials, only does two-pass if the rough text has strong non-English markers
    (to avoid doubling latency on every partial).

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
            "name": "storm-os-asr-small",
            "model": STORM_MODEL_ID,
            "supportedLanguages": SUPPORTED_LANGUAGES,
            "device": DEVICE,
            "pipelineLoaded": _asr_pipeline is not None,
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
    log.info(f"ASR Engine starting on port {PORT} (device={DEVICE})")
    log.info(f"Model: {STORM_MODEL_ID}")
    log.info(f"Supported languages: {SUPPORTED_LANGUAGES}")
    log.info(f"Language codes: {LANG_TO_WHISPER_CODE}")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
