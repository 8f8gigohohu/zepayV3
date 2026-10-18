"""Append-only audit helper. Never logs secrets."""
from sqlalchemy.ext.asyncio import AsyncSession

from .models import AuditLog


async def audit(db: AsyncSession, event: str, actor_id: int | None = None,
                detail: dict | list | None = None) -> None:
    db.add(AuditLog(actor_id=actor_id, event=event, detail=redact(detail or {})))
    await db.commit()


REDACT_KEYS = {"password", "api_key", "api_secret", "secret", "token", "encrypted_secret",
               "authorization", "key", "signature", "seed", "private_key"}


def redact(obj):
    if isinstance(obj, dict):
        return {k: ("[REDACTED]" if k.lower() in REDACT_KEYS else redact(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact(v) for v in obj]
    return obj
