"use strict";
// AURION key server — standalone license issuer + FULL E-COMMERCE STORE
// Customers: register (Gmail | Iranian mobile) -> OTP -> buy plan -> ZarinPal -> key
// Desks: POST /api/desk/activate consumes key and binds machine
// Owner: admin token -> full admin panel (secret hash /#/<ADMIN_PANEL_HASH>)

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { Store } = require("./store");
const keys = require("./keys");
const { ZarinPal } = require("./zarinpal");
const captcha = require("./captcha");
const notify = require("./notify");

// ---------------------------------------------------------------------------
// Config (.env manual)
// ---------------------------------------------------------------------------
(function loadEnv() {
  const file = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || m[1].startsWith("#")) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2];
  }
})();

const ENV = process.env;
const PORT = Number(ENV.PORT || 8899);
const PUBLIC_BASE = String(ENV.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
const KEY_PRIV = String(ENV.AURION_KEY_PRIVATE_HEX || "").trim();
const MAX_OWNER_MACHINES = Math.max(1, Number(ENV.MAX_OWNER_MACHINES || 1));
const JWT_SECRET = (() => {
  const s = String(ENV.JWT_SECRET || "").trim();
  if (!s) {
    if (String(ENV.NODE_ENV || "").toLowerCase() === "production") {
      console.error("[fatal] JWT_SECRET required in production");
      process.exit(1);
    }
    // dev only fallback, random per boot to invalidate sessions
    return "dev-" + require("crypto").randomBytes(24).toString("hex");
  }
  if (s.length < 32) {
    console.warn("[warn] JWT_SECRET too short, should be >=32 chars");
  }
  return s;
})();
const ADMIN_TOKEN = ENV.ADMIN_TOKEN || "";
const ADMIN_HASH = String(ENV.ADMIN_PANEL_HASH || "owner-axia").replace(/[^A-Za-z0-9_-]/g, "") || "owner-axia";
const MAX_REPLACEMENTS = Number(ENV.MAX_REPLACEMENTS || 3);
const ALLOW_DEV_PAID = String(ENV.ALLOW_DEV_PAID || "0") === "1";
const ADMIN_FAIL_LIMIT = Math.max(3, Number(ENV.ADMIN_FAIL_LIMIT || 10));
const SUPPORT = {
  phone: String(ENV.SUPPORT_PHONE || "").slice(0, 40),
  email: String(ENV.SUPPORT_EMAIL || "").slice(0, 120),
  telegram: String(ENV.SUPPORT_TELEGRAM_URL || ENV.SUPPORT_TELEGRAM || "").slice(0, 200),
};

const DEFAULT_PLANS = [
  { id: "m1", months: 1, days: 30, price: Number(ENV.PLAN_M1_PRICE || 15000000) },
  { id: "m3", months: 3, days: 90, price: Number(ENV.PLAN_M3_PRICE || 40000000) },
  { id: "m6", months: 6, days: 180, price: Number(ENV.PLAN_M6_PRICE || 75000000) },
  { id: "y1", months: 12, days: 365, price: Number(ENV.PLAN_Y1_PRICE || 140000000) },
];

if (!KEY_PRIV) console.warn("[warn] AURION_KEY_PRIVATE_HEX empty — minting disabled");
if (!ADMIN_TOKEN) {
  if (String(ENV.NODE_ENV || "").toLowerCase() === "production") {
    console.error("[fatal] ADMIN_TOKEN required in production");
    process.exit(1);
  }
  console.warn("[warn] ADMIN_TOKEN empty — admin disabled (dev only)");
}

const store = new Store(path.resolve(__dirname, "..", String(ENV.DATA_DIR || "./data"), "keyserver.json"));
const zarinpal = new ZarinPal({ merchantId: ENV.ZARINPAL_MERCHANT_ID, gateway: ENV.ZARINPAL_GATEWAY || "live" });

// Ensure extended collections exist
if (!Array.isArray(store.doc.coupons)) store.doc.coupons = [];
if (!Array.isArray(store.doc.products)) store.doc.products = [];
if (!store.doc.settings) store.doc.settings = {};
if (!store.doc.settings.support) store.doc.settings.support = { ...SUPPORT };
if (!store.doc.settings.site) store.doc.settings.site = { name: "AURION Keys", tagline: "فروشگاه لایسنس AURION — پرداخت امن زرین‌پال", notice: "" };
if (!Array.isArray(store.doc.wishlists)) store.doc.wishlists = []; // {user_id, product_id}
if (!store.doc.counters) store.doc.counters = { order: 1000, invoice: 1000, ticket: 1000, coupon: 1000 };

// Seed products from env if empty
if (store.doc.products.length === 0) {
  const rich = {
    m1: { title: "لایسنس ۱ ماهه AURION", desc: "مناسب برای تست و شروع — تمام قابلیت‌های پرمیوم", features: ["اتصال نامحدود MT5", "تمام استراتژی‌ها", "پشتیبانی تیکت", "۱ دستگاه"], popular: false, badge: "" },
    m3: { title: "لایسنس ۳ ماهه AURION", desc: "محبوب برای تریدرهای نیمه‌حرفه‌ای — صرفه‌جویی ۱۱٪", features: ["همه چیز پلن ۱ ماهه", "تحلیل AI پیشرفته", "بک‌تست نامحدود", "اولویت پشتیبانی"], popular: true, badge: "محبوب" },
    m6: { title: "لایسنس ۶ ماهه AURION", desc: "بهترین ارزش — صرفه‌جویی ۱۷٪ + هدیه", features: ["همه چیز پلن ۳ ماهه", "مدیریت ریسک پراپ", "تلگرام نامحدود", "۲ تیکت فوری"], popular: false, badge: "به‌صرفه" },
    y1: { title: "لایسنس ۱۲ ماهه AURION", desc: "حرفه‌ای‌ها — صرفه‌جویی ۲۲٪ + پشتیبانی VIP", features: ["همه چیز پلن ۶ ماهه", "پشتیبانی VIP تلگرام", "جلسه آنبوردینگ", "۳ جایگزینی رایگان"], popular: false, badge: "VIP" },
  };
  for (const p of DEFAULT_PLANS) {
    const r = rich[p.id] || {};
    store.doc.products.push({
      id: p.id,
      sku: `AX-${p.id.toUpperCase()}`,
      title: r.title || p.id,
      description: r.desc || "",
      long_desc: `${r.title || p.id} — لایسنس اورجینال AURION با فعال‌سازی آنلاین، بایند به یک سیستم، قابلیت بازیابی رایگان تا ${MAX_REPLACEMENTS} بار.`,
      days: p.days,
      months: p.months,
      price_rial: p.price,
      price_toman: Math.round(p.price / 10),
      features: r.features || [],
      popular: Boolean(r.popular),
      badge: r.badge || "",
      active: true,
      stock: 9999,
      rating: 4.8,
      reviews: Math.floor(Math.random() * 200) + 50,
      image: "",
      created_at: new Date().toISOString(),
    });
  }
  store.save();
}

function getProducts() {
  const list = store.doc.products.filter(p => p.active);
  if (list.length) return list;
  return DEFAULT_PLANS.map(p => ({
    id: p.id, sku: `AX-${p.id.toUpperCase()}`, title: p.id, description: "", long_desc: "", days: p.days, months: p.months,
    price_rial: p.price, price_toman: Math.round(p.price / 10), features: [], popular: p.id === "m3", badge: "", active: true, stock: 9999, rating: 4.8, reviews: 100, image: "", created_at: new Date().toISOString()
  }));
}
function findProduct(id) { return getProducts().find(p => p.id === String(id).toLowerCase()) || store.doc.products.find(p => p.id === String(id).toLowerCase()); }

const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "clipboard-write=(self), camera=(), microphone=(), geolocation=()");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none';");
  if (String(ENV.NODE_ENV).toLowerCase() === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});
