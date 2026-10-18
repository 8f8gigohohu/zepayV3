# Regression tests for the shared exchange HTTP helper. No external network: a
# local HTTP server echoes back the request path it actually received.
import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from app.exchanges import http


class _Echo(BaseHTTPRequestHandler):
    received: list[str] = []

    def do_GET(self):  # noqa: N802 (http.server naming)
        _Echo.received.append(self.path)
        body = json.dumps({"ok": True, "path": self.path}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # silence test output
        pass


def _serve():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Echo)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def test_presigned_query_survives_the_shared_helper():
    """Regression: httpx replaces the URL's query when passed params={}, which
    silently dropped ZebPay's signed timestamp ("Missing timestamp" from the API)."""
    server, base = _serve()
    try:
        _Echo.received.clear()
        out = asyncio.run(http.get_json(f"{base}/api/v2/account/balance?timestamp=1760700000123"))
        assert out["path"] == "/api/v2/account/balance?timestamp=1760700000123"
        assert _Echo.received == ["/api/v2/account/balance?timestamp=1760700000123"]
    finally:
        server.shutdown()
        server.server_close()


def test_params_are_still_sent_and_none_values_dropped():
    server, base = _serve()
    try:
        _Echo.received.clear()
        asyncio.run(http.get_json(f"{base}/path", {"symbol": "BTC-INR", "skip": None}))
        assert _Echo.received == ["/path?symbol=BTC-INR"]
    finally:
        server.shutdown()
        server.server_close()
