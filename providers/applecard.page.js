// Runs inside card.apple.com. Reads the card's statement list when it is on
// screen, by the one way Apple names a document's button, and presses only a
// statement's own Download.
//
// The sections of card.apple.com are drawn by its own menu and answer 404 by
// address, so this cannot open the list itself. Savings statements and tax
// forms share one page and one button shape and can only be told apart by the
// link that opened them, so a date for them would be a guess, and they stop.
//
// Derived from PaperPull's apps/applecard/applecard_site.py (AGPL-3.0).
(() => {
  const DRAW_WAIT_MS = 30000;
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const LOGIN_MARKERS = ["/login", "/signin", "/sign-in", "/auth/", "/mfa", "/verification", "/challenge", "/authenticate"];
  const SIGN_IN_FRAME = "iframe[src*='idmsa.apple.com'], iframe[src*='appleid.apple.com']";
  const CHECK_MARKERS = ["enter the code", "verification code", "6-digit", "two-factor", "two-step", "authenticator", "confirm your identity", "verify your identity", "we sent a code", "trusted device", "trusted phone number", "unusual", "are you a robot", "captcha", "check your email", "check your phone", "access denied", "reference #"];
  const ENDED_MARKERS = ["your session has expired", "log back in"];
  const RATE_MARKERS = ["too many requests", "rate limit", "try again later", "temporarily unavailable", "http error 429", "unusual traffic"];
  const MONTH = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
  const DOC_BUTTON = new RegExp(`^\\s*download\\s+statement\\s+of\\s+${MONTH}\\s+((?:19|20)\\d{2})\\s*\\(\\s*pdf\\s*\\)\\s*$`, "i");
  const BILL_CONTROL = /((download|view|print|open|get)\s*(my\s+|the\s+|this\s+|your\s+)?(statement|document|pdf|tax|letter|notice|1099)|(statement|document|tax\s+form|1099(-?int)?)\s*\(?\s*pdf\s*\)?|\bpdf\b|\b1099-?int\b|^\s*(view|download|open)\s*$)/i;
  const TAX_WORDS = /1099|\btax\b/i;
  const ROW_DATE = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2},?\s+)?\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|\b(19|20)\d{2}\b/i;
  const ID = /^card:(\d{4}-\d{2}-\d{2})$/;

  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nameOf = (el) => tidy(el.getAttribute("aria-label") || el.innerText);
  const controls = () => Array.from(document.querySelectorAll("button, a, [role='button'], [role='link']")).filter(shown);
  const turnedOff = (el) => el.disabled === true || el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

  const menuDrawn = () => Array.from(document.querySelectorAll("nav a, nav [role='link']"))
    .some((a) => shown(a) && /^\s*(statements?|savings)\s*$/i.test(tidy(a.innerText || a.getAttribute("aria-label"))));
  const docButtons = () => controls().filter((el) => DOC_BUTTON.test(nameOf(el)));

  // Statements run for a calendar month, so one closes on its month's last day.
  function monthEnd(label) {
    const m = DOC_BUTTON.exec(label);
    if (!m) return null;
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    return new Date(Date.UTC(+m[2], month + 1, 0)).toISOString().slice(0, 10);
  }

  function signedOut() {
    const url = location.href.toLowerCase();
    if (LOGIN_MARKERS.some((m) => url.includes(m)) || document.querySelector("input[type='password']")) return true;
    // Apple's sign-in is a frame this cannot look inside. A frame on a page with
    // nothing else drawn is a sign-in; a signed-in page may keep one around.
    const frame = Array.from(document.querySelectorAll(SIGN_IN_FRAME)).some(shown);
    return frame && !menuDrawn() && !docButtons().length;
  }

  function held() {
    if (signedOut()) return { state: "signed_out" };
    if (controls().some((el) => BILL_CONTROL.test(nameOf(el)))) return null;
    const hay = `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 1500)}`.toLowerCase();
    if (ENDED_MARKERS.some((m) => hay.includes(m))) return { state: "signed_out" };
    if (CHECK_MARKERS.some((m) => hay.includes(m))) return { state: "challenge" };
    if (RATE_MARKERS.some((m) => hay.includes(m))) return { state: "stopped", why: "Apple asked for a pause. Try again later." };
    return null;
  }

  function savingsPage() {
    const headings = Array.from(document.querySelectorAll("h1, h2")).slice(0, 6).map((h) => h.innerText).join(" ");
    return location.pathname.toLowerCase().includes("savings") || /\bsavings\b/i.test(headings);
  }

  const backToDocuments = () => Array.from(document.querySelectorAll("main a, main [role='link']"))
    .some((a) => shown(a) && /^\s*documents?\s*$/i.test(tidy(a.innerText || a.getAttribute("aria-label"))));

  function rowOf(el) {
    for (let node = el, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
      const words = (node.innerText || "").trim();
      if (ROW_DATE.test(words)) return words.slice(0, 300);
    }
    return "";
  }

  async function readList() {
    let stop = held();
    if (stop) return stop;
    const end = Date.now() + DRAW_WAIT_MS;
    while (!menuDrawn() && !docButtons().length) {
      if (Date.now() >= end) return { state: "stopped", why: "card.apple.com did not draw its menu." };
      await sleep(250);
      stop = held();
      if (stop) return stop;
    }
    const buttons = docButtons();
    if (!buttons.length) return { state: "stopped", why: "The statements list is not on screen. Open Statements from card.apple.com's menu in this tab and sweep again." };
    if (savingsPage()) return { state: "stopped", why: "This is a Savings list. Its statements and tax forms cannot be told apart here, so nothing is saved from it. Open the card's Statements and sweep again." };
    if (backToDocuments()) return { state: "stopped", why: "This looks like a Savings list, not the card's Statements. Open the card's Statements and sweep again." };
    const counted = new Map();
    for (const el of buttons) {
      const date = monthEnd(nameOf(el));
      if (!date) return { state: "stopped", why: "A statement's month could not be read." };
      if (TAX_WORDS.test(rowOf(el))) return { state: "stopped", why: "A row on this list reads as a tax form." };
      counted.set(date, (counted.get(date) || 0) + 1);
    }
    const docs = [...counted.keys()].filter((d) => counted.get(d) === 1).sort().reverse()
      .map((date) => ({ id: `card:${date}`, date, method: "click" }));
    if (docs.length !== counted.size) return { state: "stopped", why: "Two buttons name one month, so neither is saved.", docs };
    return { state: "ok", docs };
  }

  function clickDoc(doc) {
    const m = ID.exec((doc && doc.id) || "");
    if (!m) return { ok: false, why: "not a statement of this list" };
    if (savingsPage() || backToDocuments()) return { ok: false, why: "The card's Statements are not on screen." };
    const same = docButtons().filter((el) => monthEnd(nameOf(el)) === m[1]);
    if (same.length !== 1) return { ok: false, why: "That statement's button is not on the page once." };
    if (turnedOff(same[0])) return { ok: false, why: "That statement's button is turned off." };
    same[0].click();
    return { ok: true };
  }

  globalThis.__sweep = { readList, clickDoc };
})();
