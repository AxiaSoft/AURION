// The part of a broker's contract specification that prices risk.
//
// Ported from engine/aurion/runtime/risk.py. Every field here was a
// bug before it was a field: the loss tick value priced stops $30 out
// on a $100 cap, the volume ladder was hardcoded to two decimals, and
// stops_level, freeze_level, volume_limit and margin were all arriving
// from the terminal and being read by nothing at all.
//
// Nothing is guessed. A guessed tick value is a wrong stop stated with
// confidence, which is worse than no cap at all - hence Usable, which
// callers must respect rather than working around.

using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;

namespace Aurion.Core.Money;

public sealed record SymbolSpec
{
    public string Symbol { get; init; } = "";
    public double TickSize { get; init; }
    public double TickValue { get; init; }
    public int Digits { get; init; } = 5;
    public double VolumeMin { get; init; } = 0.01;
    public double VolumeStep { get; init; } = 0.01;
    public double VolumeMax { get; init; } = 100.0;
    public double ContractSize { get; init; }
    public string Currency { get; init; } = "";

    /// <summary>
    /// The size of a point, kept apart from TickSize on purpose.
    ///
    /// StopsLevel and FreezeLevel are quoted in POINTS, and point is
    /// not always the tick size. They are equal on nearly every symbol,
    /// which is exactly why reading the wrong one would go unnoticed
    /// until it did not.
    /// </summary>
    public double Point { get; init; }

    public double StopsLevel { get; init; }
    public double FreezeLevel { get; init; }

    /// <summary>
    /// The broker's ceiling on TOTAL volume in this symbol.
    ///
    /// Not VolumeMax, which is the ceiling for ONE order. A book can
    /// allow 50 lots per order and 100 in total, so a fourth 30-lot
    /// order is individually legal and still refused. 0 means no
    /// aggregate ceiling.
    /// </summary>
    public double VolumeLimit { get; init; }

    public double MarginInitial { get; init; }
    public double MarginPerLotBuy { get; init; }
    public double MarginPerLotSell { get; init; }

    /// <summary>True when a price distance can be turned into money.</summary>
    public bool Usable => TickSize > 0 && TickValue > 0;

    private double PointOrTick => Point > 0 ? Point : TickSize;

    /// <summary>
    /// Closest to the market the broker will accept a stop, in price.
    ///
    /// A stop inside it is not a tight stop - it is the whole order
    /// refused, which the trader meets as an opaque rejection with no
    /// stop and no position. 0 when the broker does not restrict it,
    /// which is common on ECN books and means exactly what it says.
    /// </summary>
    public double MinStopDistance => Math.Max(0.0, StopsLevel * PointOrTick);

    /// <summary>
    /// How near the market a position becomes untouchable, in price.
    ///
    /// Inside it the broker refuses to modify OR close, and the refusal
    /// arrives as a bare retcode - from the desk that reads as the
    /// Close button not working. A different question from
    /// MinStopDistance: that one asks where a stop may be placed, this
    /// one asks whether an order may be touched at all.
    /// </summary>
    public double FreezeDistance => Math.Max(0.0, FreezeLevel * PointOrTick);

    /// <summary>What <paramref name="distance"/> price units cost at this size.</summary>
    public double Money(double distance, double volume = 1.0)
    {
        var d = Math.Abs(Risk.F(distance));
        if (!Usable || d <= 0) return 0.0;
        return d / TickSize * TickValue * Math.Max(0.0, Risk.F(volume));
    }

    /// <summary>
    /// What holding this many lots costs in margin.
    ///
    /// 0 means unknown, never free. The terminal answers
    /// OrderCalcMargin for one lot of each side and the figure scales;
    /// where it did not answer, MarginInitial is used, and where
    /// neither exists this returns 0 and the caller must not pretend to
    /// have checked anything.
    ///
    /// Linear in volume, which is how nearly every book charges it.
    /// Brokers with volume-tiered rates differ above the tier boundary,
    /// so this warns and catches the clear-cut case; it does not
    /// replace the terminal's own answer at send time.
    /// </summary>
    public double MarginFor(string? side, double volume)
    {
        var vol = Math.Max(0.0, Risk.F(volume));
        if (vol <= 0) return 0.0;
        var isBuy = (side ?? "").Trim().ToLowerInvariant() == "buy";
        var perLot = isBuy ? MarginPerLotBuy : MarginPerLotSell;
        // Either side missing falls back to the other before giving up:
        // one answer about this symbol beats none, and the two differ
        // by a few percent where they differ at all.
        if (perLot <= 0) perLot = isBuy ? MarginPerLotSell : MarginPerLotBuy;
        if (perLot <= 0) perLot = MarginInitial;
        return perLot <= 0 ? 0.0 : perLot * vol;
    }

