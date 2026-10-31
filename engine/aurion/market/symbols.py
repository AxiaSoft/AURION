"""One name for an instrument, whatever a broker or a feed calls it.

The same pair reaches this engine as EURUSD, EURUSD.m, EURUSDm,
EURUSD-ECN, EUR/USD or EUR_USD depending on who is speaking. Multi-source
projects die here: a position opened on "EURUSD.m" and a candle series
keyed "EUR/USD" are the same market and must never be two rows.

Two different questions are answered separately, because conflating them
is the actual bug:

  `matches`   - are these two names the same instrument? Deliberately
                generous, and identical to the rule the MT5 bridge has
                always used, so adopting this module changes no existing
                behaviour.

  `canonical` - what is the one name AURION stores this under? Strict:
                it only rewrites a name when it can prove the first six
                characters are two real currency codes. A symbol it
                cannot parse keeps its own name rather than being
                mangled into a confident wrong answer.
"""

from __future__ import annotations

# ISO 4217 codes that appear in retail FX, plus the metals and the two
# metal-adjacent codes that behave like currencies in a pair name.
CURRENCIES: frozenset[str] = frozenset({
    "AUD", "BGN", "BRL", "CAD", "CHF", "CNH", "CNY", "CZK", "DKK", "EUR",
    "GBP", "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN",
    "MYR", "NOK", "NZD", "PHP", "PLN", "RON", "RUB", "SEK", "SGD", "THB",
    "TRY", "TWD", "USD", "ZAR",
    # Metals quote exactly like currencies: XAUUSD, XAGEUR, XPTUSD.
    "XAU", "XAG", "XPT", "XPD",
})

# The eight the market actually prices. Every other pair is, in
# practice, derived from two of these - which is what makes a complete
# cross list possible from an incomplete feed.
MAJORS: tuple[str, ...] = ("EUR", "GBP", "AUD", "NZD", "USD", "CAD", "CHF", "JPY")


def normalise(symbol: str) -> str:
    """Letters and digits only, upper case. Separators and suffixes stay."""
    return "".join(ch for ch in str(symbol or "").upper() if ch.isalnum())


def matches(a: str, b: str) -> bool:
    """Are these the same instrument?

    Prefix matching, so EURUSD matches EURUSD.m and EURUSDm. This is
    exactly MT5Bridge._sym_match: the rule is reproduced rather than
    improved, because tightening it here would silently change which
    positions and candles the desk considers related.
    """
    na, nb = normalise(a), normalise(b)
    if not na or not nb:
        return False
    return na == nb or na.startswith(nb) or nb.startswith(na)


def split_pair(symbol: str) -> tuple[str, str] | None:
    """(base, quote) when the name really is a currency pair, else None.

    Only the first six characters are considered, so a broker suffix is
    ignored, and both halves must be codes we know. "USOIL" and "US30"
    therefore return None rather than being cut into nonsense.
    """
    name = normalise(symbol)
    if len(name) < 6:
        return None
    base, quote = name[:3], name[3:6]
    if base in CURRENCIES and quote in CURRENCIES and base != quote:
        return (base, quote)
    return None


def is_forex(symbol: str) -> bool:
    """A currency pair proper - metals are quoted like one but are not one."""
    pair = split_pair(symbol)
    if not pair:
        return False
    return pair[0] not in {"XAU", "XAG", "XPT", "XPD"}


def canonical(symbol: str) -> str:
    """The name AURION stores this instrument under.

    A parsable pair collapses to its six characters, which is what makes
    EURUSD.m from one broker and EUR/USD from a feed the same row.
    Anything else is returned normalised but otherwise untouched: an
    unrecognised name is not evidence that it is a pair.
    """
    pair = split_pair(symbol)
    if pair:
        return pair[0] + pair[1]
    return normalise(symbol)


def invert(symbol: str) -> str | None:
    """GBPUSD -> USDGBP. The quote side of a synthetic cross."""
    pair = split_pair(symbol)
    if not pair:
        return None
    return pair[1] + pair[0]


def cross_legs(symbol: str, via: str = "USD") -> tuple[str, str] | None:
    """The two pairs a cross can be computed from, in `via` terms.

    EURGBP -> ("EURUSD", "GBPUSD"), meaning EURGBP = EURUSD / GBPUSD.
    Returns None for a pair that already contains `via`, or for anything
    that is not a pair at all. The caller still has to own the fact that
    a derived price carries a derived spread and is nobody's tradable
    quote - see Instrument.derived.
    """
    pair = split_pair(symbol)
    if not pair:
        return None
    base, quote = pair
    if via in (base, quote):
        return None
    return (base + via, quote + via)
