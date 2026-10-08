const I18N = {
  lang: localStorage.getItem("aurion.lang") || (navigator.language || "en").slice(0, 2),
  pack: {},
  async load(lang) {
    const code = ["en", "fa", "ar"].includes(lang) ? lang : "en";

    /* The desk normally gets its language pack from the engine. Served as
       plain files instead - GitHub Pages, or the folder opened straight off
       a disk - there is no engine to ask, and without a pack every label in
       the interface falls back to its key. The pack files are published
       too, two levels up from here, so they are tried second. */
    /* The pack is a plain file with no version in its name, so a browser
       that cached it once will keep serving yesterday's labels and every
       new key will render as its own key. The script tag that loaded this
       file carries the build token; borrow it. */
    const tag = document.querySelector('script[src*="i18n.js?v="]');
    const build = tag ? String(tag.src).split("v=").pop() : "";
    const bust = build ? `?v=${encodeURIComponent(build)}` : "";
    let data = null;
    for (const url of [`/api/i18n/${code}${bust}`, `../../lang/${code}.json${bust}`]) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const json = await res.json();
        data = json.data || json;        // the API wraps it; the file does not
        if (data && typeof data === "object") break;
      } catch (e) {
        // Try the next source; a missing pack must not stop the desk.
      }
    }
    if (!data) return this.pack;

    this.lang = code;
    this.pack = data;
    localStorage.setItem("aurion.lang", code);
    const dir = this.pack.meta?.dir || (code === "en" ? "ltr" : "rtl");
    const root = document.documentElement;
    root.lang = code;
    root.dir = dir;
    root.classList.toggle("rtl", dir === "rtl");
    root.classList.toggle("ltr", dir !== "rtl");
    document.body && (document.body.dir = dir);
    return this.pack;
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
