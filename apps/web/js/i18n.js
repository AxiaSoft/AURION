const I18N = {
  lang: localStorage.getItem("aurion.lang") || (navigator.language || "en").slice(0, 2),
  pack: {},
  async load(lang) {
    const code = ["en", "fa", "ar"].includes(lang) ? lang : "en";
    const res = await fetch(`/api/i18n/${code}`);
    const json = await res.json();
    this.lang = code;
    this.pack = json.data || {};
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
