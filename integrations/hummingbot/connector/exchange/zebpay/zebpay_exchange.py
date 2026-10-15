from __future__ import annotations

import asyncio
import time
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

from bidict import bidict

from hummingbot.connector.constants import s_decimal_NaN
from hummingbot.connector.exchange.zebpay import zebpay_constants as CONSTANTS, zebpay_web_utils as web_utils
from hummingbot.connector.exchange.zebpay.zebpay_api_order_book_data_source import ZebpayAPIOrderBookDataSource
from hummingbot.connector.exchange.zebpay.zebpay_api_user_stream_data_source import ZebpayPollingUserStreamDataSource
from hummingbot.connector.exchange.zebpay.zebpay_auth import ZebpayAuth
from hummingbot.connector.exchange_py_base import ExchangePyBase
from hummingbot.connector.trading_rule import TradingRule
from hummingbot.core.data_type.common import OrderType, TradeType
from hummingbot.core.data_type.in_flight_order import InFlightOrder, OrderState, OrderUpdate, TradeUpdate
from hummingbot.core.data_type.order_book_tracker_data_source import OrderBookTrackerDataSource
from hummingbot.core.data_type.trade_fee import TokenAmount, TradeFeeBase
from hummingbot.core.data_type.user_stream_tracker_data_source import UserStreamTrackerDataSource
from hummingbot.core.utils.estimate_fee import build_trade_fee
from hummingbot.core.web_assistant.connections.data_types import RESTMethod
from hummingbot.core.web_assistant.web_assistants_factory import WebAssistantsFactory


