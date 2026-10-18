from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterator

from .utils import decimal_text, split_symbol


OPEN_STATUSES = ("open", "partially_filled", "submitting", "unknown")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


class Store:
    """Small local SQLite ledger for paper balances and order audit history."""

    def __init__(self, database_path: Path | str, paper_starting_inr: Decimal):
        self.path = Path(database_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()
        self.ensure_paper_balance("INR", paper_starting_inr)

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    @contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        connection = self._connect()
        try:
            yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._db() as db:
            db.execute("PRAGMA journal_mode = WAL")
            db.execute(
                """CREATE TABLE IF NOT EXISTS orders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    client_order_id TEXT NOT NULL UNIQUE,
                    exchange_order_id TEXT,
                    mode TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    side TEXT NOT NULL,
                    order_type TEXT NOT NULL,
                    amount TEXT NOT NULL,
                    price TEXT NOT NULL,
                    filled TEXT NOT NULL DEFAULT '0',
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    raw TEXT NOT NULL DEFAULT '{}'
                )"""
            )
            db.execute(
                "CREATE INDEX IF NOT EXISTS idx_orders_mode_symbol_created "
                "ON orders(mode, symbol, created_at DESC)"
            )
            db.execute(
                "CREATE INDEX IF NOT EXISTS idx_orders_mode_status "
                "ON orders(mode, status)"
            )
            db.execute(
                """CREATE TABLE IF NOT EXISTS paper_balances (
                    currency TEXT PRIMARY KEY,
                    total TEXT NOT NULL
                )"""
            )

    def ensure_paper_balance(self, currency: str, total: Decimal) -> None:
        with self._db() as db:
            db.execute(
                "INSERT OR IGNORE INTO paper_balances(currency, total) VALUES(?, ?)",
                (currency.upper(), decimal_text(total)),
            )

    def paper_balances(self) -> dict[str, Decimal]:
        with self._db() as db:
            rows = db.execute("SELECT currency, total FROM paper_balances ORDER BY currency").fetchall()
        return {row["currency"]: Decimal(row["total"]) for row in rows}

    def paper_available_balances(self) -> dict[str, Decimal]:
        balances = self.paper_balances()
        reserved: dict[str, Decimal] = {}
        with self._db() as db:
            rows = db.execute(
                "SELECT symbol, side, amount, price FROM orders "
                "WHERE mode = 'paper' AND status IN ('open', 'partially_filled', 'submitting', 'unknown')"
            ).fetchall()
        for row in rows:
            base, quote = split_symbol(row["symbol"])
            amount = Decimal(row["amount"])
            price = Decimal(row["price"])
            currency = quote if row["side"] == "buy" else base
            held = amount * price if row["side"] == "buy" else amount
            reserved[currency] = reserved.get(currency, Decimal(0)) + held
        return {currency: max(Decimal(0), amount - reserved.get(currency, Decimal(0)))
                for currency, amount in balances.items()}

    def create_order(self, order: dict[str, Any]) -> dict[str, Any]:
        now = utc_now()
        raw = order.get("raw", {})
        with self._db() as db:
            db.execute(
                """INSERT INTO orders (
                    client_order_id, exchange_order_id, mode, symbol, side, order_type,
                    amount, price, filled, status, created_at, updated_at, raw
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    order["client_order_id"], order.get("exchange_order_id"), order["mode"],
                    order["symbol"], order["side"], order.get("order_type", "limit"),
                    decimal_text(order["amount"]), decimal_text(order["price"]),
                    decimal_text(order.get("filled", Decimal(0))), order["status"], now, now,
                    json.dumps(raw, separators=(",", ":"), default=str),
                ),
            )
            row = db.execute("SELECT * FROM orders WHERE client_order_id = ?", (order["client_order_id"],)).fetchone()
        return self._decode_order(row)

    def update_order(self, client_order_id: str, **updates: Any) -> dict[str, Any] | None:
        allowed = {"exchange_order_id", "filled", "status", "raw", "price", "amount"}
        values: list[Any] = []
        assignments: list[str] = []
        for key, value in updates.items():
            if key not in allowed:
                raise ValueError(f"Unsupported order field: {key}")
            if key in {"amount", "price", "filled"}:
                value = decimal_text(value)
            elif key == "raw":
                value = json.dumps(value, separators=(",", ":"), default=str)
            assignments.append(f"{key} = ?")
            values.append(value)
        if not assignments:
            return self.get_order(client_order_id)
        assignments.append("updated_at = ?")
        values.append(utc_now())
        values.append(client_order_id)
        with self._db() as db:
            db.execute(f"UPDATE orders SET {', '.join(assignments)} WHERE client_order_id = ?", values)
            row = db.execute("SELECT * FROM orders WHERE client_order_id = ?", (client_order_id,)).fetchone()
        return self._decode_order(row) if row else None

    def get_order(self, client_order_id: str) -> dict[str, Any] | None:
        with self._db() as db:
            row = db.execute("SELECT * FROM orders WHERE client_order_id = ?", (client_order_id,)).fetchone()
        return self._decode_order(row) if row else None

    def get_order_by_exchange_id(self, exchange_order_id: str) -> dict[str, Any] | None:
        with self._db() as db:
            row = db.execute(
                "SELECT * FROM orders WHERE exchange_order_id = ? ORDER BY id DESC LIMIT 1",
                (str(exchange_order_id),),
            ).fetchone()
        return self._decode_order(row) if row else None

    def list_orders(self, mode: str, symbol: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        query = "SELECT * FROM orders WHERE mode = ?"
        params: list[Any] = [mode]
        if symbol:
            query += " AND symbol = ?"
            params.append(symbol)
        query += " ORDER BY id DESC LIMIT ?"
        params.append(max(1, min(int(limit), 500)))
        with self._db() as db:
            rows = db.execute(query, params).fetchall()
        return [self._decode_order(row) for row in rows]

    def open_order_count(self, mode: str) -> int:
        placeholders = ",".join("?" for _ in OPEN_STATUSES)
        with self._db() as db:
            row = db.execute(
                f"SELECT COUNT(*) AS n FROM orders WHERE mode = ? AND status IN ({placeholders})",
                (mode, *OPEN_STATUSES),
            ).fetchone()
        return int(row["n"])

    def daily_notional(self, mode: str, utc_date: str) -> Decimal:
        # Count cancelled submissions too: repeatedly cancelling must not bypass a daily turnover cap.
        with self._db() as db:
            rows = db.execute(
                "SELECT amount, price FROM orders WHERE mode = ? AND substr(created_at, 1, 10) = ? "
                "AND status != 'failed'",
                (mode, utc_date),
            ).fetchall()
        return sum((Decimal(row["amount"]) * Decimal(row["price"]) for row in rows), Decimal(0))

    def cancel_paper_order(self, client_order_id: str) -> dict[str, Any] | None:
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "UPDATE orders SET status = 'canceled', updated_at = ? "
                "WHERE client_order_id = ? AND mode = 'paper' AND status = 'open'",
                (utc_now(), client_order_id),
            )
            row = db.execute("SELECT * FROM orders WHERE client_order_id = ?", (client_order_id,)).fetchone()
            db.commit()
        return self._decode_order(row) if row else None

    def fill_paper_order(self, client_order_id: str, fill_price: Decimal) -> dict[str, Any] | None:
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM orders WHERE client_order_id = ? AND mode = 'paper'",
                (client_order_id,),
            ).fetchone()
            if row is None or row["status"] != "open":
                db.commit()
                return self._decode_order(row) if row else None

            base, quote = split_symbol(row["symbol"])
            amount = Decimal(row["amount"])
            price = Decimal(row["price"])
            fill_price = Decimal(fill_price)
            if fill_price <= 0 or not fill_price.is_finite():
                db.rollback()
                raise ValueError("Invalid simulated fill price")

            balances_rows = db.execute("SELECT currency, total FROM paper_balances").fetchall()
            balances = {entry["currency"]: Decimal(entry["total"]) for entry in balances_rows}
            reserved_elsewhere: dict[str, Decimal] = {}
            other_rows = db.execute(
                "SELECT symbol, side, amount, price FROM orders "
                "WHERE mode = 'paper' AND status = 'open' AND client_order_id != ?",
                (client_order_id,),
            ).fetchall()
            for other in other_rows:
                other_base, other_quote = split_symbol(other["symbol"])
                other_amount = Decimal(other["amount"])
                other_price = Decimal(other["price"])
                currency = other_quote if other["side"] == "buy" else other_base
                reserved = other_amount * other_price if other["side"] == "buy" else other_amount
                reserved_elsewhere[currency] = reserved_elsewhere.get(currency, Decimal(0)) + reserved

            if row["side"] == "buy":
                cost = amount * fill_price
                if balances.get(quote, Decimal(0)) - reserved_elsewhere.get(quote, Decimal(0)) < cost:
                    db.commit()
                    return self._decode_order(row)
                balances[quote] = balances.get(quote, Decimal(0)) - cost
                balances[base] = balances.get(base, Decimal(0)) + amount
            else:
                if balances.get(base, Decimal(0)) - reserved_elsewhere.get(base, Decimal(0)) < amount:
                    db.commit()
                    return self._decode_order(row)
                balances[base] = balances.get(base, Decimal(0)) - amount
                balances[quote] = balances.get(quote, Decimal(0)) + amount * fill_price

            for currency, total in balances.items():
                db.execute(
                    "INSERT INTO paper_balances(currency, total) VALUES(?, ?) "
                    "ON CONFLICT(currency) DO UPDATE SET total = excluded.total",
                    (currency, decimal_text(total)),
                )
            db.execute(
                "UPDATE orders SET status = 'filled', filled = amount, price = ?, updated_at = ? "
                "WHERE client_order_id = ?",
                (decimal_text(fill_price), utc_now(), client_order_id),
            )
            updated = db.execute("SELECT * FROM orders WHERE client_order_id = ?", (client_order_id,)).fetchone()
            db.commit()
        return self._decode_order(updated)

    @staticmethod
    def _decode_order(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        order = dict(row)
        try:
            order["raw"] = json.loads(order.get("raw") or "{}")
        except json.JSONDecodeError:
            order["raw"] = {}
        return order
