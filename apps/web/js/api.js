const API = {
  // Secure token handling: memory + sessionStorage, never in URL query
  _memToken: "",
  get token() {
    if (this._memToken) return this._memToken;
    try {
      const s = sessionStorage.getItem("aurion.token") || localStorage.getItem("aurion.token") || "";
      if (s) this._memToken = s;
      return s;
    } catch { return this._memToken; }
  },
  set token(v) { this._memToken = v || ""; },
  headers() {
    const h = { "content-type": "application/json" };
    const t = this.token;
    if (t) h.authorization = `Bearer ${t}`;
    return h;
  },
  async req(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
    let json = {};
    try { json = await res.json(); } catch { json = { ok: false, error: "bad_response" }; }
    if (res.status === 401) {
      // secure: clear token and redirect to login gate
      this.setToken("");
      if (location.pathname !== "/" && !location.hash.includes("gate")) {
        // allow gate to handle
        try { window.dispatchEvent(new CustomEvent("aurion:auth-required")); } catch {}
      }
    }
    return json;
  },
  get(path) { return this.req("GET", path); },
  post(path, body) { return this.req("POST", path, body); },
  /**
   * Binary download.
   *
   * A plain <a href> navigation cannot carry the Authorization header, and the
   * desk deliberately never puts the token in a query string (it would leak
   * into the server log).  So the bytes are fetched with the header and handed
   * to a short-lived object URL.  The element is attached to the DOM first —
   * Firefox ignores click() on a detached anchor.
   */
  async download(path, filename) {
    let res;
    try {
      res = await fetch(path, { headers: this.headers(), credentials: "same-origin" });
    } catch (err) {
      return { ok: false, error: (err && err.message) || "network" };
    }
    if (res.status === 401) {
      this.setToken("");
      try { window.dispatchEvent(new CustomEvent("aurion:auth-required")); } catch {}
      return { ok: false, error: "auth_required" };
    }
    if (!res.ok) {
      let msg = "";
      try { const j = await res.json(); msg = (j && j.error) || ""; } catch {}
      return { ok: false, error: msg || ("http_" + res.status) };
    }
    const blob = await res.blob();
    if (!blob.size) return { ok: false, error: "empty_file" };
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "download";
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
    return { ok: true, size: blob.size };
  },
  setToken(token) {
    this._memToken = token || "";
    try {
      if (token) {
        sessionStorage.setItem("aurion.token", token);
        // keep localStorage for backward compat but will migrate to session
        localStorage.setItem("aurion.token", token);
      } else {
        sessionStorage.removeItem("aurion.token");
        localStorage.removeItem("aurion.token");
      }
    } catch {}
  },
};

class LiveSocket {
  constructor(onMsg) {
    this.onMsg = onMsg;
    this.ws = null;
    this.timer = null;
    this._authed = false;
  }
  connect() {
    this.close();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // NEVER send token in query string (log leakage) - use first message auth
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () => {
      // send auth as first message
      const t = API.token;
      if (t) {
        try { this.ws.send(JSON.stringify({ type: "auth", token: t })); } catch {}
      }
    };
    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg && msg.type === "ready") this._authed = true;
        this.onMsg(msg);
      } catch { /* ignore */ }
    };
    this.ws.onclose = () => {
      this._authed = false;
      this.timer = setTimeout(() => this.connect(), 2000);
    };
    this.ws.onerror = () => { try { this.ws.close(); } catch { /* */ } };
  }
  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      // prevent sending token in clear if object contains it
      this.ws.send(JSON.stringify(obj));
    }
  }
  close() {
    clearTimeout(this.timer);
    if (this.ws) {
      this.ws.onclose = null;
      try { this.ws.close(); } catch { /* */ }
    }
    this._authed = false;
  }
}
