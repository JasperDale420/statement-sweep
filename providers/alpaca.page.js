// Runs inside Alpaca's own page, where the sign-in already lives. It reads the
// documents table and presses a document's own Download, and nothing else: not
// the account switcher, not the list's Next, not a filter.
//
// Alpaca's API takes a token the page holds in memory, which this cannot see,
// so everything here is read from the table the page draws. Live account only.
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
    trade_confirmation: "Trade Confirmation",
  };
  const KIND = /^[a-z][a-z0-9_]{0,63}$/;
  const ID = /^(\d{4}-\d{2}-\d{2})_([a-z][a-z0-9_]{0,63})$/;
  const WAIT_MS = 12000;

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

  async function readList() {
    const until = Date.now() + WAIT_MS;
    for (;;) {
      if (signedOut()) return { state: "signed_out" };
      const check = asking();
      if (check === "challenge") return { state: "challenge" };
      if (check === "rate") return { state: "stopped", why: "Alpaca is asking for a pause. Try again later.", docs: [] };
      const problem = accountProblem();
      if (problem && /Paper/.test(problem)) return { state: "stopped", why: problem, docs: [] };
      if (!onDocuments()) return { state: "no_list" };
      const body = theBody();
      if (!problem && body && shownRows(body).length > 0) break;
      if (Date.now() >= until) {
        if (problem) return { state: "stopped", why: problem, docs: [] };
        return { state: "stopped", why: "Alpaca's documents table showed no rows.", docs: [] };
      }
      await sleep(300);
    }

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
    const alike = [...shapes.values()].filter((n) => n > 1).length;
    const kept = docs.filter((d) => shapes.get(d.id) === 1).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (unread) return { state: "stopped", why: "A row of Alpaca's list could not be read.", docs: kept };
    const more = moreToRead();
    if (more) return { state: "stopped", why: more, docs: kept };
    if (alike) return { state: "stopped", why: "Two documents share one date and kind, so those are left unsaved.", docs: kept };
    return { state: "ok", docs: kept };
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

  globalThis.__sweep = { readList, clickDoc };
})();
