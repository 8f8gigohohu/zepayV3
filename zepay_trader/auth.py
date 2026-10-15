from __future__ import annotations

import hmac
import secrets
import threading
import time
from collections import defaultdict, deque


class SessionManager:
    """In-memory operator sessions; secrets are never stored in browser storage."""

    def __init__(self, lifetime_seconds: int = 8 * 60 * 60, attempts_per_window: int = 5):
        self.lifetime_seconds = lifetime_seconds
        self.attempts_per_window = attempts_per_window
        self._sessions: dict[str, float] = {}
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
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._attempts[remote_key].clear()
            # Discard expired entries during login rather than allowing an unbounded session map.
            self._sessions = {key: expiry for key, expiry in self._sessions.items() if expiry > now}
            self._sessions[token] = now + self.lifetime_seconds
        return token

    def is_valid(self, token: str | None) -> bool:
        if not token:
            return False
        now = time.time()
        with self._lock:
            expiry = self._sessions.get(token)
            if expiry is None:
                return False
            if expiry <= now:
                del self._sessions[token]
                return False
            return True

    def revoke(self, token: str | None) -> None:
        if token:
            with self._lock:
                self._sessions.pop(token, None)
