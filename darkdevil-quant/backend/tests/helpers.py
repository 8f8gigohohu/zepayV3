def csrf_headers(client, extra=None):
    headers = dict(extra or {})
    token = client.cookies.get("djq_csrf")
    if token:
        headers["X-CSRF-Token"] = token
    return headers
