#!/usr/bin/env python3
"""DarkDevil Quant doctor: checks dependencies, config security, DB, and live
exchange connectivity. Exits non-zero if a required check fails."""
import asyncio
import os
import shutil
import subprocess
import sys

OK, WARN, FAIL = ("✓", "!", "✗")


def line(state, text):
    print(f"{state} {text}")
    return state


def main() -> int:
    failures = 0
    print("DarkDevil Quant — doctor\n" + "-" * 50)

    # required helpers
    for tool, ver_cmd in (("python3", ["--version"]), ("node", ["--version"]),
                          ("npm", ["--version"])):
        found = shutil.which(tool)
        if found:
            v = subprocess.run([found, *ver_cmd], capture_output=True, text=True).stdout.strip()
            line(OK, f"{tool}: {v}")
        else:
            line(FAIL, f"{tool}: not found")
            failures += 1

    # python deps importable (checked with *this* interpreter, so run the doctor
    # with the backend venv python - see the reminder printed on failure)
    import importlib.util
    required = ["fastapi", "uvicorn", "sqlalchemy", "httpx", "jwt", "bcrypt", "cryptography"]
    missing = [m for m in required if importlib.util.find_spec(m) is None]
    if missing:
        line(FAIL, f"python deps: missing {', '.join(missing)}")
        print("     (this interpreter is " + sys.executable + ")")
        print("     run the doctor with the backend venv: .venv/bin/python ../scripts/doctor.py")
    else:
        line(OK, "python deps: all importable")
    failures += bool(missing)

    os.environ.setdefault("DJQ_SECRET_KEY", "doctor-dev-run")
    os.environ.setdefault("DJQ_DATABASE_URL", "sqlite+aiosqlite:///./data/doctor-check.db")

    # The backend package lives in backend/. Import it from there so the doctor
    # works no matter which directory it is launched from, and report a clean
    # message (not a traceback) when the venv/deps are missing.
    backend_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")
    sys.path.insert(0, os.path.abspath(backend_dir))
    try:
        from app.config import get_settings  # noqa: F401
        from app.db import Base, build_engine
        from app.exchanges import registry
        from sqlalchemy import text
    except Exception as e:  # pragma: no cover - environment dependent
        line(FAIL, f"backend import failed: {e.__class__.__name__}: {e}")
        print("\n  Install the backend dependencies (and run this check with that interpreter):")
        print("    cd backend && python -m venv .venv && .venv/bin/pip install -e '.[dev]'")
        print("    .venv/bin/python ../scripts/doctor.py        # Windows: .venv\\Scripts\\python ..\\scripts\\doctor.py")
        print("-" * 50)
        print("FAILURES:", failures + 1)
        return 1

    from app.config import get_settings
    from app.db import Base, build_engine
    from app.exchanges import registry
    from sqlalchemy import text

    s = get_settings()
    # secret hygiene
    if s.is_production and (not s.secret_key or len(s.secret_key) < 32):
        line(FAIL, "DJQ_SECRET_KEY: unset/too short for production")
        failures += 1
    else:
        line(OK if s.secret_key or not s.is_production else WARN,
             f"DJQ_SECRET_KEY: {'set' if s.secret_key else 'unset (dev ok - falls back to insecure default)'}")
    line(WARN if s.live_trading_enabled else OK,
         f"live trading: {'ENABLED (double-check intended!)' if s.live_trading_enabled else 'disabled (safe default)'}")
    if s.live_trading_enabled:
        failures += 0  # advisory only
    line(OK if s.kill_switch_default_active else WARN, "kill switch default: "
         f"{'active' if s.kill_switch_default_active else 'released'}")

    # database
    async def db_check():
        engine = build_engine(s.database_url)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
                await conn.execute(text("SELECT 1"))
            return True
        finally:
            await engine.dispose()

    db_ok = asyncio.run(db_check())
    line(OK if db_ok else FAIL, f"database ({s.database_url.split('://')[0]})")
    failures += not db_ok

    # exchange connectivity (live, honest)
    for name in ("binance", "zebpay"):
        try:
            asyncio.run(registry.get_adapter(name).ping())
            line(OK, f"exchange {name}: reachable (live public API)")
        except Exception as e:
            line(WARN, f"exchange {name}: UNREACHABLE — {e.__class__.__name__}: {str(e)[:110]}")

    print("-" * 50)
    print("FAILURES:", failures)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
