"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const tls = require("tls");
const { DATA } = require("./paths");
const { load } = require("./config");

function logLine(line) {
  try {
    const log = path.join(DATA, "logs", "desk.log");
    fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(log), 0o700); } catch {}
    // redact OTP codes and passwords
    let safe = String(line || "");
    safe = safe.replace(/code=\d{6}/gi, "code=***");
    safe = safe.replace(/\d{6}/g, (m) => {
      // only redact if near code keyword, keep generic
      if (/code|otp/i.test(safe)) return "***";
      return m;
    });
    fs.appendFileSync(log, safe.endsWith("\n") ? safe : safe + "\n");
    try { fs.chmodSync(log, 0o600); } catch {}
  } catch { /* */ }
}

function otpCfg() {
  const cfg = load();
  return (cfg.license && cfg.license.otp) || {};
}

function write(sock, chunk) {
  return new Promise((resolve, reject) => sock.write(chunk, (err) => (err ? reject(err) : resolve())));
}

function read(sock) {
  return new Promise((resolve, reject) => {
    const onData = (buf) => {
      sock.off("error", onErr);
      resolve(buf.toString("utf8"));
    };
    const onErr = (err) => {
      sock.off("data", onData);
      reject(err);
    };
    sock.once("data", onData);
    sock.once("error", onErr);
  });
}

async function smtpSend({ to, subject, text }) {
  const otp = otpCfg();
  if (!otp.smtp_host || !otp.smtp_user || !to) {
    logLine(`[mail] queued log-only to=${String(to).slice(0,3)}*** subject=${subject}`);
    return { ok: true, channel: "log" };
  }
  const port = Number(otp.smtp_port || 587);
  const from = otp.smtp_from || otp.smtp_user;
  const host = String(otp.smtp_host || "").trim();
  if (!host) {
    logLine(`[mail] no host`);
    return { ok: true, channel: "log" };
  }
  return new Promise((resolve) => {
    const sock = net.connect({ host, port }, async () => {
      try {
        await read(sock);
        await write(sock, "EHLO aurion\r\n");
        await read(sock);
        await write(sock, "STARTTLS\r\n");
        const resp = await read(sock);
        if (!String(resp).startsWith("220")) throw new Error("STARTTLS not supported");
        const secure = tls.connect({
          socket: sock,
          servername: host,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
        });
        await new Promise((ok, bad) => {
          secure.once("secureConnect", () => {
            // verify cert
            if (!secure.authorized) {
              bad(new Error("TLS unauthorized: " + secure.authorizationError));
              return;
            }
            ok();
          });
          secure.once("error", bad);
        });
        await write(secure, "EHLO aurion\r\n");
        await read(secure);
        await write(secure, "AUTH LOGIN\r\n");
        await read(secure);
        await write(secure, Buffer.from(otp.smtp_user).toString("base64") + "\r\n");
        await read(secure);
        await write(secure, Buffer.from(otp.smtp_password || "").toString("base64") + "\r\n");
        const authResp = await read(secure);
        if (!String(authResp).startsWith("235")) throw new Error("SMTP auth failed");
        await write(secure, `MAIL FROM:<${from}>\r\n`);
        await read(secure);
        await write(secure, `RCPT TO:<${to}>\r\n`);
        await read(secure);
        await write(secure, "DATA\r\n");
        await read(secure);
        const body = `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n.\r\n`;
        await write(secure, body);
        await read(secure);
        await write(secure, "QUIT\r\n");
        secure.end();
        logLine(`[mail] sent to=${String(to).slice(0,3)}*** via ${host}`);
        resolve({ ok: true, channel: "smtp" });
      } catch (err) {
        logLine(`[mail] smtp failed ${err.message} to=${String(to).slice(0,3)}***`);
        resolve({ ok: false, channel: "log", error: err.message });
      }
    });
    sock.setTimeout(12000, () => {
      sock.destroy();
      logLine(`[mail] smtp timeout to=${String(to).slice(0,3)}***`);
      resolve({ ok: false, channel: "log", error: "timeout" });
    });
    sock.on("error", (err) => {
      logLine(`[mail] smtp error ${err.message}`);
      resolve({ ok: false, channel: "log", error: err.message });
    });
  });
}

async function smsSend({ to, text }) {
  const otp = otpCfg();
  if (!otp.sms_url || !to) {
    logLine(`[sms] queued log-only to=${String(to).slice(0,3)}***`);
    return { ok: true, channel: "log" };
  }
  logLine(`[sms] pending url=${otp.sms_url} to=${String(to).slice(0,3)}***`);
  return { ok: true, channel: "sms_pending" };
}

async function deliver({ gmail, phone, subject, text }) {
  const out = [];
  if (gmail) out.push(await smtpSend({ to: gmail, subject, text }));
  if (phone) out.push(await smsSend({ to: phone, text: `${subject}\n${text}` }));
  if (!out.length) {
    logLine(`[deliver] no channel ${subject}`);
    return { ok: true, channels: ["log"] };
  }
  return { ok: true, channels: out.map((x) => x.channel) };
}

module.exports = { smtpSend, smsSend, deliver, logLine };
