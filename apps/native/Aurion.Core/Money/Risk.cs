// The money rules, ported from engine/aurion/runtime/risk.py.
//
// This is the third implementation of these rules - Python in the
// engine, JavaScript on the web desk, and now C#. Three copies of
// arithmetic is exactly the shape of defect that phase zero spent ten
// bugs removing, so none of it is here on trust: every rule below is
// pinned by the same JSON fixtures the other two are tested against.
//
//     tests/fixtures/symbol-identity.json
//     tests/fixtures/auto-risk-cap.json
//     tests/fixtures/ticket-entry.json
//     tests/fixtures/lot-rounding.json
//
// Adding a case to a fixture is how a rule changes, in all three
// languages at once. See Aurion.Core.Tests/FixtureTests.cs, which
// reads those files directly rather than restating them.
//
// The rounding deserves its own warning, because the three languages
// disagree by default and it is silent when they do:
//
//     Python round()   half to even
//     JS Math.round()  half up
//     C# Math.Round()  half to even
//
// risk.py says so in as many words - "C# will need the same treatment
// when the native desk lands". Hence RoundMoney below, which states
// half-up rather than inheriting whatever the runtime prefers.

using System;

namespace Aurion.Core.Money;

/// <summary>What the cap counts.</summary>
public enum MoneyScope
{
    /// <summary>The most this ticket may lose, whatever size it is sent at.</summary>
    Trade,

    /// <summary>Quoted against the reference lot, and scales with size.</summary>
    Lot,
}

public static class Risk
{
    public const double ReferenceLot = 0.01;

    /// <summary>Anything that is not a known scope is the default, not an error.</summary>
    public static MoneyScope NormaliseScope(string? scope)
        => (scope ?? "").Trim().ToLowerInvariant() == "lot" ? MoneyScope.Lot : MoneyScope.Trade;

    /// <summary>A number, or the default. Never NaN, never infinity.</summary>
    internal static double F(double value, double fallback = 0.0)
        => double.IsNaN(value) || double.IsInfinity(value) ? fallback : value;

    /// <summary>
    /// The price a market order of this side actually opens at.
    ///
    /// A buy crosses the spread and fills at the ask; a sell at the
    /// bid. 0 when the side is unknown or the quote is unusable -
    /// deliberately NOT the mid. The mid is not a price anybody trades
    /// at, and using it understated the cost of every market stop by
    /// half the spread: 15% on gold, 12% on BTC, always in the
    /// direction that looks safer than it is.
    /// </summary>
    public static double MarketEntry(string? side, double bid, double ask)
    {
        var s = (side ?? "").Trim().ToLowerInvariant();
        double b = F(bid), a = F(ask);
        if (s == "buy") return a > 0 ? a : 0.0;
        if (s == "sell") return b > 0 ? b : 0.0;
        return 0.0;
    }

    /// <summary>
    /// Round a currency amount half-UP, explicitly.
    ///
    /// Math.Round in .NET is half-to-even, which disagrees with the web
    /// desk on a cap like 2250 x 0.05% = 1.125 exactly: 1.12 against
    /// 1.13. Half-up is what a trader reading the percentage expects,
    /// so half-up is the rule, written out rather than inherited.
    ///
    /// The epsilon pulls a product that landed a hair under the half -
    /// 1.1249999999999998 for what is arithmetically 1.125 - back onto
    /// it. Without it the rule is "half-up except when binary floating
    /// point says otherwise", which nobody can reproduce.
    /// </summary>
    public static double RoundMoney(double value, int dp = 2)
    {
        var x = F(value);
        if (x == 0.0) return 0.0;
        var factor = Math.Pow(10.0, dp);
        var scaled = x * factor;
        var nudge = scaled >= 0 ? 1e-9 : -1e-9;
        return scaled >= 0
            ? Math.Floor(scaled + 0.5 + nudge) / factor
            : Math.Ceiling(scaled - 0.5 + nudge) / factor;
    }

    /// <summary>
    /// The share of the account one trade may lose, after every ceiling.
    ///
    /// The trader's own number, held between floor and ceiling, then
    /// lowered - never raised - by the prop profile's limit when one is
    /// armed. A prop rule saying 1% and a desk saying 2% is not a
    /// disagreement to average: the tighter of the two is the only one
    /// that keeps both promises.
    ///
    /// Anything unreadable reads as the floor rather than as zero,
    /// because zero here does not mean "no risk", it means "no rule".
    /// </summary>
    public static double AutoRiskPct(double typedPct, double minPct, double maxPct, double propPct = 0.0)
    {
        var pct = F(typedPct, minPct);
        pct = Math.Max(F(minPct), Math.Min(F(maxPct), pct));
        var ceiling = F(propPct);
        if (ceiling > 0) pct = Math.Min(pct, ceiling);
        return pct;
    }

