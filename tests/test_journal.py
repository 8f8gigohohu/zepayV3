from decimal import Decimal

from zepay_trader.journal import JournalRepository


def test_journal_positions_are_mode_isolated_and_fill_application_is_idempotent(tmp_path):
    journal = JournalRepository(tmp_path / 'ledger.sqlite3')
    try:
        paper = journal.apply_fill(
            trade_id='same-id', client_order_id='P-1', exchange_order_id=None,
            symbol='BTC/INR', side='buy', amount=Decimal('1'), price=Decimal('100'), mode='paper',
        )
        live = journal.apply_fill(
            trade_id='same-id', client_order_id='L-1', exchange_order_id='Z-1',
            symbol='BTC/INR', side='buy', amount=Decimal('2'), price=Decimal('250'), mode='live',
        )
        assert paper['amount'] == '1'
        assert live['amount'] == '2'
        assert journal.get_position('BTC/INR', mode='paper')['average_entry'] == '100.0000000000000000'
        assert journal.get_position('BTC/INR', mode='live')['average_entry'] == '250.0000000000000000'

        sold = journal.apply_fill(
            trade_id='paper-sell-1', client_order_id='P-2', exchange_order_id=None,
            symbol='BTC/INR', side='sell', amount=Decimal('0.25'), price=Decimal('120'), mode='paper',
        )
        assert Decimal(sold['fill_realized_pnl']) == Decimal('5.00')
        assert sold['duplicate'] is False
        replay = journal.apply_fill(
            trade_id='paper-sell-1', client_order_id='P-2', exchange_order_id=None,
            symbol='BTC/INR', side='sell', amount=Decimal('0.25'), price=Decimal('120'), mode='paper',
        )
        assert replay['duplicate'] is True
        assert Decimal(replay['amount']) == Decimal('0.75')
        assert Decimal(replay['realized_pnl']) == Decimal('5.00')
        assert journal.daily_stats(mode='paper')['trades'] == 2
        assert journal.daily_stats(mode='live')['trades'] == 1
        assert len(journal.list_positions('paper')) == 1
        assert len(journal.list_positions('live')) == 1
    finally:
        journal.close()
