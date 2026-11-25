// The money rules, answering to the same fixtures as the other two.
//
// These files are not copies and they are not written for C#. They are
// tests/fixtures/*.json - the exact files engine/tests/*.py and
// tests/*-agrees.test.cjs read. Adding a case to one of them changes
// the rule in all three languages at once, and any implementation that
// disagrees fails here by name.
//
// That is what makes this port checkable without a human reading it.
// A failure prints the fixture's own "why" line, so the output says
// which RULE broke rather than which line number.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using Aurion.Core.Money;
using Xunit;

namespace Aurion.Core.Tests;

public static class Fixtures
{
    /// <summary>
    /// Walk up to the repository root and read a fixture.
    ///
    /// By walking rather than by a relative path with four parent
    /// steps in it: the test binary's depth changes with the
    /// configuration and the target framework, and a path that is
    /// right for Debug/net8.0 is wrong the first time anyone publishes.
    /// </summary>
    public static JsonNode Load(string name)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "package.json")))
            dir = dir.Parent;
        if (dir is null)
            throw new InvalidOperationException("could not find the repository root");
        var path = Path.Combine(dir.FullName, "tests", "fixtures", name);
        return JsonNode.Parse(File.ReadAllText(path))
               ?? throw new InvalidDataException(name + " is empty");
    }

    public static string Root()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "package.json")))
            dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("no repository root");
    }

    public static double Num(JsonNode? n, double fallback = 0)
        => n is null ? fallback : n.GetValue<double>();

    public static string Str(JsonNode? n, string fallback = "")
        => n is null ? fallback : n.ToString();
}

public class MarketEntryFixture
{
    public static TheoryData<string, string, double, double, double> Cases()
    {
        var data = new TheoryData<string, string, double, double, double>();
        foreach (var c in Fixtures.Load("ticket-entry.json")["market"]!.AsArray())
            data.Add(Fixtures.Str(c!["why"]), Fixtures.Str(c["side"]),
                     Fixtures.Num(c["bid"]), Fixtures.Num(c["ask"]), Fixtures.Num(c["entry"]));
        return data;
    }

    [Theory, MemberData(nameof(Cases))]
    public void A_market_ticket_opens_where_the_engine_says_it_does(
        string why, string side, double bid, double ask, double expected)
    {
        Assert.True(Math.Abs(Risk.MarketEntry(side, bid, ask) - expected) < 1e-9,
            $"{why}: expected {expected}, got {Risk.MarketEntry(side, bid, ask)}");
    }
}

public class AutoRiskCapFixture
{
    public static TheoryData<string, double, double, double, double, double, double, double> Cases()
    {
        var root = Fixtures.Load("auto-risk-cap.json");
        // The floor and ceiling travel WITH each case rather than in a
        // static set by whichever method xunit happened to call first.
        // They are part of the rule, not ambient state.
        var min = Fixtures.Num(root["defaults"]!["risk_pct_min"], 0.05);
        var max = Fixtures.Num(root["defaults"]!["risk_pct_max"], 10.0);
        var data = new TheoryData<string, double, double, double, double, double, double, double>();
        foreach (var c in root["cases"]!.AsArray())
            data.Add(Fixtures.Str(c!["why"]), Fixtures.Num(c["equity"]), Fixtures.Num(c["typed"]),
                     Fixtures.Num(c["prop"]), min, max,
                     Fixtures.Num(c["pct"]), Fixtures.Num(c["cap"]));
        return data;
    }

    [Theory, MemberData(nameof(Cases))]
    public void The_automatic_cap_is_one_rule_in_three_languages(
        string why, double equity, double typed, double prop,
        double minPct, double maxPct, double expectPct, double expectCap)
    {
        var (pct, cap) = Risk.AutoRiskCap(equity, typed, minPct, maxPct, prop);
        Assert.True(Math.Abs(pct - expectPct) < 1e-9, $"{why}: pct expected {expectPct}, got {pct}");
        Assert.True(Math.Abs(cap - expectCap) < 1e-9, $"{why}: cap expected {expectCap}, got {cap}");
    }
}

public class LotRoundingFixture
{
    public static TheoryData<string, double, double, double, double, double> Cases()
    {
        var data = new TheoryData<string, double, double, double, double, double>();
        foreach (var c in Fixtures.Load("lot-rounding.json")["cases"]!.AsArray())
            data.Add(Fixtures.Str(c!["why"]), Fixtures.Num(c["step"]), Fixtures.Num(c["min"]),
                     Fixtures.Num(c["max"]), Fixtures.Num(c["want"]), Fixtures.Num(c["lot"]));
        return data;
    }

