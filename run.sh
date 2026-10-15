#!/usr/bin/env sh
set -eu
exec python -m uvicorn zepay_trader.main:app --host "${HOST:-0.0.0.0}" --port "${PORT:-8000}"
