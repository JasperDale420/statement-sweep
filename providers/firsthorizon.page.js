// Runs inside First Horizon's own page. Reads the statements already drawn
// and presses only one statement's own Download PDF.
//
// The bank's API refuses a request without headers its page computes, and
// each PDF's address exists only in an answer this world cannot hear, so the
// list comes from the cards on the page and the file from the bank's button.
// An account's panel is not a document's own control, so a closed panel is
// reported rather than opened.
//
// Derived from PaperPull's apps/firsthorizon/firsthorizon_site.py (AGPL-3.0).
(() => {
  const PANEL = 'div.accordion-panel[role="button"][aria-expanded]';
  const CARD = 'div.card.edocs-item-card[aria-label^="Monthly statement for "]';
  const BUTTON = "button.edocs-download-btn";
  const ROUTE = "accounts/documents";
  const PANEL_TITLE = /^(.+) \(([^()]+)\) \(\*([0-9]{4})\) (-?\$-?[\d,]+(?:\.\d{2})?)$/;
  const CARD_LABEL = /^monthly statement for (\d{2})\/(\d{2})\/(\d{4})$/i;
  const DOWNLOAD_TEXT = /^download pdf$/i;
  const DOWNLOAD_ARIA = /^open new tab to download pdf for (\d{2})\/(\d{2})\/(\d{4}) statement$/i;
  const ID = /^([0-9]{4})-([0-9]{4}-[0-9]{2}-[0-9]{2})$/;
  const LOGIN_MARKERS = ["security.firsthorizon.com", "/fhnsso/", "/sso/logout", "www.firsthorizon.com"];
  const TIMEOUT_WORDS = ["session timeout warning", "your session has expired", "your session will expire"];
  const CHALLENGE = ["enter the code", "verification code", "6-digit", "two-factor", "two-step", "authenticator",
    "confirm your identity", "verify your identity", "we sent a code", "one-time passcode", "device approval",
    "are you a robot", "captcha", "check your email", "check your phone", "access denied"];
  const RATE_LIMIT = ["too many requests", "rate limit", "try again later", "temporarily unavailable",
    "http error 429", "unusual traffic"];

  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const bodyText = () => ((document.body && document.body.innerText) || "").toLowerCase();
  const shown = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    && getComputedStyle(el).visibility !== "hidden";
  const labelsOf = (el) => [el.innerText, el.getAttribute("aria-label"), el.getAttribute("title")].map(tidy).filter(Boolean);

  function realDate(month, day, year) {
    const d = new Date(Date.UTC(+year, +month - 1, +day));
    if (d.getUTCFullYear() !== +year || d.getUTCMonth() !== +month - 1 || d.getUTCDate() !== +day) return null;
    return d.toISOString().slice(0, 10);
  }
  function cardDate(label) {
    const m = CARD_LABEL.exec(tidy(label));
    return m ? realDate(m[1], m[2], m[3]) : null;
  }

  function signedOut() {
    const url = location.href.toLowerCase();
    if (LOGIN_MARKERS.some((m) => url.includes(m))) return true;
    if (document.querySelector("input[type='password']")) return true;
    const body = bodyText();
    return TIMEOUT_WORDS.some((w) => body.includes(w));
  }

  function pageWord() {
    if (document.querySelector(CARD)) return "";
    const hay = `${(document.title || "").toLowerCase()}\n${bodyText().slice(0, 1500)}`;
    if (CHALLENGE.some((m) => hay.includes(m))) return "challenge";
    if (RATE_LIMIT.some((m) => hay.includes(m))) return "rate";
    return "";
  }

  const ready = () => Array.from(document.querySelectorAll("h1, h2, h3")).some((h) => /^view statements$/i.test(tidy(h.innerText)))
    && Boolean(document.querySelector("button.edocs-estatements-tab")) && Boolean(document.querySelector(PANEL));

  function readPanel(panel) {
    const title = tidy(panel.innerText);
    const m = PANEL_TITLE.exec(title);
    const region = panel.getAttribute("aria-controls") || "";
    const box = region ? document.getElementById(region) : null;
    return {
      mask: m ? m[3] : "", shown: shown(panel), open: panel.getAttribute("aria-expanded") === "true",
      region, cards: box ? Array.from(box.querySelectorAll(CARD)) : [],
    };
  }
  const panels = () => Array.from(document.querySelectorAll(PANEL)).map(readPanel);

  // A title draws its balance last and an open panel its cards after its
  // answer, so each is given a moment before it is judged.
  async function settled() {
    let now = panels();
    for (let waited = 0; waited < 6000; waited += 250) {
      if (signedOut()) return null;
      if (now.length && now.every((p) => p.mask && (!p.open || p.cards.length))) return now;
      await sleep(250);
      now = panels();
    }
    return now;
  }

  async function readList() {
    if (signedOut()) return { state: "signed_out" };
    const word = pageWord();
    if (word === "challenge") return { state: "challenge" };
    if (word === "rate") return { state: "stopped", why: "First Horizon says to try again later." };
    if (location.pathname !== "/" || location.hash.replace(/^#/, "") !== ROUTE) return { state: "no_list" };
    for (let waited = 0; !ready(); waited += 250) {
      if (signedOut()) return { state: "signed_out" };
      if (waited >= 12000) return { state: "stopped", why: "The statements page did not show its heading, tab and accounts." };
      await sleep(250);
    }
    const all = await settled();
    if (!all) return { state: "signed_out" };
    const docs = [];
    const seen = new Set();
    let closed = 0;
    for (const p of all) {
      if (!p.shown) return { state: "stopped", why: "An account's panel is hidden on the page.", docs };
      if (!p.mask) return { state: "stopped", why: "An account's panel title could not be read.", docs };
      if (!p.region || !document.getElementById(p.region)) {
        if (p.open) return { state: "stopped", why: "An open account panel names no list this can read.", docs };
      }
      if (!p.open) { closed += 1; continue; }
      if (!p.cards.length) return { state: "stopped", why: "An open account panel shows no statements.", docs };
      const dates = new Set();
      for (const card of p.cards) {
        const date = cardDate(card.getAttribute("aria-label"));
        if (!date) return { state: "stopped", why: "A statement's date could not be read.", docs };
        if (!shown(card) || card.querySelectorAll(BUTTON).length !== 1) {
          return { state: "stopped", why: "A statement has no single Download PDF.", docs };
        }
        if (dates.has(date)) return { state: "stopped", why: "Two statements of one account carry one date.", docs };
        dates.add(date);
        const id = `${p.mask}-${date}`;
        if (seen.has(id)) return { state: "stopped", why: "Two account panels carry the same last four digits.", docs };
        seen.add(id);
        docs.push({ id, date, method: "click" });
      }
    }
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (closed) {
      return { state: "stopped", docs,
        why: `${closed} account panel(s) are closed. Opening one is not a document's own control, so open them in the tab and sweep again.` };
    }
    return { state: "ok", docs };
  }

  function isDownload(label, iso) {
    if (DOWNLOAD_TEXT.test(label)) return true;
    const m = DOWNLOAD_ARIA.exec(label);
    return Boolean(m) && realDate(m[1], m[2], m[3]) === iso;
  }

  function clickDoc(doc) {
    const m = ID.exec((doc && doc.id) || "");
    if (!m) return { ok: false, why: "not a statement of this list" };
    if (signedOut()) return { ok: false, signedOut: true, why: "The site asked for a sign-in." };
    const [, mask, iso] = m;
    const mine = panels().filter((p) => p.shown && p.open && p.mask === mask);
    if (mine.length !== 1) return { ok: false, why: "The account's panel was not open on the page." };
    const cards = mine[0].cards.filter((c) => cardDate(c.getAttribute("aria-label")) === iso);
    if (cards.length !== 1) return { ok: false, why: "No single statement of that date was on the page." };
    const buttons = cards[0].querySelectorAll(BUTTON);
    if (buttons.length !== 1 || !shown(buttons[0])) return { ok: false, why: "Its Download PDF was not there." };
    const button = buttons[0];
    if (button.disabled || button.getAttribute("aria-disabled") === "true") return { ok: false, why: "Its Download PDF is turned off." };
    const labels = labelsOf(button);
    if (!labels.length || !labels.every((l) => isDownload(l, iso))) return { ok: false, why: "That control is not this statement's Download PDF." };
    button.click();
    return { ok: true };
  }

  globalThis.__sweep = { readList, clickDoc };
})();
