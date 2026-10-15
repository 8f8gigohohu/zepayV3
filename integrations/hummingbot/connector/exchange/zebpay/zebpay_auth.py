from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any, Dict
from urllib.parse import urlencode

from hummingbot.connector.time_synchronizer import TimeSynchronizer
from hummingbot.core.web_assistant.auth import AuthBase
from hummingbot.core.web_assistant.connections.data_types import RESTMethod, RESTRequest, WSRequest


class ZebpayAuth(AuthBase):
    """ZebPay API-key HMAC-SHA256 signing (Spot REST).

    GET/DELETE requests sign the URL-encoded query including timestamp. POST
    requests sign the compact JSON payload including a millisecond timestamp,
    following ZebPay's current API-key signing reference.
    """

    def __init__(self, api_key: str, secret_key: str, time_provider: TimeSynchronizer):
        self.api_key = api_key
        self.secret_key = secret_key
        self.time_provider = time_provider

    async def rest_authenticate(self, request: RESTRequest) -> RESTRequest:
        timestamp = int(self.time_provider.time() * 1000)
        if request.method in (RESTMethod.GET, RESTMethod.DELETE):
            params: Dict[str, Any] = dict(request.params or {})
            params["timestamp"] = str(timestamp)
            request.params = params
            signed_payload = urlencode(params)
        else:
            if request.data is None:
                body: Dict[str, Any] = {}
            elif isinstance(request.data, str):
                body = json.loads(request.data)
            else:
                body = dict(request.data)
            body["timestamp"] = timestamp
            signed_payload = json.dumps(body, separators=(",", ":"), ensure_ascii=False)
            request.data = signed_payload

        signature = hmac.new(
            self.secret_key.encode("utf-8"),
            signed_payload.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        headers = dict(request.headers or {})
        headers.update({
            "X-AUTH-APIKEY": self.api_key,
            "X-AUTH-SIGNATURE": signature,
            "Content-Type": "application/json",
        })
        request.headers = headers
        return request

    async def ws_authenticate(self, request: WSRequest) -> WSRequest:
        # ZebPay Spot currently uses REST order and balance polling in this connector.
        return request