    /// <summary>
    /// Lots still addable in this symbol, given what is already on.
    ///
    /// Infinity when the broker sets no aggregate ceiling, so callers
    /// can compare without special-casing the common book.
    /// </summary>
    public double RoomUnderVolumeLimit(double held)
        => VolumeLimit <= 0 ? double.PositiveInfinity
            : Math.Max(0.0, VolumeLimit - Math.Max(0.0, Risk.F(held)));

    /// <summary>Round a price to the instrument's own precision.</summary>
    public double RoundPrice(double price)
        => Math.Round(Risk.F(price), Math.Max(0, Digits), MidpointRounding.AwayFromZero);

    /// <summary>
    /// Read whatever the source calls these fields.
    ///
    /// MetaTrader's own names (trade_tick_value) and the plainer ones
    /// an expert or a test would use (tick_value) are both taken.
    ///
    /// The LOSS tick value pairing is load-bearing. A stop is a loss,
    /// so it is priced with SYMBOL_TRADE_TICK_VALUE_LOSS, which on
    /// metals, indices and anything quoted away from the account
    /// currency is NOT the profit value. Reading only the prefixed
    /// spelling meant a specification from the expert - which sends the
    /// plain one - fell through to the profit value: the same hundred
    /// -tick stop cost 100 one way and 130 the other, so a ten-dollar
    /// cap was really a thirteen-dollar cap and nothing said so.
    /// </summary>
    public static SymbolSpec FromInfo(JsonNode? info, string symbol = "")
    {
        var obj = info as JsonObject;

        double Pick(double fallback, params string[] names)
        {
            if (obj is null) return fallback;
            foreach (var name in names)
            {
                if (!obj.TryGetPropertyValue(name, out var node) || node is null) continue;
                double v;
                try { v = node.GetValue<double>(); }
                catch (Exception) { if (!double.TryParse(node.ToString(), out v)) continue; }
                if (v != 0 && !double.IsNaN(v)) return v;
            }
            return fallback;
        }

        string Text(params string[] names)
        {
            if (obj is null) return "";
            foreach (var name in names)
                if (obj.TryGetPropertyValue(name, out var node) && node is not null)
                {
                    var s = node.ToString();
                    if (!string.IsNullOrEmpty(s)) return s;
                }
            return "";
        }

        var digits = (int)Pick(5, "digits");

        return new SymbolSpec
        {
            Symbol = Text("name") is { Length: > 0 } n ? n : symbol,
            TickSize = Pick(0, "trade_tick_size", "tick_size", "point"),
            TickValue = Pick(0, "trade_tick_value_loss", "tick_value_loss",
                                "trade_tick_value", "tick_value"),
            Digits = digits > 0 ? digits : 5,
            VolumeMin = Pick(0.01, "volume_min", "min_lot"),
            VolumeStep = Pick(0.01, "volume_step", "lot_step"),
            VolumeMax = Pick(100.0, "volume_max", "max_lot"),
            ContractSize = Pick(0, "trade_contract_size", "contract_size"),
            Currency = Text("currency_profit", "currency"),
            Point = Pick(0, "point", "trade_tick_size", "tick_size"),
            StopsLevel = Pick(0, "trade_stops_level", "stops_level"),
            FreezeLevel = Pick(0, "trade_freeze_level", "freeze_level"),
            VolumeLimit = Pick(0, "volume_limit"),
            MarginInitial = Pick(0, "margin_initial"),
            MarginPerLotBuy = Pick(0, "margin_per_lot_buy"),
            MarginPerLotSell = Pick(0, "margin_per_lot_sell"),
        };
    }

    /// <summary>Build from a plain dictionary, for tests and fixtures.</summary>
    public static SymbolSpec FromInfo(IReadOnlyDictionary<string, double> info, string symbol = "")
    {
        var obj = new JsonObject();
        foreach (var (k, v) in info) obj[k] = v;
        return FromInfo(obj, symbol);
    }
}
