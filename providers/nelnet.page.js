// Runs inside Nelnet's own page, where the sign-in already lives. It reads
// Inbox & Statements and presses a row's own Download button, and nothing else.
// A loan account can take a payment, so every button is read before a press.
//
// Nelnet's PDFs come from a second host that a request from this page cannot
// reach with cookies alone, so each is started by the row's own button.
//
// Derived from PaperPull's apps/nelnet/nelnet_site.py (AGPL-3.0).
(() => {
  const INBOX = "/documents/inbox-statements";
  const LOGIN = ["/login", "/signin", "/sign-in", "/mfa", "/verification", "/challenge", "/oauth", "/sso",
    "//auth.nelnet.studentaid.gov"];
  const CHALLENGE = ["enter the code", "verification code", "6-digit", "two-factor", "two-step", "authenticator",
    "confirm your identity", "verify your identity", "we sent a code", "device approval", "approve this login",
    "unusual", "are you a robot", "captcha", "let's verify", "check your email", "check your phone",
    "your session has expired", "log back in", "access denied"];
  const RATE_LIMIT = ["too many requests", "rate limit", "try again later", "temporarily unavailable",
    "http error 429", "unusual traffic"];
  const BUTTON = 'button[data-cy^="document-download-"]';
  const CY = /^document-download-([A-Za-z0-9-]+)$/;
  const ID = /^[A-Za-z0-9-]+$/;
  const WAIT_MS = 12000;

  const FORBIDDEN = new RegExp("(\\bpay\\b|\\bpaying\\b|\\bpayments?\\b|make\\s+a\\s+payment|\\bschedul(e|es|ed|ing)\\b|"
    + "auto\\s*-?\\s*(pay|debit)|recurring|one[-\\s]?time|\\bbank\\b|routing|account\\s+number|\\bdebit\\b|\\bcard\\b|"
    + "\\bhardship\\b|\\bdeferment\\b|\\bdeferral\\b|\\bforbearance\\b|modification|forgiveness|"
    + "\\bapply\\b|\\bapplication\\b|\\brequest(s|ed|ing)?\\b|\\bsubmit|\\bupload|\\benroll|\\bunenroll|sign\\s+up|paperless|"
    + "\\benable\\b|\\bdisable\\b|\\bchang(e|es|ed|ing)\\b|\\bedit(s|ed|ing)?\\b|\\bupdat(e|es|ed|ing)\\b|\\bmodify\\b|\\bmanage\\b|"
    + "set\\s+up|\\bdelete\\b|\\bremove\\b|\\bcancel|\\bwithdraw|password|passcode|username|\\bprofile\\b|\\bsettings?\\b|preferences|"
    + "contact\\s+info|\\baddress\\b|\\bconfirm\\b|\\bagree\\b|\\baccept\\b|\\bauthori[sz]e|\\bcertif|\\brecertif|"
    + "\\bchat\\b|contact\\s+us|consolidat|payoff|pay\\s+off|dispute|appeal)", "i");
  const SETTINGS = new RegExp("\\bchang(e|es|ed|ing)\\b|\\bedit(s|ed|ing)?\\b|\\bupdat(e|es|ed|ing)\\b|"
    + "\\bremov(e|es|ed|ing|al)\\b|\\bdelet(e|es|ed|ing|ion)\\b|^\\s*save\\s*$|\\bsave\\s+(changes?|settings?|preferences?|profile)\\b|"
    + "\\bsettings?\\b|\\bpreferences?\\b|\\bmanage\\b|\\bset\\s+up\\b|\\benabl(e|es|ed|ing)\\b|\\bdisabl(e|es|ed|ing)\\b|"
    + "\\bturn\\s+(on|off)\\b|\\bopt\\s*(in|out)\\b|\\bconsent\\b|\\bauthoriz(e|es|ed|ing|ation)\\b|"
    + "\\bcertif(y|ies|ied|ication)\\b|\\bbeneficiar(y|ies)\\b|\\bwithholding\\b|\\bautopay\\b|\\bauto-pay\\b|"
    + "\\bappl(y|ies|ied|ication)\\b|\\bplace\\s+order\\b|\\brebalance\\b|\\breallocate\\b|\\bliquidat(e|es|ed|ing|ion)\\b|"
    + "\\bbuy\\b|\\bsell\\b", "i");
  const AUTH = /log[\s_-]?(in|on)|sign[\s_-]?(in|on|up)|signin|logon|authenticat|credential|register|enroll(ment)?\b|username|user[\s_-]?id|password|passcode|remember\s*me/i;
  const SAFE = /^\s*download\s+document\b/i;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']"));
  }

  function asking() {
    if (document.querySelector(`main table ${BUTTON}`)) return null;
    const text = `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 1500)}`.toLowerCase();
    if (CHALLENGE.some((m) => text.includes(m))) return "challenge";
    if (RATE_LIMIT.some((m) => text.includes(m))) return "rate";
    return null;
  }

  function real(year, month, day) {
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
      ? d.toISOString().slice(0, 10) : null;
  }

  function fullYear(two) {
    return two <= (new Date().getFullYear() % 100) + 1 ? 2000 + two : 1900 + two;
  }

  // The cell must name exactly one real day. A cell naming two, or a day that
  // does not exist, has no date.
  function oneDate(cell) {
    const found = [];
    const words = /(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(\d{4})/gi;
    for (const m of cell.matchAll(words)) found.push(real(+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2]));
    for (const m of cell.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) found.push(real(+m[3], +m[1], +m[2]));
    for (const m of cell.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{2})\b/g)) found.push(real(fullYear(+m[3]), +m[1], +m[2]));
    for (const m of cell.matchAll(/\b(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) found.push(real(+m[1], +m[2], +m[3]));
    return found.length === 1 ? found[0] : null;
  }

  // The guard reads what a control says it does, with the title of its
  // document taken off: a notice called "Repayment Plan Confirmation" is not a
  // button that confirms one. Each label it carries is judged on its own.
  function safeControl(button) {
    const parts = [button.getAttribute("aria-label"), button.getAttribute("title"), button.textContent].map(tidy).filter(Boolean);
    const subjects = new Set();
    const actions = [];
    for (const part of parts) {
      if (subjects.has(part.toLowerCase())) continue;
      const m = /^(.*?)\s+with\s+subject\s+(.*)$/i.exec(part);
      if (m) subjects.add(m[2].trim().toLowerCase());
      actions.push((m ? m[1] : part).trim());
    }
    const said = actions.filter(Boolean);
    if (!said.length || said.some((a) => FORBIDDEN.test(a) || SETTINGS.test(a) || AUTH.test(a))) return false;
    return SAFE.test(tidy(button.getAttribute("aria-label")));
  }

  function subjectOf(row, button) {
    const link = row.querySelector('a[data-cy^="document-view-"]');
    if (link) {
      const copy = link.cloneNode(true);
      copy.querySelectorAll(".sr-only, u-icon, svg").forEach((n) => n.remove());
      const subject = tidy(copy.textContent);
      if (subject) return subject;
    }
    const m = /\s+with\s+subject\s+(.*)$/i.exec(tidy(button.getAttribute("aria-label")));
    return m ? m[1].trim() : "";
  }

  // A file name's part: "09/27/2026 Statement" is its date and "Statement",
  // and a notice is cut near sixty characters, since its subject can be long.
  function titled(subject) {
    const plain = subject.replace(/^\d{1,2}\/\d{1,2}\/\d{2,4}\s+/, "");
    return plain.length <= 60 ? plain : plain.slice(0, 60).replace(/\s+\S*$/, "");
  }

  const documentRows = () => Array.from(document.querySelectorAll("main table tr"))
    .filter((tr) => tr.querySelector(BUTTON));
  const offNow = (b) => !b || b.disabled || b.hasAttribute("disabled") || b.getAttribute("aria-disabled") === "true";

  function readRows() {
    const docs = [];
    const seen = new Set();
    for (const tr of documentRows()) {
      const button = tr.querySelector(BUTTON);
      const cy = CY.exec(button.getAttribute("data-cy") || "");
      if (!cy) return { why: "A document's id was not one this can read.", docs };
      const firstCell = tr.querySelector("td");
      const date = firstCell ? oneDate(tidy(firstCell.textContent)) : null;
      if (!date) return { why: "A document's date could not be read.", docs };
      const subject = subjectOf(tr, button);
      if (!subject) return { why: "A document's name could not be read.", docs };
      if (!safeControl(button)) return { why: "A document's button did not read as a download.", docs };
      if (seen.has(cy[1])) return { why: "Two rows carry one document id.", docs };
      seen.add(cy[1]);
      docs.push({ id: cy[1], date, title: titled(subject), method: "click" });
    }
    return { docs };
  }

  async function readList() {
    const until = Date.now() + WAIT_MS;
    for (;;) {
      if (signedOut()) return { state: "signed_out" };
      const check = asking();
      if (check === "challenge") return { state: "challenge" };
      if (check === "rate") return { state: "stopped", why: "Nelnet is asking for a pause. Try again later.", docs: [] };
      if (!location.pathname.startsWith(INBOX) || location.hostname !== "nelnet.studentaid.gov") return { state: "no_list" };
      if (documentRows().length > 0) break;
      if (Date.now() >= until) return { state: "stopped", why: "Nelnet's Inbox & Statements showed no documents.", docs: [] };
      await sleep(300);
    }
    const { why, docs } = readRows();
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (why) return { state: "stopped", why, docs };
    if (!offNow(document.querySelector('button[aria-label="Go to first page"]'))) {
      return { state: "stopped", why: "Nelnet's list is not on its first page.", docs };
    }
    if (!offNow(document.querySelector('button[aria-label="Next Page"]'))) {
      return { state: "stopped", why: "Nelnet's list goes on past these rows, and this reads only its first page.", docs };
    }
    return { state: "ok", docs };
  }

  function clickDoc(doc) {
    const id = (doc && doc.id) || "";
    if (!ID.test(id)) return { ok: false, why: "not a document id" };
    if (signedOut()) return { ok: false, why: "Nelnet asked for a sign-in." };
    const hits = documentRows().filter((tr) => tr.querySelector(BUTTON).getAttribute("data-cy") === `document-download-${id}`);
    if (hits.length !== 1) return { ok: false, why: "Its row was not there exactly once." };
    const firstCell = hits[0].querySelector("td");
    if (!firstCell || oneDate(tidy(firstCell.textContent)) !== doc.date) return { ok: false, why: "Its date on the page has changed." };
    const button = hits[0].querySelector(BUTTON);
    if (!safeControl(button)) return { ok: false, why: "That button did not read as a download." };
    if (offNow(button)) return { ok: false, why: "Its Download is turned off." };
    button.click();
    return { ok: true };
  }

  globalThis.__sweep = { readList, clickDoc };
})();
