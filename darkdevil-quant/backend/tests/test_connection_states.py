# Unit-level mapping table for every documented connection state. Kept in a file
# without the asyncio marker so it stays a plain synchronous test.
from app.routers import credentials as cred_mod


class _Cred:
    """Minimal stand-in for ExchangeCredential - the function only reads these fields."""

    def __init__(self, status=None, detail=None):
        self.last_test_status = status
        self.last_test_detail = detail


CAPS_READY = {"account_balances": {"status": "needs_verification"}}
CAPS_UNSUPPORTED = {"account_balances": {"status": "unsupported"}}


def test_no_credential_is_not_configured():
    assert cred_mod._derive_state(None, CAPS_READY)[0] == "NOT_CONFIGURED"


def test_saved_but_untested():
    assert cred_mod._derive_state(_Cred(), CAPS_READY)[0] == "CONFIGURED_UNTESTED"


def test_successful_account_read_is_read_only():
    state, detail = cred_mod._derive_state(_Cred("ok"), CAPS_READY)
    assert state == "CONNECTED_READ_ONLY"
    assert "read-only" in detail


def test_unimplemented_private_api_is_unsupported():
    cred = _Cred("fail", "zebpay private endpoints are NOT implemented: ...")
    assert cred_mod._derive_state(cred, CAPS_READY)[0] == "UNSUPPORTED"


def test_unsupported_capability_is_unsupported_without_a_test():
    assert cred_mod._derive_state(_Cred(), CAPS_UNSUPPORTED)[0] == "UNSUPPORTED"


def test_failed_test_is_error():
    assert cred_mod._derive_state(_Cred("fail", "HTTP 451 from upstream"), CAPS_READY)[0] == "ERROR"


def test_stored_key_never_reports_trading_verification():
    """No adapter implements place_order, so no state may claim trading readiness."""
    for status, detail in [(None, None), ("ok", None), ("fail", "boom")]:
        assert cred_mod._derive_state(_Cred(status, detail), CAPS_READY)[0] != "VERIFIED_FOR_TRADING"
