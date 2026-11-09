// Runs inside Optum Bank's member site, where the sign-in already lives.
// Reads and downloads only. It presses nothing and changes nothing.
//
// Derived from PaperPull's apps/optum/optum_site.py (AGPL-3.0).
//
// The Forms & documents page names each product. Each product's statements
// page is read with an in-page request rather than by moving the tab.
(() => {
  const MEMBER_HOST = "account.optumbank.com";
  const LANDING_HOST = "www.optumbank.com";
  const DOCUMENT_PATH = /^\/account\/products\/(\d+)\/(statements|tax_documents)\/(\d+)\.pdf$/;
  const STATEMENTS_LINK = /^\/account\/products\/(\d+)\/statements(?:\/\d+\.pdf)?\/?$/;
  const PRODUCT_PATH = /\/account\/products\/(\d+)(?:\/|$)/;
  const YEAR = /\b(?:19|20)\d{2}\b/g;
  const ISO = /^(?:19|20)\d{2}-\d{2}-\d{2}$/;
  const WAIT_MS = 15000;

  const LOGIN_URL_MARKERS = ["/signin", "/sign-in", "/login", "/oauth", "/mfa", "/verify",
    "/verification", "/challenge", "/sso", "/authorize",
    "healthsafe-id.com", "onehealthcareid.com", "identity."];
  const CHALLENGE_MARKERS = [
    "enter the code", "verification code", "6-digit", "7-digit", "two-factor",
    "two-step", "authenticator", "confirm your identity", "verify your identity",
    "we sent a code", "device approval", "approve this login",
    "are you a robot", "captcha", "let's verify", "check your email",
    "check your phone", "your session has expired", "log back in", "access denied",
  ];
  const RATE_LIMIT_MARKERS = ["too many requests", "rate limit", "try again later",
    "temporarily unavailable", "http error 429", "unusual traffic"];
  // Only a sentence that says so outright, never help text beginning "if".
  const NO_STATEMENTS = /(?<!\bif )(?<!\bwhen )\b(?:you\s+(?:have\s+no|do\s+not\s+have\s+any|don'?t\s+have\s+any)\s+statements|there\s+are\s+no\s+statements|no\s+statements\s+(?:are\s+)?(?:available|to\s+(?:show|display)|yet|found))\b/i;

  const squeeze = (text) => (text || "").replace(/\s+/g, " ").trim();
  const urlIsSignIn = (url) => LOGIN_URL_MARKERS.some((m) => url.toLowerCase().includes(m));

  class Stop extends Error {}

  function signedOut() {
    return location.hostname === LANDING_HOST || urlIsSignIn(location.href)
      || Boolean(document.querySelector("input[type='password']"));
  }

  function onForms() {
    return location.protocol === "https:" && location.hostname === MEMBER_HOST
      && !PRODUCT_PATH.test(location.pathname) && location.pathname.replace(/\/+$/, "").endsWith("/forms");
  }

  // Visible text only, and a page already showing document rows is not asking.
  function screenProblem() {
    if (document.querySelector("main table tr, main [role='row'], main li")) return null;
    const body = (document.body && document.body.innerText) || "";
    const screen = `${document.title}\n${body.slice(0, 1500)}`.toLowerCase();
    if (CHALLENGE_MARKERS.some((m) => screen.includes(m))) return "challenge";
    if (RATE_LIMIT_MARKERS.some((m) => screen.includes(m))) return "rate";
    return null;
  }

  function validIso(text) {
    if (!ISO.test(text)) return false;
    const [y, m, d] = text.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }

  // Every link and every option of a page that may point at a document.
  function entries(doc, base) {
    const out = [];
    for (const a of doc.querySelectorAll("a[href]")) {
      let target;
      try { target = new URL(a.getAttribute("href"), base); } catch (e) { continue; }
      out.push({
        text: squeeze(a.textContent) || squeeze(a.getAttribute("aria-label")),
        path: target.pathname, host: target.hostname, how: "link",
      });
    }
    for (const select of doc.querySelectorAll('select[name="document_id"]')) {
      for (const o of select.options) {
        out.push({ text: squeeze(o.text), path: o.value, host: MEMBER_HOST, how: "option" });
      }
    }
    return out;
  }

  function productIds(found) {
    const out = [];
    for (const e of found) {
      if (e.how !== "link" || e.host !== MEMBER_HOST) continue;
      const m = STATEMENTS_LINK.exec(e.path);
      if (m && !out.includes(m[1])) out.push(m[1]);
    }
    return out;
  }

  const namesADate = (text) => /\b(?:19|20)\d{2}\b/.test(text) || /\b\d{1,2}\/\d{1,2}\/\d{2}\b/.test(text);

  function documentsOf(found, pid) {
    const docs = [];
    const dates = new Map();
    const taxPaths = new Set();
    for (const e of found) {
      const m = DOCUMENT_PATH.exec(e.path);
      if (!m) {
        if (e.how === "option") {
          if (!e.path && !namesADate(e.text)) continue; // a placeholder
          throw new Stop(e.path ? "A statement option carries a value this cannot read."
            : "A dated statement option carries no value.");
        }
        continue;
      }
      if (e.host !== MEMBER_HOST) throw new Stop("A document link points off the member site.");
      if (m[1] !== pid) throw new Stop("A document link names another product.");
      if (m[2] === "statements") {
        if (!validIso(e.text)) throw new Stop("A statement's date is not a calendar date.");
        if (dates.has(e.text)) {
          if (dates.get(e.text) !== e.path) throw new Stop("Two statements carry one date.");
          continue; // the same statement, linked and listed as an option
        }
        dates.set(e.text, e.path);
        docs.push({ id: `${pid}-statements-${m[3]}`, date: e.text, title: "HSA Statement", method: "fetch", url: e.path });
      } else {
        if (taxPaths.has(e.path)) continue; // the same form, linked twice
        taxPaths.add(e.path);
        if (!e.text) throw new Stop("A tax document link has no title.");
        const years = e.text.match(YEAR);
        if (!years) throw new Stop("A tax document's title names no year.");
        docs.push({ id: `${pid}-tax_documents-${m[3]}`, date: `${years[years.length - 1]}-12-31`, title: e.text, method: "fetch", url: e.path });
      }
    }
    return docs;
  }

  const SIGN_IN = Symbol("sign-in");

  // One product's statements page, read as the page would. A redirect to
  // another origin is refused by the browser before that host is asked.
  async function statementsPage(pid) {
    let response;
    try {
      response = await fetch(`/account/products/${pid}/statements`, {
        credentials: "same-origin", mode: "same-origin", redirect: "follow",
      });
    } catch (e) {
      throw new Stop("A product's statements page did not open. You may need to sign in again.");
    }
    if (response.status === 401 || response.status === 403 || urlIsSignIn(response.url)) return SIGN_IN;
    if (!response.ok) throw new Stop(`A product's statements page answered ${response.status}.`);
    if (!PRODUCT_PATH.test(new URL(response.url).pathname)) throw new Stop("A product's statements page opened somewhere else.");
    const parsed = new DOMParser().parseFromString(await response.text(), "text/html");
    if (parsed.querySelector("input[type='password']")) return SIGN_IN;
    for (const hidden of parsed.querySelectorAll("script, style, noscript, template")) hidden.remove();
    return { parsed, base: response.url };
  }

  async function readList() {
    if (signedOut()) return { state: "signed_out" };
    const problem = screenProblem();
    if (problem === "challenge") return { state: "challenge" };
    if (problem === "rate") return { state: "stopped", why: "Optum Bank says to slow down and try later.", docs: [] };
    if (!onForms()) return { state: "no_list" };

    // The forms page draws its own link to a product's statements a moment
    // after it loads.
    const until = Date.now() + WAIT_MS;
    let pids = productIds(entries(document, location.href));
    while (!pids.length && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (signedOut()) return { state: "signed_out" };
      pids = productIds(entries(document, location.href));
    }

    const docs = [];
    const newestFirst = () => docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    try {
      if (!pids.length) throw new Stop("The Forms & documents page links no product's statements.");
      for (const pid of pids) {
        const page = await statementsPage(pid);
        if (page === SIGN_IN) return { state: "signed_out" };
        const found = documentsOf(entries(page.parsed, page.base), pid);
        if (!found.length && !NO_STATEMENTS.test(squeeze(page.parsed.body && page.parsed.body.textContent))) {
          throw new Stop("A product's statements page lists no document.");
        }
        docs.push(...found);
      }
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
      return { state: "stopped", why: e.message, docs: newestFirst() };
    }
    return { state: "ok", docs: newestFirst() };
  }

  async function fetchPdf(doc) {
    const path = (doc && doc.url) || "";
    if (!DOCUMENT_PATH.test(path)) return { ok: false, why: "not a document address" };
    if (location.protocol !== "https:" || location.hostname !== MEMBER_HOST) {
      return { ok: false, why: "The tab is not on the Optum Bank member site." };
    }
    let response;
    try {
      response = await fetch(path, { credentials: "same-origin", redirect: "manual" });
    } catch (e) {
      return { ok: false, why: "Optum Bank did not answer for that document." };
    }
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) {
      return { ok: false, signedOut: true, why: "Optum Bank asked for a sign-in." };
    }
    if (!response.ok) return { ok: false, why: `Optum Bank answered ${response.status}.` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    return globalThis.__sweepPdf.pdfResult(bytes);
  }

  globalThis.__sweep = { readList, fetchPdf };
})();
