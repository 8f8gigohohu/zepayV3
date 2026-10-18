import os
import sys
from pathlib import Path

# Make `app` importable. Each test gets an isolated SQLite database and engine.
BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))
os.environ["DJQ_SECRET_KEY"] = "test-secret-key-0123456789abcdef-safe"
os.environ["DJQ_ENVIRONMENT"] = "development"
os.environ["DJQ_COOKIE_SECURE"] = "false"
os.environ["DJQ_BINANCE_REST_PUBLIC_URL"] = "https://test.example/binance-public"
os.environ["DJQ_ZEBPAY_REST_URL"] = "https://test.example/zebpay"

import pytest
from httpx import ASGITransport, AsyncClient

import app.db as dbmod
from app.config import get_settings
from app.main import create_app


@pytest.fixture
async def client(tmp_path, monkeypatch):
    database_url = f"sqlite+aiosqlite:///{tmp_path / 'test.db'}"
    monkeypatch.setenv("DJQ_DATABASE_URL", database_url)
    get_settings.cache_clear()
    app = create_app()
    dbmod.init_engine()
    try:
        async with dbmod.engine.begin() as conn:
            await conn.run_sync(dbmod.Base.metadata.create_all)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
    finally:
        await dbmod.engine.dispose()
        dbmod.engine = None
        dbmod._session_factory = None
        get_settings.cache_clear()
