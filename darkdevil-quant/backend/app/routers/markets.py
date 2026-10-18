"""Public market-data endpoints. Every response carries provenance
(exchange, endpoint, source_url, timestamps, stale_after) - no unlabeled data."""
from fastapi import APIRouter, Depends, HTTPException, Query

from ..auth.deps import get_current_user
from ..exchanges import http, registry
from ..exchanges.base import Envelope

router = APIRouter(prefix="/api/market", tags=["market"])

MAX_LIMITS = {"tickers": 1, "klines": 1000, "orderbook": 500, "trades": 1000}


def envelope_payload(env: Envelope) -> dict:
    return {
        "exchange": env.exchange,
        "endpoint": env.endpoint,
        "source_url": env.source_url,
        "verified": env.verified.value,
        "ts_ms": env.ts_ms,
        "upstream_ts_ms": env.upstream_ts_ms,
        "stale_after_ms": env.stale_after_ms,
        "age_ms": env.age_ms,
        "data": env.data,
    }


@router.get("/{exchange}/tickers")
async def tickers(exchange: str, symbol: str | None = None,
                  _user=Depends(get_current_user)):
    try:
        env = await registry.get_adapter(exchange).tickers(symbol)
    except KeyError:
        raise HTTPException(404, f"unsupported exchange {exchange}")
    except http.UpstreamError as e:
        raise HTTPException(502, f"upstream error: {e}")
    except ValueError as e:
        raise HTTPException(400, str(e))
    payload = envelope_payload(env)
    # limit payload size: default returns all; symbol filter is applied by adapter
    return payload


@router.get("/{exchange}/klines")
async def klines(exchange: str, symbol: str, interval: str = "1h",
                 start_ms: int | None = None, end_ms: int | None = None,
                 limit: int = Query(300, ge=1, le=1000), _user=Depends(get_current_user)):
    try:
        env = await registry.get_adapter(exchange).klines(symbol, interval, start_ms, end_ms, limit)
    except KeyError:
        raise HTTPException(404, f"unsupported exchange {exchange}")
    except http.UpstreamError as e:
        raise HTTPException(502, f"upstream error: {e}")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return envelope_payload(env)


@router.get("/{exchange}/orderbook")
async def orderbook(exchange: str, symbol: str, limit: int = Query(25, ge=1, le=500),
                    _user=Depends(get_current_user)):
    try:
        env = await registry.get_adapter(exchange).orderbook(symbol, limit)
    except KeyError:
        raise HTTPException(404, f"unsupported exchange {exchange}")
    except http.UpstreamError as e:
        raise HTTPException(502, f"upstream error: {e}")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return envelope_payload(env)


@router.get("/{exchange}/trades")
async def trades(exchange: str, symbol: str, limit: int = Query(50, ge=1, le=1000),
                 _user=Depends(get_current_user)):
    try:
        env = await registry.get_adapter(exchange).trades(symbol, limit)
    except KeyError:
        raise HTTPException(404, f"unsupported exchange {exchange}")
    except http.UpstreamError as e:
        raise HTTPException(502, f"upstream error: {e}")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return envelope_payload(env)
