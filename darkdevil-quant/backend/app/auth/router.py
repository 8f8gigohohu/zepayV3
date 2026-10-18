"""Browser authentication using HttpOnly, same-site session cookies."""
import secrets

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..audit import audit
from ..config import get_settings
from ..db import get_db
from ..models import User
from ..security import create_access_token, hash_password, verify_password
from .deps import get_current_user, require_role

router = APIRouter(prefix="/api/auth", tags=["auth"])
SESSION_COOKIE = "djq_session"
CSRF_COOKIE = "djq_csrf"


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class AuthOut(BaseModel):
    authenticated: bool = True
    role: str
    email: str


def _set_session_cookies(response: Response, token: str) -> None:
    settings = get_settings()
    max_age = max(60, settings.access_token_exp_minutes * 60)
    secure = settings.cookie_secure
    response.set_cookie(
        key=SESSION_COOKIE,
        value=token,
        httponly=True,
        secure=secure,
        samesite="strict",
        max_age=max_age,
        path="/api",
    )
    # Double-submit CSRF nonce: intentionally readable by same-origin JS, unlike the
    # authentication cookie. It is not an authentication credential.
    response.set_cookie(
        key=CSRF_COOKIE,
        value=secrets.token_urlsafe(32),
        httponly=False,
        secure=secure,
        samesite="strict",
        max_age=max_age,
        path="/",
    )


def _clear_session_cookies(response: Response) -> None:
    settings = get_settings()
    response.delete_cookie(SESSION_COOKIE, path="/api", httponly=True,
                           secure=settings.cookie_secure, samesite="strict")
    response.delete_cookie(CSRF_COOKIE, path="/", httponly=False,
                           secure=settings.cookie_secure, samesite="strict")


@router.post("/register", response_model=AuthOut, status_code=status.HTTP_201_CREATED)
async def register(body: RegisterIn, response: Response, db: AsyncSession = Depends(get_db)):
    n = (await db.execute(select(func.count(User.id)))).scalar_one()
    role = "admin" if n == 0 else "viewer"  # first registered user bootstraps the admin
    existing = (await db.execute(select(User).where(User.email == body.email.lower()))).scalar_one_or_none()
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "email already registered")
    user = User(email=body.email.lower(), hashed_password=hash_password(body.password), role=role)
    db.add(user)
    await audit(db, "auth.register", detail={"email": user.email, "role": role})
    await db.refresh(user)
    _set_session_cookies(response, create_access_token(user.id, user.role))
    return AuthOut(role=user.role, email=user.email)


@router.post("/login", response_model=AuthOut)
async def login(body: LoginIn, response: Response, db: AsyncSession = Depends(get_db)):
    user = (await db.execute(select(User).where(User.email == body.email.lower()))).scalar_one_or_none()
    if not user or not user.is_active or not verify_password(body.password, user.hashed_password):
        await audit(db, "auth.login_failed", detail={"email": body.email.lower()})
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    _set_session_cookies(response, create_access_token(user.id, user.role))
    await audit(db, "auth.login", actor_id=user.id)
    return AuthOut(role=user.role, email=user.email)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(response: Response, user: User = Depends(get_current_user),
                 db: AsyncSession = Depends(get_db)):
    await audit(db, "auth.logout", actor_id=user.id)
    _clear_session_cookies(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me")
async def me(user: User = Depends(get_current_user)):
    return {"id": user.id, "email": user.email, "role": user.role,
            "created_at": user.created_at.isoformat()}


@router.get("/users")
async def list_users(limit: int = 50, user: User = Depends(require_role("admin")),
                     db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(User).order_by(User.id).limit(min(limit, 200)))).scalars().all()
    return [{"id": u.id, "email": u.email, "role": u.role,
             "is_active": u.is_active, "created_at": u.created_at.isoformat()} for u in rows]
