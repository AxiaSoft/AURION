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

  /** Put a pack into force and set the document's language and direction. */
  install(code, pack) {
    this.lang = code;
    this.pack = pack || {};
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

  async fetchPack(code) {
    /* The desk normally gets its language pack from the engine. Served as
       plain files instead - GitHub Pages, or the folder opened straight off
       a disk - there is no engine to ask, and without a pack every label in
       the interface falls back to its key. The pack files are published
       too, two levels up from here, so they are tried second. */
    /* The pack is a plain file with no version in its name, so a browser
       that cached it once will keep serving yesterday's labels and every
       new key will render as its own key. The script tag that loaded this
       file carries the build token; borrow it. */
    const build = this.buildToken();
    const bust = build ? `?v=${encodeURIComponent(build)}` : "";
    for (const url of [`/api/i18n/${code}${bust}`, `../../lang/${code}.json${bust}`]) {
      try {
        const res = await fetch(url);
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
      if (cached.build !== build) {
        this.fetchPack(code).then((fresh) => {
          if (!fresh) return;
          this.writeCache(code, fresh, build);
          // Only disturb the screen if the words actually changed.
          if (JSON.stringify(fresh) === JSON.stringify(cached.pack)) return;
          if (this.lang !== code) return;   // the trader moved on; leave it
          this.install(code, fresh);
          try {
            window.dispatchEvent(new CustomEvent("aurion:i18n", { detail: { lang: code } }));
          } catch (e) { /* the pack is in force either way */ }
        });
      }
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

  locale() {
    return this.pack.meta?.locale || { en: "en-GB", fa: "fa-IR", ar: "ar-SA" }[this.lang] || "en-GB";
  },
  t(key, vars) {
    const parts = String(key).split(".");
    let node = this.pack;
    for (const p of parts) {
      if (!node || typeof node !== "object" || !(p in node)) return key;
      node = node[p];
    }
    let text = String(node);
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
  },
  dir() {
    return this.pack.meta?.dir || "ltr";
  },
};

if (!["en", "fa", "ar"].includes(I18N.lang)) I18N.lang = "en";