    [Theory, MemberData(nameof(Cases))]
    public void A_lot_is_fitted_to_the_brokers_own_ladder(
        string why, double step, double min, double max, double want, double expected)
    {
        var spec = SymbolSpec.FromInfo(new Dictionary<string, double>
        {
            ["tick_size"] = 0.00001, ["tick_value"] = 1.0,
            ["volume_step"] = step, ["volume_min"] = min, ["volume_max"] = max,
        });
        var got = Risk.RoundVolume(want, spec);
        Assert.True(Math.Abs(got - expected) < 1e-9, $"{why}: expected {expected}, got {got}");
    }
}

public class SymbolIdentityFixture
{
    public static TheoryData<string, string> Same()
    {
        var data = new TheoryData<string, string>();
        foreach (var pair in Fixtures.Load("symbol-identity.json")["same"]!.AsArray())
            data.Add(pair![0]!.ToString(), pair[1]!.ToString());
        return data;
    }

    public static TheoryData<string, string> Different()
    {
        var data = new TheoryData<string, string>();
        foreach (var pair in Fixtures.Load("symbol-identity.json")["different"]!.AsArray())
            data.Add(pair![0]!.ToString(), pair[1]!.ToString());
        return data;
    }

    [Theory, MemberData(nameof(Same))]
    public void Two_spellings_of_one_instrument_agree(string a, string b)
        => Assert.True(SymbolIdentity.Same(a, b),
            $"{a} and {b} are the same instrument, but the key said " +
            $"{SymbolIdentity.SeriesKey(a)} vs {SymbolIdentity.SeriesKey(b)}");

    [Theory, MemberData(nameof(Different))]
    public void Two_different_instruments_are_kept_apart(string a, string b)
        => Assert.False(SymbolIdentity.Same(a, b),
            $"{a} and {b} are different instruments and both reduced to " +
            $"{SymbolIdentity.SeriesKey(a)} - the tick value of one would price stops on the other");
}

/// <summary>
/// The rounding rule that the three languages disagree about by default.
///
/// Python round() and C# Math.Round are half-to-even; JavaScript's
/// Math.round is half-up. 2250 x 0.05% is 1.125 exactly, and the
/// default behaviours answer 1.12 and 1.13. Stated, not inherited.
/// </summary>
public class RoundingIsStatedNotInherited
{
    [Theory]
    [InlineData(1.125, 1.13)]
    [InlineData(1.135, 1.14)]
    [InlineData(2.675, 2.68)]
    [InlineData(0.005, 0.01)]
    [InlineData(-1.125, -1.13)]
    public void Money_rounds_half_up_on_both_signs(double input, double expected)
        => Assert.Equal(expected, Risk.RoundMoney(input), 9);

    [Fact]
    public void And_that_is_not_what_the_runtime_would_have_done()
    {
        // If this ever stops being true the comment above is wrong, and
        // the nudge in RoundMoney has become unnecessary rather than
        // load-bearing. Either way somebody should look.
        Assert.Equal(1.12, Math.Round(1.125, 2));
        Assert.Equal(1.13, Risk.RoundMoney(1.125));
    }

    [Fact]
    public void Zero_stays_zero_and_does_not_acquire_a_sign()
        => Assert.Equal(0.0, Risk.RoundMoney(0.0));
}

/// <summary>
/// The four broker ceilings, which were read by nothing until EA 1.29.
///
/// No fixture file for these yet - they are engine-side rules the desk
/// only displays - so the cases restate engine/tests/test_broker_*.py.
/// </summary>
public class BrokerCeilings
{
    private static SymbolSpec Gold(params (string, double)[] over)
    {
        var d = new Dictionary<string, double>
        {
            ["tick_size"] = 0.01, ["tick_value"] = 1.0, ["digits"] = 2, ["point"] = 0.01,
            ["volume_min"] = 0.01, ["volume_step"] = 0.01, ["volume_max"] = 50.0,
        };
        foreach (var (k, v) in over) d[k] = v;
        return SymbolSpec.FromInfo(d);
    }

