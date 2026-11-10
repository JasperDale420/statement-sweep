// Runs inside First Horizon's own page. Reads the statements already drawn
// and presses only one statement's own Download PDF, and, in a tab the sweep
// opened itself, an account's closed panel to open it, as PaperPull does.
//
// The bank's API refuses a request without headers its page computes, and
// each PDF's address exists only in an answer this world cannot hear, so the
// list comes from the cards on the page and the file from the bank's button.
// In a tab of yours a closed panel is reported rather than opened. A panel
// is only ever opened, never closed.
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
  const OPEN_WAIT_MS = 20000;
  const MAX_PANELS = 40;
  // PaperPull's blocklist: a panel title holding any of these is not pressed.
  const FORBIDDEN = /(\benroll|\benrollment\b|\bmanage\s+statement\s+delivery\b|\bstatement\s+delivery\b|\baccount\s+options\b|\blink\s+an?\s+account\b|\bedit\s+accounts?\s+list\b|\bexport|\bzelle\b|\bquick\s+payment\b|\bquick\s+transfer\b|\bpay\b|\bpaying\b|\bpayments?\b|\bpayees?\b|\btransfers?\b|\btransferring\b|\bmanage\s+your\s+cards\b|\bopen\s+a\s+new\s+account\b|\bstay\s+logged\s+in\b|\bskip\s+this\s+step\b|\ball\s+done\b|\bgo\s+paperless\b|\bpaperless\b|\bfeedback\b|\blogout\b|\blog\s*(out|off)\b|\bsign\s*(out|off)\b|\bmessages?\b|\balerts?\b|\bview\s+online\b|\bsend\s+money\b|\bsettings?\b|\bpreferences?\b|\bsave\b|\bsubmit\b|\bconfirm\b|\bcontinue\b|\bdelet(e|es|ed|ing)\b|\bremov(e|es|ed|ing|al)\b|\bcancel\b|\bedit(s|ed|ing)?\b|\bupdat(e|es|ed|ing)\b|\bchang(e|es|ed|ing)\b|\bmanage\b|\bopt\s*-?\s*(in|out)\b|\bclose\b|\bupload\b|\bemail\b|\bshare\b|\bchat\b|\bcontact\b|\brequest(s|ed|ing)?\b|\bdeposit|\bwithdraw|\bagree\b|\baccept\b|\bauthori[sz]e\b|\bverify\b|\bpassword\b|\busername\b|\bdetails\b|\bcollapse\b|\bhide\b)/i;
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
      el: panel, mask: m ? m[3] : "", product: m ? m[2] : "", shown: shown(panel),
      open: panel.getAttribute("aria-expanded") === "true", closed: panel.getAttribute("aria-expanded") === "false",
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

  // Which panels' statements a walk has handed on and which panels it has
  // pressed, by their last four, kept on the page between askings.
  const walk = () => (globalThis.__firstHorizonWalk = globalThis.__firstHorizonWalk || { read: new Set(), pressed: new Set() });

  async function readList({ walk: mayWalk = false } = {}) {
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
    const w = mayWalk ? walk() : null;
    let closed = 0;
    let waiting = 0;
    const masks = all.map((p) => p.mask).filter(Boolean);
    if (new Set(masks).size !== masks.length) return { state: "stopped", why: "Two account panels carry the same last four digits.", docs };
    if (all.length > MAX_PANELS) return { state: "stopped", why: "The statements page shows more accounts than expected.", docs };
    for (const p of all) {
      if (!p.shown) return { state: "stopped", why: "An account's panel is hidden on the page.", docs };
      if (!p.mask) return { state: "stopped", why: "An account's panel title could not be read.", docs };
      if (!p.region || !document.getElementById(p.region)) {
        if (p.open) return { state: "stopped", why: "An open account panel names no list this can read.", docs };
      }
      if (!p.open) {
        closed += 1;
        if (w && !w.read.has(p.mask)) waiting += 1;
        continue;
      }
      // A walk hands on each panel's statements once, in the reading after
      // the panel opened.
      if (w && w.read.has(p.mask)) continue;
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
        docs.push({ id, date, title: `${p.product} (*${p.mask})`, method: "click" });
      }
    }
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (w) {
      if (waiting) return { state: "ok", docs, more: true };
      delete globalThis.__firstHorizonWalk;
      return { state: "ok", docs };
    }
    if (closed) {
      return { state: "stopped", docs,
        why: `${closed} account panel(s) are closed. Opening one is not a document's own control, so open them in the tab and sweep again.` };
    }
    return { state: "ok", docs };
  }

  // Only a panel every label of which reads wholly as an account's title,
  // with none of the blocklist's words, is ever pressed.
  function isAccountPanel(el) {
    const labels = labelsOf(el);
    return labels.length > 0 && labels.every((l) => PANEL_TITLE.test(l) && !FORBIDDEN.test(l));
  }

  async function waitFor(test, ms) {
    const end = Date.now() + ms;
    while (!test()) {
      if (Date.now() >= end) return false;
      await sleep(250);
    }
    return true;
  }

  // The next account whose panel is closed and not yet read, pressed open
  // once. It waits until that panel reads open with its statements drawn,
  // looking the panel up afresh by its last four, since the page may redraw.
  async function nextView() {
    if (signedOut()) return { why: "First Horizon asked for a sign-in." };
    const w = walk();
    const all = panels();
    // The open panels were all read in the reading just before.
    for (const p of all) if (p.open && p.mask) w.read.add(p.mask);
    const next = all.find((p) => p.mask && !p.open && !w.read.has(p.mask));
    if (!next) { delete globalThis.__firstHorizonWalk; return { moved: false }; }
    if (w.pressed.has(next.mask)) return { why: "An account's panel did not stay open once pressed." };
    if (w.pressed.size >= MAX_PANELS) return { why: "More account panels were opened than expected." };
    if (!next.shown || !next.closed) return { why: "An account's panel is not one this will open." };
    // First Horizon draws a panel's list only once it opens, so a closed
    // panel need only name it; the wait below sees it drawn with its cards.
    if (!next.region) return { why: "A closed account panel names no list this can read." };
    if (!isAccountPanel(next.el)) return { why: "An account's panel title is not one this will press." };
    if (next.el.hasAttribute("disabled") || next.el.getAttribute("aria-disabled") === "true") return { why: "First Horizon has an account's panel turned off." };
    w.pressed.add(next.mask);
    next.el.click();
    const opened = () => {
      const now = panels().filter((p) => p.mask === next.mask);
      return now.length === 1 && now[0].open && now[0].cards.length > 0 && now[0].cards.every((c) => cardDate(c.getAttribute("aria-label")));
    };
    if (!(await waitFor(opened, OPEN_WAIT_MS))) {
      if (signedOut()) return { why: "First Horizon asked for a sign-in." };
      return { why: "An account's panel did not open with its statements." };
    }
    return { moved: true };
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

  globalThis.__sweep = { readList, clickDoc, nextView };
})();
