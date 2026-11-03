const I18N = {
  lang: localStorage.getItem("aurion.lang") || (navigator.language || "en").slice(0, 2),
  pack: {},
  /* The pack is cached in this browser, and the cache is authoritative
     whenever the network is not.

     Two faults came from not doing this. After an update the desk reloads
     before the engine has finished restarting, so BOTH sources 404; the old
     code returned an empty pack and left root.lang and root.dir untouched,
     which renders every label as its own key in a left-to-right layout -
     indistinguishable, to the person looking at it, from "my language reset
     itself to English". And switching language went over the network every
     single time, so a choice that should feel instant waited on a request.

     Now: the cached pack paints immediately, the network refreshes it in
     the background, and a failed fetch changes nothing the trader can see. */
  cacheKey(code) { return "aurion.pack." + code; },

  readCache(code) {
    try {
      const raw = localStorage.getItem(this.cacheKey(code));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && parsed.pack ? parsed : null;
    } catch (e) { return null; }
  },

  writeCache(code, pack, build) {
    try {
      localStorage.setItem(this.cacheKey(code), JSON.stringify({ build, pack }));
    } catch (e) { /* private mode, or quota: the desk still works */ }
  },

  /**
   * Forget the cached packs, so the next load goes and gets fresh ones.
   *
   * An update ships new keys. The desk only notices them when the build
   * token in i18n.js's own script tag changes, and after an update the
   * page used to reload while the engine was still restarting - so the
   * service worker answered with the PREVIOUS index.html, carrying the
   * PREVIOUS token, which matched the cached pack exactly and refreshed
   * nothing. Every key added by that update then rendered as its own
   * key: "upd.rate_limited upd.rate_retry upd.rate_token_hint" on
   * screen instead of a sentence, reported from the field. (The third
   * of those keys no longer exists - it suggested setting a GitHub
   * token, and the desk stopped taking one - but the fault it exposed
   * was never about which keys they were.)
   *
   * The install screen now waits for the engine to answer before it
   * reloads, which removes the cause; this removes the leftovers. Only
   * safe to call when something is about to reload against an engine
   * known to be up, because an empty cache and an unreachable pack is
   * the one state worse than a stale one.
   */
  clearCache() {
    try {
      for (const code of ["en", "fa", "ar"]) localStorage.removeItem(this.cacheKey(code));
    } catch (e) { /* private mode: the fetch below still refreshes it */ }
  },

  /** Put a pack into force and set the document's language and direction. */
  install(code, pack) {
    this.lang = code;
    this.pack = pack || {};
    /* English is what a missing key falls back to, so it is worth keeping
       a reference to whenever it passes through here. */
    if (code === "en" && pack) this.fallback = this.pack;
    if (pack && Object.keys(pack).length) this.ready = true;
    try { localStorage.setItem("aurion.lang", code); } catch (e) { /* */ }
    const dir = this.pack.meta?.dir || (code === "en" ? "ltr" : "rtl");
    const root = document.documentElement;
    root.lang = code;
    root.dir = dir;
    root.classList.toggle("rtl", dir === "rtl");
    root.classList.toggle("ltr", dir !== "rtl");
    document.body && (document.body.dir = dir);
    return this.pack;
  },

  buildToken() {
    const tag = document.querySelector('script[src*="i18n.js?v="]');
    return tag ? String(tag.src).split("v=").pop() : "";
  },

  async fetchPack(code, fresh) {
    /* The desk normally gets its language pack from the engine. Served as
       plain files instead - GitHub Pages, or the folder opened straight off
       a disk - there is no engine to ask, and without a pack every label in
       the interface falls back to its key. The pack files are published
       too, two levels up from here, so they are tried second. */
    /* The pack is a plain file with no version in its name, so a browser
       that cached it once will keep serving yesterday's labels and every
       new key will render as its own key. The script tag that loaded this
       file carries the build token; borrow it. */
    /* `fresh` is for the case the token cannot help with: the token itself
       is stale. index.html is what carries it, so a copy of index.html
       served from the service worker or the browser's own cache brings a
       token that matches the cached pack exactly - and then nothing ever
       refreshes, however wrong the pack is. A revalidation therefore
       bypasses the HTTP cache outright rather than asking politely. */
    const build = this.buildToken();
    const bust = build ? `?v=${encodeURIComponent(build)}` : "";
    const q = fresh ? (bust ? `${bust}&t=${Date.now()}` : `?t=${Date.now()}`) : bust;
    const init = fresh ? { cache: "no-store" } : undefined;
    for (const url of [`/api/i18n/${code}${q}`, `../../lang/${code}.json${q}`]) {
      try {
        const res = await fetch(url, init);
        if (!res.ok) continue;
        const json = await res.json();
        const data = json.data || json;    // the API wraps it; the file does not
        if (data && typeof data === "object" && Object.keys(data).length) return data;
      } catch (e) {
        // Try the next source; a missing pack must not stop the desk.
      }
    }
    return null;
  },

  async load(lang) {
    const code = ["en", "fa", "ar"].includes(lang) ? lang : "en";
    const build = this.buildToken();
    const cached = this.readCache(code);

    if (cached) {
      // Paint from the cache at once, then refresh behind the trader's back.
      this.install(code, cached.pack);
      /* Revalidate EVERY time, not only when the build token moved.
         The token is read out of index.html, so it is stale in exactly
         the situation that matters: a desk whose files were replaced
         underneath it - by an update, or by the recovery script - while
         the browser kept serving the previous shell. Matching tokens
         then certified a pack that was missing every string the update
         had just added, and the panel printed "upd.inst_restart_now"
         at the trader. One conditional request at boot is a smaller
         price than that. */
      this.refresh(code, cached.pack, cached.build !== build);
      return this.pack;
    }

    const data = await this.fetchPack(code);
    if (!data) {
      /* Nothing cached and nothing reachable. Still set the language and the
         direction: a Persian desk showing keys is wrong, but a Persian desk
         showing keys left-to-right is wrong twice. */
      this.install(code, this.lang === code ? this.pack : {});
      return this.pack;
    }
    this.writeCache(code, data, build);
    return this.install(code, data);
  },

  /**
   * Fetch the pack again and put it in force if the words changed.
   *
   * `bypassCache` is set when the cached pack is known to be suspect, or
   * when a lookup has already missed; a routine boot revalidation can be
   * answered from the HTTP cache without harm.
   */
  refresh(code, previous, bypassCache) {
    /* One request in flight per language - except that a cache-bypassing
       repair is allowed to overtake a routine revalidation, which is the
       one that may be about to answer out of the very cache in doubt. */
    if (this._refreshing === code && (this._refreshingFresh || !bypassCache)) return;
    this._refreshing = code;
    this._refreshingFresh = !!bypassCache;
    const build = this.buildToken();
    return this.fetchPack(code, !!bypassCache).then((fresh) => {
      this._refreshing = "";
      this._refreshingFresh = false;
      if (!fresh) return null;
      this.writeCache(code, fresh, build);
      if (code === "en") this.fallback = fresh;
      if (this.lang !== code) return fresh;        // the trader moved on; leave it
      // Only disturb the screen if the words actually changed.
      if (previous && JSON.stringify(fresh) === JSON.stringify(previous)) return fresh;
      this.install(code, fresh);
      try {
        window.dispatchEvent(new CustomEvent("aurion:i18n", { detail: { lang: code } }));
      } catch (e) { /* the pack is in force either way */ }
      return fresh;
    }).catch(() => { this._refreshing = ""; this._refreshingFresh = false; return null; });
  },

  /* ---- what happens when a key is not in the pack ---------------------
     Nothing good, up to now: t() handed the key back and the desk printed
     it. That is how "upd.rate_limited upd.rate_retry" reached a customer's
     update screen - the pack was one build behind the code reading it, and
     every sentence that build had added came out as its own name, which
     also wrecks the layout, because a key is one long unbreakable word.

     A miss is a fault in this copy of the desk, and it is a fault with a
     known repair: go and get the pack again. So a miss now (1) asks for a
     fresh pack, once, (2) answers from English in the meantime, which is a
     real sentence, and (3) if even English has not arrived, answers with
     the key's last segment in words - "Inst restart now" rather than
     "upd.inst_restart_now". Never the dotted key. */
  missed: [],
  fallback: null,
  ready: false,
  _healAt: 0,
  _heals: 0,

  noteMissing(key) {
    if (this.missed.indexOf(key) < 0) this.missed.push(key);
    /* Lookups that happen before any pack is in force are not evidence of
       a stale pack - they are just early - and spending the repair budget
       on them would leave none for the real thing. */
    if (!this.ready) return;
    const now = Date.now();
    /* At most one repair attempt a minute and three in all: a pack that
       genuinely does not have the key must not turn a render loop into a
       request loop. */
    if (this._heals >= 3 || now - this._healAt < 60000) return;
    this._healAt = now;
    this._heals += 1;
    const code = this.lang;
    this.refresh(code, this.pack, true);
    if (code !== "en" && !this.fallback) {
      const cachedEn = this.readCache("en");
      if (cachedEn && cachedEn.pack) this.fallback = cachedEn.pack;
      else this.fetchPack("en", true).then((p) => { if (p) this.fallback = p; }).catch(() => {});
    }
  },

  /** The key's own last segment, as words. The last thing tried. */
  humanise(key) {
    const tail = String(key).split(".").pop().replace(/[_-]+/g, " ").trim();
    return tail ? tail.charAt(0).toUpperCase() + tail.slice(1) : String(key);
  },

  /**
   * Is this key defined at all?
   *
   * Some labels are optional by design - a theme's display name, an
   * account type the engine invented - and their callers want to fall
   * back to an id rather than to a sentence. They used to detect that by
   * comparing t()'s answer with the key, which worked only because t()
   * handed missing keys back. It no longer does, so the question has to
   * be asked directly, and asking it is not a miss: nothing was shown.
   */
  has(key) {
    return this.lookup(this.pack, key) !== null || this.lookup(this.fallback, key) !== null;
  },

  lookup(pack, key) {
    let node = pack;
    for (const p of String(key).split(".")) {
      if (!node || typeof node !== "object" || !(p in node)) return null;
      node = node[p];
    }
    return typeof node === "string" ? node : null;
  },

  locale() {
    return this.pack.meta?.locale || { en: "en-GB", fa: "fa-IR", ar: "ar-SA" }[this.lang] || "en-GB";
  },
  t(key, vars) {
    let text = this.lookup(this.pack, key);
    if (text === null) {
      this.noteMissing(key);
      text = this.lookup(this.fallback, key);
      if (text === null) text = this.humanise(key);
    }
    if (vars) for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, v);
    return text;
  },
  apply(root = document) {
    root.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = this.t(el.getAttribute("data-i18n"));
    });
    root.querySelectorAll("[data-i18n-ph]").forEach((el) => {
      el.setAttribute("placeholder", this.t(el.getAttribute("data-i18n-ph")));
    });
    /* Tooltips and screen-reader names, which used to be written once
       when the button was bound. That is before any pack is in force at
       boot, so the header drawer's tooltip stayed in English for the
       whole session on a Persian desk - and said "hdr.drawer" on a desk
       whose pack was behind. Declared here, they are rewritten by every
       repaint, including the one a late pack refresh asks for. */
    root.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const text = this.t(el.getAttribute("data-i18n-title"));
      el.setAttribute("title", text);
      if (el.hasAttribute("aria-label")) el.setAttribute("aria-label", text);
    });
  },
  dir() {
    return this.pack.meta?.dir || "ltr";
  },
};

if (!["en", "fa", "ar"].includes(I18N.lang)) I18N.lang = "en";
