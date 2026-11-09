// Runs inside State Farm's Document Center. Reads and downloads only, and
// presses nothing.
//
// The document list is an answer only the page can get: the same address
// asked with cookies alone is refused, and the headers it needs are the
// page's own. So only a document control that carries its own PDF link can
// be saved here. A row behind "View Documents", which opens its PDF in a new
// tab, is reported instead.
//
// Derived from PaperPull's apps/statefarm/statefarm_site.py (AGPL-3.0).
(() => {
  const HOST = "edocuments.statefarm.com";
  const CONTROLS = "a, button, [role=button], [role=link]";
  const LOGIN_MARKERS = ["/login", "/signin", "/sign-in", "/auth/", "/mfa", "/verification", "/challenge", "/authenticate"];
  const CHALLENGE = ["enter the code", "verification code", "6-digit", "two-factor", "two-step", "authenticator",
    "confirm your identity", "verify your identity", "we sent a code", "device approval", "approve this login",
    "unusual", "are you a robot", "captcha", "let's verify", "check your email", "check your phone",
    "your session has expired", "log back in", "access denied", "reference #"];
  const RATE_LIMIT = ["too many requests", "rate limit", "try again later", "temporarily unavailable",
    "http error 429", "unusual traffic"];
  const FORBIDDEN = /(transfer|zelle|\bwire\b|\bpay\b|payment(?!\s+(receipts?|history))|bill\s*pay|autopay|auto\s*pay|deposit|withdraw|send\s+money|request\s+money|move\s+money|\bapply\b|open\s+(an?\s+)?account|close\s+account|\bloan\b|\bborrow|(?<!id )\bcards?\b|replace|activate|lock|unlock|\bpin\b|limit|overdraft|alerts?\b|\bbudget|\bgoal|\brewards?\b|\boffers?\b|enroll|unenroll|sign\s+up|paperless|delivery\s+preference|enable|disable|change\b|edit\b|update\b|modify|manage\b|set\s+up|delete|remove|cancel|dispute|password|passcode|username|profile\b|settings|preferences|contact\s+info|\baddress\b|confirm\b|submit|agree|accept|authorize|\bchat\b|contact\s+us|beneficiar|nickname|order\s+checks|stop\s+payment|(?<!excludes )\bclaims?\b|file\s+a\s+claim|report\s+(a\s+)?claim|coverage|\bquote\b|add\s+(a\s+)?(vehicle|driver|car|home|policy)|change\s+(my\s+)?policy|cancel\s+policy|renew\s+now|drive\s+safe|start\s+(a\s+)?quote|roadside|\bagent\b|contact\s+(my\s+)?agent|policy\s+change)/i;
  const SAFE = /(download|view|open|print|\bpdf\b|statement|document|\bletter\b|notice|1099|1098|5498|tax\s+(form|document)|history|id\s+cards?|renewal\s+(notice|bill)|receipts?\b|\bbills?\b|billing\b|policy\s+documents?|declarations?)/i;
  const BILL = /((download|view|print|open|get)\s*(my\s+|the\s+|this\s+|your\s+)?(statement|document|pdf|tax|letter|notice|1099|1098)|(statement|document|tax\s+form|1099|1098|5498)\s*\(?\s*pdf\s*\)?|\bpdf\b|^\s*(renewal\s+(notice|bill)|declarations?(\s+page)?|policy\s+documents?|id\s+cards?|insurance\s+cards?|premium\s+notice|billing\s+statement)\b|^\s*(view|download|open)\s*$)/i;
  const PDF_HREF = /\.pdf(\?|$)|\/pdf\b|format=pdf|statement.*download|download.*statement|docId|documentId/i;
  const VIEW_DOCUMENTS = /^\s*view\s+documents?\s*\d*\s*$/i;
  const DATES = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|(?<!\d)\d{1,2}\/\d{1,2}\/\d{4}(?!\d)|(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/gi;
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const LEFT = "The rest open only by \"View Documents\" in a new tab, and the list of their addresses is only for State Farm's own page, so nothing here can save them.";

  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nameOf = (el) => tidy(el.getAttribute("aria-label") || el.innerText);
  const stop = (why, docs = []) => ({ state: "stopped", why, docs });

  function iso(text) {
    let m, y, mo, d;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text))) { y = +m[1]; mo = +m[2] - 1; d = +m[3]; }
    else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text))) { mo = +m[1] - 1; d = +m[2]; y = +m[3]; }
    else if ((m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text))) { mo = MONTHS.indexOf(m[1].toLowerCase()); d = +m[2]; y = +m[3]; }
    else return null;
    const t = new Date(Date.UTC(y, mo, d));
    if (mo < 0 || t.getUTCFullYear() !== y || t.getUTCMonth() !== mo || t.getUTCDate() !== d) return null;
    return t.toISOString().slice(0, 10);
  }

  // No document is dated after tomorrow; such a day is "available until".
  function datesIn(text) {
    const limit = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const days = (String(text || "").match(DATES) || []).map((s) => iso(tidy(s)));
    if (days.some((d) => d === null)) return null;
    return Array.from(new Set(days.filter((d) => d < limit)));
  }

  // The control's own date, else the one date its own row shows.
  function dateOf(el) {
    const own = datesIn(nameOf(el));
    if (own === null) return null;
    if (own.length === 1) return own[0];
    if (own.length > 1) return null;
    const row = el.closest("[role=row], tr, li");
    if (!row) return null;
    const near = datesIn(row.innerText);
    return near && near.length === 1 ? near[0] : null;
  }

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN_MARKERS.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']"));
  }

  const controls = () => Array.from(document.querySelectorAll(CONTROLS)).filter((el) => {
    const name = nameOf(el);
    return VIEW_DOCUMENTS.test(name) || BILL.test(name);
  });

  function pageWord() {
    if (controls().length) return "";
    const body = ((document.body && document.body.innerText) || "").toLowerCase();
    const hay = `${(document.title || "").toLowerCase()}\n${body.slice(0, 1500)}`;
    if (CHALLENGE.some((m) => hay.includes(m))) return "challenge";
    if (RATE_LIMIT.some((m) => hay.includes(m))) return "rate";
    return "";
  }

  const safeName = (name) => Boolean(name) && !FORBIDDEN.test(name) && SAFE.test(name);

  // A control's own PDF link on this host, or "" when it has none.
  function pdfLink(el) {
    const raw = el.tagName === "A" ? el.getAttribute("href") || "" : "";
    if (!raw || /^(javascript|#)/i.test(raw.trim()) || !PDF_HREF.test(raw)) return "";
    let url;
    try { url = new URL(raw, location.href); } catch (e) { return ""; }
    return url.protocol === "https:" && url.origin === location.origin && url.hostname === HOST ? url.href : "";
  }

  async function readList() {
    if (signedOut()) return { state: "signed_out" };
    const word = pageWord();
    if (word === "challenge") return { state: "challenge" };
    if (word === "rate") return stop("State Farm says to try again later.");
    if (location.hostname !== HOST || !location.pathname.startsWith("/DocumentCenterUI")) return { state: "no_list" };
    let found = controls();
    for (let waited = 0; !found.length && waited < 10000; waited += 250) {
      await sleep(250);
      if (signedOut()) return { state: "signed_out" };
      found = controls();
    }
    if (!found.length) return stop("The Document Center shows no document controls this can read.");
    const docs = [];
    const urls = new Set();
    let left = 0;
    for (const el of found) {
      const name = nameOf(el);
      const url = safeName(name) && !VIEW_DOCUMENTS.test(name) ? pdfLink(el) : "";
      if (!url) { left += 1; continue; }
      const date = dateOf(el);
      if (!date) return stop("A document's date could not be read.", docs);
      if (urls.has(url)) continue;
      urls.add(url);
      const row = el.closest("[role=row], tr, li");
      const title = /1099|1098|5498|tax/i.test(`${name} ${row ? row.innerText : ""}`) ? "Tax Document" : "Account Statement";
      const parsed = new URL(url);
      docs.push({ id: `${parsed.pathname}${parsed.search}`, date, title, method: "fetch", url });
    }
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (left) return stop(`${docs.length} document(s) have a link of their own. ${LEFT}`, docs);
    return { state: "ok", docs };
  }

  async function fetchPdf(doc) {
    let url;
    try { url = new URL((doc && doc.url) || ""); } catch (e) { return { ok: false, why: "not a document link" }; }
    if (url.protocol !== "https:" || url.origin !== location.origin || url.hostname !== HOST || !PDF_HREF.test(url.href)
      || doc.id !== `${url.pathname}${url.search}`) {
      return { ok: false, why: "not a document link" };
    }
    const response = await fetch(url.href, { credentials: "same-origin", redirect: "manual" });
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) {
      return { ok: false, signedOut: true, why: "The site asked for a sign-in." };
    }
    if (response.status !== 200) return { ok: false, why: `The site sent ${response.status}.` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    return globalThis.__sweepPdf.pdfResult(bytes);
  }

  globalThis.__sweep = { readList, fetchPdf };
})();
