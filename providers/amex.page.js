// Runs inside American Express's own page, on its PDF statements page. Reads
// the Download buttons Amex has drawn, and saves one by pressing its button
// and its file type dialog's plain PDF choice and Download, nothing else.
//
// Amex holds its session in memory, so this never asks the browser to load
// another page. Signed in somewhere else, and allowed to, it presses Amex's own
// links to get here, one press each time it is asked, and each link only once.
//
// Derived from PaperPull's apps/amex/amex_site.py (AGPL-3.0).
(() => {
  const LIST_WAIT_MS = 12000;
  const DIALOG_WAIT_MS = 10000;
  const WALK_WAIT_MS = 30000;
  const CARD_WAIT_MS = 15000;
  const SWITCHER_WAIT_MS = 5000;
  const EMPTY_WAIT_MS = 3000;
  const WALKING = { state: "walking" };
  const ACTIVITY_WORDS = /^statements?\s*&\s*activity$/i;
  const PDF_WORDS = /^go to pdf statements$/i;
  const LOGIN_MARKERS = ["/login", "/logon", "/signin", "/sign-in", "/auth", "myca/logon"];
  const CHECK_URLS = ["/mfa", "/verification", "/challenge"];
  const CHECK_MARKERS = ["enter the code", "verification code", "6-digit", "one-time code", "two-factor", "two-step", "authenticator", "confirm your identity", "verify your identity", "we sent a code", "we'll send", "check your email", "check your phone", "are you a robot", "captcha", "let's confirm it's you", "unusual activity"];
  const ENDED_MARKERS = ["your session has expired", "log back in"];
  const RATE_MARKERS = ["too many requests", "rate limit", "try again later", "temporarily unavailable", "http error 429", "unusual traffic", "access denied", "reference #"];
  const DOC_ROWS = "table tbody tr, [role='row'], [class*='statement-row'], [class*='StatementRow'], [class*='document'], [data-testid*='statement'], [data-testid*='document'], [data-test-id*='statement'], [data-test-id*='document'], li[class*='statement'], li[class*='document']";
  const byTest = (op, value) => `[data-testid${op}'${value}'], [data-test-id${op}'${value}']`;
  const DOWNLOADS = byTest("*=", "download-button");
  const PDF_LINKS = `${byTest("=", "goToPdfLinkLg")}, ${byTest("=", "goToPdfLinkSm")}`;
  const COMBOBOX = byTest("=", "simple_switcher_combobox");
  const OPTION = byTest("^=", "simple_switcher_product_option_");
  const NAME = byTest("=", "simple_switcher_display_name");
  const NUMBER = byTest("=", "simple_switcher_display_number");
  const SELECTED = byTest("=", "simple_switcher_selected_option_display");
  const STATEMENT_ID = /\/(recent|older)-statements\/(\d{4}-\d{2}-\d{2})\/download-button/;
  const YEAR_END_ID = /\/year-end-summary\/(\d{4})\/download-button/;
  const NO_STATEMENTS = /(no\s+statements?\s+(available|found|to\s+display)|there\s+are\s+no\s+statements?|you\s+have\s+no\s+statements?|no\s+documents?\s+available|no\s+billing\s+statements?|keine\s+(abrechnungen|dokumente|kontoausz[üu]ge)\s+(vorhanden|verf[üu]gbar|gefunden|anzuzeigen)|es\s+liegen\s+keine\s+(abrechnungen|dokumente|kontoausz[üu]ge)\s+vor|^\s*keine\s+(abrechnungen|dokumente|kontoausz[üu]ge)\s*[.!]?\s*$)/i;
  const BY_POST = /\b(per\s+post|by\s+post|by\s+mail|in\s+the\s+mail)\b/i;
  const AREA = `#table-area, #statements-list, ${byTest("*=", "statement")}, ${byTest("*=", "empty")}, ${byTest("*=", "no-statement")}, [class*='empty'], [class*='no-statement'], section#table-area, table tbody`;
  const CONFIRM = "[data-test-id$='download-footer-download-confirm-anchor'], [data-testid$='download-footer-download-confirm-anchor'], [id*='download-confirm'][id$='-anchor']";
  const DIALOGS = "[role='dialog'], [role='alertdialog'], dialog, [aria-modal='true']";
  const ID = /^(?:(\d{4,6}):)?(stmt:(\d{4}-\d{2}-\d{2})|ye:(\d{4}))$/;

  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const shown = (el) => Boolean(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const testIds = (el) => ["data-testid", "data-test-id"].map((a) => el.getAttribute(a)).filter(Boolean);
  const cleanName = (raw) => tidy((raw || "").replace(/[®™]/g, ""));
  const turnedOff = (el) => el.disabled === true || el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

  function realDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }

  function signIn() {
    const url = location.href.toLowerCase();
    if (CHECK_URLS.some((m) => url.includes(m))) return { state: "challenge" };
    if (LOGIN_MARKERS.some((m) => url.includes(m)) || document.querySelector("input[type='password']")) return { state: "signed_out" };
    if (document.querySelectorAll(DOC_ROWS).length > 2) return null;
    const hay = `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 1500)}`.toLowerCase();
    if (ENDED_MARKERS.some((m) => hay.includes(m))) return { state: "signed_out" };
    if (CHECK_MARKERS.some((m) => hay.includes(m))) return { state: "challenge" };
    if (RATE_MARKERS.some((m) => hay.includes(m))) return { state: "stopped", why: "American Express asked for a pause. Try again later." };
    return null;
  }

  // Each Download of a list, once per document, with its copies. Amex keeps a
  // hidden copy of each one for a narrow window.
  function listed() {
    const docs = new Map();
    for (const button of document.querySelectorAll(DOWNLOADS)) {
      const named = new Set();
      for (const tid of testIds(button)) {
        const m = STATEMENT_ID.exec(tid);
        if (m) named.add(`stmt:${m[2]}`);
        const y = YEAR_END_ID.exec(tid);
        if (y) named.add(`ye:${y[1]}`);
      }
      if (named.size > 1) return { why: "A Download button names two documents." };
      if (!named.size) continue;
      const key = [...named][0];
      const seen = docs.get(key) || { key, buttons: [] };
      seen.buttons.push(button);
      docs.set(key, seen);
    }
    return { docs: [...docs.values()] };
  }

  function saysNone() {
    for (const el of document.querySelectorAll(AREA)) {
      if (!shown(el) || el.closest("footer, header, [role='contentinfo']")) continue;
      const words = tidy(el.innerText);
      if (NO_STATEMENTS.test(words) && !BY_POST.test(words)) return true;
    }
    return false;
  }

  function cardOnShow() {
    const box = Array.from(document.querySelectorAll(SELECTED)).find(shown) || Array.from(document.querySelectorAll(COMBOBOX)).find(shown);
    if (!box) return null;
    const num = Array.from(box.querySelectorAll(NUMBER)).find(shown);
    const digits = (num ? num.innerText : "").replace(/\D/g, "");
    const nameEl = Array.from(box.querySelectorAll(NAME)).find(shown);
    return { digits, name: nameEl ? cleanName(nameEl.innerText) : "" };
  }

  function otherCards(card) {
    if (!Array.from(document.querySelectorAll(COMBOBOX)).some(shown)) return { none: true };
    const options = Array.from(document.querySelectorAll(OPTION));
    const digits = new Set(options
      .map((o) => { const n = o.querySelector(NUMBER); return n ? n.textContent.replace(/\D/g, "") : ""; })
      .filter(Boolean));
    if (card && card.digits) digits.add(card.digits);
    if (digits.size > 1) return { why: `Only the card on show was read. Choose each of the other ${digits.size - 1} in the card switcher and sweep again.` };
    if (!options.length) return { why: "Only the card on show was read. If you have other cards, choose each in the card switcher and sweep again." };
    return { none: true };
  }

  const onList = () => location.pathname.startsWith("/activity/statements");
  const onAmex = () => location.hostname.endsWith("americanexpress.com");
  const HOW_TO_GET_THERE = "Open Statements & Activity, then Go to PDF Statements, in this tab and sweep again.";

  // What has been pressed on the way, kept on the page between askings, since
  // this file is run afresh each time. A press that did not work is not
  // repeated: the walk runs out of time and says so.
  const walk = () => (globalThis.__amexWalk = globalThis.__amexWalk || { pressed: new Set(), at: 0 });
  const firstShown = (selector) => Array.from(document.querySelectorAll(selector)).find(shown);
  const linkSaying = (words) => Array.from(document.querySelectorAll("a, [role='link']"))
    .find((a) => shown(a) && [a.innerText, a.getAttribute("aria-label")].some((t) => words.test(tidy(t))));

  function press(el, step) {
    const w = walk();
    if (!el || w.pressed.has(step)) return false;
    w.pressed.add(step);
    w.at = Date.now();
    el.click();
    return true;
  }

  // One step toward the statements. A sign-in with several cards lands on an
  // overview that has no Statements & Activity link until a card is chosen.
  function walkToList() {
    const w = walk();
    if (!w.at) w.at = Date.now();
    const activity = linkSaying(ACTIVITY_WORDS);
    if (location.pathname.startsWith("/activity")) {
      if (press(firstShown(PDF_LINKS) || linkSaying(PDF_WORDS), "pdf link")) return WALKING;
    } else if (location.pathname.includes("/overview") && !activity) {
      const option = Array.from(document.querySelectorAll(OPTION)).find((o) => shown(o) && /^\d{4,6}$/.test(digitsOf(o)));
      if (press(option, "card option") || press(firstShown(COMBOBOX), "card switcher")) return WALKING;
    } else if (press(activity, "activity link")) {
      return WALKING;
    }
    if (Date.now() - w.at > WALK_WAIT_MS) return { state: "stopped", why: `Amex's links to your PDF statements did not lead there. ${HOW_TO_GET_THERE}` };
    return WALKING;
  }

  async function waitFor(test, ms) {
    const end = Date.now() + ms;
    while (!test()) {
      if (Date.now() >= end) return false;
      await sleep(150);
    }
    return true;
  }

  // The cards this sweep has read, kept on the page between askings.
  const cardsRead = () => (globalThis.__amexCards = globalThis.__amexCards || new Set());
  const digitsOf = (option) => {
    const number = option.querySelector(NUMBER);
    return number ? number.textContent.replace(/\D/g, "") : "";
  };

  // The next card in Amex's switcher that has not been read. Every Download
  // of the old card must be gone first, or its statements would be saved
  // under the new card's name: a stop beats a wrong PDF.
  async function nextView() {
    const done = cardsRead();
    const card = cardOnShow();
    if (!card || !/^\d{4,6}$/.test(card.digits)) return { why: "The card on show could not be read." };
    done.add(card.digits);
    const finished = () => { delete globalThis.__amexCards; return { moved: false }; };
    const box = firstShown(COMBOBOX);
    if (!box) return finished();
    if (!firstShown(OPTION)) {
      box.click();
      if (!(await waitFor(() => firstShown(OPTION), SWITCHER_WAIT_MS))) return { why: "Amex's card switcher did not open." };
    }
    const next = Array.from(document.querySelectorAll(OPTION)).filter(shown).find((o) => /^\d{4,6}$/.test(digitsOf(o)) && !done.has(digitsOf(o)));
    if (!next) {
      const open = firstShown(COMBOBOX);
      if (open) open.click();
      return finished();
    }
    const digits = digitsOf(next);
    const held = Array.from(document.querySelectorAll(DOWNLOADS)).filter(shown);
    const wasEmpty = !held.length && saysNone();
    next.click();
    if (!(await waitFor(() => (cardOnShow() || {}).digits === digits, CARD_WAIT_MS))) return { why: "Amex did not change to the card chosen." };
    if (!(await waitFor(() => !held.some(shown), CARD_WAIT_MS))) return { why: "Amex did not redraw its statements for the card chosen." };
    if (wasEmpty) await waitFor(() => !saysNone(), EMPTY_WAIT_MS);
    return { moved: true };
  }

  async function readList(options = {}) {
    const result = await readPage(options);
    if (result.state !== "walking") delete globalThis.__amexWalk;
    return result;
  }

  async function readPage({ walk: mayWalk = false }) {
    const first = signIn();
    if (first) return first;
    if (!onAmex() || !onList()) {
      if (mayWalk && onAmex()) return walkToList();
      return { state: "stopped", why: `Amex keeps your session in the page. ${HOW_TO_GET_THERE}` };
    }
    const end = Date.now() + LIST_WAIT_MS;
    let read = listed();
    while (!read.why && !read.docs.length && !saysNone()) {
      if (Date.now() >= end) return { state: "stopped", why: "The statements page shows no list and does not say it has none." };
      await sleep(250);
      const held = signIn();
      if (held) return held;
      read = listed();
    }
    if (read.why) return { state: "stopped", why: read.why };
    const docs = [];
    const card = cardOnShow();
    const digits = card && /^\d{4,6}$/.test(card.digits) ? card.digits : "";
    const others = otherCards(card);
    if (!digits && (others.why || document.querySelectorAll(OPTION).length > 1)) {
      return { state: "stopped", why: "The card on show could not be read, and other cards may be on this account, so nothing was listed.", docs };
    }
    for (const { key, buttons } of read.docs) {
      if (!buttons.some(shown)) continue; // in a section closed on the page
      const [kind, when] = key.split(":");
      const date = kind === "stmt" ? when : `${when}-12-31`;
      if (!realDate(date)) return { state: "stopped", why: "A statement's date could not be read.", docs };
      const words = kind === "stmt" ? "Monthly Statement" : "Year-End Summary";
      docs.push({ id: digits ? `${digits}:${key}` : key, date, method: "click", title: (others.none && !mayWalk) || !card ? words : `${words} ${card.name} (${card.digits})` });
    }
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const older = document.querySelector("[aria-controls='content-older-statements']");
    if (older && (older.getAttribute("aria-expanded") || "").toLowerCase() === "false") {
      if (mayWalk && press(older, "older statements")) return WALKING;
      return { state: "stopped", why: "Older Statements is closed on the page. Open it and sweep again.", docs };
    }
    if (mayWalk && firstShown(COMBOBOX)) return { state: "ok", docs, more: true };
    return others.why ? { state: "ok", docs, note: others.why } : { state: "ok", docs };
  }

  const ownDialog = () => Array.from(document.querySelectorAll(DIALOGS)).reverse().find((d) => shown(d) && d.querySelector(CONFIRM)) || null;

  async function closeDialog() {
    const dialog = ownDialog();
    if (!dialog) return true;
    const closer = Array.from(dialog.querySelectorAll("button, [role='button'], a"))
      .find((b) => shown(b) && /^(cancel|close)$/i.test(tidy(b.innerText || b.getAttribute("aria-label"))));
    if (!closer) return false;
    closer.click();
    for (let i = 0; i < 20 && ownDialog(); i++) await sleep(150);
    return !ownDialog();
  }

  function pdfChoice(dialog) {
    for (const selector of ["input[type='radio'][value='statement_pdf']", "input[type='radio'][value*='pdf' i]"]) {
      const found = Array.from(dialog.querySelectorAll(selector)).filter((r) => !/accessible|screen/i.test(r.value));
      if (found.length) return found.find(shown) || found[0];
    }
    return null;
  }

  async function clickDoc(doc) {
    const parts = ID.exec((doc && doc.id) || "");
    if (!parts) return { ok: false, why: "not a document of this list" };
    const card = cardOnShow();
    if (parts[1] && (!card || card.digits !== parts[1])) return { ok: false, why: "Another card is on show." };
    if (!(await closeDialog())) return { ok: false, why: "A file type dialog is open and would not close." };
    const tail = parts[3] ? `/${parts[3]}/download-button` : `/year-end-summary/${parts[4]}/download-button`;
    const button = Array.from(document.querySelectorAll(DOWNLOADS))
      .find((b) => shown(b) && testIds(b).some((tid) => tid.endsWith(tail)));
    if (!button) return { ok: false, why: "That document's Download is not on the page." };
    if (turnedOff(button)) return { ok: false, why: "That document's Download is turned off." };
    button.click();
    const end = Date.now() + DIALOG_WAIT_MS;
    let dialog = ownDialog();
    while (!dialog && Date.now() < end) {
      await sleep(250);
      dialog = ownDialog();
    }
    if (!dialog) return { ok: false, why: "The file type dialog did not open." };
    let radio = pdfChoice(dialog);
    for (let i = 0; i < 10 && !radio; i++) {
      await sleep(500);
      radio = pdfChoice(dialog);
    }
    if (!radio) return { ok: false, why: "The file type dialog offered no plain PDF." };
    radio.click();
    if (!radio.checked) return { ok: false, why: "The plain PDF could not be chosen." };
    const confirm = Array.from(dialog.querySelectorAll(CONFIRM)).find(shown);
    if (!confirm) return { ok: false, why: "The file type dialog showed no Download." };
    confirm.click();
    return { ok: true };
  }

  globalThis.__sweep = { readList, clickDoc, nextView };
})();
