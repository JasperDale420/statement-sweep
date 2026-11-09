// Runs inside PayPal's own page, where the sign-in already lives. Personal
// accounts only: it asks PayPal's own two addresses from the page, the list
// and each month's PDF, and presses nothing.
//
// Derived from PaperPull's apps/paypal/paypal_site.py (AGPL-3.0).
(() => {
  const HOST = "www.paypal.com";
  const LIST_PATH = "/myaccount/statements/api/statements";
  const DOWNLOAD_PATH = "/myaccount/statements/api/statements/download";
  const LOGIN_PATHS = ["/signin", "/signout", "/login", "/authflow", "/checkpoint", "/stepup", "/challenge"];
  const CHALLENGE = ["enter the code", "verification code", "6-digit", "two-step", "two-factor", "authenticator",
    "confirm your identity", "verify your identity", "confirm it's you", "we sent a code", "are you a robot",
    "captcha", "security challenge", "check your email", "check your phone", "your session has expired",
    "log in again", "access denied"];
  const RATE_LIMIT = ["too many requests", "rate limit", "try again later", "temporarily unavailable",
    "http error 429", "unusual traffic"];

  const onLoginPath = (path) => LOGIN_PATHS.some((m) => path.toLowerCase().includes(m));
  const signedOut = () => onLoginPath(location.pathname) || Boolean(document.querySelector("input[type='password']"));
  const visibleText = () => `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 1500)}`.toLowerCase();

  // The list's "20260801", the first of a month, and nothing else.
  function monthOf(key) {
    const m = /^(\d{4})(\d{2})01$/.exec(typeof key === "string" ? key : "");
    if (!m) return null;
    const year = +m[1], month = +m[2];
    return year >= 2000 && year <= 2100 && month >= 1 && month <= 12 ? { year, month } : null;
  }

  // A statement is dated by the last day of its month, as PaperPull files it.
  function monthEnd({ year, month }) {
    return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  }

  // A request from inside the page. A sign-in answer is said to be one: a 401
  // or 403, or an answer that landed off PayPal or on a sign-in page.
  async function ask(path) {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { accept: "application/json, application/pdf" },
    });
    let landed;
    try { landed = new URL(response.url); } catch (e) { landed = null; }
    const signedOutAnswer = response.status === 401 || response.status === 403
      || !landed || landed.hostname !== HOST || onLoginPath(landed.pathname);
    return { response, signedOutAnswer };
  }

  async function readList() {
    if (signedOut()) return { state: "signed_out" };
    const text = visibleText();
    if (CHALLENGE.some((m) => text.includes(m))) return { state: "challenge" };
    if (RATE_LIMIT.some((m) => text.includes(m))) return { state: "stopped", why: "PayPal is asking for a pause. Try again later.", docs: [] };
    const path = location.pathname;
    if (path.toLowerCase().startsWith("/businessmanage/") || path.startsWith("/reports/")) {
      return { state: "stopped", why: "This is a PayPal business account, whose statements this does not read.", docs: [] };
    }
    if (location.hostname !== HOST || !path.startsWith("/myaccount/statements")) return { state: "no_list" };

    let got;
    try {
      got = await ask(LIST_PATH);
    } catch (e) {
      return { state: "stopped", why: "PayPal's statements list did not answer.", docs: [] };
    }
    if (got.signedOutAnswer) return { state: "signed_out" };
    let answer = null;
    try { answer = await got.response.json(); } catch (e) { answer = null; }
    if (!answer || typeof answer !== "object" || !("data" in answer)) return { state: "signed_out" };
    const years = answer.data && answer.data.statements;
    if (!Array.isArray(years)) return { state: "stopped", why: "PayPal's statements list was not the shape this reads.", docs: [] };

    const docs = [];
    const seen = new Set();
    let unread = false;
    for (const y of years) {
      if (!y || !Array.isArray(y.details)) { unread = true; continue; }
      for (const entry of y.details) {
        const key = entry && entry.date;
        const month = monthOf(key);
        if (!month) { unread = true; continue; }
        if (seen.has(key)) continue;
        seen.add(key);
        docs.push({ id: key, date: monthEnd(month), title: "Monthly Statement", method: "fetch" });
      }
    }
    docs.sort((a, b) => (a.id < b.id ? 1 : -1));
    if (unread) return { state: "stopped", why: "A month in PayPal's list could not be read.", docs };
    return { state: "ok", docs };
  }

  async function fetchPdf(doc) {
    const key = doc && doc.id;
    const month = monthOf(key);
    if (!month) return { ok: false, why: "not a statement month" };
    if (doc.date !== monthEnd(month)) return { ok: false, why: "The month and its date do not agree." };
    if (location.hostname !== HOST || signedOut() || !location.pathname.startsWith("/myaccount")) {
      return { ok: false, signedOut: true, why: "The PayPal tab is not on a signed-in page." };
    }
    let got;
    try {
      got = await ask(`${DOWNLOAD_PATH}?monthList=${key}&reportType=standard`);
    } catch (e) {
      return { ok: false, why: "PayPal did not answer." };
    }
    if (got.signedOutAnswer) return { ok: false, signedOut: true, why: "PayPal asked for a sign-in." };
    const { response } = got;
    const type = (response.headers.get("content-type") || "").toLowerCase();
    if (!response.ok || !type.includes("pdf")) return { ok: false, why: `The site sent ${response.status} ${type.split(";")[0]}.` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    return globalThis.__sweepPdf.pdfResult(bytes);
  }

  globalThis.__sweep = { readList, fetchPdf };
})();
