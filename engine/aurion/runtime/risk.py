"""What a stop is allowed to cost, in money.

A stop is normally written in price: "1.0840". Whether that is a small
stop or a ruinous one depends on the instrument, the lot size and the
broker's contract specification, and those three are exactly what a
trader is not thinking about at the moment a signal arrives. The result
is the complaint this module exists to answer: the stops are too wide,
every trade risks far more than intended, and nothing says so until the
loss is realised.

So risk is stated once, in the only unit that means the same thing on
every instrument: **money**. One number, "no trade may lose more than
$10", and everything else is arithmetic:

    loss(distance, volume) = distance / tick_size * tick_value * volume

That identity is the whole module. From it come the three things the
runtime needs:

  * ``cap_stop``       — pull a stop in until it costs no more than the cap
  * ``protective_stop``— invent one at exactly the cap when an order has none
  * ``volume_for_risk``— the lot size that spends a money budget on a stop

Pure arithmetic, no MetaTrader import, so it is testable without a
terminal — the same rule as runtime/stops.py, and for the same reason: a
wrong sign here does not raise, it widens somebody's risk in silence.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

__all__ = [
    "REFERENCE_LOT",
    "MONEY_SCOPES",
    "DEFAULT_SCOPE",
    "normalise_scope",
    "market_entry",
    "round_money",
    "auto_risk_pct",
    "auto_risk_cap",
    "risk_budget",
    "SymbolSpec",
    "StopCap",
    "cap_stop",
    "protective_stop",
    "volume_for_risk",
    "round_volume",
    "money_at_risk",
]


def _f(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if out == out else default  # NaN without importing math


@dataclass(frozen=True)
class SymbolSpec:
    """The part of a broker's contract specification that prices risk.

    Everything is optional because the two sources disagree about what
    they can supply: the native MetaTrader module hands over the whole
    structure, an attached EA sends what it was asked for, and a desk
    with neither has nothing. ``usable`` is the honest answer to "can
    money be computed here", and callers must respect it rather than
    guessing a tick value — a guessed tick value is a wrong stop stated
    with confidence, which is worse than no cap at all.
    """

    symbol: str = ""
    tick_size: float = 0.0
    tick_value: float = 0.0
    digits: int = 5
    volume_min: float = 0.01
    volume_step: float = 0.01
    volume_max: float = 100.0
    contract_size: float = 0.0
    currency: str = ""
    # The broker's own minimum distance for a stop, in points, and the
    # size of a point. Kept apart from tick_size because stops_level is
    # quoted in points and the two are not always the same number.
    point: float = 0.0
    stops_level: float = 0.0

    @classmethod
    def from_info(cls, info: dict[str, Any] | None, symbol: str = "") -> "SymbolSpec":
        """Read whatever the source calls these fields.

        MetaTrader's own names (``trade_tick_value``) and the plainer
        ones an EA or a test would use (``tick_value``) are both taken,
        and ``point`` stands in for a missing tick size, which is true
        for nearly every symbol and never worse than nothing.

        Both spellings of the LOSS tick value are taken too, and that
        pairing is load-bearing. A stop is a loss, so it is priced
        with SYMBOL_TRADE_TICK_VALUE_LOSS, which on metals, indices
        and anything quoted away from the account currency is not the
        profit value. Only the prefixed spelling used to be read - so
        a specification that arrived from the expert, which sends the
        plain one, fell through to the profit value instead.

        Same broker, same symbol: a hundred-tick stop on one lot cost
        100 by way of the expert and 130 by way of the MetaTrader5
        package. The trader's ten-dollar cap was really a
        thirteen-dollar cap, and nothing raised - it just widened
        somebody's risk in silence, which is the exact failure this
        module was written to prevent.
        """
        info = dict(info or {})

        def pick(*names: str, default: float = 0.0) -> float:
            for name in names:
                if name in info and info[name] not in (None, ""):
                    val = _f(info[name])
                    if val:
                        return val
            return default

        tick_size = pick("trade_tick_size", "tick_size", "point")
        tick_value = pick(
            "trade_tick_value_loss", "tick_value_loss",
            "trade_tick_value", "tick_value",
        )
        digits = int(pick("digits", default=5))
        return cls(
            symbol=str(info.get("name") or symbol or ""),
            tick_size=tick_size,
            tick_value=tick_value,
            digits=digits if digits > 0 else 5,
            volume_min=pick("volume_min", "min_lot", default=0.01),
            volume_step=pick("volume_step", "lot_step", default=0.01),
            volume_max=pick("volume_max", "max_lot", default=100.0),
            contract_size=pick("trade_contract_size", "contract_size"),
            currency=str(info.get("currency_profit") or info.get("currency") or ""),
            point=pick("point", "trade_tick_size", "tick_size"),
            stops_level=pick("trade_stops_level", "stops_level"),
        )

    @property
    def usable(self) -> bool:
        """True when a price distance can be turned into money."""
        return self.tick_size > 0 and self.tick_value > 0

    @property
    def min_stop_distance(self) -> float:
        """Closest to the market the broker will accept a stop, in price.

        SYMBOL_TRADE_STOPS_LEVEL, converted from points. A stop inside
        it is not a tight stop - it is TRADE_RETCODE_INVALID_STOPS, the
        whole order refused, which the trader meets as an opaque
        rejection with no stop and no position.

        The expert has been sending this number since the spec message
        was written and nothing read it. The one floor that was being
        enforced was the live spread, which is a different and usually
        smaller number: a broker quoting EURUSD at 0.2 points of spread
        can still demand 20 points of stop distance.

        0 when the broker does not restrict it, which is common on ECN
        books and means exactly what it says.
        """
        step = self.point if self.point > 0 else self.tick_size
        return max(0.0, self.stops_level * step)

    def money(self, distance: float, volume: float = 1.0) -> float:
        """What ``distance`` price units cost at ``volume`` lots."""
        distance = abs(_f(distance))
        if not self.usable or distance <= 0:
            return 0.0
        return distance / self.tick_size * self.tick_value * max(0.0, _f(volume))

    def distance_for(self, money: float, volume: float = 1.0) -> float:
        """The price distance that costs ``money`` at ``volume`` lots."""
        money = abs(_f(money))
        volume = max(0.0, _f(volume))
        if not self.usable or money <= 0 or volume <= 0:
            return 0.0
        return money / (self.tick_value * volume) * self.tick_size

    def round_price(self, price: float) -> float:
        return round(_f(price), max(0, int(self.digits)))

    def floor_to_tick(self, distance: float) -> float:
        """A distance truncated to whole ticks, so money never rounds up."""
        distance = abs(_f(distance))
        if self.tick_size <= 0:
            return distance
        ticks = int(distance / self.tick_size)
        return ticks * self.tick_size


def money_at_risk(side: str, entry: float, sl: float, volume: float, spec: SymbolSpec) -> float:
    """What this ticket loses if the stop is hit. 0 when it cannot be said."""
    entry, sl = _f(entry), _f(sl)
    if not spec.usable or entry <= 0 or sl <= 0:
        return 0.0
    side = str(side or "").lower()
    distance = entry - sl if side == "buy" else sl - entry
    if distance <= 0:
        # A stop on the wrong side of the entry is not a risk of this
        # size, it is a broken ticket. Someone else's job to refuse it.
        return 0.0
    return spec.money(distance, volume)


@dataclass
class StopCap:
    """The stop after the money rule has had its say."""

    sl: float
    distance: float
    money: float
    capped: bool
    reason: str = ""

    @property
    def money_per_lot(self) -> float:
        """Deprecated name for :attr:`money`.

        It was never the money per lot - it has always been the cost of
        this stop at the volume it was asked about - and reading it as
        "per lot" is how a journal line came to say "one lot risks
        100.00" about a 0.10-lot ticket. Kept so nothing breaks while
        the callers move over.
        """
        return self.money

    def __bool__(self) -> bool:  # pragma: no cover - convenience only
        return self.sl > 0


# The lot the money cap is quoted against.
#
# "Max loss per lot = 10" has to mean something specific before a stop
# can be placed from it, and the only reading that matches how the
# number is used is "ten dollars for one micro lot". Quoting it against
# a full 1.0 lot instead produced a stop a hundred times tighter than
# the trader's own risk budget on a 0.01-lot ticket - minutes of noise
# rather than the move being traded - and, because the distance was
# then fixed, raising the lot did not raise the risk, it just made the
# same tiny stop cost more.
#
# Quoting against 0.01 gives both halves of what that setting promised:
# a 0.01-lot ticket risks the cap, and doubling the lot doubles the
# money at risk over the same, instrument-appropriate distance.
#
# It is now only used by the "lot" scope below. The default scope reads
# the cap as a per-TRADE number and never consults this constant, which
# is why a 0.10-lot ticket no longer silently costs ten times the cap.
REFERENCE_LOT = 0.01


# What the cap counts.
#
# "trade" - the number is the most this ticket may lose, whatever size
#           it is sent at. Set 10 and no single trade loses more than
#           10, at 0.01 lots or at 1.00.
# "lot"   - the number is quoted against REFERENCE_LOT and scales with
#           the size: 10 on a 0.10-lot ticket is 100.
#
# "trade" is the default and the reading everybody means by "maximum
# loss". "lot" is the older behaviour, kept because it is the right
# tool for someone who varies size deliberately and wants the risk to
# vary with it, and because silently reinterpreting a number somebody
# already has saved is how a setting becomes untrustworthy.
MONEY_SCOPES = ("trade", "lot")
DEFAULT_SCOPE = "trade"


def normalise_scope(scope: Any) -> str:
    """Anything that is not a known scope is the default, not an error."""
    text = str(scope or "").strip().lower()
    return text if text in MONEY_SCOPES else DEFAULT_SCOPE


def market_entry(side: Any, bid: Any, ask: Any) -> float:
    """The price a market order of this side actually opens at.

    A buy crosses the spread and fills at the ask; a sell fills at the
    bid. 0.0 when the side is unknown or the quote is not usable.

    Trivial arithmetic, written out because the number it produces is
    what every stop on the ticket is measured from. The desk used to
    measure from the mid instead, which is not a price anybody trades
    at: it understated the cost of a stop by half the spread, on both
    sides, always in the direction that looks safer than it is.

        XAUUSD, 0.30 spread, 100-tick stop, 1 lot
            desk said  85.00      engine computes  100.00    -15%
        BTCUSD, 12.00 spread, 5000-tick stop, 1 lot
            desk said  44.00      engine computes   50.00    -12%

    That gap is not cosmetic. A trader working to a 100 cap sets a stop
    the desk prices at 100, the engine prices the same stop at 118 and
    pulls it in to fit - so the stop that gets sent is not the stop that
    was agreed to, and nothing on screen said why.

    Pinned from both languages by tests/fixtures/ticket-entry.json.
    """
    s = str(side or "").strip().lower()
    b, a = _f(bid), _f(ask)
    if s == "buy":
        return a if a > 0 else 0.0
    if s == "sell":
        return b if b > 0 else 0.0
    return 0.0


def round_money(value: float, dp: int = 2) -> float:
    """Round a currency amount half-UP, explicitly.

    Not an implementation detail: the desk previews the same cap the
    engine computes, so the rounding has to be part of the rule rather
    than inherited from whichever language is evaluating it. Python's
    round() is half-to-even and JavaScript's Math.round() is half-up,
    and they disagree on a cap like 2250 x 0.05% = 1.125 exactly - 1.12
    against 1.13. Half-up is what a trader reading the percentage
    expects, so half-up is the rule, written out here once.

    C# will need the same treatment when the native desk lands:
    Math.Round is half-to-even there too.
    """
    x = _f(value)
    if x == 0.0:
        return 0.0
    factor = 10.0 ** dp
    scaled = x * factor
    # The epsilon pulls a product that landed a hair under the half -
    # 1.1249999999999998 for what is arithmetically 1.125 - back onto
    # it. Without it the rule is "half-up except when binary floating
    # point says otherwise", which is not a rule anybody can reproduce.
    nudge = 1e-9 if scaled >= 0 else -1e-9
    import math

    return math.floor(scaled + 0.5 + nudge) / factor if scaled >= 0 \
        else math.ceil(scaled - 0.5 + nudge) / factor


def auto_risk_pct(typed_pct: Any, min_pct: float, max_pct: float,
                  prop_pct: Any = 0.0) -> float:
    """The share of the account one trade may lose, after every ceiling.

    The trader's own number, held between the floor and the ceiling, and
    then lowered - never raised - by the prop profile's limit when one is
    armed. A prop rule that says 1% and a desk that says 2% is not a
    disagreement to average out: the tighter of the two is the only one
    that keeps both promises.

    Anything unreadable reads as the floor rather than as zero, because
    zero here does not mean "no risk", it means "no rule".
    """
    pct = _f(typed_pct, default=min_pct)
    pct = max(_f(min_pct), min(_f(max_pct), pct))
    ceiling = _f(prop_pct)
    if ceiling > 0:
        pct = min(pct, ceiling)
    return pct


def auto_risk_cap(equity: Any, typed_pct: Any, min_pct: float, max_pct: float,
                  prop_pct: Any = 0.0) -> tuple[float, float]:
    """The automatic money cap: ``(percentage in force, cap in currency)``.

    One rule, evaluated in two languages. The engine applies it to size
    and stop-cap every ticket; the desk draws a preview of it while the
    trader is still typing. Those two must agree, so the arithmetic lives
    here and the engine publishes this function's *inputs* - the floor,
    the ceiling and the prop ceiling - for the desk to run it over.

    It used to be reproduced on the desk from ``risk_pct_effective``, the
    already-resolved answer for the *saved* percentage, used as though it
    were a ceiling on the percentage being typed. It is not a ceiling, it
    is an answer, so the preview sat frozen at the saved value: 1% saved
    on a 10,000 account previewed a 100 cap no matter what was typed,
    while the engine would go on to apply 300 for 3%.

    The shared cases are in tests/fixtures/auto-risk-cap.json and are run
    from both sides. Adding a case there is how this rule changes.
    """
    pct = auto_risk_pct(typed_pct, min_pct, max_pct, prop_pct)
    eq = _f(equity)
    if not eq > 0:
        # No equity to size against is not a negative cap and not a
        # fallback: it is zero here, and the caller decides whether to
        # hold the last good one. See Trader._cap.
        return pct, 0.0
    return pct, max(0.0, round_money(eq * pct / 100.0))


def risk_budget(max_loss_per_lot: float, volume: float,
                scope: str = DEFAULT_SCOPE) -> float:
    """The money this ticket is allowed to lose.

    Reported from the desk: a manual trade was given a stop costing
    $100 when the setting said 10. Both numbers were right - the cap
    was being read per 0.01 lot and the ticket was 0.10 - and that is
    the defect. A field labelled "maximum loss" that multiplies by the
    lot behind the trader's back is a number nobody can act on, and the
    way it fails is always the expensive direction, because people
    raise their size long before they revisit their risk settings.
    """
    cap = _f(max_loss_per_lot)
    volume = _f(volume)
    if cap <= 0:
        return 0.0
    if normalise_scope(scope) == "trade":
        # The ticket's own size is deliberately not consulted. That is
        # the whole promise of a per-trade cap.
        return cap
    if volume <= 0:
        volume = REFERENCE_LOT
    return cap * (volume / REFERENCE_LOT)


def protective_stop(
    side: str,
    entry: float,
    spec: SymbolSpec,
    max_loss_per_lot: float,
    volume: float = REFERENCE_LOT,
    scope: str = DEFAULT_SCOPE,
) -> float:
    """A stop at exactly the cap, for an order that arrived without one.

    An entry with no stop is not a small risk, it is an unbounded one,
    and the cap is the only number in the system that knows how far is
    too far. Returns 0 when it cannot be computed, and the caller must
    then refuse to improvise.

    It also returns 0 when the cap would place the stop closer than the
    broker accepts (SYMBOL_TRADE_STOPS_LEVEL). That is not a stop the
    trader can have: sending it gets the whole order refused, with no
    stop and no position, which is a worse outcome than being told the
    cap and the instrument do not fit each other.
    """
    entry = _f(entry)
    cap = _f(max_loss_per_lot)
    side = str(side or "").lower()
    if not spec.usable or entry <= 0 or cap <= 0 or side not in {"buy", "sell"}:
        return 0.0
    volume = _f(volume) or REFERENCE_LOT
    budget = risk_budget(cap, volume, scope)
    distance = spec.floor_to_tick(spec.distance_for(budget, volume))
    if distance <= 0:
        return 0.0
    if distance < spec.min_stop_distance:
        return 0.0
    return spec.round_price(entry - distance if side == "buy" else entry + distance)


def cap_stop(
    side: str,
    entry: float,
    sl: float,
    spec: SymbolSpec,
    max_loss_per_lot: float,
    volume: float = REFERENCE_LOT,
    scope: str = DEFAULT_SCOPE,
) -> StopCap | None:
    """Pull ``sl`` in until one lot cannot lose more than the cap.

    Only ever *inwards*. A stop that already costs less than the cap is
    returned untouched: this rule is a ceiling on risk, not an opinion
    about where the stop belongs, and widening somebody's stop to "use
    up" the allowance would be the opposite of what it is for.

    Returns None when the question cannot be answered — no spec, no cap,
    no entry — so the caller can say so instead of pretending, and also
    when the cap is tighter than the broker's own minimum stop distance.
    Tightening past SYMBOL_TRADE_STOPS_LEVEL does not produce a cheap
    stop, it produces TRADE_RETCODE_INVALID_STOPS and no trade at all;
    that conflict belongs to the caller to explain, not to this function
    to paper over.
    """
    entry, sl = _f(entry), _f(sl)
    cap = _f(max_loss_per_lot)
    side = str(side or "").lower()
    if not spec.usable or cap <= 0 or entry <= 0 or side not in {"buy", "sell"}:
        return None

    volume = _f(volume) or REFERENCE_LOT
    budget = risk_budget(cap, volume, scope)
    limit = spec.floor_to_tick(spec.distance_for(budget, volume))
    if limit <= 0:
        return None
    # The cap buys this much distance; the broker will not accept less
    # than that. When the two disagree there is no legal stop at this
    # cap, and saying so is the only honest answer.
    if limit < spec.min_stop_distance:
        return None

    if sl <= 0:
        placed = protective_stop(side, entry, spec, cap, volume, scope)
        if placed <= 0:
            return None
        return StopCap(placed, limit, spec.money(limit, volume), True, "no stop was attached")

    distance = entry - sl if side == "buy" else sl - entry
    if distance <= 0:
        # Wrong side of the entry: replace it rather than "cap" it, since
        # the ticket as written protects nothing at all.
        placed = protective_stop(side, entry, spec, cap, volume, scope)
        if placed <= 0:
            return None
        return StopCap(placed, limit, spec.money(limit, volume), True,
                       "the stop was on the wrong side of the entry")

    if distance <= limit:
        return StopCap(spec.round_price(sl), distance, spec.money(distance, volume), False, "")

    tightened = spec.round_price(entry - limit if side == "buy" else entry + limit)
    return StopCap(
        tightened,
        limit,
        spec.money(limit, volume),
        True,
        f"stop risked {spec.money(distance, volume):.2f} at {volume:g} lots, "
        f"capped at {budget:.2f}",
    )


def _step_dp(step: float) -> int:
    """How many decimals the broker's own volume step is written with.

    0.01 -> 2, 0.001 -> 3, 1.0 -> 0, 0.25 -> 2. Capped at 8, which is
    far past any real volume step and keeps the search bounded.
    """
    for dp in range(0, 9):
        scaled = step * (10.0 ** dp)
        if abs(scaled - round(scaled)) < 1e-9:
            return dp
    return 8


def round_volume(volume: float, spec: SymbolSpec) -> float:
    """Down to the broker's step, inside its bounds. Down, never up.

    "Down, never up" is a money statement, not a tidiness one. This
    number usually arrives from volume_for_risk, which divides a budget
    by what the stop costs per lot; rounding it up spends more than the
    cap the trader agreed to.

    The final rounding exists only to clear binary dust, and its
    precision has to come from the broker's step. It used to be
    round(out, 2) - two decimals, whatever the broker said - which on a
    book quoting 0.001 lots turned the broker's own minimum lot into
    0.0 ("no tradeable size") and turned 0.005 into 0.01, doubling a
    $10 budget into a $20 trade. Pinned by
    tests/fixtures/lot-rounding.json.
    """
    volume = _f(volume)
    step = spec.volume_step if spec.volume_step > 0 else 0.01
    if volume <= 0:
        return 0.0
    dp = _step_dp(step)
    # Floor, with a millionth of a step of slack. Without the slack a
    # budget that divides exactly — 100 dollars of risk at 10 dollars a
    # lot — lands on 9.999999999998 in binary and is floored to 9.99,
    # which looks like an arbitrary haircut and is really a float.
    steps = int(volume / step + 1e-6)
    out = max(0, steps) * step
    if spec.volume_max > 0 and out > spec.volume_max:
        # The ceiling is not necessarily on the ladder. Come down to the
        # ceiling and then back onto the nearest step at or below it, or
        # the "rounded" lot is one the broker refuses.
        out = int(spec.volume_max / step + 1e-6) * step
    # Below the broker's minimum there is no tradeable size; say zero
    # rather than quietly sending a lot the broker will reject.
    if out < spec.volume_min - 1e-12:
        return 0.0
    return round(out, dp)


def volume_for_risk(
    side: str,
    entry: float,
    sl: float,
    spec: SymbolSpec,
    risk_money: float,
    requested: float = 0.0,
) -> float:
    """The largest lot whose stop costs no more than ``risk_money``.

    Never larger than ``requested`` when one is given: position sizing
    may protect a trader from their own stop distance, but it may not
    silently trade bigger than they asked for.
    """
    risk_money = _f(risk_money)
    requested = _f(requested)
    per_lot = money_at_risk(side, entry, sl, 1.0, spec)
    if per_lot <= 0 or risk_money <= 0:
        return round_volume(requested, spec) if requested > 0 else 0.0
    allowed = risk_money / per_lot
    if requested > 0:
        allowed = min(allowed, requested)
    return round_volume(allowed, spec)
