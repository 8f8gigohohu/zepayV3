import base64
import hashlib

import bcrypt
from cryptography.fernet import Fernet

from .config import get_settings

# --- Password hashing ------------------------------------------------------


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), hashed.encode())
    except ValueError:
        return False


# --- Token payloads / JWT --------------------------------------------------

import jwt  # noqa: E402  (kept below helpers for readability)


def create_access_token(user_id: int, role: str) -> str:
    from datetime import datetime, timedelta, timezone

    s = get_settings()
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "role": role,
        "iat": now,
        "exp": now + timedelta(minutes=s.access_token_exp_minutes),
    }
    return jwt.encode(payload, _secret(), algorithm="HS256")


def decode_access_token(token: str) -> dict:
    return jwt.decode(token, _secret(), algorithms=["HS256"])


# --- Symmetric encryption for exchange credentials -------------------------


def _secret() -> bytes:
    from .config import secret_bytes

    return secret_bytes(get_settings())


def _fernet() -> Fernet:
    """AES-128-CBC Fernet envelope, key derived from DJQ_SECRET_KEY.

    NOTE (documented): in production use a managed secrets service (vault/KMS)
    rather than app-config-level encryption. See docs/SECURITY.md.
    """
    key = hashlib.sha256(b"djq-fernet-v1:" + _secret()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_secret(plain: str) -> str:
    return _fernet().encrypt(plain.encode()).decode()


def decrypt_secret(token: str) -> str:
    return _fernet().decrypt(token.encode()).decode()


def mask_key(key: str, visible: int = 4) -> str:
    if len(key) <= visible:
        return "*" * len(key)
    return f"{key[:visible]}...{key[-4:]}"
