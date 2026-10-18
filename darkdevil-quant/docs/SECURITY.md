# DarkDevil Quant — Security Notes (M1)

## Secrets
- All API credentials are stored **encrypted-at-rest** (Fernet/AES; key derived from `DJQ_SECRET_KEY`).
  In production, replace app-level encryption with a secrets manager (vault/KMS) — documented upgrade path in `ARCHITECTURE.md`.
- No secret is ever returned by any API: creations/tests return only a masked key (`abcd...wxyz`).
  Audit lines pass through a key-name redaction filter.
- Secrets never appear in frontend code or network responses; only the backend process reads them.
- No API secret is requested from the user in chat: those go through the UI or env.

## Exchange connections (added in the upgrade pass)
- Credential state is derived from evidence on every read and exposed through a documented lifecycle:
  `NOT_CONFIGURED`, `CONFIGURED_UNTESTED`, `CONNECTED_READ_ONLY`, `VERIFIED_FOR_TRADING`, `ERROR`,
  `UNSUPPORTED`. Storing a key never reports a connection, and an account read never reports trading
  readiness; `place_order` is reported as its own capability.
- A test persists its status, reason and timestamp. The reason is truncated to 400 characters, so an
  upstream response body cannot bloat the database row, the API response or the audit entry.
- `GET /api/system/risk` is read-only and exposes exactly the gate and limit values the risk engine
  uses. Changing the kill switch remains admin-only, audited, and behind a confirmation dialog.
- Tests assert that neither the API key nor the secret can appear in any connection response body.

## Access control
- JWT bearer tokens (HS256), configurable expiry, role checks on every mutating endpoint
  (`admin` required for kill switch; `trader`/`admin` semantics formalized in M2 order routing).
- All order attempts (including anonymous and duplicate ones) are recorded in an
  **append-only audit log**; no update/delete paths exist on that table.

## Known trade-offs for M1
- JWT tokens are stored in `localStorage` client-side for the dashboard — convenient but
  XSS-sensitive; M2 will move to HttpOnly cookie sessions plus CSRF protection.
- Table creation is done by `Base.metadata.create_all` at startup; Alembic migrations arrive in M2.
- SQLite is the default dev database; production deployments must use the provided
  Postgres compose service (`DJQ_DATABASE_URL`), whose ports are not published.

## Incident response / rotation
1. Rotate `DJQ_SECRET_KEY` → all sessions invalid and all stored credentials must be re-saved
   (they are re-encryptable only if the old key is retained — treat rotation as a credential re-entry step).
2. Delete stored exchange credentials from the Connections screen; rotate keys at each exchange.
3. Inspect `audit_log` for unauthorized `auth.login_failed` or `connection.*` events.
