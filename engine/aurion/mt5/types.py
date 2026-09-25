from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

TIMEFRAMES: dict[str, int] = {
    "M1": 1,
    "M5": 5,
    "M15": 15,
    "M30": 30,
    "H1": 60,
    "H4": 240,
    "D1": 1440,
    "W1": 10080,
    "MN1": 43200,
}

# Official MetaTrader5 timeframe constants (safe even if the package is absent).
MT5_TF = {
    "M1": 1,
    "M5": 5,
    "M15": 15,
    "M30": 30,
    "H1": 16385,
    "H4": 16388,
    "D1": 16408,
    "W1": 32769,
    "MN1": 49153,
}


def timeframe_minutes(name: str) -> int:
    return TIMEFRAMES.get(str(name).upper(), 15)


def timeframe_mt5(name: str) -> int:
    return MT5_TF.get(str(name).upper(), 15)


def timeframe_from_minutes(minutes: int) -> str:
    invert = {v: k for k, v in TIMEFRAMES.items()}
    return invert.get(int(minutes), f"M{minutes}")


@dataclass
class Tick:
    symbol: str
    time: str
    bid: float
    ask: float
    last: float = 0.0
    volume: float = 0.0
    flags: int = 0
    time_msc: int = 0

    @property
    def mid(self) -> float:
        if self.bid and self.ask:
            return (self.bid + self.ask) / 2.0
        return self.last or self.bid or self.ask

    @property
    def spread(self) -> float:
        if self.bid and self.ask:
            return max(0.0, self.ask - self.bid)
        return 0.0

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["mid"] = self.mid
        data["spread"] = self.spread
        return data


@dataclass
class Candle:
    symbol: str
    timeframe: str
    time: str
    time_msc: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    spread: float = 0.0
    real_volume: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Position:
    ticket: int
    symbol: str
    type: str
    volume: float
    price_open: float
    price_current: float
    sl: float
    tp: float
    profit: float
    swap: float
    time: str
    magic: int
    comment: str
    identifier: int = 0
    strategy: str = ""

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        open_px = float(self.price_open or 0)
        cur_px = float(self.price_current or 0)
        if open_px > 0 and cur_px > 0:
            raw = (cur_px - open_px) / open_px * 100.0
            data["profit_pct"] = -raw if str(self.type).lower() == "sell" else raw
        else:
            data["profit_pct"] = 0.0
        if not data.get("strategy"):
            from ..runtime.store import parse_strategy_tag

            data["strategy"] = parse_strategy_tag(self.comment)
        return data


@dataclass
class PendingOrder:
    ticket: int
    symbol: str
    type: str
    volume: float
    price: float
    sl: float
    tp: float
    time: str
    magic: int
    comment: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def classify_account(
    trade_mode: int = -1,
    margin_mode: int = -1,
    server: str = "",
    company: str = "",
    name: str = "",
) -> dict[str, Any]:
    """Map MT5 ACCOUNT_TRADE_MODE / MARGIN_MODE + broker strings to a desk label.

    trade_mode: 0 demo, 1 contest, 2 real
    margin_mode: 0 netting, 1 exchange, 2 hedging
    """
    try:
        tcode = int(trade_mode)
    except (TypeError, ValueError):
        tcode = -1
    try:
        mcode = int(margin_mode)
    except (TypeError, ValueError):
        mcode = -1
    kind = {0: "demo", 1: "contest", 2: "real"}.get(tcode, "")
    blob = f"{server} {company} {name}".lower()
    if not kind:
        if any(w in blob for w in ("demo", "trial", "practice", "test")):
            kind = "demo"
        elif any(w in blob for w in ("contest",)):
            kind = "contest"
        else:
            kind = "real" if (server or company) else "unknown"
    label = kind
    prop_marks = ("ftmo", "fundingpips", "fundednext", "the5ers", "5ers", "prop firm", "challenge", "evaluation", "funded", "phase 1", "phase 2")
    if any(w in blob for w in prop_marks):
        if "funded" in blob and "challenge" not in blob and "evaluation" not in blob:
            label = "prop_funded"
        else:
            label = "prop_challenge"
    hedge = {0: "netting", 1: "exchange", 2: "hedging", 3: "fifo"}.get(mcode, "")
    return {
        "account_type": kind,
        "account_label": label,
        "margin_mode": hedge,
        "trade_mode_code": tcode,
        "margin_mode_code": mcode,
    }


@dataclass
class Account:
    login: int = 0
    name: str = ""
    server: str = ""
    currency: str = ""
    company: str = ""
    leverage: int = 0
    balance: float = 0.0
    equity: float = 0.0
    margin: float = 0.0
    margin_free: float = 0.0
    margin_level: float = 0.0
    profit: float = 0.0
    credit: float = 0.0
    trade_allowed: bool = False
    trade_expert: bool = False
    connected: bool = False
    account_type: str = ""
    account_label: str = ""
    margin_mode: str = ""
    trade_mode_code: int = -1
    margin_mode_code: int = -1

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Deal:
    ticket: int
    order: int
    symbol: str
    type: str
    volume: float
    price: float
    profit: float
    swap: float
    commission: float
    time: str
    magic: int
    comment: str
    position_id: int = 0
    entry: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ChartAgent:
    chart_id: int
    symbol: str
    timeframe: str
    ea_name: str
    version: str
    status: str = "online"
    last_seen: str = ""
    last_signal: dict[str, Any] = field(default_factory=dict)
    params: dict[str, Any] = field(default_factory=dict)
    logs: list[dict[str, Any]] = field(default_factory=list)
    performance: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        # ChartID is often wider than JS MAX_SAFE_INTEGER — keep it a string.
        data["chart_id"] = str(self.chart_id)
        params = self.params or {}
        data["tester"] = bool(params.get("tester") or str(params.get("mode") or "").lower() in {"tester", "backtest"})
        data["mode"] = "tester" if data["tester"] else "live"
        data["live"] = self.status != "offline" and bool(self.symbol)
        return data


@dataclass
class OrderRequest:
    action: str
    symbol: str
    volume: float
    order_type: str = "market"
    side: str = "buy"
    price: float = 0.0
    sl: float = 0.0
    tp: float = 0.0
    deviation: int = 20
    comment: str = "AURION"
    magic: int = 908173
    ticket: int = 0
    sl_points: float = 0.0
    tp_points: float = 0.0
    trailing_points: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
