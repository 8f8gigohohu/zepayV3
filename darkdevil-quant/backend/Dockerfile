# Build backend image (uvicorn init + run)
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
RUN pip install --no-cache-dir ".[postgres]"
COPY app ./app
EXPOSE 8000
HEALTHCHECK CMD python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/system/health')" || exit 1
CMD ["python3", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
