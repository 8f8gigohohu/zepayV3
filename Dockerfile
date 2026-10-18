FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.11-slim AS terminal
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8000
WORKDIR /app

RUN groupadd --system --gid 10001 terminal \
    && useradd --system --uid 10001 --gid terminal --home-dir /app --shell /usr/sbin/nologin terminal \
    && mkdir -p /app/data /app/logs /app/models \
    && chown -R terminal:terminal /app

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY --chown=terminal:terminal zepay_trader/ ./zepay_trader/
COPY --chown=terminal:terminal config.yaml ./config.yaml
COPY --from=frontend-build --chown=terminal:terminal /app/web/ ./web/

USER terminal
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3).read()" || exit 1
CMD ["uvicorn", "zepay_trader.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
