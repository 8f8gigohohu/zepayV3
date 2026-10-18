# Automated tests - all accounts are synthetic users in the temporary test DB.
import pytest

from tests.helpers import csrf_headers

pytestmark = pytest.mark.asyncio


async def test_first_user_becomes_admin_and_receives_cookie_not_token(client):
    r = await client.post("/api/auth/register", json={
        "email": "admin@example.com", "password": "correct-horse-99"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["role"] == "admin"
    assert body["authenticated"] is True
    assert "access_token" not in body
    cookies = " ".join(r.headers.get_list("set-cookie")).lower()
    assert "djq_session=" in cookies and "httponly" in cookies and "samesite=strict" in cookies
    assert "djq_csrf=" in cookies
    assert (await client.get("/api/auth/me")).status_code == 200


async def test_second_user_is_viewer_and_rbac_enforced(client):
    await client.post("/api/auth/register", json={
        "email": "one@example.com", "password": "correct-horse-99"})
    r = await client.post("/api/auth/register", headers=csrf_headers(client), json={
        "email": "two@example.com", "password": "correct-horse-99"})
    assert r.status_code == 201, r.text
    assert r.json()["role"] == "viewer"
    assert "access_token" not in r.json()

    # The second registration rotated the session cookie to the viewer account.
    r2 = await client.get("/api/auth/users")
    assert r2.status_code == 403


async def test_login_success_and_failure(client):
    await client.post("/api/auth/register", json={
        "email": "login@example.com", "password": "correct-horse-99"})
    ok = await client.post("/api/auth/login", headers=csrf_headers(client), json={
        "email": "login@example.com", "password": "correct-horse-99"})
    assert ok.status_code == 200
    assert "access_token" not in ok.json()
    bad = await client.post("/api/auth/login", headers=csrf_headers(client), json={
        "email": "login@example.com", "password": "wrong-pass-1"})
    assert bad.status_code == 401


async def test_me_requires_session_cookie(client):
    await client.post("/api/auth/register", json={
        "email": "me@example.com", "password": "correct-horse-99"})
    client.cookies.clear()
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_authenticated_mutation_requires_csrf_nonce(client):
    r = await client.post("/api/auth/register", json={
        "email": "csrf@example.com", "password": "correct-horse-99"})
    assert r.status_code == 201
    denied = await client.post("/api/system/kill-switch", json={"active": False})
    assert denied.status_code == 403
    assert "CSRF" in denied.text
    allowed = await client.post("/api/system/kill-switch", headers=csrf_headers(client),
                                json={"active": False})
    assert allowed.status_code == 200, allowed.text
