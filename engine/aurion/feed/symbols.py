"""The forex symbol universe AURION knows about, independent of any broker.

Until now the only symbol table was whatever the attached MetaTrader terminal
happened to expose, so with no terminal there were no symbols at all and the
desk fell back to a hard-coded handful.  This module is the standalone
replacement: every currency pair the desk can chart, derived from a currency
table rather than typed out, plus the metals that quote like currencies.

Two things here are load-bearing and easy to get wrong:

*Pair orientation.*  EURUSD exists; USDEUR does not.  Which currency is the
base is pure market convention, and it follows a fixed precedence order
(EUR before GBP before AUD...).  `pair()` applies that order so the generated
table can never contain an inverted pair.

*Broker suffixes.*  The same pair is "EURUSD" at one broker, "EURUSD.m" at
another, "EURUSDpro", "EURUSD_raw", "EUR/USD"...  `normalise()` folds those
onto the canonical name, which is what makes a chart, a position and a
strategy all agree they are talking about the same market.
"""

from __future__ import annotations

import re

from dataclasses import dataclass, field
from typing import Any, Iterable

# --------------------------------------------------------------------------
# currencies
# --------------------------------------------------------------------------

#: The eight currencies that pair freely with each other.  Order matters: it
#: is the base/quote precedence the whole market quotes by.
MAJORS: tuple[str, ...] = ("EUR", "GBP", "AUD", "NZD", "USD", "CAD", "CHF", "JPY")

#: Everything else trades against a major rather than against each other.
#: Each entry lists the majors it is actually quoted against, most liquid
#: first; inventing crosses nobody quotes would only produce dead charts.
EXOTICS: dict[str, tuple[str, ...]] = {
    "NOK": ("USD", "EUR", "GBP", "SEK"),
    "SEK": ("USD", "EUR", "GBP", "NOK"),
    "DKK": ("USD", "EUR", "GBP"),
    "PLN": ("USD", "EUR", "GBP", "CHF"),
    "CZK": ("USD", "EUR", "GBP", "PLN"),
    "HUF": ("USD", "EUR", "GBP", "CHF"),
    "RON": ("USD", "EUR"),
    "BGN": ("USD", "EUR"),
    "ISK": ("USD", "EUR"),
    "TRY": ("USD", "EUR", "GBP", "JPY", "CHF"),
    "RUB": ("USD", "EUR"),
    "UAH": ("USD", "EUR"),
    "ZAR": ("USD", "EUR", "GBP", "JPY", "CHF", "AUD"),
    "MXN": ("USD", "EUR", "GBP", "JPY", "CAD", "CHF"),
    "BRL": ("USD", "EUR"),
    "CLP": ("USD", "EUR"),
    "COP": ("USD", "EUR"),
    "ARS": ("USD",),
    "PEN": ("USD",),
    "SGD": ("USD", "EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD"),
    "HKD": ("USD", "EUR", "GBP", "JPY", "CHF", "AUD", "CAD"),
    "CNH": ("USD", "EUR", "GBP", "JPY", "AUD", "CAD", "NZD"),
    "TWD": ("USD",),
    "KRW": ("USD", "EUR", "JPY"),
    "THB": ("USD", "EUR", "JPY"),
    "INR": ("USD", "EUR", "GBP", "JPY"),
    "IDR": ("USD",),
    "MYR": ("USD",),
    "PHP": ("USD",),
    "VND": ("USD",),
    "ILS": ("USD", "EUR", "GBP"),
    "AED": ("USD", "EUR"),
    "SAR": ("USD", "EUR"),
    "QAR": ("USD",),
    "KWD": ("USD",),
    "BHD": ("USD",),
    "OMR": ("USD",),
    "JOD": ("USD",),
    "EGP": ("USD", "EUR"),
    "MAD": ("USD", "EUR"),
    "NGN": ("USD",),
    "KES": ("USD",),
    "GHS": ("USD",),
}

#: Precious metals quote exactly like a currency pair and belong on the same
#: screen, so they live in the same table with their own `kind`.
METALS: dict[str, tuple[str, ...]] = {
    "XAU": ("USD", "EUR", "GBP", "JPY", "AUD", "CHF"),
    "XAG": ("USD", "EUR", "GBP", "AUD"),
    "XPT": ("USD",),
    "XPD": ("USD",),
}

