// The transport half of the API client. The 125 route methods are
// generated into AurionApi.g.cs; this is the part that cannot be,
// because it is behaviour rather than a list.
//
// Deliberately a close reading of apps/web/js/api.js rather than an
// improvement on it. The two clients talk to the same backend and must
// fail the same way: the same header, the same handling of 401 and of
// the support-expired 403, and the same refusal to put the token in a
// query string.

using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Aurion.Core.Api;

/// <summary>Raised when the desk's session is no longer accepted.</summary>
public sealed class AurionAuthRequiredException : Exception
{
    public AurionAuthRequiredException() : base("authentication required") { }
}

/// <summary>Raised when the engine refuses everything but the way out.</summary>
public sealed class AurionSupportExpiredException : Exception
{
    public JsonNode? Support { get; }

    public AurionSupportExpiredException(JsonNode? support)
        : base("support_expired") => Support = support;
}

public sealed partial class AurionApi : IDisposable
{
    private readonly HttpClient _http;
    private readonly bool _ownsHttp;
    private string _token = "";

    /// <summary>
    /// The session token.
    ///
    /// Held in memory only. The web desk keeps it in sessionStorage
    /// because a browser tab has nowhere better; a desktop process has
    /// no such excuse, and a token on disk is a token in a backup.
    /// Never placed in a query string - it would be written to the
    /// server log, which is the one place a credential must not be.
    /// </summary>
    public string Token
    {
        get => _token;
        set => _token = value ?? "";
    }

    /// <summary>Fired when the backend answers 401, so the shell can show the gate.</summary>
    public event Action? AuthRequired;

    /// <summary>Fired when support has lapsed. The facts travel in the body.</summary>
    public event Action<JsonNode?>? SupportExpired;

    public AurionApi(Uri baseAddress, HttpClient? http = null)
    {
        _ownsHttp = http is null;
        _http = http ?? new HttpClient();
        _http.BaseAddress = baseAddress;
    }

    /// <summary>The desk as the window hosts it: the backend on 8080.</summary>
    public static AurionApi Local(int port = 8080)
        => new(new Uri($"http://127.0.0.1:{port}"));

    private HttpRequestMessage Build(HttpMethod method, string path, object? body)
    {
        var req = new HttpRequestMessage(method, path);
        if (!string.IsNullOrEmpty(_token))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
        if (body is not null)
        {
            var json = body as string ?? JsonSerializer.Serialize(body);
            req.Content = new StringContent(json, Encoding.UTF8, "application/json");
        }
        return req;
    }

    /// <summary>
    /// One request, and the same three outcomes the web client knows.
    ///
    /// A body that is not JSON is not an exception: the web client
    /// answers { ok: false, error: "bad_response" } and carries on,
    /// because a desk that throws on a truncated reply is a desk that
    /// stops drawing. This does the same.
    /// </summary>
    public async Task<JsonNode?> SendAsync(
        HttpMethod method, string path, object? body = null, CancellationToken ct = default)
    {
        using var req = Build(method, path, body);
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);

        JsonNode? json;
        try
        {
            var text = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            json = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
        }
        catch (JsonException)
        {
            json = new JsonObject { ["ok"] = false, ["error"] = "bad_response" };
        }

        var error = json?["error"]?.GetValue<string>();

        // End of support. The desk is past a published update and the
        // server is refusing everything but the way out of that. The
        // facts travel in the body, so the screen that explains it
        // needs no request of its own - which matters, because the
        // request it would have made is one of the ones being refused.
        if ((int)res.StatusCode == 403 && error == "support_expired")
            SupportExpired?.Invoke(json?["support"]);

        if ((int)res.StatusCode == 401)
        {
            Token = "";
            AuthRequired?.Invoke();
        }

        return json;
    }

    public Task<JsonNode?> GetAsync(string path, CancellationToken ct = default)
        => SendAsync(HttpMethod.Get, path, null, ct);

    /// <summary>
    /// Bytes, with the header attached.
    ///
    /// The web desk needs an object URL for this because an anchor
    /// cannot carry an Authorization header. Here it is just a request,
    /// which is one of the few places the native client is simpler
    /// rather than merely different.
    /// </summary>
    public async Task<byte[]> DownloadAsync(string path, CancellationToken ct = default)
    {
        using var req = Build(HttpMethod.Get, path, null);
        using var res = await _http.SendAsync(req, ct).ConfigureAwait(false);
        if ((int)res.StatusCode == 401)
        {
            Token = "";
            AuthRequired?.Invoke();
            throw new AurionAuthRequiredException();
        }
        return await res.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
    }

    public void Dispose()
    {
        if (_ownsHttp) _http.Dispose();
    }
}
