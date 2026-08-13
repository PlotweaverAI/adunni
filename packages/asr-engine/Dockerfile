# ── ASR Engine Dockerfile ──
# Python service wrapping NCAIR1 + Whisper models for African language ASR
#
# Uses a slim Python base with system deps for audio processing.
# Models are downloaded from HuggingFace on first use and cached in /models.

FROM python:3.11-slim

# System dependencies for audio processing + ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first (better Docker layer caching)
COPY packages/asr-engine/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir setuptools wheel && \
    pip install --no-cache-dir fastapi==0.115.6 "uvicorn[standard]==0.34.0" pydantic==2.10.4 && \
    pip install --no-cache-dir torch==2.5.1 torchaudio==2.5.1 && \
    pip install --no-cache-dir transformers==4.46.3 soundfile==0.12.1 numpy==1.26.4 && \
    pip install --no-cache-dir --no-build-isolation openai-whisper==20231117 && \
    pip install --no-cache-dir stable-ts==2.16.0

# Copy the application
COPY packages/asr-engine/ ./

# Create model cache directory
ENV HF_HOME=/models
ENV TRANSFORMERS_CACHE=/models
RUN mkdir -p /models

EXPOSE 3010

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:3010/health')" || exit 1

CMD ["uvicorn", "asr_engine:app", "--host", "0.0.0.0", "--port", "3010"]
