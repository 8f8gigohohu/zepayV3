from __future__ import annotations

from decimal import Decimal


def decimal_text(value: Decimal | str | int | float) -> str:
    number = value if isinstance(value, Decimal) else Decimal(str(value))
    if not number.is_finite():
        raise ValueError("Non-finite decimal values are not supported")
    rendered = format(number, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered or "0"


def normalize_symbol(symbol: str) -> str:
    return symbol.strip().upper().replace("-", "/")


def split_symbol(symbol: str) -> tuple[str, str]:
    normalized = normalize_symbol(symbol)
    if normalized.count("/") != 1:
        raise ValueError(f"Invalid spot symbol: {symbol}")
    base, quote = normalized.split("/", 1)
    return base, quote
