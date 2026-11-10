// Runs inside Alpaca's own page, where the sign-in already lives. It reads the
// documents table and presses a document's own Download and, in a tab the
// sweep opened itself, the list's own Next and Previous, and nothing else:
// not the account switcher, not a filter.
//
// Alpaca's API takes a token the page holds in memory, which this cannot see,
// so everything here is read from the table the page draws, ten rows a page.
// Walking, the first look presses Next to the last page, so every row is
// counted before any is saved, and each page is then a view of its own,
// stepped back with Previous, so its rows are on show when their Download is
// pressed. Live account only. Tax forms are passed over, as PaperPull does.
//
// Derived from PaperPull's apps/alpaca/alpaca_site.py (AGPL-3.0).
(() => {
  const DOCUMENTS = "/account/documents";
  const SWITCHER = '[data-testid="account-switcher-button"]';
  const LOGIN = ["/account/login", "/login", "authx.alpaca.markets", "/logout"];
  const CHALLENGE = ["enter the code we sent", "enter your verification code", "verification code", "one-time",
    "one time passcode", "security code", "we sent a code", "two-factor", "two-step", "authenticator",
    "confirm your identity", "verify your identity", "are you a robot", "captcha",
    "your session has expired", "please log in again"];
  const RATE_LIMIT = ["too many requests", "rate limit", "try again later", "temporarily unavailable", "http error 429"];
  const TITLES = {
    account_statement: "Brokerage Statement",
    crypto_account_statement: "Crypto Statement",
  };
  const KIND = /^[a-z][a-z0-9_]{0,63}$/;
  const ID = /^(\d{4}-\d{2}-\d{2})_([a-z][a-z0-9_]{0,63})$/;
  const WAIT_MS = 12000;
  const TURN_WAIT_MS = 10000;
  // More pages than any account has shown, so a list that never ends stops.
  const MAX_PAGES = 200;
  const WALK_STALE_MS = 30 * 60 * 1000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const shown = (el) => Boolean(el) && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    && getComputedStyle(el).visibility !== "hidden";
  const labels = (el) => [tidy(el.innerText), tidy(el.getAttribute("aria-label")), tidy(el.getAttribute("title"))].filter(Boolean);
  const onDocuments = () => location.pathname === DOCUMENTS && !location.search && !location.hash;

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']"));
  }

  function asking() {
    if (document.querySelectorAll("table tbody tr").length > 0) return null;
    const text = `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 1500)}`.toLowerCase();
    if (CHALLENGE.some((m) => text.includes(m))) return "challenge";
    if (RATE_LIMIT.some((m) => text.includes(m))) return "rate";
    return null;
  }

  // A date is taken only as the table prints it, one whole calendar day.
  function calendarDay(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? value : null;
  }

  // The switcher reads "<name> Paper - <id>" on a Paper account. Any "paper"
  // at all is refused, which is the safe way to be wrong.
  function accountProblem() {
    const switchers = Array.from(document.querySelectorAll(SWITCHER));
    if (switchers.length !== 1 || !shown(switchers[0]) || !tidy(switchers[0].innerText)) return "Alpaca's account switcher could not be read.";
    if (tidy(switchers[0].innerText).toLowerCase().includes("paper")) return "Alpaca is showing a Paper account. Choose your Live account yourself and sweep again.";
    if (/you are on paper trading/i.test(document.body.innerText)) return "Alpaca is showing a Paper account. Choose your Live account yourself and sweep again.";
    return null;
  }

  function theBody() {
    const tables = document.querySelectorAll("table");
    if (tables.length !== 1) return null;
    const bodies = tables[0].querySelectorAll("tbody");
    return bodies.length === 1 ? bodies[0] : null;
  }

  // "<date> | <type> | Download", with one Download in its last cell, or null.
  function rowShape(tr) {
    const cells = Array.from(tr.children).filter((c) => c.tagName === "TD");
    if (cells.length !== 3 || tidy(cells[2].innerText).toLowerCase() !== "download") return null;
    const controls = cells[2].querySelectorAll("p");
    if (controls.length !== 1) return null;
    const date = calendarDay(tidy(cells[0].innerText));
    const kind = tidy(cells[1].innerText);
    return date && KIND.test(kind) ? { date, kind, control: controls[0] } : null;
  }

  const shownRows = (body) => Array.from(body.children).filter((tr) => tr.tagName === "TR" && shown(tr));

  function pagerButtons(word) {
    return Array.from(document.querySelectorAll("button"))
      .filter((b) => labels(b).some((l) => l.toLowerCase() === word));
  }
  const turnedOff = (b) => b.disabled || b.getAttribute("aria-disabled") === "true";
  // How the list goes on past what is shown, in words, or null when it does not.
  function moreToRead() {
    const next = pagerButtons("next");
    if (next.length > 1) return "Alpaca's list has more than one Next button.";
    if (next.length === 1 && shown(next[0]) && !turnedOff(next[0])) return "Alpaca's list goes on past these rows, and this reads only the first page of ten.";
    const previous = pagerButtons("previous");
    if (previous.length === 1 && shown(previous[0]) && !turnedOff(previous[0])) return "Alpaca's list is not on its first page.";
    return null;
  }

  // The one pager button reading wholly `word`, shown and on, or why not. A
  // button with any other label beside it is not pressed.
  function pagerButton(word) {
    const found = pagerButtons(word);
    if (found.length > 1) return { why: `Alpaca's list has more than one ${word === "next" ? "Next" : "Previous"} button.` };
    if (!found.length || !shown(found[0]) || turnedOff(found[0])) return { none: true };
    if (!labels(found[0]).every((l) => l.toLowerCase() === word)) return { why: "A pager button of Alpaca's list reads in a way this cannot read." };
    return { button: found[0] };
  }
  const pagerOn = (word) => Boolean(pagerButton(word).button);

  // The rows on show, as one string, or null while one cannot be read.
  function signature() {
    const body = theBody();
    if (!body) return null;
    const rows = shownRows(body).map(rowShape);
    if (!rows.length || rows.some((r) => !r)) return null;
    return rows.map((r) => `${r.date}|${r.kind}`).join(",");
  }

  async function waitFor(test, ms) {
    const end = Date.now() + ms;
    while (!test()) {
      if (Date.now() >= end) return false;
      await sleep(150);
    }
    return true;
  }

  // Presses Next or Previous once, re-found by its words just before, and
  // waits for the rows to be `want`'s, or any others when `want` is null.
  async function turn(word, want) {
    if (signedOut()) return { why: "Alpaca asked for a sign-in." };
    const problem = accountProblem();
    if (problem) return { why: problem };
    const found = pagerButton(word);
    if (found.why) return { why: found.why };
    if (!found.button) return { why: `Alpaca's list has no ${word === "next" ? "Next" : "Previous"} to press.` };
    const before = signature();
    found.button.click();
    const arrived = () => {
      const now = signature();
      return Boolean(now) && (want === null ? now !== before : now === want);
    };
    if (!(await waitFor(arrived, TURN_WAIT_MS))) {
      return { why: want === null ? "Alpaca's list did not show other rows after Next." : "Alpaca did not go back to the page of its list read before." };
    }
    return { sig: signature() };
  }

  // The walk through the list's pages, kept on the page between askings,
  // since this file is run afresh each time: every page's rows as first
  // read, how often each document shows in the whole list, and which page is
  // on show now.
  const walkState = () => globalThis.__alpacaWalk;
  const endWalk = () => { delete globalThis.__alpacaWalk; };

  // Presses Next from the first page to the last, counting every row.
  async function census() {
    const counts = {};
    const pages = [];
    let sig = signature();
    for (;;) {
      if (!sig) return { why: "A row of Alpaca's list could not be read." };
      if (pages.includes(sig)) return { why: "A page of Alpaca's list came twice." };
      pages.push(sig);
      for (const key of sig.split(",")) {
        const [date, kind] = key.split("|");
        const id = `${date}_${kind}`;
        counts[id] = (counts[id] || 0) + 1;
      }
      const next = pagerButton("next");
      if (next.why) return { why: next.why };
      if (!next.button) break;
      if (pages.length >= MAX_PAGES) return { why: `Alpaca's list ran past ${MAX_PAGES} pages.` };
      const turned = await turn("next", null);
      if (turned.why) return { why: turned.why };
      sig = turned.sig;
    }
    return { walk: { counts, pages, page: pages.length - 1, at: Date.now() } };
  }

  // This page's documents, each shown once in the whole list (`counts`).
  function docsOnShow(counts) {
    const docs = [];
    const shapes = new Map();
    let unread = false;
    for (const tr of shownRows(theBody())) {
      const row = rowShape(tr);
      if (!row) { unread = true; continue; }
      if (!TITLES[row.kind]) continue; // Twins, the application and tax forms are not taken.
      const id = `${row.date}_${row.kind}`;
      if (shapes.has(id)) { shapes.set(id, shapes.get(id) + 1); continue; }
      shapes.set(id, 1);
      docs.push({ id, date: row.date, title: TITLES[row.kind], method: "click" });
    }
    const once = (id) => (counts ? counts[id] === 1 : shapes.get(id) === 1);
    const alike = counts
      ? Object.entries(counts).some(([id, n]) => n > 1 && TITLES[ID.exec(id)[2]])
      : [...shapes.values()].some((n) => n > 1);
    const kept = docs.filter((d) => once(d.id)).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return { kept, unread, alike };
  }

  const ALIKE = "Two documents share one date and kind, so those are left unsaved.";

  // Alpaca can open on a Paper account, which has no statements. In a tab the
  // sweep opened, the account switcher is opened, its "Live" side chosen, and
  // the one live account in it pressed, as the person would. Each step presses
  // only something whose whole text is known: the switcher itself, a control
  // reading exactly "Live", and a line reading exactly "Brokerage Account"
  // and its number. Nothing near it (New Paper Account, Account Management,
  // Sign Out) can match. Tried at most once a minute, so it cannot loop.
  const LIVE_ACCOUNT = /^Brokerage Account \d{5,15}$/;
  async function shownOnce(find, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const hits = find();
      if (hits.length || Date.now() >= end) return hits;
      await sleep(200);
    }
  }
  async function switchToLive() {
    try {
      if (Date.now() - (Number(sessionStorage.getItem("statementSweepLive")) || 0) < 60000) {
        return "Alpaca stayed on a Paper account after choosing Live. Choose your Live account at the top left and sweep again.";
      }
      sessionStorage.setItem("statementSweepLive", String(Date.now()));
    } catch (e) {
      return "Alpaca is showing a Paper account. Choose your Live account at the top left and sweep again.";
    }
    const switchers = Array.from(document.querySelectorAll(SWITCHER)).filter(shown);
    if (switchers.length !== 1) return "Alpaca's account switcher could not be read.";
    const liveSide = () => Array.from(document.querySelectorAll("button, [role='tab'], [role='button']"))
      .filter((el) => shown(el) && tidy(el.innerText) === "Live" && !el.contains(switchers[0]));
    if (!liveSide().length) switchers[0].click();
    const sides = await shownOnce(liveSide, 4000);
    if (sides.length !== 1) return "Alpaca's account menu did not show one Live choice.";
    sides[0].click();
    const lines = () => Array.from(document.querySelectorAll("body *"))
      .filter((el) => shown(el) && el.children.length === 0 && LIVE_ACCOUNT.test(tidy(el.textContent)));
    const accounts = await shownOnce(lines, 4000);
    if (accounts.length !== 1) {
      return accounts.length ? "Alpaca lists more than one live account. Choose one at the top left and sweep again."
        : "Alpaca's Live side shows no brokerage account.";
    }
    accounts[0].click();
    const live = await shownOnce(() => {
      const now = Array.from(document.querySelectorAll(SWITCHER)).filter(shown);
      return now.length === 1 && !tidy(now[0].innerText).toLowerCase().includes("paper") ? now : [];
    }, 10000);
    return live.length ? "" : "Alpaca stayed on a Paper account after choosing Live. Choose your Live account at the top left and sweep again.";
  }

  async function readList(options = {}) {
    const mayWalk = Boolean(options && options.walk);
    if (!mayWalk) endWalk();
    const result = await readPage(mayWalk);
    if ((result.state === "ok" || result.state === "stopped") && !result.more) endWalk();
    return result;
  }

  async function readPage(mayWalk) {
    const until = Date.now() + WAIT_MS;
    for (;;) {
      if (signedOut()) return { state: "signed_out" };
      const check = asking();
      if (check === "challenge") return { state: "challenge" };
      if (check === "rate") return { state: "stopped", why: "Alpaca is asking for a pause. Try again later.", docs: [] };
      const problem = accountProblem();
      if (problem && /Paper/.test(problem)) {
        if (!mayWalk) return { state: "stopped", why: problem, docs: [] };
        const why = await switchToLive();
        // Switched: the page may move on, so it is read again from the start.
        return why ? { state: "stopped", why, docs: [] } : { state: "walking" };
      }
      if (!onDocuments()) return { state: "no_list" };
      const body = theBody();
      if (!problem && body && shownRows(body).length > 0) break;
      if (Date.now() >= until) {
        if (problem) return { state: "stopped", why: problem, docs: [] };
        return { state: "stopped", why: "Alpaca's documents table showed no rows.", docs: [] };
      }
      await sleep(300);
    }

    if (!mayWalk) {
      const { kept, unread, alike } = docsOnShow(null);
      if (unread) return { state: "stopped", why: "A row of Alpaca's list could not be read.", docs: kept };
      const more = moreToRead();
      if (more) return { state: "stopped", why: more, docs: kept };
      if (alike) return { state: "stopped", why: ALIKE, docs: kept };
      return { state: "ok", docs: kept };
    }

    let w = walkState();
    if (w && Date.now() - w.at > WALK_STALE_MS) { endWalk(); w = null; }
    if (!w) {
      const first = pagerButton("previous");
      if (first.why) return { state: "stopped", why: first.why, docs: [] };
      if (first.button) return { state: "stopped", why: "Alpaca's list is not on its first page.", docs: [] };
      const counted = await census();
      if (counted.why) return { state: "stopped", why: counted.why, docs: [] };
      w = globalThis.__alpacaWalk = counted.walk;
    }
    if (signature() !== w.pages[w.page]) return { state: "stopped", why: "Alpaca's list changed while it was read.", docs: [] };
    if (w.page === 0 && pagerOn("previous")) return { state: "stopped", why: "Alpaca's list is not on its first page.", docs: [] };
    const { kept, unread, alike } = docsOnShow(w.counts);
    if (unread) return { state: "stopped", why: "A row of Alpaca's list could not be read.", docs: kept };
    if (w.page > 0) return { state: "ok", docs: kept, more: true };
    if (alike) return { state: "stopped", why: ALIKE, docs: kept };
    return { state: "ok", docs: kept };
  }

  // One page back toward the first, which every page was counted from.
  async function nextView() {
    const w = walkState();
    if (!w || w.page <= 0) { endWalk(); return { moved: false }; }
    if (signature() !== w.pages[w.page]) { endWalk(); return { why: "Alpaca's list changed while it was read." }; }
    const turned = await turn("previous", w.pages[w.page - 1]);
    if (turned.why) { endWalk(); return { why: turned.why }; }
    w.page -= 1;
    w.at = Date.now();
    return { moved: true };
  }

  function clickDoc(doc) {
    const m = ID.exec((doc && doc.id) || "");
    if (!m || !TITLES[m[2]]) return { ok: false, why: "not a document this reads" };
    if (signedOut()) return { ok: false, why: "Alpaca asked for a sign-in." };
    const problem = accountProblem();
    if (problem) return { ok: false, why: problem };
    const body = onDocuments() ? theBody() : null;
    if (!body) return { ok: false, why: "This is not Alpaca's documents page." };
    const rows = shownRows(body);
    const hits = rows.map(rowShape).filter((r) => r && r.date === m[1] && r.kind === m[2]);
    if (hits.length !== 1) return { ok: false, why: "Its row was not there exactly once." };
    const control = hits[0].control;
    const said = labels(control);
    if (!said.length || !said.every((l) => l.toLowerCase() === "download")) return { ok: false, why: "That control was not a Download." };
    if (control.getAttribute("aria-disabled") === "true") return { ok: false, why: "Its Download is turned off." };
    control.click();
    return { ok: true };
  }

  globalThis.__sweep = { readList, clickDoc, nextView };
})();
