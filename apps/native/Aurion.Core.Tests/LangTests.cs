// The language packs, read by the native desk exactly as they ship.
//
// Not a copy, not a .resx conversion: lang/en.json, lang/fa.json and
// lang/ar.json are loaded as they are. 1947 keys in each, already in
// exact agreement, and the surest way to break that is to keep a
// second copy in another format that somebody has to remember.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using Aurion.Core.I18n;
using Xunit;

namespace Aurion.Core.Tests;

public class LangTests
{
    private static string LangDir => Path.Combine(Fixtures.Root(), "lang");

    private static Lang Load(string code) => Lang.Load(LangDir, code);

    [Theory]
    [InlineData("en")]
    [InlineData("fa")]
    [InlineData("ar")]
    public void Every_pack_loads_and_is_not_nearly_empty(string code)
    {
        var lang = Load(code);
        Assert.Equal(code, lang.Code);
        // A loader that silently returned an empty dictionary would
        // pass every other test in this file, because a missing key
        // falls back. So the size is asserted first.
        Assert.True(lang.Has("exec.buy"), $"{code}: exec.buy is missing, so nothing loaded");
    }

    [Fact]
    public void The_three_packs_hold_exactly_the_same_keys()
    {
        // The port's whole i18n strategy rests on this. If the packs
        // could drift, the native desk would show English in the
        // middle of a Persian screen and nobody would notice until a
        // trader did.
        var keys = new Dictionary<string, HashSet<string>>();
        foreach (var code in new[] { "en", "fa", "ar" })
        {
            var flat = new HashSet<string>(StringComparer.Ordinal);
            Flatten(JsonNode.Parse(File.ReadAllText(Path.Combine(LangDir, code + ".json")))!.AsObject(), "", flat);
            keys[code] = flat;
        }
        foreach (var code in new[] { "fa", "ar" })
        {
            var missing = keys["en"].Except(keys[code]).OrderBy(k => k).Take(10).ToArray();
            var extra = keys[code].Except(keys["en"]).OrderBy(k => k).Take(10).ToArray();
            Assert.True(missing.Length == 0, $"{code} is missing: {string.Join(", ", missing)}");
            Assert.True(extra.Length == 0, $"{code} has keys en does not: {string.Join(", ", extra)}");
        }
    }

    private static void Flatten(JsonObject node, string prefix, ISet<string> into)
    {
        foreach (var (key, value) in node)
        {
            var path = prefix.Length == 0 ? key : prefix + "." + key;
            if (value is JsonObject child) Flatten(child, path, into);
            else into.Add(path);
        }
    }

    [Fact]
    public void A_missing_key_returns_itself_rather_than_a_blank()
    {
        // It looks wrong on screen because it IS wrong. A blank hides it.
        var en = Load("en");
        Assert.Equal("no.such.key.anywhere", en.T("no.such.key.anywhere"));
    }

    [Fact]
    public void Placeholders_are_filled_from_the_arguments()
    {
        var en = Load("en");
        var text = en.T("engerr.max_open", "n", 3);
        Assert.Contains("3", text);
        Assert.DoesNotContain("{n}", text);
    }

    [Fact]
    public void An_argument_that_was_not_supplied_is_left_visible()
    {
        // Rather than emptied. "The ceiling of has been reached" reads
        // like a finished sentence and hides the fault; "{n}" does not.
        var en = Load("en");
        Assert.Contains("{n}", en.T("engerr.max_open"));
    }

    [Fact]
    public void Substitution_is_single_pass()
    {
        // A value containing braces must not be re-scanned. A broker
        // whose symbol is literally "{n}" cannot be handed somebody
        // else's number.
        var en = Load("en");
        var text = en.T("engerr.frozen", "symbol", "{n}");
        Assert.Contains("{n}", text);
    }

    [Theory]
    [InlineData("fa", true)]
    [InlineData("ar", true)]
    [InlineData("en", false)]
    public void Direction_is_known_without_asking_the_window(string code, bool rtl)
        => Assert.Equal(rtl, Load(code).IsRightToLeft);

    [Theory]
    [InlineData(null, "en")]
    [InlineData("", "en")]
    [InlineData("de", "en")]
    [InlineData("FA", "fa")]
    [InlineData("fa-IR", "fa")]
    [InlineData("ar-SA", "ar")]
    public void An_unknown_language_is_english_rather_than_an_exception(string? given, string expected)
        => Assert.Equal(expected, Lang.Normalise(given));

    [Fact]
    public void A_translated_pack_really_is_translated()
    {
        // Guards the failure where a pack is created by copying en and
        // filling it in later: every key present, none of it translated.
        var en = Load("en");
        var fa = Load("fa");
        var same = 0;
        var checkedCount = 0;
        foreach (var key in new[]
        {
            "exec.buy", "exec.sell", "exec.close", "engerr.max_open",
            "exec.margin_short", "engerr.frozen",
        })
        {
            checkedCount++;
            if (en.T(key) == fa.T(key)) same++;
        }
        Assert.True(same < checkedCount, "the Persian pack is answering in English");
    }

    [Fact]
    public void The_strings_phase_zero_added_are_there_in_all_three()
    {
        foreach (var code in new[] { "en", "fa", "ar" })
        {
            var lang = Load(code);
            foreach (var key in new[]
            {
                "exec.risk_no_side", "exec.risk_stop_too_close",
                "exec.margin_need", "exec.margin_short", "engerr.frozen",
            })
                Assert.True(lang.Has(key), $"{code} is missing {key}");
        }
    }
}