class ZebpayExchange(ExchangePyBase):
    """Hummingbot CEX connector for ZebPay Spot, using ZebPay's signed REST API."""

    SHORT_POLL_INTERVAL = 5.0
    LONG_POLL_INTERVAL = 5.0
    web_utils = web_utils

    def __init__(
        self,
        zebpay_api_key: str,
        zebpay_secret_key: str,
        balance_asset_limit: Optional[Dict[str, Dict[str, Decimal]]] = None,
        rate_limits_share_pct: Decimal = Decimal("100"),
        trading_pairs: Optional[List[str]] = None,
        trading_required: bool = True,
        domain: str = CONSTANTS.DEFAULT_DOMAIN,
    ):
        self.api_key = zebpay_api_key
        self.secret_key = zebpay_secret_key
        self._trading_pairs = trading_pairs or []
        self._trading_required = trading_required
        self._domain = domain
        super().__init__(balance_asset_limit, rate_limits_share_pct)

    @property
    def name(self) -> str:
        return "zebpay"

    @property
    def authenticator(self) -> ZebpayAuth:
        return ZebpayAuth(self.api_key, self.secret_key, self._time_synchronizer)

    @property
    def rate_limits_rules(self):
        return CONSTANTS.RATE_LIMITS

    @property
    def domain(self) -> str:
        return self._domain

    @property
    def client_order_id_max_length(self) -> int:
        return CONSTANTS.MAX_ORDER_ID_LEN

    @property
    def client_order_id_prefix(self) -> str:
        return "HBZ"

    @property
    def trading_rules_request_path(self) -> str:
        return CONSTANTS.EXCHANGE_INFO_PATH_URL

    @property
    def trading_pairs_request_path(self) -> str:
        return CONSTANTS.EXCHANGE_INFO_PATH_URL

    @property
    def check_network_request_path(self) -> str:
        return CONSTANTS.SYSTEM_STATUS_PATH_URL

    @property
    def trading_pairs(self) -> List[str]:
        return self._trading_pairs

    @property
    def is_cancel_request_in_exchange_synchronous(self) -> bool:
        return True

    @property
    def is_trading_required(self) -> bool:
        return self._trading_required

    def supported_order_types(self) -> List[OrderType]:
        # Market orders are intentionally excluded until spot quantity semantics
        # are verified against the user's ZebPay account/API version.
        return [OrderType.LIMIT]

    def _is_request_exception_related_to_time_synchronizer(self, request_exception: Exception) -> bool:
        return "timestamp" in str(request_exception).lower()

    def _is_order_not_found_during_status_update_error(self, status_update_exception: Exception) -> bool:
        message = str(status_update_exception).lower()
        return "order not found" in message or "unknown order" in message or "not exist" in message

    def _is_order_not_found_during_cancelation_error(self, cancelation_exception: Exception) -> bool:
        return self._is_order_not_found_during_status_update_error(cancelation_exception)

    def _create_web_assistants_factory(self) -> WebAssistantsFactory:
        return web_utils.build_api_factory(
            throttler=self._throttler,
            time_synchronizer=self._time_synchronizer,
            auth=self._auth,
        )

    def _create_order_book_data_source(self) -> OrderBookTrackerDataSource:
        return ZebpayAPIOrderBookDataSource(
            trading_pairs=self._trading_pairs,
            connector=self,
            api_factory=self._web_assistants_factory,
        )

    def _create_user_stream_data_source(self) -> UserStreamTrackerDataSource:
        return ZebpayPollingUserStreamDataSource(connector=self)

    async def _place_order(
        self,
        order_id: str,
        trading_pair: str,
        amount: Decimal,
        trade_type: TradeType,
        order_type: OrderType,
        price: Decimal,
        **kwargs,
    ) -> Tuple[str, float]:
        if order_type is not OrderType.LIMIT:
            raise ValueError("ZebPay connector supports limit orders only")
        exchange_symbol = await self.exchange_symbol_associated_to_pair(trading_pair)
        response = await self._api_post(
            path_url=CONSTANTS.ORDERS_PATH_URL,
            data={
                "symbol": exchange_symbol,
                "side": "BUY" if trade_type is TradeType.BUY else "SELL",
                "type": "LIMIT",
                "price": str(price),
                "amount": str(amount),
                "timeInForce": "GTC",
                "clientOrderId": order_id,
            },
            is_auth_required=True,
            limit_id=CONSTANTS.ORDERS_PATH_URL,
        )
        data = response.get("data") or {}
        exchange_order_id = data.get("orderId") or data.get("id")
        if exchange_order_id is None:
            raise IOError(f"ZebPay did not return an order id: {response}")
        timestamp = self.current_timestamp or time.time()
        return str(exchange_order_id), timestamp

    async def _place_cancel(self, order_id: str, tracked_order: InFlightOrder) -> bool:
        exchange_order_id = await tracked_order.get_exchange_order_id()
        response = await self._api_delete(
            path_url=CONSTANTS.ORDER_PATH_URL,
            params={"orderId": exchange_order_id},
            is_auth_required=True,
            limit_id=CONSTANTS.ORDER_PATH_URL,
        )
        data = response.get("data") or {}
        status = str(data.get("status", "")).upper()
        return status in {"CANCELLED", "CANCELED"}

    async def _format_trading_rules(self, exchange_info_dict: Dict[str, Any]) -> List[TradingRule]:
        result: list[TradingRule] = []
        data = exchange_info_dict.get("data") or {}
        for row in data.get("symbols") or []:
            if not web_utils.is_exchange_information_valid(row):
                continue
            try:
                symbol = str(row["symbol"]).replace("/", "-")
                amount_step = Decimal(str(row.get("lotSz") or "0.00000001"))
                price_step = Decimal(str(row.get("tickSz") or "0.01"))
                min_amount = Decimal(str(row.get("minOrderSize") or row.get("lotSz") or "0"))
                min_notional = Decimal(str(row.get("minNotional") or row.get("quoteMinSize") or "0"))
                result.append(TradingRule(
                    trading_pair=symbol,
                    min_order_size=min_amount,
                    min_price_increment=price_step,
                    min_base_amount_increment=amount_step,
                    min_notional_size=min_notional,
                    supports_limit_orders=True,
                    supports_market_orders=False,
                ))
            except Exception:
                self.logger().exception(f"Unable to parse ZebPay trading rule: {row}")
        return result

    async def _update_trading_fees(self):
        # Fee estimates use ZebPay's published exchange-info default schema.
        # Users with account-specific fee tiers should set Hummingbot fee overrides.
        return

    async def _user_stream_event_listener(self):
        async for event_message in self._iter_user_event_queue():
            try:
                # This connector has no documented private Spot websocket feed.
                # Order state and balance updates are handled by the REST poller.
                if event_message.get("event") != "rest_poll_heartbeat":
                    self.logger().debug("Ignoring unsupported ZebPay user-stream message")
            except asyncio.CancelledError:
                raise
            except Exception:
                self.logger().exception("Unexpected message on ZebPay REST polling tracker")

    async def _update_balances(self):
        response = await self._api_get(
            path_url=CONSTANTS.BALANCE_PATH_URL,
            is_auth_required=True,
            limit_id=CONSTANTS.BALANCE_PATH_URL,
        )
        rows = response.get("data") or []
        seen_assets: set[str] = set()
        for row in rows:
            currency = str(row.get("currency", "")).upper()
            if not currency:
                continue
            free = Decimal(str(row.get("free") or "0"))
            total_value = row.get("total")
            total = Decimal(str(total_value)) if total_value is not None else free + Decimal(str(row.get("used") or "0"))
            self._account_available_balances[currency] = free
            self._account_balances[currency] = total
            seen_assets.add(currency)
        for currency in set(self._account_balances) - seen_assets:
            self._account_available_balances.pop(currency, None)
            self._account_balances.pop(currency, None)

    async def _all_trade_updates_for_order(self, order: InFlightOrder) -> List[TradeUpdate]:
        exchange_order_id = await order.get_exchange_order_id()
        response = await self._api_get(
            path_url=CONSTANTS.ORDER_FILLS_PATH_URL,
            params={"orderId": exchange_order_id},
            is_auth_required=True,
            limit_id=CONSTANTS.ORDER_FILLS_PATH_URL,
        )
        data = response.get("data") or {}
        fills = data.get("fills") if isinstance(data, dict) else data
        trade_updates: list[TradeUpdate] = []
        for index, fill in enumerate(fills or []):
            amount = Decimal(str(fill.get("amount") or fill.get("qty") or "0"))
            price = Decimal(str(fill.get("price") or "0"))
            if amount <= 0 or price <= 0:
                continue
            quote = order.quote_asset
            fee_asset = str(fill.get("feeCurrency") or quote).upper()
            fee_amount = Decimal(str(fill.get("totalFees") or fill.get("fees") or "0"))
            flat_fees = [TokenAmount(amount=fee_amount, token=fee_asset)] if fee_amount > 0 else []
            fee = TradeFeeBase.new_spot_fee(
                fee_schema=self.trade_fee_schema(),
                trade_type=order.trade_type,
                percent_token=fee_asset,
                flat_fees=flat_fees,
            )
            timestamp_value = fill.get("createdAt") or fill.get("timestamp") or self.current_timestamp or time.time()
            timestamp = float(timestamp_value)
            if timestamp > 1e12:
                timestamp /= 1000.0
            trade_updates.append(TradeUpdate(
                trade_id=str(fill.get("tradeId") or fill.get("id") or f"{exchange_order_id}-{timestamp}-{index}"),
                client_order_id=order.client_order_id,
                exchange_order_id=str(exchange_order_id),
                trading_pair=order.trading_pair,
                fee=fee,
                fill_base_amount=amount,
                fill_quote_amount=amount * price,
                fill_price=price,
                fill_timestamp=timestamp,
            ))
        return trade_updates

    async def _request_order_status(self, tracked_order: InFlightOrder) -> OrderUpdate:
        exchange_order_id = await tracked_order.get_exchange_order_id()
        response = await self._api_get(
            path_url=CONSTANTS.ORDER_PATH_URL,
            params={"orderId": exchange_order_id},
            is_auth_required=True,
            limit_id=CONSTANTS.ORDER_PATH_URL,
        )
        data = response.get("data") or {}
        status = str(data.get("status", "OPEN")).upper()
        state_name = CONSTANTS.ORDER_STATES.get(status)
        if state_name is None:
            raise IOError(f"Unknown ZebPay order status {status!r}")
        raw_timestamp = data.get("timestamp")
        if raw_timestamp is None:
            update_timestamp = self.current_timestamp or time.time()
        else:
            update_timestamp = float(raw_timestamp)
            if update_timestamp > 1e12:
                update_timestamp /= 1000.0
        return OrderUpdate(
            client_order_id=tracked_order.client_order_id,
            exchange_order_id=str(exchange_order_id),
            trading_pair=tracked_order.trading_pair,
            update_timestamp=update_timestamp,
            new_state=OrderState[state_name],
        )

    def _get_fee(
        self,
        base_currency: str,
        quote_currency: str,
        order_type: OrderType,
        order_side: TradeType,
        amount: Decimal,
        price: Decimal = s_decimal_NaN,
        is_maker: Optional[bool] = None,
    ) -> TradeFeeBase:
        return build_trade_fee(
            exchange=self.name,
            is_maker=order_type is OrderType.LIMIT_MAKER if is_maker is None else is_maker,
            order_side=order_side,
            order_type=order_type,
            amount=amount,
            price=price,
            base_currency=base_currency,
            quote_currency=quote_currency,
        )

    def _initialize_trading_pair_symbols_from_exchange_info(self, exchange_info: Dict[str, Any]):
        mapping = bidict()
        data = exchange_info.get("data") or {}
        for row in data.get("symbols") or []:
            if not web_utils.is_exchange_information_valid(row):
                continue
            symbol = str(row.get("symbol", ""))
            base = str(row.get("baseAsset") or "").upper()
            quote = str(row.get("quoteAsset") or "").upper()
            if symbol and base and quote:
                mapping[symbol] = f"{base}-{quote}"
        self._set_trading_pair_symbol_map(mapping)

    async def get_last_traded_prices(self, trading_pairs: List[str] = None) -> Dict[str, float]:
        if not trading_pairs:
            return {}
        response = await self._api_get(
            path_url=CONSTANTS.ALL_TICKERS_PATH_URL,
            limit_id=CONSTANTS.ALL_TICKERS_PATH_URL,
        )
        requested = set(trading_pairs)
        rows = (response.get("data") or [])
        result: dict[str, float] = {}
        for row in rows:
            symbol = str(row.get("symbol", "")).replace("/", "-")
            base = str(row.get("baseAsset") or "").upper()
            quote = str(row.get("quoteAsset") or "").upper()
            pair = f"{base}-{quote}" if base and quote else symbol
            if pair in requested:
                last = row.get("last") or row.get("close")
                if last is not None:
                    result[pair] = float(last)
        return result
