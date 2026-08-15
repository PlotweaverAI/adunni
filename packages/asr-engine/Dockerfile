# ── ASR Engine Dockerfile ──
# Python service using faster-whisper (CTranslate2) with NCAIR1 + STORM models
# for African language ASR. 4x faster than HuggingFace transformers on CPU.
#
# Models are converted to CTranslate2 int8 format on first run and cached in /models.

FROM python:3.11-slim

# System dependencies for audio processing + ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first (better Docker layer caching)
# Use CPU-only PyTorch (needed for model conversion only, inference uses CTranslate2)
COPY packages/asr-engine/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir setuptools wheel && \
    pip install --no-cache-dir fastapi==0.115.6 "uvicorn[standard]==0.34.0" pydantic==2.10.4 && \
    pip install --no-cache-dir torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu && \
    pip install --no-cache-dir transformers==4.46.3 soundfile==0.12.1 numpy==1.26.4 sentencepiece==0.2.0 sacremoses==0.1.1 && \
    pip install --no-cache-dir librosa==0.10.2.post1 && \
    pip install --no-cache-dir faster-whisper==1.0.3 ctranslate2==4.5.0

# Copy the application
COPY packages/asr-engine/ ./

# Create model cache directory
ENV HF_HOME=/models
ENV TRANSFORMERS_CACHE=/models
ENV MODEL_CACHE_DIR=/models
ENV CUDA_VISIBLE_DEVICES=""
RUN mkdir -p /models

# Pre-download NLLB translation model (still uses transformers pipeline)
RUN python -c "from transformers import pipeline; pipeline('translation', model='facebook/nllb-200-distilled-600M')" 2>/dev/null || true

EXPOSE 3010

# Health check — longer start period because model conversion happens on first run
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:3010/health')" || exit 1

CMD ["uvicorn", "asr_engine:app", "--host", "0.0.0.0", "--port", "3010", "--timeout-keep-alive", "120"]
