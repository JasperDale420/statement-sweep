// Runs inside card.apple.com. Reads the card's statements, the Savings
// statements and the Savings tax forms (1099-INT), each from the one way
// Apple names a document's button, and presses only a document's own
// Download and the few menu links that lead to those three lists.
//
// The sections of card.apple.com are drawn by its own menu and answer 404 by
// address, so a list is reached the way a person reaches it, through the
// menu, and only in a tab the sweep opened itself: the menu's Statements for
// the card, and Savings, then Documents, then "Statements <count>" or "Tax
// Documents <count>" for the other two. The Savings statements and the tax
// forms share one address and one button shape, so which one is on screen is
// known only from the link this pressed to open it, and in a tab of yours,
// where nothing is pressed, a Savings list is not read.
//
// Derived from PaperPull's apps/applecard/applecard_site.py (AGPL-3.0).
(() => {
  const DRAW_WAIT_MS = 30000;
  const STEP_WAIT_MS = 8000;
  const STEP_SETTLE_MS = 1500;
  const ARRIVE_WAIT_MS = 10000;
  const MAX_PRESSES = 8;
  const REVEAL_MS = 600;
  const REVEAL_ROUNDS = 40;
  const MORE_PRESSES = 30;
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const LOGIN_MARKERS = ["/login", "/signin", "/sign-in", "/auth/", "/mfa", "/verification", "/challenge", "/authenticate"];
  const SIGN_IN_FRAME = "iframe[src*='idmsa.apple.com'], iframe[src*='appleid.apple.com']";
  const CHECK_MARKERS = ["enter the code", "verification code", "6-digit", "two-factor", "two-step", "authenticator", "confirm your identity", "verify your identity", "we sent a code", "trusted device", "trusted phone number", "unusual", "are you a robot", "captcha", "check your email", "check your phone", "access denied", "reference #"];
  const ENDED_MARKERS = ["your session has expired", "log back in"];
  const RATE_MARKERS = ["too many requests", "rate limit", "try again later", "temporarily unavailable", "http error 429", "unusual traffic"];
  // A short line for the run log (shared.js), never the page's own text.
  const trace = (text) => { if (globalThis.__sweepLog) globalThis.__sweepLog(text); };
  const MONTH = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
  const DOC_BUTTON = new RegExp(`^\\s*download\\s+statement\\s+of\\s+${MONTH}\\s+((?:19|20)\\d{2})\\s*\\(\\s*pdf\\s*\\)\\s*$`, "i");
  const BILL_CONTROL = /((download|view|print|open|get)\s*(my\s+|the\s+|this\s+|your\s+)?(statement|document|pdf|tax|letter|notice|1099)|(statement|document|tax\s+form|1099(-?int)?)\s*\(?\s*pdf\s*\)?|\bpdf\b|\b1099-?int\b|^\s*(view|download|open)\s*$)/i;
  const TAX_WORDS = /1099|\btax\b/i;
  const INT_FORM = /1099[\s-]*int/i;
  // PaperPull's expand_all: a list's own control for the rest of it, its
  // every label saying only that.
  const MORE = /^\s*(show|load|view|see)\s+(more|all|older)(\s+(statements?|documents?))?\s*$|^\s*(older|previous)\s+statements?\s*$/i;
  const ROW_DATE = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2},?\s+)?\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|\b(19|20)\d{2}\b/i;
  // card:<month end> is the id the card's statements always had. The other
  // two kinds have prefixes of their own, so no id of one is another's.
  const ID = /^(card|savings):(\d{4}-\d{2}-\d{2})$|^(tax):((?:19|20)\d{2})$/;

  const CARD = "card", SAVINGS = "savings", TAX = "tax";
  const KINDS = [CARD, SAVINGS, TAX];
  const NAMES = { [CARD]: "the card's statements", [SAVINGS]: "the Savings statements", [TAX]: "the Savings tax forms" };
  // The links pressed to reach each list, as PaperPull's SECTION_PATH, each
  // matched whole. The menu's Statements never carries a count, and both
  // links under Savings' Documents do, so the card's link cannot be taken for
  // the Savings statements'.
  // Apple's side menu: a <nav>, or whatever the page marks as navigation, an
  // aside, or the header. Its entries may be links or buttons.
  const NAV = "nav, [role='navigation'], aside, header", MAIN = "main";
  const ITEMS = "a, [role='link'], button, [role='button'], [role='tab'], [role='menuitem']";
  const PATHS = {
    [CARD]: [[NAV, /^\s*statements?\s*$/i]],
    [SAVINGS]: [[NAV, /^\s*savings\s*$/i], [MAIN, /^\s*documents?\s*$/i], [MAIN, /^\s*statements?\s*(\d+)\s*$/i]],
    [TAX]: [[NAV, /^\s*savings\s*$/i], [MAIN, /^\s*documents?\s*$/i], [MAIN, /^\s*tax\s+documents?\s*(\d+)\s*$/i]],
  };

  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const shown = (el) => Boolean(el) && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nameOf = (el) => tidy(el.getAttribute("aria-label") || el.innerText);
  // A control's name as a screen reader gives it, the words it is labelled by
  // first, and its own words when none of them read as a document's, as
  // PaperPull's controls_named falls back to a control's text (#38).
  function labelsOf(el) {
    const by = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.textContent).join(" ");
    return [tidy(by), tidy(el.getAttribute("aria-label")), tidy(el.innerText), tidy(el.textContent)].filter(Boolean);
  }
  const docName = (el) => labelsOf(el).find((l) => DOC_BUTTON.test(l)) || "";
  const controls = () => Array.from(document.querySelectorAll("button, a, [role='button'], [role='link']")).filter(shown);
  const turnedOff = (el) => el.disabled === true || el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

  // Signed in: the side menu is drawn, with Statements or Savings, or the
  // signed-in card pages' other entries (Payments, Installments).
  const inMenu = (sel) => NAV.split(",").map((s) => `${s.trim()} ${sel}`).join(", ");
  const menuDrawn = () => Array.from(document.querySelectorAll(inMenu(ITEMS)))
    .some((a) => shown(a) && /^\s*(statements?|savings|payments|installments)\s*$/i.test(tidy(a.innerText || a.getAttribute("aria-label"))));
  // The signed-out front page: Apple's own Sign In, and no menu.
  const welcomePage = () => !menuDrawn() && controls()
    .some((el) => /^\s*sign\s*in\s*$/i.test(tidy(el.innerText || el.getAttribute("aria-label"))));
  const docButtons = () => controls().filter((el) => docName(el));

  async function waitFor(test, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const found = test();
      if (found || Date.now() >= end) return found;
      await sleep(250);
    }
  }

  // Statements run for a calendar month, so one closes on its month's last
  // day. A tax form's button names a month and year the same way, and the
  // year is the form's own (PaperPull's tax_list_date, checked against the
  // year printed on the form), so it is filed at that year's end.
  // Every month of the list drawn before it is read, as PaperPull's
  // collect_download_docs does: the list scrolled to its end until no more
  // buttons come, and, in a tab the sweep opened, the list's own "Show more"
  // pressed while it is there. Scrolling presses nothing.
  // Only a button: a link of those words may lead off the list.
  function moreButton() {
    return controls().find((el) => !el.closest("nav, a, [role='link']") && !turnedOff(el)
      && [tidy(el.getAttribute("aria-label")), tidy(el.innerText)].filter(Boolean).every((l) => MORE.test(l))
      && [tidy(el.getAttribute("aria-label")), tidy(el.innerText)].some(Boolean)) || null;
  }

  async function reveal(mayPress) {
    const here = location.href;
    let still = 0, more = 0;
    for (let round = 0; round < REVEAL_ROUNDS && still < 2 && location.href === here; round++) {
      const before = docButtons();
      const button = mayPress && more < MORE_PRESSES ? moreButton() : null;
      if (button) {
        more += 1;
        button.click();
      } else {
        const last = before[before.length - 1];
        for (let node = last && last.parentElement; node; node = node.parentElement) {
          if (node.scrollHeight > node.clientHeight + 1) node.scrollTop = node.scrollHeight;
        }
        window.scrollTo(0, document.documentElement.scrollHeight);
      }
      await sleep(REVEAL_MS);
      still = !button && docButtons().length === before.length ? still + 1 : 0;
    }
  }

  function dateOf(kind, label) {
    const m = DOC_BUTTON.exec(label);
    if (!m) return null;
    if (kind === TAX) return `${m[2]}-12-31`;
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    return new Date(Date.UTC(+m[2], month + 1, 0)).toISOString().slice(0, 10);
  }
  const idOf = (kind, date) => (kind === TAX ? `tax:${date.slice(0, 4)}` : `${kind}:${date}`);

  function signedOut() {
    const url = location.href.toLowerCase();
    if (LOGIN_MARKERS.some((m) => url.includes(m)) || document.querySelector("input[type='password']")) return true;
    if (welcomePage()) return true;
    // Apple's sign-in is a frame this cannot look inside. A frame on a page with
    // nothing else drawn is a sign-in; a signed-in page may keep one around.
    const frame = Array.from(document.querySelectorAll(SIGN_IN_FRAME)).some(shown);
    return frame && !menuDrawn() && !docButtons().length;
  }

  // PaperPull asks for a check only once a list is reached, where its
  // document buttons make the page a normal one. A page with the signed-in
  // menu drawn is one too, whatever its words: a home page's notices
  // ("unusual", "check your phone") are not a check.
  function held() {
    if (signedOut()) return { state: "signed_out" };
    if (menuDrawn() || controls().some((el) => BILL_CONTROL.test(nameOf(el)) || docName(el))) return null;
    const hay = `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 1500)}`.toLowerCase();
    if (ENDED_MARKERS.some((m) => hay.includes(m))) return { state: "signed_out" };
    if (CHECK_MARKERS.some((m) => hay.includes(m))) return { state: "challenge" };
    if (RATE_MARKERS.some((m) => hay.includes(m))) return { state: "stopped", why: "Apple asked for a pause. Try again later." };
    return null;
  }

  // RECORDED in PaperPull: Savings keeps /savings in the address on every
  // page under it, and the card's statements are at the front page's.
  function savingsPage() {
    const headings = Array.from(document.querySelectorAll("h1, h2")).slice(0, 6).map((h) => h.innerText).join(" ");
    return location.pathname.toLowerCase().includes("savings") || /\bsavings\b/i.test(headings);
  }

  // RECORDED: the Savings lists carry a link back to Documents; the card's
  // statements have no link of that name anywhere.
  const backToDocuments = () => Array.from(document.querySelectorAll("main a, main [role='link']"))
    .some((a) => shown(a) && /^\s*documents?\s*$/i.test(tidy(a.innerText || a.getAttribute("aria-label"))));

  function rowOf(el) {
    for (let node = el, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
      const words = (node.innerText || "").trim();
      if (ROW_DATE.test(words)) return words.slice(0, 300);
    }
    return "";
  }

  // Where the walk is, kept on the page between askings, since this file is
  // run afresh each time: the list this opened, at what address, the count
  // its link carried, and how many presses it has made.
  const walkState = () => (globalThis.__appleCardWalk = globalThis.__appleCardWalk || { kind: null, url: "", count: null, presses: 0 });
  const opened = () => (globalThis.__appleCardWalk && globalThis.__appleCardWalk.kind ? globalThis.__appleCardWalk : null);

  // What the list on screen must show before it is read as `kind`'s, as in
  // PaperPull's _list_checks: its buttons drawn, none left from before the
  // press, the address agreeing, no link back to Documents on the card's, and
  // no more buttons than the link that opened it counted.
  function listIs(kind, old = [], count = null) {
    const buttons = docButtons();
    return buttons.length > 0
      && old.every((el) => !shown(el))
      && savingsPage() === (kind !== CARD)
      && (kind !== CARD || !backToDocuments())
      && (count === null || buttons.length <= count);
  }

  // The kind of list on screen and that it may be read, or why not.
  function onScreen() {
    const w = opened();
    if (w) {
      if (location.href !== w.url) return { why: `card.apple.com moved away from ${NAMES[w.kind]} this opened.` };
      if (!listIs(w.kind, [], w.count)) return { why: `${NAMES[w.kind][0].toUpperCase()}${NAMES[w.kind].slice(1)} are no longer on screen as this opened them.` };
      return { kind: w.kind };
    }
    if (savingsPage()) return { why: "This is a Savings list. Its statements and tax forms cannot be told apart unless this opens them, so nothing is saved from it here. Close this tab and sweep again, and Statement Sweep opens its own." };
    if (backToDocuments()) return { why: "This looks like a Savings list, not the card's Statements. Close this tab and sweep again, and Statement Sweep opens its own." };
    return { kind: CARD };
  }

  function readDocs(kind) {
    const counted = new Map();
    const titles = new Map();
    for (const el of docButtons()) {
      const date = dateOf(kind, docName(el));
      if (!date) return { why: "A document's month could not be read." };
      const row = rowOf(el);
      // A statement row that speaks of tax is neither a statement nor, on a
      // statements list, known to be a tax form.
      if (kind !== TAX && TAX_WORDS.test(row)) return { why: "A row on this list reads as a tax form." };
      counted.set(date, (counted.get(date) || 0) + 1);
      if (kind === TAX) titles.set(date, INT_FORM.test(`${docName(el)} ${row}`) ? "1099-INT" : "Savings Tax Document");
    }
    const title = (date) => (kind === CARD ? "Statement" : kind === SAVINGS ? "Savings Statement" : titles.get(date));
    const docs = [...counted.keys()].filter((d) => counted.get(d) === 1).sort().reverse()
      .map((date) => ({ id: idOf(kind, date), date, title: title(date), method: "click" }));
    const doubled = docs.length !== counted.size
      ? (kind === TAX ? "Two buttons name one tax year" : "Two buttons name one month") : "";
    return { docs, doubled };
  }

  // The one shown link a path step names inside its part of the page, its
  // name (as PaperPull reads it, the label or else the words) matched whole,
  // or why there is more than one.
  function stepLink([where, rx]) {
    const scope = where === NAV ? inMenu(ITEMS) : `${where} a, ${where} [role='link']`;
    const found = Array.from(document.querySelectorAll(scope))
      .filter((a) => shown(a) && !turnedOff(a) && rx.test(nameOf(a)));
    const unique = [...new Set(found)];
    if (unique.length > 1) return { why: "card.apple.com shows two links where this expects one, so neither is pressed." };
    return { el: unique[0] || null };
  }

  function press(el) {
    const w = walkState();
    w.presses += 1;
    if (w.presses > MAX_PRESSES * KINDS.length) return false;
    el.click();
    return true;
  }

  // Press along `kind`'s path, always the furthest link on screen, so a walk
  // that starts partway along, on Savings' Documents or on one of the lists
  // under it, carries on from there (PaperPull's _walk). Answers the count the
  // last link carried, or what stopped it.
  async function walkTo(kind) {
    const path = PATHS[kind];
    const old = docButtons();
    let start = 0;
    for (let presses = 0; presses < MAX_PRESSES; presses++) {
      let step = -1, link = null, why = "";
      await waitFor(() => {
        for (let j = path.length - 1; j >= start; j--) {
          const found = stepLink(path[j]);
          if (found.why) { why = found.why; return true; }
          if (found.el) { step = j; link = found.el; return true; }
        }
        return signedOut();
      }, STEP_WAIT_MS);
      if (why) return { why };
      if (signedOut()) return { why: "Apple asked for a sign-in." };
      if (!link) return { missing: start };
      const last = step === path.length - 1;
      const m = last && path[step][1].exec(nameOf(link));
      const count = m && m[1] !== undefined ? +m[1] : null;
      // The link says the list is empty: nothing to open and nothing to read.
      if (count === 0) return { empty: true };
      if (!press(link)) return { why: "card.apple.com took more presses than expected to reach its lists." };
      if (last) {
        if (!(await waitFor(() => listIs(kind, old, count), ARRIVE_WAIT_MS))) {
          return { why: `${NAMES[kind][0].toUpperCase()}${NAMES[kind].slice(1)} did not draw after their link was pressed.` };
        }
        return { count };
      }
      await sleep(STEP_SETTLE_MS);
      start = step + 1;
    }
    return { why: "card.apple.com took more presses than expected to reach its lists." };
  }

  // Opens `kind`'s list and remembers it, or answers why not, or that there
  // is nothing of that kind to read (`none`, with a note when worth saying).
  async function open(kind) {
    const got = await walkTo(kind);
    trace(`Walk to ${NAMES[kind]}: ${got.why ? `stopped: ${got.why}` : got.empty ? "its link says none" : got.missing !== undefined ? `no link at step ${got.missing + 1}` : `opened${got.count !== null && got.count !== undefined ? `, its link says ${got.count}` : ""}`}.`);
    if (got.why) return { why: got.why };
    if (got.empty) return { none: true };
    if (got.missing !== undefined) {
      if (kind === CARD) return { why: "card.apple.com's menu shows no Statements link." };
      if (got.missing === 0) return { none: true, note: "card.apple.com's menu shows no Savings, so only the card's statements were read." };
      if (got.missing === 1) return { none: true, note: "Savings showed no Documents link, so no Savings statements or tax forms were read." };
      return { none: true, note: `Savings' Documents showed no link to ${kind === TAX ? "Tax Documents" : "Statements"}, so ${NAMES[kind]} were not read.` };
    }
    Object.assign(walkState(), { kind, url: location.href, count: got.count });
    return { kind };
  }

  // One step on: the next of the three lists that has anything in it.
  async function nextView() {
    const w = opened();
    if (!w) return { why: "card.apple.com's lists were not opened by this sweep." };
    const notes = [];
    for (let i = KINDS.indexOf(w.kind) + 1; i < KINDS.length; i++) {
      const got = await open(KINDS[i]);
      if (got.why) return { why: got.why };
      if (got.kind) return { moved: true };
      if (got.note) notes.push(got.note);
      // No Savings or no Documents means neither list under it is there.
      if (got.note && !/^Savings' Documents/.test(got.note)) break;
    }
    delete globalThis.__appleCardWalk;
    return notes.length ? { moved: false, note: notes.join(" ") } : { moved: false };
  }

  async function readList({ walk: mayWalk = false } = {}) {
    let stop = held();
    if (stop) return stop;
    const end = Date.now() + DRAW_WAIT_MS;
    while (!menuDrawn() && !docButtons().length) {
      if (Date.now() >= end) {
        trace(`Nothing drawn after ${DRAW_WAIT_MS / 1000} s: no menu and no document buttons.`);
        return { state: "stopped", why: "card.apple.com did not draw its menu." };
      }
      await sleep(250);
      stop = held();
      if (stop) return stop;
    }
    if (mayWalk && !opened()) {
      // The card's statements come first, as in PaperPull. When they are on
      // screen already they are read as they are.
      const here = docButtons().length && !savingsPage() && !backToDocuments();
      if (here) Object.assign(walkState(), { kind: CARD, url: location.href, count: null });
      else {
        const got = await open(CARD);
        if (got.why) return { state: "stopped", why: got.why };
      }
    }
    if (!mayWalk) delete globalThis.__appleCardWalk;
    // Apple keeps the sign-in in this tab only: another tab opens signed out.
    // So a signed-in tab of yours is carried on in, by Apple's own menu.
    if (!mayWalk && !docButtons().length && menuDrawn()) {
      trace("Signed in, menu drawn, no list on screen: asking to carry on in this tab.");
      return { state: "ready", why: "Signed in to Apple Card in this tab." };
    }
    if (!docButtons().length) return { state: "stopped", why: "The statements list is not on screen. Open Statements from card.apple.com's menu in this tab and sweep again." };
    const where = onScreen();
    trace(`On screen: ${where.why ? `unclear: ${where.why}` : NAMES[where.kind]}; ${docButtons().length} document button(s); walk ${mayWalk}.`);
    if (where.why) return { state: "stopped", why: where.why };
    await reveal(mayWalk);
    const read = readDocs(where.kind);
    trace(read.why ? `Read stopped: ${read.why}` : `Read ${read.docs.length} of ${NAMES[where.kind]}${read.doubled ? `, ${read.doubled}` : ""}.`);
    if (read.why) return { state: "stopped", why: read.why };
    const { docs, doubled } = read;
    if (mayWalk) {
      const note = doubled ? `${doubled} on ${NAMES[where.kind]}, so neither was saved.` : undefined;
      return note ? { state: "ok", docs, more: true, note } : { state: "ok", docs, more: true };
    }
    if (doubled) return { state: "stopped", why: `${doubled}, so neither is saved.`, docs };
    // In a tab of yours nothing is pressed, so Savings is left for a sweep
    // in a tab of its own.
    if (stepLink(PATHS[SAVINGS][0]).el) {
      return { state: "stopped", why: "Only the card's statements were read. Savings statements and tax forms are under Savings in card.apple.com's menu; close this tab and sweep again, and Statement Sweep opens its own tab and reads all three.", docs };
    }
    return { state: "ok", docs };
  }

  function clickDoc(doc) {
    const m = ID.exec((doc && doc.id) || "");
    if (!m) return { ok: false, why: "not a document of these lists" };
    const kind = m[1] || m[3];
    const date = kind === TAX ? `${m[4]}-12-31` : m[2];
    const where = onScreen();
    if (where.why) return { ok: false, why: where.why };
    if (where.kind !== kind) return { ok: false, why: `${NAMES[kind][0].toUpperCase()}${NAMES[kind].slice(1)} are not on screen.` };
    const same = docButtons().filter((el) => dateOf(kind, docName(el)) === date);
    if (same.length !== 1) return { ok: false, why: "That document's button is not on the page once." };
    if (kind !== TAX && TAX_WORDS.test(rowOf(same[0]))) return { ok: false, why: "That row reads as a tax form." };
    if (turnedOff(same[0])) return { ok: false, why: "That document's button is turned off." };
    same[0].click();
    return { ok: true };
  }

  globalThis.__sweep = { readList, clickDoc, nextView };
})();
