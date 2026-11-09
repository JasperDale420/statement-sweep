// Runs inside Coinbase's own page, where the sign-in already lives. It reads
// the Statements page and presses a month's own PDF button, and nothing else:
// never Load more, never the custom statement generator, never a tab.
//
// Derived from PaperPull's apps/coinbase/coinbase_site.py (AGPL-3.0).
(() => {
  const PDF_BUTTON = "button[data-testid='statements-pdf-v2']";
  const LOAD_MORE = "button[data-testid='load-more']";
  const OWNER_INFO = "/v2/tax/owner-info";
  const LOGIN = ["/signin", "/sign-in", "/login", "/oauth", "/2fa", "/mfa", "/verify", "/verification", "/challenge", "/sso",
    "//login.coinbase.com"];
  const CHALLENGE = ["enter the code", "verification code", "6-digit", "7-digit", "two-factor", "two-step", "authenticator",
    "confirm your identity", "verify your identity", "we sent a code", "device approval", "approve this login",
    "are you a robot", "captcha", "let's verify", "check your email", "check your phone",
    "your session has expired", "log back in", "access denied"];
  const RATE_LIMIT = ["too many requests", "rate limit", "try again later", "temporarily unavailable",
    "http error 429", "unusual traffic"];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const WINDOW_ROW = "Last 30 days";
  const ID = /^(\d{4})-(\d{2})$/;
  const WAIT_MS = 12000;

  const FORBIDDEN = new RegExp("(\\bbuy\\b|\\bsell\\b|\\btrad(e|es|ed|ing)\\b|\\bconvert(s|ed|ing)?\\b|\\bswap(s|ped|ping)?\\b|"
    + "\\bsend\\b|\\breceive\\b|\\bwithdraw(al|als|s)?\\b|\\bdeposit(s|ed)?\\b|\\btransfer(s|red|ring)?\\b|"
    + "\\bstak(e|es|ed|ing)\\b|\\bunstak(e|es|ed|ing)\\b|\\bearn\\b|\\bborrow\\b|\\blend(ing)?\\b|\\bloan\\b|"
    + "\\bcard\\b|\\bpay\\b|\\bpayment(s)?\\b|\\brecurring\\b|\\border(s)?\\b|\\badvanced\\b|\\bwallet\\b|"
    + "\\baddress(es)?\\b|\\bwhitelist\\b|\\ballowlist\\b|\\bapi\\b|\\bkey(s)?\\b|"
    + "\\bgenerat(e|es|ed|ing)\\b|\\bcreat(e|es|ed|ing)\\b|\\bcustom\\b|\\brequest(s|ed|ing)?\\b|"
    + "\\bapprov(e|es|ed|ing|al)\\b|\\bcontinue\\b|\\bsubmit\\b|\\bconfirm\\b|\\bagree\\b|\\baccept\\b|"
    + "\\bauthori[sz]e\\b|\\bverify\\b|\\bidentity\\b|\\bpassword\\b|\\bpasskey\\b|\\b2fa\\b|\\bsecurity\\b|"
    + "\\bsettings?\\b|\\bprofile\\b|\\benabl(e|es|ed|ing)\\b|\\bdisabl(e|es|ed|ing)\\b|"
    + "\\bchang(e|es|ed|ing)\\b|\\bedit(s|ed|ing)?\\b|\\bupdat(e|es|ed|ing)\\b|\\bdelet(e|es|ed|ing)\\b|"
    + "\\bremov(e|es|ed|ing)\\b|\\bcancel\\b|\\bclose\\b|\\bexport\\b|\\bemail\\b|\\bshare\\b|"
    + "\\bsign\\s*up\\b|\\bupgrade\\b|\\bsubscribe\\b|\\bone\\b|\\bchat\\b|\\bcontact\\b|\\bmark\\b)", "i");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const buttons = () => Array.from(document.querySelectorAll(PDF_BUTTON));
  const onStatements = () => location.hostname === "accounts.coinbase.com" && location.pathname.replace(/\/$/, "") === "/statements";

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']"));
  }

  function asking() {
    if (buttons().length > 0) return null;
    const text = `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 1500)}`.toLowerCase();
    if (CHALLENGE.some((m) => text.includes(m))) return "challenge";
    if (RATE_LIMIT.some((m) => text.includes(m))) return "rate";
    return null;
  }

  // The label of the row a PDF button sits in. An ancestor holding a second
  // PDF button is the list around the rows, and the climb stops there with no
  // label, so a row that does not start with its month is never read as
  // another row's.
  function labelOf(button) {
    let el = button;
    for (let k = 0; k < 8 && el; k++, el = el.parentElement) {
      if (el.querySelectorAll(PDF_BUTTON).length > 1) return "";
      const m = (el.innerText || "").trim().match(/^(Last 30 days|[A-Z][a-z]+ (?:19|20)\d{2})(?!\S)/);
      if (m) return m[1];
    }
    return "";
  }

  // "September 2026" as its own last day, or null.
  function monthEnd(label) {
    const m = /^([A-Z][a-z]+) ((?:19|20)\d{2})$/.exec(label);
    if (!m) return null;
    const month = MONTHS.indexOf(m[1]);
    if (month < 0) return null;
    return new Date(Date.UTC(+m[2], month + 1, 0)).toISOString().slice(0, 10);
  }

  function isPdfLabel(button) {
    const label = tidy(button.innerText || button.getAttribute("aria-label"));
    return /\bpdf\b/i.test(label) && !FORBIDDEN.test(label);
  }

  function loadMoreShowing() {
    const button = document.querySelector(LOAD_MORE);
    return Boolean(button) && Boolean(button.offsetWidth || button.getClientRects().length)
      && !button.disabled && button.getAttribute("aria-disabled") !== "true";
  }

  function readRows() {
    const docs = [];
    const seen = new Set();
    let windows = 0;
    for (const button of buttons()) {
      const label = labelOf(button);
      if (label === WINDOW_ROW) {
        windows += 1;
        if (windows > 1) return { why: "Two rows read Last 30 days.", docs };
        continue;
      }
      const date = label && monthEnd(label);
      if (!date) return { why: "A statement row has no month this can read.", docs };
      if (!isPdfLabel(button)) return { why: "A statement's button did not read as PDF.", docs };
      if (seen.has(date)) return { why: "Two rows read one month.", docs };
      seen.add(date);
      docs.push({ id: date.slice(0, 7), date, title: "Monthly Statement", method: "click" });
    }
    return { docs };
  }

  // The list is whole only when it reaches back to the month of the account's
  // first transaction, which Coinbase gives at this address of its own.
  async function firstTransaction() {
    try {
      const response = await fetch(OWNER_INFO, { credentials: "same-origin", redirect: "error" });
      if (!response.ok) return "";
      const data = await response.json();
      const m = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-\d{2}/.exec(String((data && data.first_transaction_date) || ""));
      return m ? m[0] : "";
    } catch (e) {
      return "";
    }
  }

  async function readList() {
    const until = Date.now() + WAIT_MS;
    for (;;) {
      if (signedOut()) return { state: "signed_out" };
      const check = asking();
      if (check === "challenge") return { state: "challenge" };
      if (check === "rate") return { state: "stopped", why: "Coinbase is asking for a pause. Try again later.", docs: [] };
      if (!onStatements()) return { state: "no_list" };
      if (buttons().some((b) => monthEnd(labelOf(b) || ""))) break;
      if (Date.now() >= until) {
        return { state: "stopped", why: "Coinbase's Statements page showed no months.", docs: [] };
      }
      await sleep(300);
    }
    const { why, docs } = readRows();
    docs.sort((a, b) => (a.date < b.date ? 1 : -1));
    if (why) return { state: "stopped", why, docs };
    if (loadMoreShowing()) {
      return { state: "stopped", why: "Coinbase's list goes on behind Load more, and this reads only the months shown.", docs };
    }
    const first = await firstTransaction();
    if (!first) return { state: "stopped", why: "Coinbase did not say when the account began, so the list cannot be checked whole.", docs };
    const oldest = docs[docs.length - 1];
    const today = new Date();
    const hasMonths = first.slice(0, 7) < `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
    if (hasMonths && (!oldest || oldest.date.slice(0, 7) > first.slice(0, 7))) {
      return { state: "stopped", why: "Coinbase's list stops short of the account's first month.", docs };
    }
    return { state: "ok", docs };
  }

  function clickDoc(doc) {
    const m = ID.exec((doc && doc.id) || "");
    if (!m || +m[2] < 1 || +m[2] > 12) return { ok: false, why: "not a statement month" };
    if (signedOut() || !onStatements()) return { ok: false, why: "This is not a signed-in Statements page." };
    const label = `${MONTHS[+m[2] - 1]} ${m[1]}`;
    const hits = buttons().filter((b) => labelOf(b) === label);
    if (hits.length !== 1) return { ok: false, why: "Its row was not there exactly once." };
    const button = hits[0];
    if (!isPdfLabel(button)) return { ok: false, why: "That button did not read as PDF." };
    if (button.disabled || button.getAttribute("aria-disabled") === "true") return { ok: false, why: "Its PDF button is turned off." };
    button.click();
    return { ok: true };
  }

  globalThis.__sweep = { readList, clickDoc };
})();
