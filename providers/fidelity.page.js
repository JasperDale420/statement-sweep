// Runs inside Fidelity's Document Access Hub, where the sign-in already lives.
// Reads and downloads only. It presses nothing and changes nothing.
//
// Derived from PaperPull's apps/fidelity/fidelity_site.py (AGPL-3.0).
//
// PaperPull also calls dpservice.fidelity.com, for the list of accounts and
// for tax forms. That is another origin, so neither is asked for here: tax
// forms are left out, and the account's type is the "Brokerage" PaperPull
// itself falls back to.
(() => {
  const PAGE_HOST = "digitalservices.fidelity.com";
  const API = "/ftgw/dp/retail-am-financialdoc";
  const LIST_PATH = `${API}/v1/accounts/communications/financial-documents/statements`;
  const DOWNLOAD_PATH = `${API}/v2/accounts/communications/financial-documents/download`;
  // The page's own app identity. Not a credential; the API answers 400 without it.
  const APP_HEADERS = {
    appid: "AP160308",
    appname: "Document Access Hub",
    "fid-originating-app-id": "AP160308",
    "fid-originating-app-version": "1",
  };
  const KINDS = { STMT: "Statement", TC: "Trade Confirmation" };
  const FIRST_YEAR = 2016; // the oldest year the hub's picker offers
  const ACCOUNT_TYPE = "Brokerage";
  const DOC_ID = /^[A-Za-z0-9._:=+\/~-]{1,4096}$/;
  const ACCOUNT = /^[A-Za-z0-9-]{0,40}$/;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const LOGIN_URL_MARKERS = ["/login", "/logon", "/signin", "/sign-in", "/mfa", "/verify", "/onboarding"];
  const CHALLENGE_MARKERS = [
    "one-time passcode", "one time passcode", "enter the code", "verification code",
    "we sent a code", "text message", "authenticator", "confirm your identity",
    "verify your identity", "are you a robot", "captcha", "access denied",
    "your session has expired", "session timed out", "signed out",
  ];
  const RATE_LIMIT_MARKERS = ["too many requests", "rate limit", "try again later",
    "temporarily unavailable", "unusual traffic"];

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN_URL_MARKERS.some((m) => url.includes(m))
      || Boolean(document.querySelector("input[type='password']"));
  }

  // Visible text only. A page's source can carry every string its scripts
  // could ever show, on a normal day.
  function screenText() {
    const body = (document.body && document.body.innerText) || "";
    return `${document.title}\n${body.slice(0, 2000)}`.toLowerCase();
  }

  function onHub() {
    return location.protocol === "https:" && location.hostname === PAGE_HOST
      && location.pathname.includes("ent-documentcenter");
  }

  function realDate(year, month, day) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return "";
    return d.toISOString().slice(0, 10);
  }

  function dateFromText(text) {
    const s = text.trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(s);
    if (m) return realDate(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return realDate(+m[3], +m[1], +m[2]);
    m = /^([A-Z][a-z]{2})[a-z]*\.? (\d{1,2}), (\d{4})$/.exec(s);
    if (m && MONTHS.includes(m[1])) return realDate(+m[3], MONTHS.indexOf(m[1]) + 1, +m[2]);
    return "";
  }

  const seconds = (value) => {
    if (!/^\d+$/.test(String(value))) return null;
    const v = Number(value);
    return v > 1e11 ? Math.floor(v / 1000) : v;
  };

  // Fidelity's dates are epoch seconds at midnight Eastern. Twelve hours on,
  // read as UTC, is that calendar day in either half of the year.
  function dateOf(value) {
    const v = seconds(value);
    if (v === null) return dateFromText(String(value));
    const date = new Date((v + 12 * 3600) * 1000).toISOString().slice(0, 10);
    const year = +date.slice(0, 4);
    return year >= 2000 && year <= new Date().getFullYear() + 1 ? date : "";
  }

  function first(item, keys) {
    for (const key of keys) {
      if (item[key] !== undefined && item[key] !== null && item[key] !== "") return item[key];
    }
    return "";
  }

  async function post(path, body) {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...APP_HEADERS },
      body: JSON.stringify(body),
    });
    let json = null;
    try { json = JSON.parse(await response.text()); } catch (e) { /* stays null */ }
    return { status: response.status, json };
  }

  function titleOf(docType, item, account) {
    let title = KINDS[docType];
    if (docType === "STMT") {
      const start = seconds(item.periodStartDate), end = seconds(item.periodEndDate);
      if (start !== null && end !== null) {
        title = (end - start) / 86400 > 45 ? "Quarterly Statement" : "Monthly Statement";
      }
    }
    return `${title} ${account.slice(-4)}`.trim();
  }

  async function readList() {
    if (signedOut()) return { state: "signed_out" };
    const screen = screenText();
    if (CHALLENGE_MARKERS.some((m) => screen.includes(m))) return { state: "challenge" };
    if (RATE_LIMIT_MARKERS.some((m) => screen.includes(m))) {
      return { state: "stopped", why: "Fidelity says to slow down and try later.", docs: [] };
    }
    if (!onHub()) return { state: "no_list" };

    const docs = [];
    const counted = new Map();
    const newestFirst = () => docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const stop = (why) => ({ state: "stopped", why, docs: newestFirst() });

    const thisYear = new Date().getFullYear();
    for (const docType of Object.keys(KINDS)) {
      for (let year = thisYear; year >= FIRST_YEAR; year--) {
        let answer;
        try {
          answer = await post(LIST_PATH, {
            startDate: `${year}-01-01`, endDate: `${year}-12-31`, docType,
            hasCryptoAccount: false, annuityAccountLookup: docType === "STMT",
          });
        } catch (e) {
          return stop("Fidelity did not answer for the document list.");
        }
        if (answer.status === 401 || answer.status === 403) return { state: "signed_out" };
        if (answer.status !== 200) return stop(`Fidelity answered ${answer.status} for the document list.`);
        if (!answer.json || typeof answer.json !== "object") return stop("Fidelity's document list could not be read.");
        const statement = answer.json.statement || {};
        const items = (statement.docDetails || {}).docDetail || [];
        if (!Array.isArray(items)) return stop("Fidelity's document list could not be read.");
        for (const item of items) {
          if (!item || typeof item !== "object") return stop("A document in the list could not be read.");
          const format = (item.formatTypes || {}).formatType;
          if (format && format.isPDF === false) continue;
          const account = String(item.acctNum || "");
          const docId = String(first(item, ["id", "docId", "documentId"]));
          if (!ACCOUNT.test(account) || !DOC_ID.test(docId)) return stop("A document's number was not one this can read.");
          const date = dateOf(first(item, ["periodEndDate", "generatedDate", "availableDate", "date"]));
          if (!date) return stop("A document's date could not be read.");
          // A document is known by its kind, account and date. Fidelity's own
          // id does not last, so it is only what this one sweep asks for.
          const key = `${docType}-${account}-${date}`;
          const occurrence = counted.get(key) || 0;
          counted.set(key, occurrence + 1);
          docs.push({
            id: `${key}-${occurrence}`, date, title: titleOf(docType, item, account), method: "fetch",
            docId, docType, acctType: ACCOUNT_TYPE,
          });
        }
      }
    }
    return { state: "ok", docs: newestFirst() };
  }

  async function inflated(bytes, format) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function fetchPdf(doc) {
    if (!doc || !DOC_ID.test(doc.docId || "") || !Object.keys(KINDS).includes(doc.docType)
        || !/^[A-Za-z]{1,30}$/.test(doc.acctType || "")) {
      return { ok: false, why: "not a document this can ask for" };
    }
    if (!onHub()) return { ok: false, why: "The tab is not on Fidelity's document page." };
    let answer;
    try {
      answer = await post(DOWNLOAD_PATH, { id: doc.docId, formatType: "PDF", docType: doc.docType, acctType: doc.acctType });
    } catch (e) {
      return { ok: false, why: "Fidelity did not answer for that document." };
    }
    if (answer.status === 401 || answer.status === 403) {
      return { ok: false, signedOut: true, why: "Fidelity asked for a sign-in." };
    }
    if (answer.status !== 200) return { ok: false, why: `Fidelity answered ${answer.status}.` };
    const detail = ((answer.json || {}).document || {}).docDetail || {};
    if (typeof detail.content !== "string" || !detail.content) return { ok: false, why: "Fidelity sent no document." };
    let bytes;
    try {
      bytes = Uint8Array.from(atob(detail.content), (c) => c.charCodeAt(0));
    } catch (e) {
      return { ok: false, why: "That was not a PDF." };
    }
    if (!globalThis.__sweepPdf.isPdf(bytes) && String(detail.deflated || "").toUpperCase().startsWith("Y")) {
      for (const format of ["deflate", "deflate-raw", "gzip"]) {
        try {
          bytes = await inflated(bytes, format);
          break;
        } catch (e) { /* the next format */ }
      }
    }
    return globalThis.__sweepPdf.pdfResult(bytes);
  }

  globalThis.__sweep = { readList, fetchPdf };
})();