    [Fact]
    public void Stops_level_is_resolved_from_points_into_price()
        => Assert.Equal(0.30, Gold(("stops_level", 30)).MinStopDistance, 9);

    [Fact]
    public void Freeze_is_a_different_question_from_the_stop_floor()
    {
        var spec = Gold(("stops_level", 10), ("freeze_level", 40));
        Assert.Equal(0.10, spec.MinStopDistance, 9);
        Assert.Equal(0.40, spec.FreezeDistance, 9);
    }

    [Fact]
    public void Points_are_not_ticks()
    {
        // Equal on nearly every symbol, which is why reading the wrong
        // one would go unnoticed until it did not.
        var spec = SymbolSpec.FromInfo(new Dictionary<string, double>
        {
            ["tick_size"] = 0.00005, ["point"] = 0.00001,
            ["tick_value"] = 1.0, ["stops_level"] = 20,
        });
        Assert.Equal(0.0002, spec.MinStopDistance, 9);
    }

    [Fact]
    public void An_unrestricted_book_says_zero_and_means_it()
    {
        Assert.Equal(0.0, Gold().MinStopDistance);
        Assert.Equal(0.0, Gold().FreezeDistance);
    }

    [Fact]
    public void Volume_limit_is_not_volume_max()
    {
        var spec = Gold(("volume_max", 50), ("volume_limit", 100));
        // 80 already on, asking 30: under volume_max, over the total.
        Assert.Equal(20.0, spec.RoomUnderVolumeLimit(80), 9);
        Assert.Equal(0.0, spec.RoomUnderVolumeLimit(140), 9);
    }

    [Fact]
    public void No_aggregate_ceiling_is_infinite_room()
        => Assert.True(double.IsPositiveInfinity(Gold().RoomUnderVolumeLimit(1e9)));

    [Fact]
    public void Margin_comes_from_the_terminals_own_answer_and_scales()
    {
        var spec = Gold(("margin_per_lot_buy", 1000), ("margin_per_lot_sell", 990));
        Assert.Equal(2000.0, spec.MarginFor("buy", 2), 9);
        Assert.Equal(1980.0, spec.MarginFor("sell", 2), 9);
        Assert.Equal(500.0, spec.MarginFor("buy", 0.5), 9);
    }

    [Fact]
    public void A_missing_side_falls_back_before_giving_up()
        => Assert.Equal(1000.0, Gold(("margin_per_lot_buy", 1000)).MarginFor("sell", 1), 9);

    [Fact]
    public void Margin_initial_is_the_last_resort_not_the_first()
    {
        // It is 0 on most forex books, which is why OrderCalcMargin is asked.
        Assert.Equal(1000.0, Gold(("margin_initial", 750), ("margin_per_lot_buy", 1000)).MarginFor("buy", 1), 9);
        Assert.Equal(750.0, Gold(("margin_initial", 750)).MarginFor("buy", 1), 9);
    }

    [Fact]
    public void Unknown_margin_is_zero_and_zero_means_unknown_not_free()
        => Assert.Equal(0.0, Gold().MarginFor("buy", 10));
}

/// <summary>The loss tick value, which was a $30 error on a $100 cap.</summary>
public class LossTickValueWins
{
    [Fact]
    public void The_plain_spelling_the_expert_sends_is_read()
    {
        var spec = SymbolSpec.FromInfo(new Dictionary<string, double>
        {
            ["tick_size"] = 0.01, ["tick_value"] = 1.30, ["tick_value_loss"] = 1.00,
        });
        // A stop is a loss, so it is priced with the LOSS value.
        Assert.Equal(1.00, spec.TickValue, 9);
        Assert.Equal(100.0, spec.Money(1.0, 1.0), 9);
    }

    [Fact]
    public void And_the_prefixed_one_still_wins_where_both_arrive()
    {
        var spec = SymbolSpec.FromInfo(new Dictionary<string, double>
        {
            ["tick_size"] = 0.01,
            ["trade_tick_value_loss"] = 1.00, ["tick_value_loss"] = 9.99,
        });
        Assert.Equal(1.00, spec.TickValue, 9);
    }

    [Fact]
    public void An_unusable_spec_refuses_to_guess()
    {
        var spec = SymbolSpec.FromInfo(new Dictionary<string, double> { ["digits"] = 5 });
        Assert.False(spec.Usable);
        Assert.Equal(0.0, spec.Money(100, 1));
    }
}
