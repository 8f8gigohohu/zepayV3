from __future__ import annotations

import threading
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy import DateTime, Integer, Numeric, String, create_engine, func, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker


class Base(DeclarativeBase):
    pass


class TradeRecord(Base):
    __tablename__ = "execution_journal"

    mode: Mapped[str] = mapped_column(String(8), primary_key=True)
    trade_id: Mapped[str] = mapped_column(String(180), primary_key=True)
    client_order_id: Mapped[str] = mapped_column(String(64), index=True)
    exchange_order_id: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    symbol: Mapped[str] = mapped_column(String(32), index=True)
    side: Mapped[str] = mapped_column(String(8))
    amount: Mapped[Decimal] = mapped_column(Numeric(38, 16))
    price: Mapped[Decimal] = mapped_column(Numeric(38, 16))
    fee: Mapped[Decimal] = mapped_column(Numeric(38, 16), default=Decimal("0"))
    fee_currency: Mapped[str | None] = mapped_column(String(16), nullable=True)
    realized_pnl: Mapped[Decimal] = mapped_column(Numeric(38, 16), default=Decimal("0"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class PositionRecord(Base):
    __tablename__ = "position_ledger"

    mode: Mapped[str] = mapped_column(String(8), primary_key=True)
    symbol: Mapped[str] = mapped_column(String(32), primary_key=True)
    base_currency: Mapped[str] = mapped_column(String(16))
    quote_currency: Mapped[str] = mapped_column(String(16))
    amount: Mapped[Decimal] = mapped_column(Numeric(38, 16), default=Decimal("0"))
    average_entry: Mapped[Decimal] = mapped_column(Numeric(38, 16), default=Decimal("0"))
    realized_pnl: Mapped[Decimal] = mapped_column(Numeric(38, 16), default=Decimal("0"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class RiskEventRecord(Base):
    __tablename__ = "risk_event_journal"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    mode: Mapped[str] = mapped_column(String(8), index=True)
    event_type: Mapped[str] = mapped_column(String(40), index=True)
    reason: Mapped[str] = mapped_column(String(500))
    symbol: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class JournalRepository:
    """SQLAlchemy-backed fills, positions, and risk-event journal.

    Order submission state remains in the existing SQLite order ledger; this journal
    adds idempotent execution accounting without storing API credentials.
    """

    def __init__(self, database_path: Path | str):
        path = Path(database_path).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        self.engine = create_engine(
            f"sqlite:///{path.as_posix()}",
            connect_args={"check_same_thread": False, "timeout": 10},
            pool_pre_ping=True,
        )
        self._sessions = sessionmaker(self.engine, expire_on_commit=False)
        self._lock = threading.RLock()
        Base.metadata.create_all(self.engine)

    def apply_fill(
        self,
        *,
        trade_id: str,
        client_order_id: str,
        exchange_order_id: str | None,
        symbol: str,
        side: str,
        amount: Decimal,
        price: Decimal,
        fee: Decimal = Decimal("0"),
        fee_currency: str | None = None,
        created_at: datetime | None = None,
        mode: str = "paper",
    ) -> dict[str, Any]:
        amount = Decimal(amount)
        price = Decimal(price)
        fee = Decimal(fee)
        if amount <= 0 or price <= 0 or not amount.is_finite() or not price.is_finite():
            raise ValueError("Fill amount and price must be finite positive values")
        if fee < 0 or not fee.is_finite():
            raise ValueError("Fill fee must be finite and non-negative")
        normalized_symbol = symbol.strip().upper().replace("-", "/")
        if normalized_symbol.count("/") != 1 or side.lower() not in {"buy", "sell"}:
            raise ValueError("Fill must include a spot pair and buy/sell side")
        base, quote = normalized_symbol.split("/", 1)
        side = side.lower()
        fee_currency = fee_currency.upper() if fee_currency else None
        mode = mode.strip().lower()
        if mode not in {"paper", "live"}:
            raise ValueError("Journal mode must be paper or live")
        now = created_at or utc_now()

        with self._lock, self._sessions.begin() as session:
            existing = session.get(TradeRecord, (mode, trade_id))
            if existing is not None:
                payload = self._position_payload(session.get(PositionRecord, (mode, normalized_symbol))) or {}
                payload.update({"fill_realized_pnl": str(existing.realized_pnl), "duplicate": True})
                return payload

            position = session.get(PositionRecord, (mode, normalized_symbol))
            if position is None:
                position = PositionRecord(
                    mode=mode,
                    symbol=normalized_symbol,
                    base_currency=base,
                    quote_currency=quote,
                    amount=Decimal("0"),
                    average_entry=Decimal("0"),
                    realized_pnl=Decimal("0"),
                    updated_at=now,
                )
                session.add(position)
                session.flush()

            realized = Decimal("0")
            old_amount = Decimal(position.amount)
            old_average = Decimal(position.average_entry)
            if side == "buy":
                credited_amount = amount - fee if fee_currency == base else amount
                if credited_amount <= 0:
                    raise ValueError("Base-asset fee consumes the entire fill")
                quote_cost = amount * price + (fee if fee_currency == quote else Decimal("0"))
                new_amount = old_amount + credited_amount
                position.average_entry = (old_amount * old_average + quote_cost) / new_amount
                position.amount = new_amount
            else:
                base_debit = amount + (fee if fee_currency == base else Decimal("0"))
                if base_debit > old_amount:
                    raise ValueError("Sell fill would create an unsupported short position")
                realized = (price - old_average) * amount
                if fee_currency == quote:
                    realized -= fee
                elif fee_currency == base:
                    realized -= fee * old_average
                position.amount = old_amount - base_debit
                if position.amount == 0:
                    position.average_entry = Decimal("0")
                position.realized_pnl = Decimal(position.realized_pnl) + realized

            position.updated_at = now
            session.add(TradeRecord(
                mode=mode,
                trade_id=trade_id,
                client_order_id=client_order_id,
                exchange_order_id=exchange_order_id,
                symbol=normalized_symbol,
                side=side,
                amount=amount,
                price=price,
                fee=fee,
                fee_currency=fee_currency,
                realized_pnl=realized,
                created_at=now,
            ))
            session.flush()
            payload = self._position_payload(position) or {}
            payload.update({"fill_realized_pnl": str(realized), "duplicate": False})
            return payload

    def get_position(self, symbol: str, mode: str = "paper") -> dict[str, Any] | None:
        normalized = symbol.strip().upper().replace("-", "/")
        with self._sessions() as session:
            return self._position_payload(session.get(PositionRecord, (mode, normalized)))

    def list_positions(self, mode: str = "paper") -> list[dict[str, Any]]:
        with self._sessions() as session:
            rows = session.scalars(
                select(PositionRecord)
                .where(PositionRecord.amount != 0, PositionRecord.mode == mode)
                .order_by(PositionRecord.symbol)
            ).all()
            return [self._position_payload(row) for row in rows]

    def list_trades(
        self, limit: int = 50, offset: int = 0, mode: str | None = None
    ) -> tuple[list[dict[str, Any]], int]:
        limit = max(1, min(int(limit), 200))
        offset = max(0, int(offset))
        with self._sessions() as session:
            query = select(TradeRecord)
            count_query = select(func.count()).select_from(TradeRecord)
            if mode is not None:
                query = query.where(TradeRecord.mode == mode)
                count_query = count_query.where(TradeRecord.mode == mode)
            total = int(session.scalar(count_query) or 0)
            rows = session.scalars(
                query.order_by(TradeRecord.created_at.desc()).offset(offset).limit(limit)
            ).all()
            items = [{
                "mode": row.mode,
                "trade_id": row.trade_id,
                "client_order_id": row.client_order_id,
                "exchange_order_id": row.exchange_order_id,
                "symbol": row.symbol,
                "side": row.side,
                "amount": str(row.amount),
                "price": str(row.price),
                "fee": str(row.fee),
                "fee_currency": row.fee_currency,
                "realized_pnl": str(row.realized_pnl),
                "created_at": row.created_at.isoformat(),
            } for row in rows]
            return items, total

    def daily_stats(self, day: date | None = None, mode: str | None = None) -> dict[str, Any]:
        day = day or utc_now().date()
        start = datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc)
        end = datetime.combine(day, datetime.max.time(), tzinfo=timezone.utc)
        with self._sessions() as session:
            statement = select(
                func.count(TradeRecord.trade_id), func.coalesce(func.sum(TradeRecord.realized_pnl), 0)
            ).where(TradeRecord.created_at >= start, TradeRecord.created_at <= end)
            if mode is not None:
                statement = statement.where(TradeRecord.mode == mode)
            row = session.execute(statement).one()
            return {"trades": int(row[0] or 0), "realized_pnl": Decimal(str(row[1] or 0))}

    def daily_notional(self, day: date | None = None, mode: str | None = None) -> Decimal:
        day = day or utc_now().date()
        start = datetime.combine(day, datetime.min.time(), tzinfo=timezone.utc)
        end = datetime.combine(day, datetime.max.time(), tzinfo=timezone.utc)
        with self._sessions() as session:
            statement = select(TradeRecord.amount, TradeRecord.price).where(
                TradeRecord.created_at >= start, TradeRecord.created_at <= end
            )
            if mode is not None:
                statement = statement.where(TradeRecord.mode == mode)
            rows = session.execute(statement).all()
            return sum((Decimal(amount) * Decimal(price) for amount, price in rows), Decimal("0"))

    def record_risk_event(
        self, event_type: str, reason: str, symbol: str | None = None, mode: str = "paper"
    ) -> None:
        with self._sessions.begin() as session:
            session.add(RiskEventRecord(
                mode=mode,
                event_type=event_type[:40],
                reason=reason[:500],
                symbol=symbol,
                created_at=utc_now(),
            ))

    def list_risk_events(self, limit: int = 50, mode: str | None = None) -> list[dict[str, Any]]:
        with self._sessions() as session:
            statement = select(RiskEventRecord)
            if mode is not None:
                statement = statement.where(RiskEventRecord.mode == mode)
            rows = session.scalars(
                statement.order_by(RiskEventRecord.id.desc()).limit(max(1, min(limit, 200)))
            ).all()
            return [{
                "id": row.id,
                "mode": row.mode,
                "event_type": row.event_type,
                "reason": row.reason,
                "symbol": row.symbol,
                "created_at": row.created_at.isoformat(),
            } for row in rows]

    def latest_risk_control_event(self, mode: str = "paper") -> dict[str, Any] | None:
        with self._sessions() as session:
            row = session.scalar(
                select(RiskEventRecord)
                .where(
                    RiskEventRecord.mode == mode,
                    RiskEventRecord.event_type.in_(["HALT", "RESUME", "CIRCUIT_BREAKER"]),
                )
                .order_by(RiskEventRecord.id.desc())
                .limit(1)
            )
            if row is None:
                return None
            return {"event_type": row.event_type, "reason": row.reason, "created_at": row.created_at}

    def last_realized_loss_time(self, mode: str = "paper") -> float | None:
        with self._sessions() as session:
            created_at = session.scalar(
                select(TradeRecord.created_at)
                .where(TradeRecord.mode == mode, TradeRecord.realized_pnl < 0)
                .order_by(TradeRecord.created_at.desc())
                .limit(1)
            )
        if created_at is None:
            return None
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        return created_at.timestamp()

    def close(self) -> None:
        self.engine.dispose()

    @staticmethod
    def _position_payload(position: PositionRecord | None) -> dict[str, Any] | None:
        if position is None:
            return None
        return {
            "mode": position.mode,
            "symbol": position.symbol,
            "base_currency": position.base_currency,
            "quote_currency": position.quote_currency,
            "amount": str(position.amount),
            "average_entry": str(position.average_entry),
            "realized_pnl": str(position.realized_pnl),
            "updated_at": position.updated_at.isoformat(),
        }
