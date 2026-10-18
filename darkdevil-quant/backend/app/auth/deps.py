"""Authentication dependencies for browser-facing routes.

The UI receives an HttpOnly session cookie, never a bearer token in JavaScript.
A cookie-only browser session also keeps credentials out of localStorage.
"""
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..models import User
from ..security import decode_access_token

ROLE_ORDER = {"viewer": 0, "trader": 1, "admin": 2}


async def get_current_user(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    token = request.cookies.get("djq_session")
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "authentication required")
    try:
        payload = decode_access_token(token)
        user_id = int(payload["sub"])
    except Exception:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or expired session")
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "user not found or disabled")
    return user


def require_role(minimum: str):
    async def _dep(user: User = Depends(get_current_user)) -> User:
        if ROLE_ORDER.get(user.role, -1) < ROLE_ORDER[minimum]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"requires role >= {minimum}")
        return user
    return _dep
