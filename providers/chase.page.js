// Runs inside Chase's own page, where the sign-in already lives. Reads the
// statement rows Chase has drawn and presses only a row's "Saves document".
// In a tab the sweep opened, it also walks every year of the View picker and
// every card of each year, pressing only a card's own header and a year's own
// option, the way PaperPull's chase_collect_via_api does.
//
// A Chase sign-in can hold business accounts too. Chase Business saves
// those, so a business account is never opened or read here: only a card
// whose name carries no business word, and only rows that name that card in
// full, which a business account's rows never do (as in PaperPull, where
// they read as no document at all).
//
// The center is opened at the address PaperPull's own press of the
// dashboard's "Statements & documents" lands on. When Chase draws something
// else there, its business account menu or its front page, a tab the sweep
// opened presses that link once, the way PaperPull reaches the center.
//
// Derived from PaperPull's apps/chase/chase_site.py (AGPL-3.0).
(() => {
  const DRAW_WAIT_MS = 30000;
  const MENU_SETTLE_MS = 3000;
  const SETTLE_MS = 1500;
  const CARD_WAIT_MS = 15000;
  const YEAR_WAIT_MS = 8000;
  const OPTION_WAIT_MS = 5000;
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const LOGIN_MARKERS = ["/logon", "/login", "/signin", "/sign-in", "/auth/logon", "/idp", "/mfa", "/verify", "chase.com/web/auth#/logon"];
  const CHECK_MARKERS = ["enter the code we sent", "enter your verification code", "verification code", "one-time", "one time passcode", "security code", "we sent a code", "two-factor", "two-step", "authenticator", "confirm your identity", "verify your identity", "we need to verify", "unusual activity", "are you a robot", "captcha", "unable to verify", "trouble verifying"];
  const ENDED_MARKERS = ["your session has expired", "please log in again", "you've been logged out", "for your security, we signed you out"];
  const RATE_MARKERS = ["too many requests", "rate limit", "try again later", "temporarily unavailable", "http error 429", "unusual traffic"];
  // A short line for the run log (shared.js), never the page's own text.
  const trace = (text) => { if (globalThis.__sweepLog) globalThis.__sweepLog(text); };
  const DOC_ROWS = "table tbody tr, [role='row'], [class*='statement-row'], [class*='StatementRow'], [class*='documentRow'], [data-testid*='statement'], [data-testid*='document'], li[class*='statement'], li[class*='document']";
  const ROUTE = "#/dashboard/documents/";
  const YEAR_PICKER = "input[id*='filterstyledselect']";
  const YEAR_OPTIONS = "[role='option'], [id^='container-'][id*='filterstyledselect']";
  const YEAR_LEADS = /^((?:19|20)\d{2})\b/;
  // A year option reads as its year, and only these words may follow it.
  const YEAR_CHOICE = /^((?:19|20)\d{2})(\s*,\s*(current selection|you['’]ve reached the end of the list))?$/i;
  // The same, allowing only the words screen readers add around a year
  // option: where it sits in the list, that it is chosen, or what it is.
  const YEAR_LOOSE = /^((?:19|20)\d{2})(?:[\s,.;:()-]*(?:current selection|selected|you['’]ve reached the end of the list|\d{1,2}\s+of\s+\d{1,2}|option|list\s*item))*[\s,.;:()-]*$/i;
  const CARD = /\(\s*\.{2,}\s*\d{4}\s*\)/;
  // A card header reads wholly as the card a row names, nothing more.
  const CARD_ENTRY = /^[A-Z0-9][^()]*\(\s*\.{2,}\s*\d{4}\s*\)$/;
  const ROW_NAME = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{1,2}),\s*(20\d{2})\s+(.*?)\s+([A-Z0-9][^()]*\(\s*\.{2,}\s*\d{4}\s*\))/i;
  // Chase sells cards named "...REWARDS...", so a row or a card is judged on
  // action verbs, not on the words of a product's name.
  const CARD_ACTION = /\bpay\b|\bpayment\b|transfer|redeem|activat|\block\b|unlock|replace|dispute|\bclose\b|appl(y|ies|ied|ication)\b|request|increase|advance|authorized\s+user|set\s+up|\bchang(e|es|ed|ing)\b|\bupdat(e|es|ed|ing)\b|\bmanage\b|autopay|auto-?pay|zelle|\bwire\b|deposit|withdraw|\bsend\b|enroll|\bopen\b|\bcancel\b|\bsettings?\b|\bpreferences?\b/i;
  const SAFE_DOC = /(download|view|open|print|pdf|statement|document|1099|1098|5498|tax|e-?statement|year.?end)/i;
  // The dashboard's own link to the document center (PaperPull's
  // click_documents_nav, which its runs found as "Statements & documents").
  const NAV_LINK = /^statements?\s*(&|and)\s*documents?$/i;
  // Chase Business's account menu, a[id^="bottom-"] (its survey).
  const MENU_ENTRY = "a[id^='bottom-']";
  // What Chase Business reads as its own: an account named business, a
  // business checking ("BUS COMPLETE CHK"), and a cardholder's entry under a
  // business card ("J. SURNAME (...1234)").
  const BUSINESS = /\bBUS(INESS)?\b|\bCHK\b/i;
  const CARDHOLDER = /^[A-Z]\.\s+[A-Z][A-Z'’-]*(\s+[A-Z][A-Z'’-]*)*\s*\(\s*\.{2,}\s*\d{4}\s*\)$/;
  const BUSINESS_ONLY = "Chase's Statements & documents shows only business accounts in this sign-in, and Chase Business saves those. If your personal card is under another Chase profile or sign-in, switch to it in this tab and sweep again; if not, untick Chase.";

  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function day(year, month, date) {
    const d = new Date(Date.UTC(year, month, date));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== date) return null;
    return d.toISOString().slice(0, 10);
  }

  function signedOut() {
    const url = location.href.toLowerCase();
    // Chase can keep a page's address and draw its sign-in in a frame over it.
    const frame = document.querySelector("iframe[name='logonbox'], iframe#logonbox");
    return LOGIN_MARKERS.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']")) || Boolean(frame && shown(frame));
  }

  // A page drawing its list is a normal page, whatever its words.
  function held() {
    if (document.querySelectorAll(DOC_ROWS).length > 2) return null;
    const hay = `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 1500)}`.toLowerCase();
    if (ENDED_MARKERS.some((m) => hay.includes(m))) return { state: "signed_out" };
    if (CHECK_MARKERS.some((m) => hay.includes(m))) return { state: "challenge" };
    if (RATE_MARKERS.some((m) => hay.includes(m))) return { state: "stopped", why: "Chase asked for a pause. Try again later." };
    return null;
  }

  const anotherTab = () => {
    const found = /documentType=([A-Za-z_]+)/i.exec(location.href);
    return Boolean(found) && found[1].toUpperCase() !== "STATEMENTS";
  };

  const business = (label) => BUSINESS.test(label) || CARDHOLDER.test(label);

  // Every card-shaped header on the page, a business account's included.
  function allCards() {
    return Array.from(document.querySelectorAll("button, [role='button']"))
      .filter((el) => shown(el))
      .map((el) => ({ el, label: tidy(el.innerText) }))
      .filter((c) => CARD.test(c.label) && !CARD_ACTION.test(c.label));
  }

  // The personal cards: the only headers this ever presses or reads.
  const cards = () => allCards().filter((c) => !business(c.label) && !business(tidy(c.el.getAttribute("aria-label"))));

  const menuEntries = () => Array.from(document.querySelectorAll(MENU_ENTRY)).filter(shown);

  // The one link this presses outside the center: the dashboard's own to
  // Statements & documents, every label it carries saying just that, and
  // never one to another site.
  function navLink() {
    return Array.from(document.querySelectorAll("a, [role='link']")).find((a) => {
      if (!shown(a) || a.matches(MENU_ENTRY)) return false;
      const labels = [tidy(a.innerText), tidy(a.getAttribute("aria-label"))].filter(Boolean);
      if (!labels.length || !labels.every((l) => NAV_LINK.test(l))) return false;
      const href = a.getAttribute("href");
      if (!href) return true;
      try {
        const to = new URL(href, location.href);
        return !/^https?:$/.test(to.protocol) || to.hostname === "secure.chase.com";
      } catch (e) { return false; }
    }) || null;
  }

  // Drawn for any account, so a center of business accounts alone is told
  // from one that never drew.
  function centerDrawn() {
    if (!location.href.includes(ROUTE)) return false;
    return Boolean(yearShown()) && allCards().length > 0;
  }

  // What Chase drew where the center should be: its account menu, or
  // nothing this reads. A tab the sweep opened presses the dashboard's own
  // link once; anything else stops, or, for a menu in a tab not walked, is
  // no list at all, so the sweep opens a tab of its own.
  function notDrawn(mayWalk, menu) {
    if (mayWalk && !globalThis.__chaseNav) {
      const link = navLink();
      if (link) {
        globalThis.__chaseNav = true;
        trace("No statements center drawn: pressing Chase's own Statements & documents link.");
        link.click();
        return { state: "walking" };
      }
    }
    trace(`Layout: ${menu ? `an account menu of ${menuEntries().length} entries (Chase Business's)` : "nothing this reads, after the wait"}; walk ${mayWalk}.`);
    if (menu && !mayWalk) return { state: "no_list" };
    if (menu) {
      const personal = menuEntries().map((a) => tidy(a.innerText).replace(/\s*,\s*current selection\s*$/i, ""))
        .filter((l) => CARD.test(l) && !business(l));
      trace(`Personal cards in the menu: ${personal.length}.`);
      if (!personal.length) return { state: "stopped", why: BUSINESS_ONLY };
      return { state: "stopped", why: "Chase drew Statements & documents as an account menu, which this does not read for a personal card. Open Statements & documents from Chase's own menu in this tab and sweep again." };
    }
    return { state: "stopped", why: "Chase did not show personal card statements. If your Chase sign-in holds only business accounts, Chase Business saves them: untick Chase." };
  }

  function yearShown() {
    return Array.from(document.querySelectorAll(YEAR_PICKER)).slice(0, 5)
      .map((p) => tidy(p.value || p.getAttribute("value")))
      .find((v) => /^20\d{2}$/.test(v)) || "";
  }

  // The years the View picker has drawn. Its list exists only while it is
  // open, and opening it is not a document's own control, so no list on the
  // page means the years are not known.
  function yearsOffered() {
    const years = new Set();
    for (const el of document.querySelectorAll(YEAR_OPTIONS)) {
      for (const label of [tidy(el.textContent), tidy(el.getAttribute("aria-label"))]) {
        const m = YEAR_LEADS.exec(label);
        if (m) years.add(m[1]);
      }
    }
    return years;
  }

  // Every row a "Saves document" link names, read from its full label.
  function rowsOf() {
    const rows = [];
    for (const link of document.querySelectorAll("a, [role='link']")) {
      const labels = [tidy(link.innerText), tidy(link.getAttribute("aria-label"))].filter((l) => /saves document/i.test(l));
      const found = labels.map((l) => [l, ROW_NAME.exec(l)]).find(([, m]) => m);
      if (!found) continue;
      const [label, m] = found;
      const date = day(+m[3], MONTHS.indexOf(m[1].toLowerCase()), +m[2]);
      rows.push({ link, label, date, type: tidy(m[4]), card: tidy(m[5]) });
    }
    return rows;
  }

  const idOf = (row) => `${row.date}|${row.type}|${row.card}`;
  const safeRow = (label) => Boolean(label) && !CARD_ACTION.test(label) && SAFE_DOC.test(label);

  async function waitFor(test, ms) {
    const end = Date.now() + ms;
    while (!test()) {
      if (Date.now() >= end) return false;
      await sleep(150);
    }
    return true;
  }

  const isOpen = (el) => (el.getAttribute("aria-expanded") || "").toLowerCase() === "true";

  // Only a card's own accordion header is ever pressed: a button that reads
  // wholly as a card, carries no action word, and opens and closes.
  function isCardEntry(c) {
    const expanded = (c.el.getAttribute("aria-expanded") || "").toLowerCase();
    const named = tidy(c.el.getAttribute("aria-label"));
    return (expanded === "true" || expanded === "false") && CARD_ENTRY.test(c.label) && !CARD_ACTION.test(c.label)
      && !CARD_ACTION.test(named);
  }

  // The cards on the page, if every one is a card this will press.
  function entries() {
    const all = cards();
    if (all.some((c) => !isCardEntry(c))) return { why: "A card on Chase's statements page reads in a way this will not press." };
    const labels = all.map((c) => c.label);
    if (new Set(labels).size !== labels.length) return { why: "Two cards on Chase's statements page carry one name." };
    return { labels, open: all.filter((c) => isOpen(c.el)).map((c) => c.label) };
  }

  // Looked up afresh each time, since the page may draw its cards anew.
  function cardNamed(label) {
    const found = cards().filter((c) => c.label === label && isCardEntry(c));
    return found.length === 1 ? found[0].el : null;
  }

  async function setOpen(label, want) {
    const el = cardNamed(label);
    if (!el) return { why: "A card on Chase's statements page went missing." };
    if (isOpen(el) === want) return {};
    el.click();
    const done = () => { const now = cardNamed(label); return Boolean(now) && isOpen(now) === want; };
    if (!(await waitFor(done, CARD_WAIT_MS))) return { why: `Chase did not ${want ? "open" : "close"} ${label}.` };
    return {};
  }

  // The one View picker, showing a year.
  function picker() {
    const found = Array.from(document.querySelectorAll(YEAR_PICKER))
      .filter((p) => /^20\d{2}$/.test(tidy(p.value || p.getAttribute("value"))));
    if (found.length !== 1 || CARD_ACTION.test(tidy(found[0].getAttribute("aria-label")))) return null;
    return found[0];
  }

  // The year options the open picker shows, each read wholly as its year.
  function yearChoices() {
    const choices = [];
    for (const el of document.querySelectorAll("[role='option']")) {
      if (!shown(el)) continue;
      const labels = [tidy(el.textContent), tidy(el.getAttribute("aria-label"))].filter(Boolean);
      if (!labels.some((l) => YEAR_LEADS.test(l))) continue;
      // Each label leads with the option's year; what follows it varies
      // ("current selection", a position, hidden screen-reader words). The
      // year is what matters, so every label must lead with the same one.
      const years = labels.map((l) => (YEAR_LOOSE.exec(l) || [])[1]);
      if (years.some((y) => !y) || new Set(years).size !== 1) {
        if (globalThis.__sweepLog) globalThis.__sweepLog(`View picker option unread: ${labels.map((l) => l.replace(/(19|20)\d{2}/g, "YYYY").slice(0, 60)).join(" | ")}`);
        return { why: "Chase's View picker reads in a way this cannot read." };
      }
      if (!labels.every((l) => YEAR_CHOICE.test(l)) && globalThis.__sweepLog) {
        globalThis.__sweepLog(`View picker option read by its leading year: ${labels.map((l) => l.replace(/(19|20)\d{2}/g, "YYYY").slice(0, 60)).join(" | ")}`);
      }
      choices.push({ el, year: years[0] });
    }
    return { choices };
  }

  async function openYears() {
    const now = yearChoices();
    if (now.why || now.choices.length) return now;
    const p = picker();
    if (!p) return { why: "Chase's View picker could not be told." };
    p.click();
    await waitFor(() => { const c = yearChoices(); return Boolean(c.why) || c.choices.length > 0; }, OPTION_WAIT_MS);
    const got = yearChoices();
    if (!got.why && !got.choices.length) return { why: "Chase's View picker did not open." };
    return got;
  }

  function closeYears() {
    const p = picker();
    if (p && (yearChoices().choices || []).length) p.click();
  }

  const shownRowsOf = (label) => rowsOf().filter((r) => r.card === label && shown(r.link));

  // Until the cards read the same twice over, so a year's redraw is done.
  async function cardsSettled() {
    const end = Date.now() + DRAW_WAIT_MS;
    let last = allCards().map((c) => c.label).join("|");
    for (;;) {
      await sleep(SETTLE_MS);
      const now = allCards().map((c) => c.label).join("|");
      if (now === last && now) return true;
      if (Date.now() >= end) return false;
      last = now;
    }
  }

  // Where the walk through years and cards has been, kept on the page
  // between askings, since this file is run afresh each time.
  const walk = () => (globalThis.__chaseWalk = globalThis.__chaseWalk || { years: null, done: new Set(), finished: new Set(), chosen: new Set() });
  const key = (year, label) => `${year}|${label}`;

  // This card alone open, opened afresh so Chase draws its rows for the year,
  // and its rows waited for, so another year's are never read as this one's.
  async function openOnly(label, year) {
    const here = entries();
    if (here.why) return here;
    for (const other of here.open.filter((l) => l !== label)) {
      const shut = await setOpen(other, false);
      if (shut.why) return shut;
    }
    const shut = await setOpen(label, false);
    if (shut.why) return shut;
    const opened = await setOpen(label, true);
    if (opened.why) return opened;
    walk().done.add(key(year, label));
    const inYear = () => shownRowsOf(label).some((r) => (r.date || "").startsWith(`${year}-`));
    if (!(await waitFor(inYear, YEAR_WAIT_MS)) && shownRowsOf(label).length) return { why: `Chase did not redraw ${label}'s statements for ${year}.` };
    return { moved: true };
  }

  async function chooseYear(year) {
    const w = walk();
    if (w.chosen.has(year)) return { why: `Chase did not stay on ${year}.` };
    w.chosen.add(year);
    const got = await openYears();
    if (got.why) return got;
    const option = got.choices.find((c) => c.year === year);
    if (!option) { closeYears(); return { why: `Chase's View picker no longer offers ${year}.` }; }
    option.el.click();
    if (!(await waitFor(() => yearShown() === year, YEAR_WAIT_MS))) return { why: `Chase did not change to ${year}.` };
    if (!(await cardsSettled())) return { why: `Chase did not draw its cards for ${year}.` };
    // Every card closed, so the next one opened fetches the new year.
    const here = entries();
    if (here.why) return here;
    for (const label of here.open) {
      const shut = await setOpen(label, false);
      if (shut.why) return shut;
    }
    return { moved: true };
  }

  // One step on: this year's next card, or else the next year.
  async function nextView() {
    if (signedOut()) return { why: "Chase signed you out in the middle of the sweep." };
    const w = walk();
    const year = yearShown();
    if (!year) return { why: "Chase's View picker shows no year." };
    const here = entries();
    if (here.why) return here;
    for (const label of here.open) w.done.add(key(year, label));
    if (w.years === null) {
      const got = await openYears();
      if (got.why) return got;
      const others = [...new Set(got.choices.map((c) => c.year))].filter((y) => y !== year).sort().reverse();
      closeYears();
      w.years = [year, ...others];
      w.chosen.add(year);
    }
    // A year may draw cards another did not, so each year's cards are its own.
    const next = here.labels.find((l) => !w.done.has(key(year, l)));
    if (next) return openOnly(next, year);
    w.finished.add(year);
    const nextYear = w.years.find((y) => !w.finished.has(y));
    if (nextYear) return chooseYear(nextYear);
    delete globalThis.__chaseWalk;
    return { moved: false };
  }

  async function readList({ walk: mayWalk = false } = {}) {
    if (!mayWalk) delete globalThis.__chaseWalk;
    if (signedOut()) return { state: "signed_out" };
    let stop = held();
    if (stop) return stop;
    if (location.hostname !== "secure.chase.com" || anotherTab() || !location.href.includes(ROUTE)) return { state: "no_list" };
    const end = Date.now() + DRAW_WAIT_MS;
    let menuSince = 0;
    while (!centerDrawn()) {
      // Chase Business's menu, still drawn and no card header after a few
      // seconds, is not going to turn into the personal center.
      menuSince = menuEntries().length ? menuSince || Date.now() : 0;
      if (menuSince && Date.now() - menuSince >= MENU_SETTLE_MS) return notDrawn(mayWalk, true);
      if (Date.now() >= end) return notDrawn(mayWalk, false);
      await sleep(250);
      if (signedOut()) return { state: "signed_out" };
      stop = held();
      if (stop) return stop;
    }
    delete globalThis.__chaseNav;
    const all = cards();
    trace(`Layout: the statements center. Cards: ${all.length}${all.length ? ` (${all.map((c) => String(c.label).slice(0, 40)).join("; ")})` : ""}.`);
    if (!all.length) {
      // A year of the walk may draw a business account and no card.
      const walking = mayWalk && globalThis.__chaseWalk && globalThis.__chaseWalk.years;
      return walking ? { state: "ok", docs: [], more: true } : { state: "stopped", why: BUSINESS_ONLY };
    }
    const open = all.filter((c) => (c.el.getAttribute("aria-expanded") || "").toLowerCase() === "true");
    if (!open.length && mayWalk) return { state: "ok", docs: [], more: true };
    if (!open.length) return { state: "stopped", why: "No card is open on Chase's statements page. Open a card there and sweep again." };
    const labels = new Set(open.map((c) => c.label));
    if (mayWalk && !rowsOf().some((r) => labels.has(r.card))) await waitFor(() => rowsOf().some((r) => labels.has(r.card)), YEAR_WAIT_MS);
    const docs = [];
    const seen = new Set();
    for (const row of rowsOf()) {
      // Rows of a collapsed card can still be in the page.
      if (!labels.has(row.card) || !/^statement$/i.test(row.type)) continue;
      if (!row.date) return { state: "stopped", why: "A statement's date could not be read.", docs };
      if (!safeRow(row.label)) return { state: "stopped", why: "A statement's link was not one this will press.", docs };
      const id = idOf(row);
      if (seen.has(id)) continue;
      seen.add(id);
      docs.push({ id, date: row.date, title: row.card, method: "click" });
    }
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    trace(`Open cards: ${open.length} of ${all.length}; statements read: ${docs.length}; year shown: ${yearShown() || "none"}.`);
    if (mayWalk) return { state: "ok", docs, more: true };
    if (!docs.length) return { state: "stopped", why: "The open card shows no statements for the year chosen. Pick another year in Chase's View picker and sweep again.", docs };
    const closed = all.length - open.length;
    if (closed) return { state: "stopped", why: `Only the open card was read. Open each of the other ${closed} on Chase's page and sweep again.`, docs };
    const year = yearShown();
    const offered = yearsOffered();
    if (offered.size !== 1 || !offered.has(year)) return { state: "stopped", why: `Only ${year} was read. Chase's View picker may hold other years. Choose each there and sweep again.`, docs };
    return { state: "ok", docs };
  }

  function clickDoc(doc) {
    const id = doc && doc.id;
    if (typeof id !== "string" || !id) return { ok: false, why: "not a statement of this list" };
    const row = rowsOf().find((r) => idOf(r) === id && shown(r.link));
    if (!row) return { ok: false, why: "That statement's row is not on the page. Open its card and year." };
    if (!safeRow(row.label)) return { ok: false, why: "That link is not one this will press." };
    row.link.click();
    return { ok: true };
  }

  globalThis.__sweep = { readList, clickDoc, nextView };
})();
