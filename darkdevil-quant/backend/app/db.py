from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import get_settings


class Base(DeclarativeBase):
    pass


def _ensure_sqlite_dir(database_url: str) -> None:
    if database_url.startswith("sqlite"):
        path = database_url.split("///", 1)[-1]
        if path and path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)


def build_engine(database_url: str | None = None):
    url = database_url or get_settings().database_url
    _ensure_sqlite_dir(url)
    return create_async_engine(url)


engine = None  # initialized lazily in main lifespan
_session_factory: async_sessionmaker[AsyncSession] | None = None


def init_engine() -> None:
    global engine, _session_factory
    engine = build_engine()
    _session_factory = async_sessionmaker(engine, expire_on_commit=False)


def session_factory() -> async_sessionmaker[AsyncSession]:
    assert _session_factory is not None, "engine not initialized"
    return _session_factory


async def get_db() -> AsyncSession:
    """FastAPI dependency yielding an async DB session."""
    factory = session_factory()
    async with factory() as session:
        yield session