    /// <summary>
    /// The automatic money cap: the percentage in force, and the cap it buys.
    ///
    /// No equity to size against is not a negative cap and not a
    /// fallback: it is zero here, and the caller decides whether to
    /// hold the last good one.
    /// </summary>
    public static (double Pct, double Cap) AutoRiskCap(
        double equity, double typedPct, double minPct, double maxPct, double propPct = 0.0)
    {
        var pct = AutoRiskPct(typedPct, minPct, maxPct, propPct);
        var eq = F(equity);
        if (!(eq > 0)) return (pct, 0.0);
        return (pct, Math.Max(0.0, RoundMoney(eq * pct / 100.0)));
    }

    /// <summary>
    /// The money this ticket is allowed to lose.
    ///
    /// Under "trade" the ticket's own size is deliberately not
    /// consulted. That is the whole promise of a per-trade cap: a field
    /// labelled "maximum loss" that multiplies by the lot behind the
    /// trader's back is a number nobody can act on, and it fails in the
    /// expensive direction, because people raise their size long before
    /// they revisit their risk settings.
    /// </summary>
    public static double RiskBudget(double maxLossPerLot, double volume, MoneyScope scope = MoneyScope.Trade)
    {
        var cap = F(maxLossPerLot);
        var vol = F(volume);
        if (cap <= 0) return 0.0;
        if (scope == MoneyScope.Trade) return cap;
        if (vol <= 0) vol = ReferenceLot;
        return cap * (vol / ReferenceLot);
    }

    /// <summary>
    /// How many decimals the broker's own volume step is written with.
    ///
    /// 0.01 -&gt; 2, 0.001 -&gt; 3, 1.0 -&gt; 0, 0.25 -&gt; 2. Capped at 8,
    /// which is far past any real volume step and keeps the search
    /// bounded.
    /// </summary>
    public static int StepDp(double step)
    {
        for (var dp = 0; dp <= 8; dp++)
        {
            var scaled = step * Math.Pow(10.0, dp);
            if (Math.Abs(scaled - Math.Round(scaled)) < 1e-9) return dp;
        }
        return 8;
    }

    /// <summary>
    /// Down to the broker's step, inside its bounds. Down, never up.
    ///
    /// "Down, never up" is a money statement, not a tidiness one. This
    /// number usually arrives from VolumeForRisk, which divides a
    /// budget by what the stop costs per lot; rounding it up spends
    /// more than the cap the trader agreed to.
    ///
    /// The final rounding exists only to clear binary dust, and its
    /// precision comes from the broker's step. Two decimals regardless
    /// of the book turned a 0.001 minimum lot into 0.0 ("no tradeable
    /// size") and turned 0.005 into 0.01, doubling a $10 budget into a
    /// $20 trade.
    /// </summary>
    public static double RoundVolume(double volume, SymbolSpec spec)
    {
        var vol = F(volume);
        var step = spec.VolumeStep > 0 ? spec.VolumeStep : 0.01;
        if (vol <= 0) return 0.0;
        var dp = StepDp(step);

        // Floor, with a millionth of a step of slack. Without it a
        // budget that divides exactly - 100 dollars of risk at 10 a lot
        // - lands on 9.999999999998 in binary and floors to 9.99, which
        // looks like an arbitrary haircut and is really a float.
        var steps = (long)(vol / step + 1e-6);
        var outv = Math.Max(0, steps) * step;

        if (spec.VolumeMax > 0 && outv > spec.VolumeMax)
        {
            // The ceiling is not necessarily on the ladder. Come down to
            // it and then back onto the nearest step at or below, or the
            // "rounded" lot is one the broker refuses.
            outv = (long)(spec.VolumeMax / step + 1e-6) * step;
        }

        // Below the broker's minimum there is no tradeable size; say
        // zero rather than quietly sending a lot it will reject.
        if (outv < spec.VolumeMin - 1e-12) return 0.0;

        // AwayFromZero, not the default half-to-even. At this point the
        // value is already a multiple of the step so a midpoint should
        // not arise - but "should not arise" is not a rounding mode,
        // and the other two languages do not round to even here.
        return Math.Round(outv, dp, MidpointRounding.AwayFromZero);
    }

    /// <summary>What a stop of this distance costs at this size.</summary>
    public static double MoneyAtRisk(string? side, double entry, double sl, double volume, SymbolSpec spec)
    {
        if (!spec.Usable) return 0.0;
        var e = F(entry);
        var s = F(sl);
        if (e <= 0 || s <= 0) return 0.0;
        return spec.Money(Math.Abs(e - s), volume);
    }

    /// <summary>
    /// The largest lot whose stop costs no more than <paramref name="riskMoney"/>.
    ///
    /// Never larger than what was requested. Position sizing may
    /// protect a trader from their own stop distance; it may not
    /// silently trade bigger than they asked for.
    /// </summary>
    public static double VolumeForRisk(
        string? side, double entry, double sl, SymbolSpec spec, double riskMoney, double requested = 0.0)
    {
        var money = F(riskMoney);
        var want = F(requested);
        var perLot = MoneyAtRisk(side, entry, sl, 1.0, spec);
        if (perLot <= 0 || money <= 0)
            return want > 0 ? RoundVolume(want, spec) : 0.0;
        var allowed = money / perLot;
        if (want > 0) allowed = Math.Min(allowed, want);
        return RoundVolume(allowed, spec);
    }
}
