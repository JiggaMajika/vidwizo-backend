FROM python:3.11-slim

RUN apt-get update && apt-get install -y ffmpeg fonts-dejavu fonts-liberation && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN pip install --upgrade pip
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the faster-whisper "base" model
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')"

# Create data directory for SQLite
RUN mkdir -p /data

COPY main.py .
# Static frontend files will be copied during build
COPY static/ /app/static/

ENV PORT=8000
EXPOSE 8000

CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
