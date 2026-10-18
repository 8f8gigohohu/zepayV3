from decimal import Decimal

from zepay_trader.engine.risk_engine import RiskEngine
from zepay_trader.journal import JournalRepository
from zepay_trader.runtime_config import RiskConfig


def test_multilayer_risk_caps_and_restart_halt_persistence(tmp_path):
    journal = JournalRepository(tmp_path / 'risk.sqlite3')
    config = RiskConfig(
        max_position_base=0.01,
        max_daily_loss_quote=500,
        max_daily_trades=5,
        cooldown_after_loss_sec=30,
        circuit_breaker_pct=0.05,
        max_order_notional_quote=1000,
        max_daily_notional_quote=2500,
    )
    risk = RiskEngine(config, journal, mode='live')
    try:
        allowed, reason = risk.check(
            {'symbol': 'BTC/INR', 'side': 'buy', 'amount': '0.001', 'price': '100000'},
            Decimal('0'), Decimal('100000'), Decimal('100000'),
        )
        assert allowed and reason == 'approved'

        allowed, reason = risk.check(
            {'symbol': 'BTC/INR', 'side': 'buy', 'amount': '0.02', 'price': '100000'},
            Decimal('0'), Decimal('100000'), Decimal('100000'),
        )
        assert not allowed and 'notional cap' in reason

        allowed, reason = risk.check(
            {'symbol': 'BTC/INR', 'side': 'sell', 'amount': '0.002', 'price': '100000'},
            Decimal('0.001'), Decimal('100000'), Decimal('100000'),
        )
        assert not allowed and 'tracked base-asset position' in reason

        risk.halt('manual safety stop')
        restored = RiskEngine(config, journal, mode='live')
        assert restored.state()['halted'] is True
        assert restored.state()['halt_reason'] == 'manual safety stop'
        restored.resume()
        assert RiskEngine(config, journal, mode='live').state()['halted'] is False
    finally:
        journal.close()
