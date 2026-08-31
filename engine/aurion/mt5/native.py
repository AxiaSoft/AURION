"""Optional official MetaTrader5 package adapter (Windows / Wine).

Importing this module must never crash on Linux. All calls fail closed:
they return empty structures instead of inventing prices.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .types import (
    Account,
    Candle,
    Deal,
    PendingOrder,
    Position,
    Tick,
    classify_account,
    timeframe_from_minutes,
    timeframe_mt5,
)

try:
    import MetaTrader5 as mt5  # type: ignore

    AVAILABLE = True
except Exception:  # pragma: no cover - package is Windows-only
    mt5 = None  # type: ignore
    AVAILABLE = False


def _iso(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, (int, float)) and value > 10_000_000_000:
        return datetime.fromtimestamp(value / 1000.0, tz=timezone.utc).isoformat()
    if isinstance(value, (int, float)) and value > 1_000_000_000:
        return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
    return str(value)


def _side(code: int, kind: str = "position") -> str:
    if kind == "position":
        return "buy" if code == 0 else "sell"
    mapping = {
        0: "buy",
        1: "sell",
        2: "buy_limit",
        3: "sell_limit",
        4: "buy_stop",
        5: "sell_stop",
        6: "buy_stop_limit",
        7: "sell_stop_limit",
    }
    return mapping.get(int(code), str(code))


class NativeMT5:
    def __init__(self) -> None:
        self.connected = False
        self.last_error: tuple[int, str] = (0, "")

    def initialize(
        self,
        path: str = "",
        login: int = 0,
        password: str = "",
        server: str = "",
        timeout: int = 10000,
        portable: bool = False,
    ) -> tuple[bool, str]:
        if not AVAILABLE:
            return False, "MetaTrader5 Python package is not installed (Windows only)."
        kwargs: dict[str, Any] = {"timeout": timeout}
        if path:
            kwargs["path"] = path
        if portable:
            kwargs["portable"] = True
        ok = bool(mt5.initialize(**kwargs))
        if not ok:
            self.last_error = mt5.last_error()
            return False, f"initialize failed: {self.last_error}"
        if login:
            authorized = bool(mt5.login(int(login), password=password, server=server))
            if not authorized:
                self.last_error = mt5.last_error()
                mt5.shutdown()
                self.connected = False
                return False, f"login failed: {self.last_error}"
        self.connected = True
        return True, "connected"

    def shutdown(self) -> None:
        if AVAILABLE and self.connected:
            try:
                mt5.shutdown()
            except Exception:
                pass
        self.connected = False

    def terminal_info(self) -> dict[str, Any]:
        if not AVAILABLE or not self.connected:
            return {}
        info = mt5.terminal_info()
        return info._asdict() if info else {}

    def account(self) -> Account:
        empty = Account()
        if not AVAILABLE or not self.connected:
            return empty
        info = mt5.account_info()
        if info is None:
            return empty
        d = info._asdict()
        kind = classify_account(
            trade_mode=int(d.get("trade_mode") if d.get("trade_mode") is not None else -1),
            margin_mode=int(d.get("margin_mode") if d.get("margin_mode") is not None else -1),
            server=str(d.get("server") or ""),
            company=str(d.get("company") or ""),
            name=str(d.get("name") or ""),
        )
        return Account(
            login=int(d.get("login") or 0),
            name=str(d.get("name") or ""),
            server=str(d.get("server") or ""),
            currency=str(d.get("currency") or ""),
            company=str(d.get("company") or ""),
            leverage=int(d.get("leverage") or 0),
            balance=float(d.get("balance") or 0),
            equity=float(d.get("equity") or 0),
            margin=float(d.get("margin") or 0),
            margin_free=float(d.get("margin_free") or 0),
            margin_level=float(d.get("margin_level") or 0),
            profit=float(d.get("profit") or 0),
            credit=float(d.get("credit") or 0),
            trade_allowed=bool(d.get("trade_allowed")),
            trade_expert=bool(d.get("trade_expert")),
            connected=True,
            account_type=str(kind["account_type"]),
            account_label=str(kind["account_label"]),
            margin_mode=str(kind["margin_mode"]),
            trade_mode_code=int(kind["trade_mode_code"]),
            margin_mode_code=int(kind["margin_mode_code"]),
        )

    def symbols(self) -> list[str]:
        if not AVAILABLE or not self.connected:
            return []
        selected = mt5.symbols_get()
        if not selected:
            return []
        return [s.name for s in selected if getattr(s, "visible", True) or getattr(s, "select", False)]

    def ensure_symbol(self, symbol: str) -> bool:
        if not AVAILABLE or not self.connected:
            return False
        info = mt5.symbol_info(symbol)
        if info is None:
            return False
        if not info.visible:
            return bool(mt5.symbol_select(symbol, True))
        return True

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        if not AVAILABLE or not self.connected:
            return {}
        info = mt5.symbol_info(symbol)
        return info._asdict() if info else {}

    def tick(self, symbol: str) -> Tick | None:
        if not AVAILABLE or not self.connected:
            return None
        raw = mt5.symbol_info_tick(symbol)
        if raw is None:
            return None
        return Tick(
            symbol=symbol,
            time=_iso(getattr(raw, "time", None)),
            bid=float(raw.bid),
            ask=float(raw.ask),
            last=float(getattr(raw, "last", 0) or 0),
            volume=float(getattr(raw, "volume", 0) or 0),
            flags=int(getattr(raw, "flags", 0) or 0),
            time_msc=int(getattr(raw, "time_msc", 0) or 0),
        )

    def candles(self, symbol: str, timeframe: str, count: int) -> list[Candle]:
        if not AVAILABLE or not self.connected:
            return []
        rates = mt5.copy_rates_from_pos(symbol, timeframe_mt5(timeframe), 0, int(count))
        if rates is None:
            return []
        out: list[Candle] = []
        for row in rates:
            t = int(row["time"])
            out.append(
                Candle(
                    symbol=symbol,
                    timeframe=timeframe,
                    time=datetime.fromtimestamp(t, tz=timezone.utc).isoformat(),
                    time_msc=t * 1000,
                    open=float(row["open"]),
                    high=float(row["high"]),
                    low=float(row["low"]),
                    close=float(row["close"]),
                    volume=float(row["tick_volume"]),
                    spread=float(row["spread"]) if "spread" in row.dtype.names else 0.0,
                    real_volume=float(row["real_volume"]) if "real_volume" in row.dtype.names else 0.0,
                )
            )
        return out

    def positions(self) -> list[Position]:
        if not AVAILABLE or not self.connected:
            return []
        rows = mt5.positions_get()
        if not rows:
            return []
        out: list[Position] = []
        for row in rows:
            d = row._asdict()
            out.append(
                Position(
                    ticket=int(d["ticket"]),
                    symbol=str(d["symbol"]),
                    type=_side(int(d["type"])),
                    volume=float(d["volume"]),
                    price_open=float(d["price_open"]),
                    price_current=float(d["price_current"]),
                    sl=float(d["sl"]),
                    tp=float(d["tp"]),
                    profit=float(d["profit"]),
                    swap=float(d["swap"]),
                    time=_iso(d.get("time")),
                    magic=int(d.get("magic") or 0),
                    comment=str(d.get("comment") or ""),
                    identifier=int(d.get("identifier") or 0),
                )
            )
        return out

    def orders(self) -> list[PendingOrder]:
        if not AVAILABLE or not self.connected:
            return []
        rows = mt5.orders_get()
        if not rows:
            return []
        out: list[PendingOrder] = []
        for row in rows:
            d = row._asdict()
            out.append(
                PendingOrder(
                    ticket=int(d["ticket"]),
                    symbol=str(d["symbol"]),
                    type=_side(int(d["type"]), "order"),
                    volume=float(d["volume_current"] if d.get("volume_current") else d.get("volume_initial") or 0),
                    price=float(d.get("price_open") or 0),
                    sl=float(d.get("sl") or 0),
                    tp=float(d.get("tp") or 0),
                    time=_iso(d.get("time_setup")),
                    magic=int(d.get("magic") or 0),
                    comment=str(d.get("comment") or ""),
                )
            )
        return out

    def deals(self, date_from: datetime, date_to: datetime) -> list[Deal]:
        if not AVAILABLE or not self.connected:
            return []
        rows = mt5.history_deals_get(date_from, date_to)
        if not rows:
            return []
        out: list[Deal] = []
        for row in rows:
            d = row._asdict()
            dtype = int(d.get("type") or 0)
            entry = int(d.get("entry") or 0)
            out.append(
                Deal(
                    ticket=int(d["ticket"]),
                    order=int(d.get("order") or 0),
                    symbol=str(d.get("symbol") or ""),
                    type=_side(dtype),
                    volume=float(d.get("volume") or 0),
                    price=float(d.get("price") or 0),
                    profit=float(d.get("profit") or 0),
                    swap=float(d.get("swap") or 0),
                    commission=float(d.get("commission") or 0),
                    time=_iso(d.get("time")),
                    magic=int(d.get("magic") or 0),
                    comment=str(d.get("comment") or ""),
                    position_id=int(d.get("position_id") or 0),
                    entry="in" if entry == 0 else "out" if entry == 1 else "inout",
                )
            )
        return out

    def send_order(self, request: dict[str, Any]) -> dict[str, Any]:
        if not AVAILABLE or not self.connected:
            return {"ok": False, "error": "native MT5 is not connected"}
        result = mt5.order_send(request)
        if result is None:
            return {"ok": False, "error": str(mt5.last_error())}
        data = result._asdict() if hasattr(result, "_asdict") else dict(result)
        retcode = int(data.get("retcode") or 0)
        deal = int(data.get("deal") or 0)
        order = int(data.get("order") or 0)
        comment = str(data.get("comment") or "")
        # Official codes: 10008 placed, 10009 done, 10010 done_partial.
        # retcode 0 is only a fill when the broker also returns a deal/order or "done".
        comment_l = comment.lower()
        ok = retcode in (10008, 10009, 10010) or deal > 0
        if retcode == 0 and (deal > 0 or order > 0 or comment_l in {"done", "placed"}):
            ok = True
        if comment_l == "done" and deal > 0:
            ok = True
        return {
            "ok": ok,
            "retcode": retcode,
            "deal": deal,
            "order": order,
            "volume": data.get("volume"),
            "price": data.get("price"),
            "comment": comment,
            "detail": f"deal={deal} order={order} {comment}".strip(),
            "request_id": data.get("request_id"),
            "raw": {k: v for k, v in data.items() if k != "request"},
        }

    def last_error(self) -> tuple[int, str]:
        if not AVAILABLE:
            return (-1, "package missing")
        return mt5.last_error()


# Re-export helper used by backtester comments
def native_timeframe_name(code: int) -> str:
    invert = {1: "M1", 5: "M5", 15: "M15", 30: "M30", 16385: "H1", 16388: "H4", 16408: "D1"}
    return invert.get(int(code), timeframe_from_minutes(int(code)))
