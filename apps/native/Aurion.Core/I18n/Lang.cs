// The language packs, read straight off disk.
//
// lang/en.json, lang/fa.json and lang/ar.json are not copied, mirrored
// or converted into .resx for the native desk. They are read as they
// are. Three packs with 1947 keys each already agree exactly, and the
// surest way to break that is to keep a second copy of them in another
// format that somebody has to remember to update.
//
// So: one set of files, two clients. A string fixed for the web desk
// is fixed for this one in the same commit.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Aurion.Core.I18n;

/// <summary>One language pack, flattened to dotted keys.</summary>
public sealed class Lang
{
    public const string Fallback = "en";

    private static readonly string[] Supported = { "en", "fa", "ar" };

    private readonly Dictionary<string, string> _values;
    private readonly Lang? _fallback;

    public string Code { get; }

    /// <summary>Persian and Arabic are written right to left.</summary>
    public bool IsRightToLeft => Code is "fa" or "ar";

    private Lang(string code, Dictionary<string, string> values, Lang? fallback)
    {
        Code = code;
        _values = values;
        _fallback = fallback;
    }

    /// <summary>
    /// Load a pack from the directory holding lang/*.json.
    ///
    /// English is loaded behind every other language, not as a
    /// translation strategy but as a guard: if a key is ever added to
    /// one pack and not the others, the desk shows English rather than
    /// a dotted key in the middle of a sentence. The packs are checked
    /// for parity in the test suite, so this should never fire - and
    /// the day it does, the trader should still be able to read the
    /// screen.
    /// </summary>
    public static Lang Load(string langDirectory, string code)
    {
        code = Normalise(code);
        var fallback = code == Fallback ? null : Load(langDirectory, Fallback);
        var file = Path.Combine(langDirectory, code + ".json");
        var flat = new Dictionary<string, string>(StringComparer.Ordinal);
        var root = JsonNode.Parse(File.ReadAllText(file)) as JsonObject
                   ?? throw new InvalidDataException($"{file} is not a JSON object");
        Flatten(root, "", flat);
        return new Lang(code, flat, fallback);
    }

    /// <summary>Anything unrecognised is English, never an exception.</summary>
    public static string Normalise(string? code)
    {
        var c = (code ?? "").Trim().ToLowerInvariant();
        if (c.Length > 2) c = c[..2];
        return Array.IndexOf(Supported, c) >= 0 ? c : Fallback;
    }

    private static void Flatten(JsonObject node, string prefix, IDictionary<string, string> into)
    {
        foreach (var (key, value) in node)
        {
            var path = prefix.Length == 0 ? key : prefix + "." + key;
            if (value is JsonObject child) Flatten(child, path, into);
            else if (value is not null) into[path] = value.ToString();
        }
    }

    public bool Has(string key) => _values.ContainsKey(key);

    /// <summary>
    /// A translated string, with {placeholders} filled in.
    ///
    /// A missing key returns the key itself, which is what the web
    /// desk does. It looks wrong on screen because it IS wrong, and a
    /// blank would hide it.
    ///
    /// Substitution is literal and single-pass: a value that itself
    /// contains braces is not re-scanned, so a broker's symbol called
    /// "{n}" cannot turn into somebody else's number.
    /// </summary>
    public string T(string key, IReadOnlyDictionary<string, object?>? args = null)
    {
        if (!_values.TryGetValue(key, out var text))
            text = _fallback is not null && _fallback.Has(key) ? _fallback.T(key) : key;

        if (args is null || args.Count == 0 || text.IndexOf('{') < 0) return text;

        var sb = new System.Text.StringBuilder(text.Length + 16);
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] != '{') { sb.Append(text[i]); continue; }
            var close = text.IndexOf('}', i + 1);
            if (close < 0) { sb.Append(text[i]); continue; }
            var name = text[(i + 1)..close];
            if (args.TryGetValue(name, out var value))
            {
                sb.Append(Format(value));
                i = close;
            }
            else sb.Append(text[i]);
        }
        return sb.ToString();
    }

    public string T(string key, string name, object? value)
        => T(key, new Dictionary<string, object?> { [name] = value });

    /// <summary>
    /// Numbers are formatted in the reader's own locale.
    ///
    /// Not InvariantCulture: a Persian desk writes its digits and its
    /// decimal separator differently, and a number that does not match
    /// the rest of the screen reads as a bug.
    /// </summary>
    private string Format(object? value) => value switch
    {
        null => "",
        string s => s,
        IFormattable f => f.ToString(null, Culture),
        _ => value.ToString() ?? "",
    };

    public CultureInfo Culture => Code switch
    {
        "fa" => CultureInfo.GetCultureInfo("fa-IR"),
        "ar" => CultureInfo.GetCultureInfo("ar-SA"),
        _ => CultureInfo.GetCultureInfo("en-GB"),
    };
}
