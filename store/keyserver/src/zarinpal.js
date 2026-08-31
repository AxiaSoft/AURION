"use strict";
// ZarinPal Payment Gateway v4 (REST). Production first; set ZARINPAL_GATEWAY=sandbox
// while testing. Amounts are IRI Rial.

const HOSTS = {
  live: {
    request: "https://api.zarinpal.com/pg/v4/payment/request.json",
    verify: "https://api.zarinpal.com/pg/v4/payment/verify.json",
    startpay: "https://www.zarinpal.com/pg/StartPay/",
  },
  sandbox: {
    request: "https://sandbox.zarinpal.com/pg/v4/payment/request.json",
    verify: "https://sandbox.zarinpal.com/pg/v4/payment/verify.json",
    startpay: "https://sandbox.zarinpal.com/pg/StartPay/",
  },
};

class ZarinPal {
  constructor({ merchantId, gateway }) {
    this.merchantId = String(merchantId || "").trim();
    this.mode = HOSTS[gateway] ? gateway : "live";
  }

  get configured() { return Boolean(this.merchantId) && this.merchantId !== "00000000-0000-0000-0000-000000000000"; }
  host() { return HOSTS[this.mode]; }

  async request({ amount, callbackUrl, description, email, mobile }) {
    if (!this.configured) throw new Error("zarinpal merchant id is not configured");
    const res = await fetch(this.host().request, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchant_id: this.merchantId,
        amount: Math.round(Number(amount)),
        currency: "IRR",
        callback_url: callbackUrl,
        description: String(description || "AURION license").slice(0, 250),
        metadata: { email: email || undefined, mobile: mobile || undefined },
      }),
    });
    const json = await res.json().catch(() => ({}));
    const data = json.data || {};
    const errors = json.errors || {};
    if (!res.ok || (data.code !== 100 && data.code !== 101) || !data.authority) {
      const msg = errors.message || `zarinpal request failed (code ${data.code ?? res.status})`;
      const err = new Error(msg);
      err.code = data.code;
      throw err;
    }
    return {
      authority: data.authority,
      fee: data.fee,
      payUrl: this.host().startpay + encodeURIComponent(data.authority),
    };
  }

  async verify({ amount, authority }) {
    if (!this.configured) throw new Error("zarinpal merchant id is not configured");
    const res = await fetch(this.host().verify, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchant_id: this.merchantId,
        amount: Math.round(Number(amount)),
        authority: String(authority || ""),
      }),
    });
    const json = await res.json().catch(() => ({}));
    const data = json.data || {};
    // code 100 = first-time success, 101 = already verified (avoid double mint).
    if (data.code === 100 || data.code === 101) {
      return { ok: true, refId: data.ref_id, cardPan: data.card_pan || "", already: data.code === 101 };
    }
    return { ok: false, code: data.code, message: (json.errors || {}).message || `verify failed (${data.code})` };
  }
}

module.exports = { ZarinPal };
