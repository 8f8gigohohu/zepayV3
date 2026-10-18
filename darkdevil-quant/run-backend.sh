#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$ROOT/data"
SECRET_FILE="$DATA_DIR/application.secret"
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

# Keep the Fernet/JWT key stable across process restarts without printing it or
# committing it. The nested .gitignore excludes the entire data directory.
if [[ ! -s "$SECRET_FILE" ]]; then
  umask 077
  TMP_SECRET="$DATA_DIR/.application.secret.$$"
  python3 -c 'import secrets; print(secrets.token_urlsafe(48))' > "$TMP_SECRET"
  chmod 600 "$TMP_SECRET"
  mv "$TMP_SECRET" "$SECRET_FILE"
fi
chmod 600 "$SECRET_FILE"
export DJQ_SECRET_KEY="$(<"$SECRET_FILE")"
export DJQ_ENVIRONMENT="${DJQ_ENVIRONMENT:-production}"
export DJQ_COOKIE_SECURE="${DJQ_COOKIE_SECURE:-true}"
export DJQ_DATABASE_URL="${DJQ_DATABASE_URL:-sqlite+aiosqlite:///$DATA_DIR/darkdevil.db}"

cd "$ROOT/backend"
exec .venv/bin/python -m uvicorn app.main:app \
  --host "${HOST:-0.0.0.0}" --port "${BACKEND_PORT:-8000}"
