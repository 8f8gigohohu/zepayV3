from __future__ import annotations

import hmac
import secrets
import threading
import time
from collections import defaultdict, deque
from typing import Any

import jwt


class SessionManager:
    """Rate-limited single-admin JWT sessions delivered only in HttpOnly cookies."""

    def __init__(
        self,
        secret: str | None = None,
        lifetime_seconds: int = 8 * 60 * 60,
        attempts_per_window: int = 5,
    ):
        self.secret = secret or secrets.token_urlsafe(48)
        self.lifetime_seconds = lifetime_seconds
        self.attempts_per_window = attempts_per_window
        self._revoked: dict[str, float] = {}
        self._attempts: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def login(self, remote_key: str, password: str, expected_password: str) -> str | None:
        now = time.time()
        with self._lock:
            attempts = self._attempts[remote_key]
            while attempts and attempts[0] <= now - 300:
                attempts.popleft()
            if len(attempts) >= self.attempts_per_window:
                return None

        if not expected_password or not hmac.compare_digest(password, expected_password):
            with self._lock:
                self._attempts[remote_key].append(now)
            return None
        token = jwt.encode(
            {"sub": "operator", "iat": int(now), "exp": int(now + self.lifetime_seconds), "jti": secrets.token_urlsafe(24)},
            self.secret,
            algorithm="HS256",
        )
        with self._lock:
            self._attempts[remote_key].clear()
            self._revoked = {jti: expiry for jti, expiry in self._revoked.items() if expiry > now}
        return token

    def is_valid(self, token: str | None) -> bool:
        if not token:
            return False
        try:
            claims: dict[str, Any] = jwt.decode(token, self.secret, algorithms=["HS256"])
        except jwt.InvalidTokenError:
            return False
        jti = str(claims.get("jti", ""))
        if claims.get("sub") != "operator" or not jti:
            return False
        with self._lock:
            return jti not in self._revoked

    def revoke(self, token: str | None) -> None:
        if not token:
            return
        try:
            claims = jwt.decode(token, self.secret, algorithms=["HS256"], options={"verify_exp": False})
        except jwt.InvalidTokenError:
            return
        jti = str(claims.get("jti", ""))
        expiry = float(claims.get("exp", 0))
        if jti:
            with self._lock:
                self._revoked[jti] = expiry
