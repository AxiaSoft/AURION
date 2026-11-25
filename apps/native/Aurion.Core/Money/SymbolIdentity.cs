// Which instrument a spelling names.
//
// The same rule as the engine's _series_key and the desk's
// symbolSeriesKey, and it has to be: the engine decides whose candles
// and whose contract specification are whose, and the client decides
// which specification to price a ticket with. Two answers to that
// question means the number shown before the order and the number
// enforced after it are about different instruments.
//
// What this replaced cut the name at the first non-alphanumeric
// character, so CL.F25 and CL.G25 - two different dated futures - both
// came out as "CL" and shared one contract specification. The tick
// value of the wrong contract then priced every stop on the right one.
//
// Pinned from all three languages by tests/fixtures/symbol-identity.json.

using System.Text;
using System.Text.RegularExpressions;

namespace Aurion.Core.Money;

public static class SymbolIdentity
{
    // A broker's account-type suffix: its own separator-delimited
    // token of up to four letters, at the end. Nothing else is folded.
    private static readonly Regex Suffix =
        new(@"[._\-\s][A-Z]{1,4}$", RegexOptions.Compiled);

    /// <summary>
    /// The identity of a symbol: the base name, with a broker suffix folded away.
    ///
    /// The suffix is only removed when it is a separator-delimited
    /// token of at most four letters starting at index 3 or later.
    /// That last condition is what keeps CL.F25 apart from CL.G25 -
    /// too short to be an account-type suffix on a name that short.
    /// </summary>
    public static string SeriesKey(string? symbol)
    {
        var s = (symbol ?? "").Trim().ToUpperInvariant();
        if (s.Length == 0) return "";

        var m = Suffix.Match(s);
        var baseName = (m.Success && m.Index >= 3) ? s[..m.Index] : s;

        var sb = new StringBuilder(baseName.Length);
        foreach (var c in baseName)
            if (c is >= 'A' and <= 'Z' or >= '0' and <= '9') sb.Append(c);
        return sb.ToString();
    }

    /// <summary>Are these two spellings the same instrument?</summary>
    public static bool Same(string? a, string? b)
    {
        var ka = SeriesKey(a);
        return ka.Length > 0 && ka == SeriesKey(b);
    }
}
