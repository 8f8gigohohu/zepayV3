from __future__ import annotations

import hmac
import json
import os
import secrets
import tempfile
import threading
from pathlib import Path
from typing import Any


_PRIVATE_FIELDS = frozenset({"api_key", "api_secret", "app_password", "jwt_secret", "secure_cookie"})


def private_settings_path(database_path: Path | str) -> Path:
    configured = os.getenv("PRIVATE_SETTINGS_PATH", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return Path(database_path).expanduser().resolve().parent / "private_settings.json"


def _secure_directory(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(directory, 0o700)
    except OSError:
        # Permission semantics differ on Windows; the file itself is still opened
        # with the most restrictive mode supported by the platform.
        pass


class PrivateSettingsStore:
    """Atomic, owner-only persistence for dashboard-managed exchange secrets."""

    def __init__(self, path: Path | str):
        self.path = Path(path).expanduser().resolve()
        self._lock = threading.RLock()

    def load(self) -> dict[str, Any]:
        with self._lock:
            if not self.path.exists():
                return {}
            if self.path.is_symlink():
                raise RuntimeError("Private settings path must not be a symbolic link")
            try:
                with self.path.open("r", encoding="utf-8") as handle:
                    values = json.load(handle)
            except (OSError, json.JSONDecodeError) as exc:
                raise RuntimeError("Private settings file could not be read") from exc
            if not isinstance(values, dict):
                raise RuntimeError("Private settings file has an invalid format")
            result: dict[str, Any] = {}
            for key in _PRIVATE_FIELDS:
                if key not in values:
                    continue
                value = values[key]
                if key == "secure_cookie":
                    if not isinstance(value, bool):
                        raise RuntimeError("Private settings file has an invalid format")
                elif not isinstance(value, str):
                    raise RuntimeError("Private settings file has an invalid format")
                result[key] = value
            try:
                os.chmod(self.path, 0o600)
            except OSError:
                pass
            return result

    def save(self, *, api_key: str, api_secret: str, app_password: str, jwt_secret: str, secure_cookie: bool) -> None:
        values = {
            "api_key": api_key,
            "api_secret": api_secret,
            "app_password": app_password,
            "jwt_secret": jwt_secret,
            "secure_cookie": bool(secure_cookie),
        }
        with self._lock:
            _secure_directory(self.path.parent)
            fd, temporary = tempfile.mkstemp(prefix=f".{self.path.name}.", dir=self.path.parent)
            try:
                try:
                    os.fchmod(fd, 0o600)
                except OSError:
                    pass
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(values, handle, ensure_ascii=False, separators=(",", ":"))
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.path)
                try:
                    os.chmod(self.path, 0o600)
                    directory_fd = os.open(self.path.parent, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                except OSError:
                    pass
            except Exception:
                try:
                    os.close(fd)
                except OSError:
                    pass
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
                raise

    def save_settings(self, settings: Any) -> None:
        self.save(
            api_key=settings.api_key,
            api_secret=settings.api_secret,
            app_password=settings.app_password,
            jwt_secret=settings.jwt_secret,
            secure_cookie=settings.secure_cookie,
        )


class BootstrapTokenStore:
    """One-time local bootstrap token; only its path, never its value, is exposed."""

    def __init__(self, path: Path | str):
        self.path = Path(path).expanduser().resolve()
        self._lock = threading.RLock()

    def ensure(self) -> None:
        with self._lock:
            if self.path.exists():
                if self.path.is_symlink():
                    raise RuntimeError("Bootstrap token path must not be a symbolic link")
                try:
                    os.chmod(self.path, 0o600)
                except OSError:
                    pass
                return
            _secure_directory(self.path.parent)
            token = secrets.token_urlsafe(32)
            try:
                fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                return
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(token)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())

    def verify(self, candidate: str) -> bool:
        if not candidate:
            return False
        with self._lock:
            if not self.path.is_file() or self.path.is_symlink():
                return False
            try:
                expected = self.path.read_text(encoding="utf-8").strip()
            except OSError:
                return False
            return bool(expected) and hmac.compare_digest(candidate, expected)

    def consume(self) -> None:
        with self._lock:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass

    def reset(self) -> None:
        """Replace a lost, unused setup token; intended for a local CLI command."""
        with self._lock:
            self.consume()
            self.ensure()
