"""Shared HTTP client for exchange API access.

- Attaches a browser-like User-Agent: ZebPay's edge (Cloudflare rule 1010) blocks
  non-browser agents on *public* endpoints (verified against the live API).
- Exposes rate-limit retry headers for callers that need them.
"""
from typing import Any

import httpx

from ..config import get_settings


def headers() -> dict[str, str]:
    return {"User-Agent": get_settings().user_agent, "Accept": "application/json"}


async def get(url: str, params: dict[str, Any] | None = None,
              extra_headers: dict[str, str] | None = None) -> httpx.Response:
    merged = {**headers(), **(extra_headers or {})}
    timeout = get_settings().http_timeout_seconds
    query = {k: v for k, v in (params or {}).items() if v is not None}
    async with httpx.AsyncClient(timeout=timeout) as client:
        # IMPORTANT: passing params (even an empty dict) REPLACES the query string
        # already present in `url`. Signed requests (ZebPay) pre-build their query,
        # so passing {} here silently dropped the signed timestamp and the server
        # answered "Missing timestamp." Only pass params when there are any.
        if query:
            return await client.get(url, params=query, headers=merged)
        return await client.get(url, headers=merged)


async def get_json(url: str, params: dict[str, Any] | None = None,
                   extra_headers: dict[str, str] | None = None) -> Any:
    resp = await get(url, params, extra_headers)
    if resp.status_code >= 400:
        raise UpstreamError(resp.status_code, resp.text[:500])
    return resp.json()


class UpstreamError(RuntimeError):
    def __init__(self, status: int, body: str):
        super().__init__(f"upstream HTTP {status}: {body[:200]}")
        self.status = status
        self.body = body