NAMES: dict[str, str] = {
    "EUR": "Euro", "GBP": "British Pound", "AUD": "Australian Dollar",
    "NZD": "New Zealand Dollar", "USD": "US Dollar", "CAD": "Canadian Dollar",
    "CHF": "Swiss Franc", "JPY": "Japanese Yen", "SEK": "Swedish Krona",
    "NOK": "Norwegian Krone", "DKK": "Danish Krone", "PLN": "Polish Zloty",
    "CZK": "Czech Koruna", "HUF": "Hungarian Forint", "RON": "Romanian Leu",
    "BGN": "Bulgarian Lev", "ISK": "Icelandic Krona", "TRY": "Turkish Lira",
    "RUB": "Russian Ruble", "UAH": "Ukrainian Hryvnia", "ZAR": "South African Rand",
    "MXN": "Mexican Peso", "BRL": "Brazilian Real", "CLP": "Chilean Peso",
    "COP": "Colombian Peso", "ARS": "Argentine Peso", "PEN": "Peruvian Sol",
    "SGD": "Singapore Dollar", "HKD": "Hong Kong Dollar", "CNH": "Chinese Yuan (offshore)",
    "TWD": "Taiwan Dollar", "KRW": "South Korean Won", "THB": "Thai Baht",
    "INR": "Indian Rupee", "IDR": "Indonesian Rupiah", "MYR": "Malaysian Ringgit",
    "PHP": "Philippine Peso", "VND": "Vietnamese Dong", "ILS": "Israeli Shekel",
    "AED": "UAE Dirham", "SAR": "Saudi Riyal", "QAR": "Qatari Riyal",
    "KWD": "Kuwaiti Dinar", "BHD": "Bahraini Dinar", "OMR": "Omani Rial",
    "JOD": "Jordanian Dinar", "EGP": "Egyptian Pound", "MAD": "Moroccan Dirham",
    "NGN": "Nigerian Naira", "KES": "Kenyan Shilling", "GHS": "Ghanaian Cedi",
    "XAU": "Gold", "XAG": "Silver", "XPT": "Platinum", "XPD": "Palladium",
}

#: Quote currencies whose pairs are priced to 3 decimals rather than 5.  The
#: yen is the famous one; the rest are the other "big number" quotes where a
#: pip is 0.01 rather than 0.0001.
_BIG_QUOTE = {"JPY", "KRW", "IDR", "VND", "CLP", "COP", "HUF", "ISK"}


# --------------------------------------------------------------------------
# the symbol record
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Symbol:
    """One tradable instrument, in the shape the desk and the feed both want."""

    name: str
    base: str
    quote: str
    kind: str          # major | minor | exotic | metal
    digits: int
    description: str
    #: Yahoo Finance ticker.  Kept on the record rather than derived at the
    #: call site so a provider that spells a symbol differently only has to
    #: override one field.
    yahoo: str = ""

    @property
    def point(self) -> float:
        """Smallest price increment."""
        return 10.0 ** -self.digits

    @property
    def pip(self) -> float:
        """One pip. A pip is ten points on a 3- or 5-digit quote."""
        return 10.0 ** -(self.digits - 1) if self.digits in (3, 5) else self.point

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "base": self.base,
            "quote": self.quote,
            "kind": self.kind,
            "digits": self.digits,
            "point": self.point,
            "pip": self.pip,
            "description": self.description,
        }


def _digits_for(base: str, quote: str) -> int:
    if base in METALS:
        # Gold moves in dollars, silver in cents; both are quoted far coarser
        # than a currency pair.
        return 2 if base in ("XAU", "XPT", "XPD") else 3
    return 3 if quote in _BIG_QUOTE else 5


def _kind_for(base: str, quote: str) -> str:
    if base in METALS:
        return "metal"
    if base in MAJORS and quote in MAJORS:
        return "major" if "USD" in (base, quote) else "minor"
    return "exotic"


def _yahoo_for(base: str, quote: str) -> str:
    """Yahoo spells forex `EURUSD=X`, and dollar pairs as plain `TRY=X`."""
    if base == "USD":
        return f"{quote}=X"
    return f"{base}{quote}=X"


#: Base/quote precedence across every currency, strongest base first.
#:
#: Metals lead (XAUUSD, never USDXAU).  Then the majors in their conventional
#: order.  Then the exotics -- which is the subtle part: the yen is the quote
#: in every major pair, so it sits last among the majors, but it is ALSO the
#: quote against exotics (CNHJPY, ZARJPY, TRYJPY).  Leaving the exotics off
#: the end of the list made the yen outrank them and generated JPYCNH.
PRECEDENCE: tuple[str, ...] = (
    tuple(METALS)
    + tuple(c for c in MAJORS if c != "JPY")
    + tuple(EXOTICS)
    + ("JPY",)
)


def pair(a: str, b: str) -> tuple[str, str]:
    """Order two currencies into (base, quote) by market convention."""
    a, b = a.upper(), b.upper()
    ia = PRECEDENCE.index(a) if a in PRECEDENCE else len(PRECEDENCE)
    ib = PRECEDENCE.index(b) if b in PRECEDENCE else len(PRECEDENCE)
    return (a, b) if ia <= ib else (b, a)


def _build() -> dict[str, Symbol]:
    out: dict[str, Symbol] = {}

    def add(a: str, b: str) -> None:
        base, quote = pair(a, b)
        if base == quote:
            return
        name = f"{base}{quote}"
        if name in out:
            return
        out[name] = Symbol(
            name=name,
            base=base,
            quote=quote,
            kind=_kind_for(base, quote),
            digits=_digits_for(base, quote),
            description=f"{NAMES.get(base, base)} / {NAMES.get(quote, quote)}",
            yahoo=_yahoo_for(base, quote),
        )

    # every major against every other major
    for i, a in enumerate(MAJORS):
        for b in MAJORS[i + 1:]:
            add(a, b)
    for cur, against in EXOTICS.items():
        for other in against:
            add(cur, other)
    for metal, against in METALS.items():
        for other in against:
            add(metal, other)
    return dict(sorted(out.items()))