app.use(express.json({ limit: "256kb" }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function clientIp(req) { return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim(); }
function guardRate(req, res, n, windowMs) {
  if (!captcha.rateLimit(clientIp(req) + ":" + req.path, n, windowMs)) {
    res.status(429).json({ ok: false, error: "too_many_requests" });
    return false;
  }
  return true;
}
function normalizeIdentity(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  let phone = s.replace(/[\s-]/g, "");
  if (phone.startsWith("0098")) phone = "+98" + phone.slice(4);
  if (phone.startsWith("98") && phone.length === 12) phone = "+" + phone;
  if (/^09\d{9}$/.test(phone)) return { kind: "phone", value: phone };
  if (/^\+989\d{9}$/.test(phone)) return { kind: "phone", value: "0" + phone.slice(3) };
  const email = s.toLowerCase();
  if (/^[a-z0-9._%+\-]+@(gmail\.com|googlemail\.com)$/.test(email)) {
    return { kind: "gmail", value: email.replace("@googlemail.com", "@gmail.com") };
  }
  return null;
}
function signSession(user) { return jwt.sign({ uid: user.id, ident: user.identity }, JWT_SECRET, { expiresIn: "7d" }); }
function authRequired(req, res, next) {
  const hdr = String(req.headers.authorization || "");
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = store.findIn("users", u => u.id === payload.uid);
    if (!user || user.disabled) return res.status(401).json({ ok: false, error: "session_invalid" });
    req.user = user;
    next();
  } catch { return res.status(401).json({ ok: false, error: "session_invalid" }); }
}
const adminFails = new Map();
function adminRequired(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(404).json({ ok: false, error: "disabled" });
  const ip = clientIp(req);
  const rec = adminFails.get(ip);
  if (rec && rec.until && rec.until > Date.now()) return res.status(429).json({ ok: false, error: "admin_locked" });
  const given = String(req.headers["x-admin-token"] || "");
  // constant-time compare with length check to prevent timing leak
  let match = false;
  try {
    if (ADMIN_TOKEN && given.length === ADMIN_TOKEN.length) {
      match = crypto.timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(ADMIN_TOKEN, "utf8"));
    }
  } catch { match = false; }
  if (!match) {
    const cur = adminFails.get(ip) || { n: 0, until: 0 };
    cur.n += 1;
    if (cur.n >= ADMIN_FAIL_LIMIT) { cur.until = Date.now() + 15 * 60_000; cur.n = 0; }
    adminFails.set(ip, cur);
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  adminFails.delete(ip);
  next();
}
function validCaptcha(body) { return captcha.checkChallenge(body.captcha_id, body.captcha_answer); }
function issueOtp(user) {
  const code = notify.genCode();
  store.doc.otps = store.doc.otps.filter(o => o.identity !== user.identity);
  store.push("otps", { identity: user.identity, code_hash: bcrypt.hashSync(code, 8), expires: Date.now() + 10 * 60 * 1000, attempts: 0 });
  return notify.deliverOtp(ENV, user.identity_kind, user.identity, code);
}
function publicUser(u) {
  return {
    id: u.id,
    identity: notify.mask(u.identity),
    raw_identity: u.identity,
    kind: u.identity_kind,
    verified: Boolean(u.verified),
    display_name: u.display_name || "",
    created_at: u.created_at,
    last_login: u.last_login || "",
  };
}
function orderKeys(orderId) { return store.filterIn("keys", k => k.order_id === orderId); }
function nextNo(kind, prefix) {
  if (!store.doc.counters) store.doc.counters = {};
  const n = Number(store.doc.counters[kind] || 1000) + 1;
  store.doc.counters[kind] = n;
  return `${prefix}-${n}`;
}
function markPaid(order, extra = {}) {
  if (order.status !== "paid") {
    order.status = "paid";
    order.paid_at = new Date().toISOString();
    if (!order.invoice_no) order.invoice_no = nextNo("invoice", "AX-I");
  }
  Object.assign(order, extra);
}
(function backfill() {
  let dirty = false;
  for (const o of store.doc.orders) {
    if (!o.order_no) { o.order_no = nextNo("order", "AX-O"); dirty = true; }
    if (o.status === "paid" && !o.invoice_no) { o.invoice_no = nextNo("invoice", "AX-I"); dirty = true; }
  }
  if (dirty) store.save();
})();
function audit(req, action, target, detail) {
  if (!Array.isArray(store.doc.admin_audit)) store.doc.admin_audit = [];
  if (store.doc.admin_audit.length > 3000) store.doc.admin_audit.splice(0, 600);
  store.push("admin_audit", { id: store.nextId(), action: String(action).slice(0, 40), target: String(target || "").slice(0, 120), detail: String(detail || "").slice(0, 300), ip: clientIp(req), at: new Date().toISOString() });
}
function getSupportInfo() {
  const s = store.doc.settings && store.doc.settings.support ? store.doc.settings.support : SUPPORT;
  return {
    phone: s.phone || SUPPORT.phone || "",
    email: s.email || SUPPORT.email || "",
    telegram: s.telegram || SUPPORT.telegram || "",
    hours: s.hours || "شنبه تا چهارشنبه ۹ تا ۱۸",
    address: s.address || "",
  };
}
function validateCoupon(code, items, subtotal) {
  if (!code) return { ok: true, discount: 0, coupon: null };
  const c = store.findIn("coupons", x => x.code.toLowerCase() === String(code).toLowerCase().trim() && x.active);
  if (!c) return { ok: false, error: "coupon_invalid" };
  if (c.expires_at && new Date(c.expires_at).getTime() < Date.now()) return { ok: false, error: "coupon_expired" };
  if (c.max_uses && c.used >= c.max_uses) return { ok: false, error: "coupon_used" };
  if (c.min_amount && subtotal < c.min_amount) return { ok: false, error: "coupon_min", min: c.min_amount };
  if (c.applicable_plans && c.applicable_plans.length) {
    const ok = items.some(it => c.applicable_plans.includes(it.plan));
    if (!ok) return { ok: false, error: "coupon_plan" };
  }
  let discount = 0;
  if (c.discount_type === "percent") discount = Math.round(subtotal * (Number(c.discount_value) / 100));
  else discount = Number(c.discount_value);
  discount = Math.min(discount, subtotal);
  return { ok: true, discount, coupon: c };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.get("/api/captcha", (req, res) => {
  if (!guardRate(req, res, 30, 60_000)) return;
  const ch = captcha.newChallenge();
  res.json({ ok: true, id: ch.id, question: ch.question });
});

app.post("/api/auth/register", async (req, res) => {
  if (!guardRate(req, res, 10, 10 * 60_000)) return;
  if (String(req.body.company || "")) return res.status(400).json({ ok: false, error: "bot_detected" });
  if (!validCaptcha(req.body)) return res.status(400).json({ ok: false, error: "captcha_failed" });
  const ident = normalizeIdentity(req.body.identity);
  if (!ident) return res.status(400).json({ ok: false, error: "identity_invalid" });
  const password = String(req.body.password || "");
  if (password.length < 8) return res.status(400).json({ ok: false, error: "password_short" });
  let user = store.findIn("users", u => u.identity === ident.value);
  if (user && user.verified) return res.status(400).json({ ok: false, error: "identity_taken" });
  if (!user) {
    user = store.push("users", {
      id: store.nextId(),
      identity: ident.value,
      identity_kind: ident.kind,
      password_hash: bcrypt.hashSync(password, 10),
      display_name: String(req.body.display_name || "").slice(0, 80),
      verified: false,
      disabled: false,
      created_at: new Date().toISOString(),
      last_login: "",
    });
  } else {
    user.password_hash = bcrypt.hashSync(password, 10);
    if (req.body.display_name) user.display_name = String(req.body.display_name).slice(0, 80);
  }
  const otp = await issueOtp(user);
  const resp = { ok: true, need_verify: true, identity: notify.mask(ident.value) };
  if (String(ENV.DEV_OTP_FALLBACK || "0") === "1") resp.dev_code = otp.dev_code;
  res.json(resp);
});

app.post("/api/auth/verify", (req, res) => {
  if (!guardRate(req, res, 20, 10 * 60_000)) return;
  const ident = normalizeIdentity(req.body.identity);
  const user = ident && store.findIn("users", u => u.identity === ident.value);
  const otp = ident && store.findIn("otps", o => o.identity === ident.value);
  if (!user || !otp) return res.status(400).json({ ok: false, error: "otp_missing" });
  if (otp.expires < Date.now()) return res.status(400).json({ ok: false, error: "otp_expired" });
  if (otp.attempts >= 5) return res.status(400).json({ ok: false, error: "otp_locked" });
  if (!bcrypt.compareSync(String(req.body.code || ""), otp.code_hash)) {
    otp.attempts += 1; store.save();
    return res.status(400).json({ ok: false, error: "otp_wrong" });
  }
  store.doc.otps = store.doc.otps.filter(o => o.identity !== ident.value);
  user.verified = true;
  user.last_login = new Date().toISOString();
  store.save();
  res.json({ ok: true, token: signSession(user), user: publicUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  if (!guardRate(req, res, 15, 10 * 60_000)) return;
  if (String(req.body.company || "")) return res.status(400).json({ ok: false, error: "bot_detected" });
  if (!validCaptcha(req.body)) return res.status(400).json({ ok: false, error: "captcha_failed" });
  const ident = normalizeIdentity(req.body.identity);
  const user = ident && store.findIn("users", u => u.identity === ident.value);
  if (!user || !bcrypt.compareSync(String(req.body.password || ""), user.password_hash)) {
    return res.status(400).json({ ok: false, error: "bad_credentials" });
  }
  if (user.disabled) return res.status(403).json({ ok: false, error: "user_disabled" });
  if (!user.verified) {
    const otp = await issueOtp(user);
    const resp = { ok: true, need_verify: true, identity: notify.mask(user.identity) };
    if (String(ENV.DEV_OTP_FALLBACK || "0") === "1") resp.dev_code = otp.dev_code;
    return res.json(resp);
  }
  user.last_login = new Date().toISOString();
  store.save();
  res.json({ ok: true, token: signSession(user), user: publicUser(user) });
});

app.post("/api/auth/forgot", async (req, res) => {
  if (!guardRate(req, res, 5, 10 * 60_000)) return;
  if (!validCaptcha(req.body)) return res.status(400).json({ ok: false, error: "captcha_failed" });
  const ident = normalizeIdentity(req.body.identity);
  const user = ident && store.findIn("users", u => u.identity === ident.value);
  if (!user) return res.json({ ok: true, identity: notify.mask(ident ? ident.value : ""), dev_code: null, msg: "if exists, code sent" });
  const otp = await issueOtp(user);
  const resp = { ok: true, identity: notify.mask(user.identity) };
  if (String(ENV.DEV_OTP_FALLBACK || "0") === "1") resp.dev_code = otp.dev_code;
  res.json(resp);
});

app.post("/api/auth/reset", (req, res) => {
  if (!guardRate(req, res, 10, 10 * 60_000)) return;
  const ident = normalizeIdentity(req.body.identity);
  const user = ident && store.findIn("users", u => u.identity === ident.value);
  const otp = ident && store.findIn("otps", o => o.identity === ident.value);
  if (!user || !otp) return res.status(400).json({ ok: false, error: "otp_missing" });
  if (otp.expires < Date.now()) return res.status(400).json({ ok: false, error: "otp_expired" });
  if (!bcrypt.compareSync(String(req.body.code || ""), otp.code_hash)) return res.status(400).json({ ok: false, error: "otp_wrong" });
  const pass = String(req.body.password || "");
  if (pass.length < 8) return res.status(400).json({ ok: false, error: "password_short" });
  user.password_hash = bcrypt.hashSync(pass, 10);
  store.doc.otps = store.doc.otps.filter(o => o.identity !== ident.value);
  user.verified = true;
  store.save();
  res.json({ ok: true, token: signSession(user) });
});

app.get("/api/me", authRequired, (req, res) => {
  const orders = store.filterIn("orders", o => o.user_id === req.user.id).map(o => ({
    id: o.id, order_no: o.order_no || "", invoice_no: o.invoice_no || "", group_id: o.group_id || "",
    plan: o.plan, plans: o.plans || (o.plan ? [o.plan] : []), items: o.items || [], amount: o.amount, original_amount: o.original_amount || o.amount,
    discount: o.discount || 0, coupon: o.coupon || "", status: o.status, ref_id: o.ref_id || "", grant: Boolean(o.grant),
    created_at: o.created_at, paid_at: o.paid_at || "", keys: orderKeys(o.id).map(k => ({
      key: k.key, status: k.status, plan: k.plan, activated_at: k.activated_at || "", expires_at: k.expires_at || "", replacements: k.replacements || 0,
    })),
  })).reverse();
  const wishlist = store.filterIn("wishlists", w => w.user_id === req.user.id).map(w => w.product_id);
  res.json({ ok: true, user: { ...publicUser(req.user), display_name: req.user.display_name || "" }, orders, wishlist });
});

app.post("/api/me/profile", authRequired, (req, res) => {
  const name = String(req.body.display_name || "").slice(0, 80);
  if (name) req.user.display_name = name;
  store.save();
  res.json({ ok: true, user: publicUser(req.user) });
});

app.post("/api/me/password", authRequired, (req, res) => {
  const cur = String(req.body.current || "");
  const next = String(req.body.next || "");
  if (!bcrypt.compareSync(cur, req.user.password_hash)) return res.status(400).json({ ok: false, error: "bad_credentials" });
  if (next.length < 8) return res.status(400).json({ ok: false, error: "password_short" });
  req.user.password_hash = bcrypt.hashSync(next, 10);
  store.save();
  res.json({ ok: true });
});

app.get("/api/support/info", (req, res) => {
  res.json({ ok: true, ...getSupportInfo(), site: store.doc.settings.site || {} });
});

app.get("/api/site/info", (req, res) => {
  res.json({ ok: true, support: getSupportInfo(), site: store.doc.settings.site || {}, stats: { users: store.doc.users.length, orders: store.filterIn("orders", o => o.status === "paid").length, keys: store.doc.keys.length } });
});

// ---------------------------------------------------------------------------
// Products & Coupons (public)
// ---------------------------------------------------------------------------
app.get("/api/products", (req, res) => {
  res.json({ ok: true, products: getProducts(), faqs: store.doc.settings.faqs || defaultFaqs() });
});
function defaultFaqs() {
  return [
    { q: "کلید بعد از پرداخت چقدر طول می‌کشد؟", a: "بلافاصله. بعد از تایید زرین‌پال، کلید در حساب شما و صفحه موفقیت نمایش داده می‌شود." },
    { q: "کلید روی چند سیستم فعال می‌شود؟", a: "هر کلید یک‌بارمصرف و بایند به یک سیستم است. تا ۳ بار بازیابی رایگان دارید." },
    { q: "اگر سیستم عوض شد چه کنم؟", a: "از تب بازیابی کلید، با همان سفارش یک کلید جایگزین رایگان بگیرید." },
    { q: "پشتیبانی چطور پاسخ می‌دهد؟", a: "از تب پشتیبانی تیکت بزنید؛ معمولا کمتر از ۶ ساعت پاسخ می‌دهیم. راه‌های تماس مستقیم هم هست." },
    { q: "زرین‌پال امن است؟", a: "بله، پرداخت مستقیما در درگاه زرین‌پال انجام می‌شود؛ ما شماره کارت شما را نمی‌بینیم." },
  ];
}
app.get("/api/products/:id", (req, res) => {
  const p = findProduct(req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, product: p });
});
app.post("/api/coupons/validate", authRequired, (req, res) => {
  const items = (req.body.items || []).map(it => ({ plan: String(it.plan || "").toLowerCase(), qty: Number(it.qty || 1) })).filter(it => it.plan);
  if (!items.length) return res.status(400).json({ ok: false, error: "empty" });
  let subtotal = 0;
  for (const it of items) {
    const pr = findProduct(it.plan);
    if (!pr) return res.status(400).json({ ok: false, error: "plan_unknown" });
    subtotal += pr.price_rial * (it.qty || 1);
  }
  const v = validateCoupon(req.body.code, items, subtotal);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error, min: v.min });
  res.json({ ok: true, discount: v.discount, total: subtotal - v.discount, subtotal });
});
app.post("/api/wishlist/toggle", authRequired, (req, res) => {
  const pid = String(req.body.product_id || "").toLowerCase();
  if (!findProduct(pid)) return res.status(400).json({ ok: false, error: "plan_unknown" });
  const idx = store.doc.wishlists.findIndex(w => w.user_id === req.user.id && w.product_id === pid);
  if (idx >= 0) { store.doc.wishlists.splice(idx, 1); store.save(); return res.json({ ok: true, wishlisted: false }); }
  store.push("wishlists", { user_id: req.user.id, product_id: pid, at: new Date().toISOString() });
  res.json({ ok: true, wishlisted: true });
});

// ---------------------------------------------------------------------------
// Plans legacy + purchase
// ---------------------------------------------------------------------------
app.get("/api/plans", (req, res) => {
  const prods = getProducts();
  res.json({ ok: true, plans: prods.map(p => ({ id: p.id, months: p.months, days: p.days, price_rial: p.price_rial, title: p.title })) });
});

app.post("/api/orders", authRequired, async (req, res) => {
  if (!guardRate(req, res, 10, 60_000)) return;
  if (!req.user.verified) return res.status(403).json({ ok: false, error: "not_verified" });
  const plan = findProduct(req.body.plan);
  if (!plan) return res.status(400).json({ ok: false, error: "plan_unknown" });
  // coupon
  let discount = 0; let couponCode = "";
  if (req.body.coupon) {
    const v = validateCoupon(req.body.coupon, [{ plan: plan.id, qty: 1 }], plan.price_rial);
    if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
    discount = v.discount; couponCode = v.coupon ? v.coupon.code : "";
  }
  const finalAmount = plan.price_rial - discount;
  const order = store.push("orders", {
    id: store.nextId(),
    order_no: nextNo("order", "AX-O"),
    user_id: req.user.id,
    plan: plan.id,
    plans: [plan.id],
    items: [{ plan: plan.id, title: plan.title, qty: 1, price: plan.price_rial }],
    amount: finalAmount,
    original_amount: plan.price_rial,
    discount,
    coupon: couponCode,
    status: "pending",
    created_at: new Date().toISOString(),
    authority: "",
    ref_id: "",
  });
  if (!zarinpal.configured) {
    order.status = "gateway_error"; store.save();
    return res.status(503).json({ ok: false, error: "gateway_not_configured", order_id: order.id });
  }
  try {
    const callback = `${PUBLIC_BASE}/api/pay/callback?order=${order.id}`;
    const meta = req.user.identity_kind === "gmail" ? { email: req.user.identity } : { mobile: req.user.identity };
    const pay = await zarinpal.request({ amount: order.amount, callbackUrl: callback, description: `AURION ${plan.title} — ${order.order_no}`, ...meta });
    order.authority = pay.authority; store.save();
    res.json({ ok: true, order_id: order.id, order_no: order.order_no, pay_url: pay.payUrl, amount: order.amount, discount });
  } catch (exc) {
    order.status = "gateway_error"; store.save();
    res.status(502).json({ ok: false, error: String(exc.message || exc) });
  }
});

app.post("/api/cart/checkout", authRequired, async (req, res) => {
  if (!guardRate(req, res, 10, 60_000)) return;
  if (!req.user.verified) return res.status(403).json({ ok: false, error: "not_verified" });
  const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
  const items = rawItems.map(it => ({ plan: String(it.plan || it.id || "").toLowerCase(), qty: Math.max(1, Math.min(10, Number(it.qty || 1))) })).filter(it => it.plan && findProduct(it.plan));
  if (!items.length) return res.status(400).json({ ok: false, error: "empty_cart" });
  let subtotal = 0;
  const detailed = [];
  for (const it of items) {
    const pr = findProduct(it.plan);
    const line = pr.price_rial * it.qty;
    subtotal += line;
    detailed.push({ plan: pr.id, title: pr.title, qty: it.qty, price: pr.price_rial, line_total: line, days: pr.days });
  }
  const couponRes = validateCoupon(req.body.coupon, items, subtotal);
  if (!couponRes.ok) return res.status(400).json({ ok: false, error: couponRes.error, min: couponRes.min });
  const discount = couponRes.discount || 0;
  const total = subtotal - discount;
  if (total < 1000) return res.status(400).json({ ok: false, error: "amount_low" });
  const groupId = nextNo("order", "AX-G");
  const order = store.push("orders", {
    id: store.nextId(),
    order_no: nextNo("order", "AX-O"),
    group_id: groupId,
    user_id: req.user.id,
    plan: detailed[0].plan,
    plans: detailed.map(d => d.plan),
    items: detailed,
    amount: total,
    original_amount: subtotal,
    discount,
    coupon: couponRes.coupon ? couponRes.coupon.code : "",
    status: "pending",
    created_at: new Date().toISOString(),
    authority: "",
    ref_id: "",
  });
  if (!zarinpal.configured) { order.status = "gateway_error"; store.save(); return res.status(503).json({ ok: false, error: "gateway_not_configured" }); }
  try {
    const callback = `${PUBLIC_BASE}/api/pay/callback?order=${order.id}`;
    const meta = req.user.identity_kind === "gmail" ? { email: req.user.identity } : { mobile: req.user.identity };
    const pay = await zarinpal.request({ amount: total, callbackUrl: callback, description: `AURION سبد ${groupId} — ${detailed.map(d=>d.title).join(", ").slice(0,120)}`, ...meta });
    order.authority = pay.authority; store.save();
    if (couponRes.coupon) { couponRes.coupon.used = (couponRes.coupon.used || 0) + 1; store.save(); }
    res.json({ ok: true, order_id: order.id, order_no: order.order_no, group_id: groupId, pay_url: pay.payUrl, subtotal, discount, total, items: detailed });
  } catch (exc) {
    order.status = "gateway_error"; store.save();
    res.status(502).json({ ok: false, error: String(exc.message || exc) });
  }
});

app.get("/api/pay/callback", async (req, res) => {
  const orderId = Number(req.query.order || 0);
  const authority = String(req.query.Authority || "");
  const status = String(req.query.Status || "");
  const order = store.findIn("orders", o => o.id === orderId);
  const done = (q) => res.redirect("/?" + q + "#/done");
  if (!order || !authority || order.authority !== authority) return done("paid=0&why=order");
  if (order.status === "paid") {
    const k = orderKeys(order.id)[0];
    return done(`paid=1&plan=${order.plan}&key=${encodeURIComponent(k ? k.key : "")}&ord=${encodeURIComponent(order.order_no || "")}&inv=${encodeURIComponent(order.invoice_no || "")}&group=${encodeURIComponent(order.group_id || "")}`);
  }
  if (status !== "OK") { order.status = "cancelled"; store.save(); return done("paid=0&why=cancelled"); }
  try {
    const v = await zarinpal.verify({ amount: order.amount, authority });
    if (!v.ok && !(v.already && order.status === "paid")) { order.status = "verify_failed"; store.save(); return done(`paid=0&why=verify&code=${v.code ?? ""}`); }
    if (order.status !== "paid") {
      markPaid(order, { ref_id: String(v.refId || "") });
      const items = order.items && order.items.length ? order.items : [{ plan: order.plan, qty: 1 }];
      const minted = [];
      for (const it of items) {
        const qty = Number(it.qty || 1);
        for (let i = 0; i < qty; i++) {
          const k = store.push("keys", {
            id: store.nextId(), key: keys.mint(it.plan, KEY_PRIV), plan: it.plan, order_id: order.id, user_id: order.user_id,
            status: "unused", machine: "", replacements: 0, created_at: new Date().toISOString(),
          });
          minted.push(k);
        }
      }
      store.save();
      const firstKey = minted[0] ? minted[0].key : "";
      return done(`paid=1&plan=${order.plan}&key=${encodeURIComponent(firstKey)}&keys=${encodeURIComponent(minted.map(k=>k.key).join(","))}&ord=${encodeURIComponent(order.order_no || "")}&inv=${encodeURIComponent(order.invoice_no || "")}&group=${encodeURIComponent(order.group_id || "")}&count=${minted.length}`);
    }
    return done(`paid=1&plan=${order.plan}`);
  } catch (exc) {
    return done("paid=0&why=network&message=" + encodeURIComponent(String(exc.message || exc)));
  }
});

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------
app.post("/api/keys/recover", authRequired, (req, res) => {
  if (!guardRate(req, res, 6, 60 * 60_000)) return;
  if (!validCaptcha(req.body)) return res.status(400).json({ ok: false, error: "captcha_failed" });
  const raw = keys.normalizeKey(req.body.key);
  const row = store.findIn("keys", k => k.user_id === req.user.id && (k.key === raw || k.order_id === Number(req.body.order_id || 0)));
  if (!row) return res.status(404).json({ ok: false, error: "key_not_found" });
  const order = store.findIn("orders", o => o.id === row.order_id);
  if (!order || order.status !== "paid") return res.status(400).json({ ok: false, error: "order_unpaid" });
  if ((row.replacements || 0) >= MAX_REPLACEMENTS) return res.status(400).json({ ok: false, error: "replacement_limit", max: MAX_REPLACEMENTS });
  row.status = "replaced"; row.replaced_at = new Date().toISOString();
  const fresh = store.push("keys", {
    id: store.nextId(), key: keys.mint(row.plan, KEY_PRIV), plan: row.plan, order_id: row.order_id, user_id: row.user_id,
    status: "unused", machine: "", replacements: (row.replacements || 0) + 1, replacement_of: row.key, note: "free recovery", created_at: new Date().toISOString(),
  });
  store.save();
  res.json({ ok: true, key: fresh.key, plan: fresh.plan, replacements_left: MAX_REPLACEMENTS - fresh.replacements });
});

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------
app.get("/api/support/info", (req, res) => { res.json({ ok: true, ...getSupportInfo() }); });
function ticketSummary(t, admin) {
  return { id: t.id, ticket_no: t.ticket_no, subject: t.subject, order_no: t.order_no || "", status: t.status, created_at: t.created_at, updated_at: t.updated_at, unread: Boolean(admin ? t.unread_admin : t.unread_user), messages: t.messages.length };
}
app.post("/api/support/tickets", authRequired, (req, res) => {
  if (!guardRate(req, res, 8, 60 * 60_000)) return;
  if (!req.user.verified) return res.status(403).json({ ok: false, error: "not_verified" });
  const subject = String(req.body.subject || "").trim().slice(0, 120);
  const body = String(req.body.body || "").trim().slice(0, 4000);
  if (subject.length < 3 || body.length < 5) return res.status(400).json({ ok: false, error: "ticket_short" });
  const openMine = store.filterIn("tickets", t => t.user_id === req.user.id && t.status !== "closed");
  if (openMine.length >= 10) return res.status(400).json({ ok: false, error: "too_many_open" });
  let orderNo = String(req.body.order_no || "").trim().slice(0, 24);
  if (orderNo && !store.findIn("orders", o => o.user_id === req.user.id && o.order_no === orderNo)) orderNo = "";
  const now = new Date().toISOString();
  const t = store.push("tickets", {
    id: store.nextId(), ticket_no: nextNo("ticket", "AX-T"), user_id: req.user.id, subject, order_no: orderNo, status: "open",
    priority: String(req.body.priority || "normal").slice(0, 10),
    category: String(req.body.category || "general").slice(0, 20),
    messages: [{ from: "user", body, at: now }], created_at: now, updated_at: now, unread_admin: true, unread_user: false,
  });
  res.json({ ok: true, ticket_no: t.ticket_no, id: t.id });
});
app.get("/api/support/tickets", authRequired, (req, res) => {
  const rows = store.filterIn("tickets", t => t.user_id === req.user.id).map(t => ticketSummary(t, false)).reverse();
  res.json({ ok: true, tickets: rows });
});
app.get("/api/support/ticket", authRequired, (req, res) => {
  const t = store.findIn("tickets", x => x.id === Number(req.query.id || 0) && x.user_id === req.user.id);
  if (!t) return res.status(404).json({ ok: false, error: "ticket_not_found" });
  t.unread_user = false; store.save();
  res.json({ ok: true, ...ticketSummary(t, false), priority: t.priority || "normal", category: t.category || "general", messages: t.messages });
});
app.post("/api/support/reply", authRequired, (req, res) => {
  if (!guardRate(req, res, 30, 60 * 60_000)) return;
  const t = store.findIn("tickets", x => x.id === Number(req.body.id || 0) && x.user_id === req.user.id);
  if (!t) return res.status(404).json({ ok: false, error: "ticket_not_found" });
  if (t.status === "closed") return res.status(400).json({ ok: false, error: "ticket_closed" });
  const body = String(req.body.body || "").trim().slice(0, 4000);
  if (body.length < 2) return res.status(400).json({ ok: false, error: "ticket_short" });
  if (t.messages.length >= 200) return res.status(400).json({ ok: false, error: "ticket_full" });
  const now = new Date().toISOString();
  t.messages.push({ from: "user", body, at: now }); t.status = "open"; t.updated_at = now; t.unread_admin = true; store.save();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Desk API
// ---------------------------------------------------------------------------
app.post("/api/desk/activate", (req, res) => {
  if (!guardRate(req, res, 30, 60_000)) return;
  const decoded = keys.decodeKey(req.body.key, KEY_PRIV);
  if (!decoded) return res.json({ ok: false, error: "invalid_key" });
  const machine = String(req.body.machine || "").trim();
  if (decoded.plan === "developer") {
    const nowIso = new Date().toISOString();
    let row = store.findIn("owner_keys", k => k.key === decoded.key);
    if (!row) row = store.push("owner_keys", { id: store.nextId(), key: decoded.key, machines: [], revoked: false, note: "auto-registered", created_at: nowIso, last_seen: nowIso });
    if (row.revoked) return res.json({ ok: false, error: "key_revoked" });
    if (!row.machines.includes(machine)) {
      if (row.machines.length >= MAX_OWNER_MACHINES) return res.json({ ok: false, error: "machine_limit", detail: `owner key bound to ${MAX_OWNER_MACHINES}` });
      row.machines.push(machine);
    }
    row.last_seen = nowIso; store.save();
    return res.json({ ok: true, plan: "developer", plan_label: "developer", activated_at: row.created_at, expires_at: null, owner: true, machines_used: row.machines.length, machines_max: MAX_OWNER_MACHINES });
  }
  const row = store.findIn("keys", k => k.key === decoded.key);
  if (!row) return res.json({ ok: false, error: "unknown_key" });
  if (row.status === "revoked") return res.json({ ok: false, error: "key_revoked" });
  if (row.status === "replaced") return res.json({ ok: false, error: "key_replaced", recover: true });
  if (row.status === "active") {
    if (row.machine === machine) return res.json({ ok: true, plan: row.plan, plan_label: keys.PLAN_LABEL[row.plan], activated_at: row.activated_at, expires_at: row.expires_at, machine_unchanged: true });
    if (!row.machine) { row.machine = machine; store.save(); return res.json({ ok: true, plan: row.plan, plan_label: keys.PLAN_LABEL[row.plan], activated_at: row.activated_at, expires_at: row.expires_at, rebind: true }); }
    return res.json({ ok: false, error: "machine_mismatch", recover: true });
  }
  const now = new Date().toISOString();
  row.status = "active"; row.machine = machine; row.activated_at = now; row.expires_at = keys.expiresAt(now, row.plan); store.save();
  res.json({ ok: true, plan: row.plan, plan_label: keys.PLAN_LABEL[row.plan], activated_at: now, expires_at: row.expires_at });
});
function keyHashOf(rawKey) { return crypto.createHash("sha256").update(keys.normalizeKey(rawKey)).digest("hex"); }
app.post("/api/desk/heartbeat", (req, res) => {
  if (!guardRate(req, res, 60, 60_000)) return;
  const kh = String(req.body.key_hash || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(kh)) return res.json({ ok: false, error: "invalid_key" });
  const machine = String(req.body.machine || "").trim();
  const ip = clientIp(req);
  const now = new Date().toISOString();
  let row = store.findIn("keys", k => keyHashOf(k.key) === kh);
  let owner = false;
  if (!row) { row = store.findIn("owner_keys", k => keyHashOf(k.key) === kh); owner = Boolean(row); }
  if (!row) return res.json({ ok: false, error: "unknown_key" });
  const plan = owner ? "developer" : row.plan;
  const revoked = owner ? Boolean(row.revoked) : row.status === "revoked";
  row.last_seen = now; row.last_ip = ip;
  if (revoked) { store.save(); return res.json({ ok: false, error: "key_revoked", action: "downgrade", plan }); }
  if (!owner && row.status === "replaced") { store.save(); return res.json({ ok: false, error: "key_replaced", action: "downgrade", recover: true, plan }); }
  const bound = owner ? String((row.machines || [])[0] || "") : String(row.machine || "");
  if (bound && machine && bound !== machine) {
    if (store.doc.violations.length > 5000) store.doc.violations.splice(0, 1000);
    store.push("violations", { id: store.nextId(), plan, key_tail: String(row.key).slice(-8), bound_machine: bound, seen_machine: machine, ip, at: now });
    store.save();
    return res.json({ ok: false, error: "machine_mismatch", action: "downgrade", plan });
  }
  store.save();
  res.json({ ok: true, plan, status: owner ? (revoked ? "revoked" : "active") : row.status, expires_at: owner ? null : row.expires_at || "" });
});
app.post("/api/desk/status", (req, res) => {
  const decoded = keys.decodeKey(req.body.key, KEY_PRIV);
  if (!decoded) return res.json({ ok: false, error: "invalid_key" });
  if (decoded.plan === "developer") {
    const row = store.findIn("owner_keys", k => k.key === decoded.key);
    return res.json({ ok: true, status: row && row.revoked ? "revoked" : "active", plan: "developer", expires_at: "", revoked: Boolean(row && row.revoked), machines_used: row ? row.machines.length : 0, machines_max: MAX_OWNER_MACHINES });
  }
  const row = store.findIn("keys", k => k.key === decoded.key);
  if (!row) return res.json({ ok: false, error: "unknown_key" });
  res.json({ ok: true, status: row.status, plan: row.plan, expires_at: row.expires_at || "", revoked: row.status === "revoked" });
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
app.get("/api/admin/overview", adminRequired, (req, res) => {
  const paid = store.filterIn("orders", o => o.status === "paid");
  const revenue = paid.filter(o => !o.grant).reduce((s, o) => s + Number(o.amount || 0), 0);
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const dayOrders = paid.filter(o => (o.paid_at || "").slice(0, 10) === iso);
    last7.push({ date: iso, orders: dayOrders.length, revenue: dayOrders.reduce((s, o) => s + Number(o.amount || 0), 0) });
  }
  res.json({
    ok: true,
    users: store.doc.users.length,
    orders: paid.length,
    revenue,
    last7,
    keys: {
      unused: store.filterIn("keys", k => k.status === "unused").length,
      active: store.filterIn("keys", k => k.status === "active").length,
      revoked: store.filterIn("keys", k => k.status === "revoked").length,
      replaced: store.filterIn("keys", k => k.status === "replaced").length,
    },
    owner_keys: store.doc.owner_keys.length,
    violations: store.doc.violations.length,
    open_tickets: store.filterIn("tickets", t => t.status !== "closed").length,
    unread_tickets: store.filterIn("tickets", t => t.unread_admin && t.status !== "closed").length,
    coupons: store.doc.coupons.length,
    products: store.doc.products.length,
  });
});

app.post("/api/admin/mint", adminRequired, (req, res) => {
  if (!guardRate(req, res, 30, 60_000)) return;
  const plan = String(req.body.plan || "").toLowerCase();
  if (!keys.PLANS.includes(plan)) return res.status(400).json({ ok: false, error: "plan_unknown" });
  const count = Math.min(Math.max(Number(req.body.count || 1), 1), 50);
  const out = [];
  for (let i = 0; i < count; i++) {
    const row = store.push("keys", { id: store.nextId(), key: keys.mint(plan, KEY_PRIV), plan, order_id: 0, user_id: 0, status: "unused", machine: "", replacements: 0, note: String(req.body.note || "admin mint"), created_at: new Date().toISOString() });
    out.push(row.key);
  }
  store.save(); audit(req, "mint", plan, `${count} key(s)`);
  res.json({ ok: true, plan, keys: out });
});
app.get("/api/admin/keys", adminRequired, (req, res) => {
  const want = String(req.query.status || "");
  const q = String(req.query.q || "").toLowerCase();
  let rows = store.filterIn("keys", k => !want || k.status === want);
  if (q) rows = rows.filter(k => k.key.toLowerCase().includes(q) || k.plan.includes(q));
  rows = rows.slice(-500).reverse().map(k => ({
    key: k.key, plan: k.plan, status: k.status, order_id: k.order_id, user_id: k.user_id, machine: k.machine ? k.machine.slice(0, 12) + "…" : "", activated_at: k.activated_at || "", expires_at: k.expires_at || "", replacements: k.replacements || 0, note: k.note || "", created_at: k.created_at,
  }));
  res.json({ ok: true, keys: rows });
});
app.post("/api/admin/revoke", adminRequired, (req, res) => {
  if (!guardRate(req, res, 60, 60_000)) return;
  const raw = keys.normalizeKey(req.body.key);
  const row = store.findIn("keys", k => k.key === raw);
  if (!row) return res.status(404).json({ ok: false, error: "key_not_found" });
  row.status = "revoked"; row.revoked_at = new Date().toISOString(); store.save();
  audit(req, "revoke", raw.slice(-10), `plan=${row.plan}`);
  res.json({ ok: true });
});
app.get("/api/admin/owner-keys", adminRequired, (req, res) => {
  res.json({ ok: true, max_machines: MAX_OWNER_MACHINES, keys: store.doc.owner_keys.map(k => ({ key: k.key, machines: k.machines.length, machine_list: k.machines, revoked: Boolean(k.revoked), note: k.note || "", created_at: k.created_at, last_seen: k.last_seen || "" })) });
});
app.post("/api/admin/owner-revoke", adminRequired, (req, res) => {
  const raw = keys.normalizeKey(req.body.key);
  const row = store.findIn("owner_keys", k => k.key === raw);
  if (!row) return res.status(404).json({ ok: false, error: "key_not_found" });
  row.revoked = req.body.revoked === false ? false : true;
  row.revoked_at = row.revoked ? new Date().toISOString() : undefined; store.save();
  audit(req, "owner_revoke", raw.slice(-10), row.revoked ? "revoked" : "restored");
  res.json({ ok: true, revoked: row.revoked });
});
app.post("/api/admin/owner-reset-machines", adminRequired, (req, res) => {
  const raw = keys.normalizeKey(req.body.key);
  const row = store.findIn("owner_keys", k => k.key === raw);
  if (!row) return res.status(404).json({ ok: false, error: "key_not_found" });
  row.machines = []; store.save();
  audit(req, "owner_reset_machines", raw.slice(-10), "freed");
  res.json({ ok: true, machines: 0 });
});
app.get("/api/admin/orders", adminRequired, (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(10, Number(req.query.limit || 30)));
  const q = String(req.query.q || "").toLowerCase();
  const status = String(req.query.status || "");
  let rows = store.doc.orders.slice().reverse();
  if (status) rows = rows.filter(o => o.status === status);
  if (q) rows = rows.filter(o => {
    const u = store.findIn("users", x => x.id === o.user_id);
    const ident = u ? u.identity : "";
    return (o.order_no || "").toLowerCase().includes(q) || (o.invoice_no || "").toLowerCase().includes(q) || ident.toLowerCase().includes(q) || (o.plan || "").includes(q);
  });
  const total = rows.length;
  const paged = rows.slice((page - 1) * limit, page * limit).map(o => ({
    id: o.id, order_no: o.order_no || "", invoice_no: o.invoice_no || "", group_id: o.group_id || "", user_id: o.user_id,
    identity: (() => { const u = store.findIn("users", x => x.id === o.user_id); return u ? notify.mask(u.identity) : o.user_id ? "#" + o.user_id : "—"; })(),
    raw_identity: (() => { const u = store.findIn("users", x => x.id === o.user_id); return u ? u.identity : ""; })(),
    plan: o.plan, plans: o.plans || [], items: o.items || [], amount: o.amount, original_amount: o.original_amount || o.amount, discount: o.discount || 0, coupon: o.coupon || "",
    status: o.status, grant: Boolean(o.grant), ref_id: o.ref_id || "", paid_at: o.paid_at || "", created_at: o.created_at, keys: orderKeys(o.id).length,
  }));
  res.json({ ok: true, orders: paged, total, page, limit, pages: Math.ceil(total / limit) });
});
app.post("/api/admin/grant", adminRequired, (req, res) => {
  if (!guardRate(req, res, 30, 60_000)) return;
  const ident = normalizeIdentity(req.body.identity);
  if (!ident) return res.status(400).json({ ok: false, error: "identity_invalid" });
  const user = store.findIn("users", u => u.identity === ident.value);
  if (!user) return res.status(404).json({ ok: false, error: "user_not_found" });
  if (user.disabled) return res.status(403).json({ ok: false, error: "user_disabled" });
  const plan = String(req.body.plan || "").toLowerCase();
  if (!keys.PLANS.includes(plan)) return res.status(400).json({ ok: false, error: "plan_unknown" });
  if (!KEY_PRIV) return res.status(503).json({ ok: false, error: "signing_not_configured" });
  const now = new Date().toISOString();
  const note = String(req.body.note || "support grant").slice(0, 200);
  const order = store.push("orders", { id: store.nextId(), order_no: nextNo("order", "AX-O"), user_id: user.id, plan, amount: 0, status: "pending", grant: true, note, created_at: now, authority: "", ref_id: "" });
  markPaid(order, { ref_id: "GRANT" });
  const key = store.push("keys", { id: store.nextId(), key: keys.mint(plan, KEY_PRIV), plan, order_id: order.id, user_id: user.id, status: "unused", machine: "", replacements: 0, note, created_at: now });
  store.save(); audit(req, "grant", notify.mask(user.identity), `${plan} · ${order.order_no}`);
  res.json({ ok: true, key: key.key, order_no: order.order_no, invoice_no: order.invoice_no });
});
app.post("/api/admin/reset-machines", adminRequired, (req, res) => {
  if (!guardRate(req, res, 60, 60_000)) return;
  const raw = keys.normalizeKey(req.body.key);
  const row = store.findIn("keys", k => k.key === raw);
  if (!row) return res.status(404).json({ ok: false, error: "key_not_found" });
  row.machine = ""; store.save();
  audit(req, "reset_machines", raw.slice(-10), "cleared");
  res.json({ ok: true });
});
app.post("/api/admin/user-disable", adminRequired, (req, res) => {
  if (!guardRate(req, res, 60, 60_000)) return;
  const ident = normalizeIdentity(req.body.identity);
  const user = ident && store.findIn("users", u => u.identity === ident.value);
  if (!user) return res.status(404).json({ ok: false, error: "user_not_found" });
  user.disabled = req.body.disabled !== false; store.save();
  audit(req, "user_disable", notify.mask(user.identity), user.disabled ? "disabled" : "enabled");
  res.json({ ok: true, disabled: user.disabled });
});
app.get("/api/admin/user-detail", adminRequired, (req, res) => {
  const ident = normalizeIdentity(req.query.identity);
  const user = ident && store.findIn("users", u => u.identity === ident.value);
  if (!user) return res.status(404).json({ ok: false, error: "user_not_found" });
  const orders = store.filterIn("orders", o => o.user_id === user.id).reverse().map(o => ({
    id: o.id, order_no: o.order_no || "", invoice_no: o.invoice_no || "", plan: o.plan, amount: o.amount, status: o.status, grant: Boolean(o.grant), created_at: o.created_at, paid_at: o.paid_at || "",
    keys: orderKeys(o.id).map(k => ({ key: k.key, status: k.status, plan: k.plan, activated_at: k.activated_at || "", expires_at: k.expires_at || "", machine: k.machine ? k.machine.slice(0, 10) + "…" : "" })),
  }));
  const tickets = store.filterIn("tickets", t => t.user_id === user.id).reverse().map(t => ticketSummary(t, true));
  res.json({ ok: true, user: publicUser(user), disabled: Boolean(user.disabled), orders, tickets, wishlist: store.filterIn("wishlists", w => w.user_id === user.id).map(w => w.product_id) });
});
app.get("/api/admin/tickets", adminRequired, (req, res) => {
  const st = String(req.query.status || "");
  const q = String(req.query.q || "").toLowerCase();
  let rows = store.doc.tickets.slice();
  if (st) rows = rows.filter(t => t.status === st);
  if (q) rows = rows.filter(t => t.ticket_no.toLowerCase().includes(q) || t.subject.toLowerCase().includes(q));
  rows = rows.slice(-300).map(t => { const u = store.findIn("users", x => x.id === t.user_id); return { ...ticketSummary(t, true), identity: u ? notify.mask(u.identity) : "?", raw_identity: u ? u.identity : "" }; }).reverse();
  res.json({ ok: true, tickets: rows });
});
app.get("/api/admin/ticket", adminRequired, (req, res) => {
  const t = store.findIn("tickets", x => x.id === Number(req.query.id || 0));
  if (!t) return res.status(404).json({ ok: false, error: "ticket_not_found" });
  t.unread_admin = false; store.save();
  const u = store.findIn("users", x => x.id === t.user_id);
  res.json({ ok: true, ...ticketSummary(t, true), identity: u ? notify.mask(u.identity) : "?", raw_identity: u ? u.identity : "", messages: t.messages, priority: t.priority || "normal", category: t.category || "general" });
});
app.post("/api/admin/tickets/reply", adminRequired, async (req, res) => {
  if (!guardRate(req, res, 60, 60_000)) return;
  const t = store.findIn("tickets", x => x.id === Number(req.body.id || 0));
  if (!t) return res.status(404).json({ ok: false, error: "ticket_not_found" });
  const body = String(req.body.body || "").trim().slice(0, 4000);
  if (body.length < 2) return res.status(400).json({ ok: false, error: "ticket_short" });
  if (t.messages.length >= 200) return res.status(400).json({ ok: false, error: "ticket_full" });
  const now = new Date().toISOString();
  t.messages.push({ from: "admin", body, at: now }); t.status = "answered"; t.updated_at = now; t.unread_user = true; store.save();
  audit(req, "ticket_reply", t.ticket_no, body.slice(0, 80));
  const u = store.findIn("users", x => x.id === t.user_id);
  if (u) await notify.sendNotice(ENV, u.identity_kind, u.identity, `AURION Keys — پاسخ تیکت ${t.ticket_no}`, `پاسخ پشتیبانی برای تیکت ${t.ticket_no} ثبت شد.`);
  res.json({ ok: true });
});
app.post("/api/admin/tickets/status", adminRequired, (req, res) => {
  if (!guardRate(req, res, 60, 60_000)) return;
  const t = store.findIn("tickets", x => x.id === Number(req.body.id || 0));
  if (!t) return res.status(404).json({ ok: false, error: "ticket_not_found" });
  const status = String(req.body.status || "");
  if (!["open", "answered", "closed"].includes(status)) return res.status(400).json({ ok: false, error: "status_unknown" });
  t.status = status; t.updated_at = new Date().toISOString(); store.save();
  audit(req, "ticket_status", t.ticket_no, status);
  res.json({ ok: true, status: t.status });
});
app.get("/api/admin/audit", adminRequired, (req, res) => {
  const q = String(req.query.q || "").toLowerCase();
  let rows = (store.doc.admin_audit || []).slice(-500).reverse();
  if (q) rows = rows.filter(a => (a.action + " " + a.target + " " + a.detail).toLowerCase().includes(q));
  res.json({ ok: true, audit: rows });
});
app.get("/api/admin/violations", adminRequired, (req, res) => { res.json({ ok: true, violations: store.doc.violations.slice(-200).reverse() }); });
app.get("/api/admin/users", adminRequired, (req, res) => {
  const q = String(req.query.q || "").toLowerCase();
  let users = store.doc.users.map(u => ({ ...publicUser(u), disabled: Boolean(u.disabled), orders: store.filterIn("orders", o => o.user_id === u.id).length, keys: store.filterIn("keys", k => k.user_id === u.id).length }));
  if (q) users = users.filter(u => u.raw_identity.toLowerCase().includes(q) || u.identity.toLowerCase().includes(q));
  users = users.reverse().slice(0, 200);
  res.json({ ok: true, users });
});

// Products admin
app.get("/api/admin/products", adminRequired, (req, res) => { res.json({ ok: true, products: store.doc.products }); });
app.post("/api/admin/products", adminRequired, (req, res) => {
  if (!guardRate(req, res, 20, 60_000)) return;
  const id = String(req.body.id || "").toLowerCase().trim();
  if (!id) return res.status(400).json({ ok: false, error: "id_required" });
  let p = store.findIn("products", x => x.id === id);
  const data = {
    id,
    sku: String(req.body.sku || `AX-${id.toUpperCase()}`).slice(0, 30),
    title: String(req.body.title || id).slice(0, 120),
    description: String(req.body.description || "").slice(0, 500),
    long_desc: String(req.body.long_desc || "").slice(0, 2000),
    days: Number(req.body.days || 30),
    months: Number(req.body.months || 1),
    price_rial: Number(req.body.price_rial || 0),
    price_toman: Math.round(Number(req.body.price_rial || 0) / 10),
    features: Array.isArray(req.body.features) ? req.body.features.map(s => String(s).slice(0, 100)).slice(0, 10) : [],
    popular: Boolean(req.body.popular),
    badge: String(req.body.badge || "").slice(0, 20),
    active: req.body.active !== false,
    stock: Number(req.body.stock || 9999),
    rating: Number(req.body.rating || 4.8),
    reviews: Number(req.body.reviews || 0),
    image: String(req.body.image || "").slice(0, 500),
    updated_at: new Date().toISOString(),
  };
  if (p) Object.assign(p, data);
  else { p = { ...data, created_at: new Date().toISOString() }; store.push("products", p); }
  store.save(); audit(req, "product_upsert", id, data.title);
  res.json({ ok: true, product: p });
});
app.delete("/api/admin/products/:id", adminRequired, (req, res) => {
  const id = String(req.params.id || "").toLowerCase();
  const idx = store.doc.products.findIndex(p => p.id === id);
  if (idx < 0) return res.status(404).json({ ok: false, error: "not_found" });
  store.doc.products.splice(idx, 1); store.save(); audit(req, "product_delete", id, "");
  res.json({ ok: true });
});

// Coupons admin
app.get("/api/admin/coupons", adminRequired, (req, res) => { res.json({ ok: true, coupons: store.doc.coupons.slice().reverse() }); });
app.post("/api/admin/coupons", adminRequired, (req, res) => {
  if (!guardRate(req, res, 20, 60_000)) return;
  const code = String(req.body.code || "").toUpperCase().trim().replace(/[^A-Z0-9_-]/g, "");
  if (!code || code.length < 3) return res.status(400).json({ ok: false, error: "code_invalid" });
  let c = store.findIn("coupons", x => x.code === code);
  const data = {
    code,
    discount_type: req.body.discount_type === "fixed" ? "fixed" : "percent",
    discount_value: Number(req.body.discount_value || 0),
    max_uses: Number(req.body.max_uses || 0),
    used: c ? c.used : 0,
    min_amount: Number(req.body.min_amount || 0),
    applicable_plans: Array.isArray(req.body.applicable_plans) ? req.body.applicable_plans.map(s => String(s).toLowerCase()) : [],
    expires_at: req.body.expires_at ? new Date(req.body.expires_at).toISOString() : "",
    active: req.body.active !== false,
    note: String(req.body.note || "").slice(0, 200),
    created_at: c ? c.created_at : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (data.discount_type === "percent" && (data.discount_value <= 0 || data.discount_value > 90)) return res.status(400).json({ ok: false, error: "discount_invalid" });
  if (data.discount_type === "fixed" && data.discount_value <= 0) return res.status(400).json({ ok: false, error: "discount_invalid" });
  if (c) Object.assign(c, data); else { c = { id: store.nextId(), ...data }; store.push("coupons", c); }
  store.save(); audit(req, "coupon_upsert", code, `${data.discount_type} ${data.discount_value}`);
  res.json({ ok: true, coupon: c });
});
app.delete("/api/admin/coupons/:code", adminRequired, (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  const idx = store.doc.coupons.findIndex(c => c.code === code);
  if (idx < 0) return res.status(404).json({ ok: false, error: "not_found" });
  store.doc.coupons.splice(idx, 1); store.save(); audit(req, "coupon_delete", code, "");
  res.json({ ok: true });
});

// Settings admin
app.get("/api/admin/settings", adminRequired, (req, res) => { res.json({ ok: true, settings: store.doc.settings, env_support: SUPPORT }); });
app.post("/api/admin/settings", adminRequired, (req, res) => {
  if (!guardRate(req, res, 20, 60_000)) return;
  const s = req.body || {};
  if (s.support) {
    store.doc.settings.support = {
      phone: String(s.support.phone || "").slice(0, 40),
      email: String(s.support.email || "").slice(0, 120),
      telegram: String(s.support.telegram || "").slice(0, 200),
      hours: String(s.support.hours || "").slice(0, 100),
      address: String(s.support.address || "").slice(0, 200),
    };
  }
  if (s.site) {
    store.doc.settings.site = {
      name: String(s.site.name || "AURION Keys").slice(0, 80),
      tagline: String(s.site.tagline || "").slice(0, 200),
      notice: String(s.site.notice || "").slice(0, 500),
    };
  }
  if (Array.isArray(s.faqs)) {
    store.doc.settings.faqs = s.faqs.map(f => ({ q: String(f.q || "").slice(0, 200), a: String(f.a || "").slice(0, 1000) })).slice(0, 20);
  }
  store.save(); audit(req, "settings_update", "site", "updated");
  res.json({ ok: true, settings: store.doc.settings });
});

app.get("/api/admin/export/orders", adminRequired, (req, res) => {
  const rows = store.doc.orders.slice(-1000).map(o => {
    const u = store.findIn("users", x => x.id === o.user_id);
    return { order_no: o.order_no, invoice_no: o.invoice_no || "", identity: u ? u.identity : "", plan: o.plan, amount: o.amount, status: o.status, created_at: o.created_at, paid_at: o.paid_at || "", ref_id: o.ref_id || "" };
  });
  res.json({ ok: true, orders: rows });
});

if (ALLOW_DEV_PAID) {
  app.post("/api/admin/dev-paid", adminRequired, (req, res) => {
    const order = store.findIn("orders", o => o.id === Number(req.body.order_id || 0));
    if (!order || order.status === "paid") return res.status(400).json({ ok: false, error: "order_state" });
    markPaid(order, { ref_id: "DEV-" + Date.now() });
    const items = order.items && order.items.length ? order.items : [{ plan: order.plan, qty: 1 }];
    const minted = [];
    for (const it of items) {
      const qty = Number(it.qty || 1);
      for (let i = 0; i < qty; i++) {
        const k = store.push("keys", { id: store.nextId(), key: keys.mint(it.plan, KEY_PRIV), plan: it.plan, order_id: order.id, user_id: order.user_id, status: "unused", machine: "", replacements: 0, note: "dev-paid", created_at: new Date().toISOString() });
        minted.push(k.key);
      }
    }
    store.save();
    res.json({ ok: true, keys: minted });
  });
  console.warn("[warn] ALLOW_DEV_PAID=1 — dev-paid enabled, never in production");
}

// ---------------------------------------------------------------------------
// Serve frontend with injected secrets
// ---------------------------------------------------------------------------
const publicDir = path.join(__dirname, "..", "public");
let appJsCache = "";
try {
  appJsCache = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
} catch {}
function getAppJs() {
  try {
    const raw = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
    return raw.replaceAll("__ADMIN_HASH__", ADMIN_HASH);
  } catch { return appJsCache.replaceAll("__ADMIN_HASH__", ADMIN_HASH); }
}
app.get("/app.js", (req, res) => {
  res.set("Cache-Control", "no-store").type("application/javascript").send(getAppJs());
});
app.use(express.static(publicDir, { setHeaders: (res, p) => { if (p.endsWith(".html")) res.setHeader("Cache-Control", "no-store"); } }));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(publicDir, "index.html"));
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`AURION key server FULL on :${PORT} (${PUBLIC_BASE}) gateway=${zarinpal.mode}${zarinpal.configured ? "" : " unconfigured"} adminHash=${ADMIN_HASH}`));
}
module.exports = { app, store };