#: Every symbol AURION can chart, keyed by canonical name.
UNIVERSE: dict[str, Symbol] = _build()

ALL_CURRENCIES: tuple[str, ...] = tuple(sorted(set(MAJORS) | set(EXOTICS) | set(METALS)))

#: What a fresh install watches before the trader picks anything.
DEFAULT_WATCHLIST: tuple[str, ...] = (
    "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD", "XAUUSD",
)


# --------------------------------------------------------------------------
# lookup
# --------------------------------------------------------------------------

def normalise(raw: Any) -> str:
    """Fold a broker's spelling of a symbol onto the canonical name.

    `EUR/USD`, `eurusd.m`, `EURUSDpro`, `FX:EURUSD` and `EURUSD` are all one
    market; anything that does not resolve is returned upper-cased and
    stripped so the caller still has something printable.

    This began as a table of known suffixes (".m", ".ecn", "pro", "_raw"...).
    Mutation testing showed the whole table was dead: deleting it changed
    nothing, because stripping to letters and taking the first six already
    resolved every one of those forms.  Worse, the table could only ever
    handle decorations on the *end*, so "FX:EURUSD" and "m.EURUSD" -- both
    real broker spellings -- still failed.  A window scan over the letters
    replaces it: shorter, and it handles a prefix, a suffix or both.
    """
    s = str(raw or "").strip().upper()
    if not s:
        return ""
    if s in UNIVERSE:
        return s
    # "EUR/USD" and friends, but only when the whole string is a pair; a
    # blind strip would turn "USD_RAW" into "USDRAW".
    collapsed = re.sub(r"[^A-Z0-9]", "", s)
    if collapsed in UNIVERSE:
        return collapsed
    letters = re.sub(r"[^A-Z]", "", s)
    for i in range(len(letters) - 5):
        window = letters[i:i + 6]
        if window in UNIVERSE:
            return window
    return s


def get(raw: Any) -> Symbol | None:
    """The Symbol record for any spelling, or None if it is not forex."""
    return UNIVERSE.get(normalise(raw))


def is_known(raw: Any) -> bool:
    return normalise(raw) in UNIVERSE


def search(query: Any = "", limit: int = 50, kinds: Iterable[str] | None = None) -> list[Symbol]:
    """Rank symbols for the chart's search box.

    Ordering is by how well the query matches, not alphabetically, because a
    trader typing "eur" wants EURUSD first and EURSEK somewhere further down.
    An empty query returns the default watchlist followed by the majors.
    """
    want = {k.lower() for k in kinds} if kinds else None
    pool = [s for s in UNIVERSE.values() if not want or s.kind in want]

    q = str(query or "").strip().upper().replace("/", "").replace(" ", "")
    if not q:
        rank = {"major": 0, "minor": 1, "metal": 2, "exotic": 3}
        pool.sort(key=lambda s: (
            0 if s.name in DEFAULT_WATCHLIST else 1,
            DEFAULT_WATCHLIST.index(s.name) if s.name in DEFAULT_WATCHLIST else 0,
            rank.get(s.kind, 9),
            s.name,
        ))
        return pool[:limit]

    scored: list[tuple[tuple[int, int, str], Symbol]] = []
    for s in pool:
        name = s.name
        desc = s.description.upper()
        if name == q:
            score = 0
        elif name.startswith(q):
            score = 1
        elif s.base == q or s.quote == q:
            score = 2
        elif q in name:
            score = 3
        elif desc.startswith(q):
            score = 4
        elif q in desc:
            score = 5
        else:
            continue
        tier = {"major": 0, "minor": 1, "metal": 2, "exotic": 3}.get(s.kind, 9)
        scored.append((
            (
                0 if name == q else 1,
                # Liquidity first. "JPY" prefix-matches JPYTRY and only
                # base/quote-matches USDJPY, so match quality alone put nine
                # exotics above the pair the trader meant.
                tier,
                # The dollar leg is the one people chart, and it outranks
                # match quality: "turkish" hits TRYJPY's description one
                # character earlier than USDTRY's, which is not a reason to
                # show it first.
                0 if "USD" in (s.base, s.quote) else 1,
                score,
                0 if name in DEFAULT_WATCHLIST else 1,
                name,
            ),
            s,
        ))

    scored.sort(key=lambda row: row[0])
    return [s for _, s in scored[:limit]]


def grouped() -> dict[str, list[str]]:
    """Symbol names bucketed by kind, for a dropdown with section headers."""
    out: dict[str, list[str]] = {"major": [], "minor": [], "metal": [], "exotic": []}
    for s in UNIVERSE.values():
        out.setdefault(s.kind, []).append(s.name)
    for names in out.values():
        names.sort()
    return out
