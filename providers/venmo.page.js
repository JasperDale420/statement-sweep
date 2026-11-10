// Runs inside Venmo's own Statements page. In a tab the sweep opened it walks
// the finished months by their own addresses, as PaperPull does, and lists
// each month that holds transactions. It presses one control only: a month's
// own "Show more", before that month is printed. It asks Venmo for nothing.
//
// Venmo has no PDF statement, so a month's page is printed. Each month is
// reached by its statement address, built from the fields of the address
// Venmo itself settles on (the profile id is private and never leaves this
// tab). A walk goes back MAX_MONTHS finished months, one month to a view, and
// a page with Wallet and Balance tabs is read on both, each its own view.
// Where the walk is between loads is kept in this tab's session storage.
//
// What PaperPull reads and this cannot: Venmo's own data answers, which the
// page fetches and this never hears. So a Wallet tab that says a month is
// empty, and a Balance tab that never opens (a profile with no Venmo balance
// looks the same as one that failed to load), stop the walk.
//
// Derived from PaperPull's apps/venmo/venmo_site.py (AGPL-3.0).
(() => {
  const HOST = "account.venmo.com";
  const PATH = "/statement";
  const LOGIN_MARKERS = ["id.venmo.com", "/signin", "/sign-in", "/login", "/account/logout"];
  const CHECK_WORDS = ["enter the code", "verification code", "6-digit", "two-factor", "two-step", "authenticator",
    "confirm your identity", "verify your identity", "we sent a code", "we texted", "device approval", "approve this login",
    "are you a robot", "captcha", "let's verify", "check your email", "check your phone", "access denied", "confirm it's you"];
  const EXPIRED_WORDS = ["your session has expired", "log back in"];
  const SLOW_WORDS = ["too many requests", "rate limit", "try again later", "temporarily unavailable", "http error 429", "unusual traffic"];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const MONTH_VALUE = new RegExp(`^(${MONTHS.join("|")}) ([0-9]{4})$`);
  const LOAD_MORE = /^\s*(load|show|see)\s+more\b/i;
  const EMPTY = /No transactions yet for this month|There are no transactions for these dates/i;
  const LIST = "[class*='completedTransactionList']";
  const ROW = ":scope > a[class*='transactionItem']";
  const PENDING = "[class*='pendingTransactionList']";
  // The one control ever pressed: the completed list's own pager.
  const SHOW_MORE_CSS = "[class*='completedTransactionList'] > div:last-child button, [class*='completedTransactionList'] > div:last-child [role='button']";
  const SHOW_MORE_PRESSES = 60;
  const QUERY_KEYS = ["accountType", "month", "profileId", "year"];
  const ACCOUNT_TYPE = "personal";
  const TAB_KEY = "accountTab";
  const WALLET_TAB = "venmo-account";
  const BALANCE_TAB = "venmo-balance";
  const BALANCE_ID = "-balance";
  const DOC_ID = /^([0-9]{4})-(0[1-9]|1[0-2])(-balance)?$/;
  const PROFILE_ID = /^[A-Za-z0-9_-]{4,64}$/;
  // How many finished months a walk reads. How far Venmo goes back is not
  // known, so when the oldest of them has transactions the walk says so.
  const MAX_MONTHS = 24;
  const FIRST_MONTH = "2000-01";
  const POLL_MS = 250;
  const SETTLE_MS = 20000;
  const EMPTY_HOLD_MS = 2000;
  const LAYOUT_HOLD_MS = 5000;
  const ADDRESS_WAIT_MS = 5000;
  const WALK_KEY = "__sweepVenmoWalk";
  const WALK_AGE_MS = 30 * 60 * 1000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A short line for the run log (shared.js), never the page's own text.
  const trace = (text) => { if (globalThis.__sweepLog) globalThis.__sweepLog(text); };
  const squash = (text) => (text || "").replace(/\s+/g, " ").trim();
  const pad = (n) => String(n).padStart(2, "0");
  const stopped = (why, docs = []) => ({ state: "stopped", why, docs });
  const onStatements = () => location.hostname === HOST && location.pathname.replace(/\/$/, "") === PATH;
  const SIGNED_OUT = "Venmo signed out. Sign in, then run it again.";

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN_MARKERS.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']"));
  }

  function monthOf(text) {
    const m = MONTH_VALUE.exec(squash(text));
    if (!m) return null;
    const year = +m[2];
    if (year < 2000 || year > 2099) return null;
    return `${m[2]}-${pad(MONTHS.indexOf(m[1]) + 1)}`;
  }

  const monthEnd = (month) => {
    const [y, m] = month.split("-").map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  };

  // A month counts as finished a whole day after its last day.
  function finished(month) {
    const d = new Date(Date.now() - 86400000);
    return month < `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }

  // The finished months, newest first, MAX_MONTHS of them.
  function monthsToWalk() {
    const d = new Date(Date.now() - 86400000);
    let y = d.getFullYear(), m = d.getMonth() + 1;
    const out = [];
    while (out.length < MAX_MONTHS) {
      m -= 1;
      if (m === 0) { y -= 1; m = 12; }
      const month = `${y}-${pad(m)}`;
      if (month < FIRST_MONTH) break;
      out.push(month);
    }
    return out;
  }

  // The statement address's own fields, or null unless it is exactly that.
  function statementQuery() {
    if (location.protocol !== "https:" || !onStatements() || location.hash) return null;
    const params = new URLSearchParams(location.search);
    const keys = Array.from(params.keys());
    if (new Set(keys).size !== keys.length) return null;
    const rest = keys.filter((k) => k !== TAB_KEY).sort();
    if (rest.length !== QUERY_KEYS.length || rest.some((k, i) => k !== QUERY_KEYS[i])) return null;
    const got = Object.fromEntries(params);
    if (params.has(TAB_KEY) && ![WALLET_TAB, BALANCE_TAB].includes(got[TAB_KEY])) return null;
    if (!/^([1-9]|1[0-2]|0[1-9])$/.test(got.month) || !/^20[0-9]{2}$/.test(got.year)) return null;
    if (!/^[A-Za-z]{2,20}$/.test(got.accountType) || !PROFILE_ID.test(got.profileId)) return null;
    return got;
  }

  // Venmo settles a bare visit on a month's address a moment after it loads.
  async function settledQuery() {
    let query = statementQuery();
    for (let i = 0; !query && i < ADDRESS_WAIT_MS / POLL_MS; i++) {
      await sleep(POLL_MS);
      query = statementQuery();
    }
    return query;
  }

  // A month's statement address on this profile, the Balance tab's when asked.
  function urlFor(where, month, balance) {
    const [y, m] = month.split("-");
    const params = new URLSearchParams({ accountType: where.accountType, month: String(+m), profileId: where.profileId, year: y });
    if (balance) params.set(TAB_KEY, BALANCE_TAB);
    return `https://${HOST}${PATH}?${params.toString()}`;
  }

  // Whether the address is this month on this profile, on the tab asked for.
  // The plain address gains the Wallet's name once the page has drawn it.
  function isAt(q, where, month, balance) {
    if (!q || `${q.year}-${pad(+q.month)}` !== month) return false;
    if (q.profileId !== where.profileId || q.accountType !== where.accountType) return false;
    const tab = q[TAB_KEY] || "";
    return balance ? tab === BALANCE_TAB : tab === "" || tab === WALLET_TAB;
  }

  // The server's yes or no on tabs. The page keeps it in a variable this world
  // cannot read, and Next.js writes the same data into this element.
  function toldTabs() {
    const el = document.getElementById("__NEXT_DATA__");
    if (!el) return null;
    try {
      const told = JSON.parse(el.textContent).props.pageProps.isAccountRestructuringEnabledSSR;
      return told === true || told === false ? told : null;
    } catch (e) {
      return null;
    }
  }

  function readState() {
    const months = Array.from(document.querySelectorAll("input")).map((i) => squash(i.value)).filter((v) => /^[A-Z][a-z]+ [0-9]{4}$/.test(v));
    const heading = Array.from(document.querySelectorAll("h1, h2, h3")).some((h) => /^\s*account statement\s*$/i.test(h.textContent || ""));
    const lists = document.querySelectorAll(LIST);
    const rows = lists.length === 1 ? lists[0].querySelectorAll(ROW).length : 0;
    const kids = lists.length === 1 ? lists[0].children.length : 0;
    let pager = 0;
    if (lists.length === 1 && kids > rows) {
      const last = lists[0].lastElementChild;
      const isRow = last && last.matches("a[class*='transactionItem']");
      const controls = last && !isRow ? last.querySelectorAll("button, [role='button'], a") : [];
      if (controls.length === 1 && /^show more$/i.test(squash(controls[0].textContent))) pager = 1;
    }
    const main = document.querySelector("main") || document.body;
    const drawn = (id) => document.querySelectorAll(`[data-testid="${id}"]`).length;
    const labels = Array.from(document.querySelectorAll("button, [role='button'], a"))
      .map((b) => squash(b.textContent || b.getAttribute("aria-label"))).filter((t) => t && t.length < 40);
    return {
      months, heading, lists: lists.length, rows, kids, pager, labels,
      pending: document.querySelectorAll(PENDING).length,
      empty: EMPTY.test((main && main.innerText) || ""),
      loading: main ? main.querySelectorAll("[data-testid='shimmer']").length : 0,
      tabbed: drawn("account-statement-layout"),
      wallet: drawn("venmo-account-tab-body"),
      balance: drawn("venmo-balance-account-tab-body"),
      asked: new URLSearchParams(location.search).get(TAB_KEY) || "",
      told: toldTabs(),
    };
  }

  function tabProblem(s) {
    if (s.told === true && !s.tabbed) return "Venmo says this statement has tabs and the page draws none.";
    if (!s.tabbed && !s.asked) return "";
    if (!s.tabbed) return "The address names a statement tab and the page draws none.";
    if (!s.asked) return "The page draws statement tabs and its address names none.";
    const wanted = s.asked === BALANCE_TAB ? [0, 1] : [1, 0];
    if (s.wallet !== wanted[0] || s.balance !== wanted[1]) return "The page has not drawn the statement tab its address names.";
    return "";
  }

  function settledWhy(s, month) {
    if (!s.heading) return "The statement did not finish drawing.";
    if (s.months.length !== 1 || monthOf(s.months[0]) !== month) return "The month picker does not show the month in the address.";
    if (s.loading) return "The statement is still loading.";
    const tab = tabProblem(s);
    if (tab) return tab;
    if (s.empty && (s.lists || s.pending)) return "The page draws transactions and says there are none.";
    if (s.lists === 1 && s.rows > 0 && s.rows + (s.pager ? 1 : 0) === s.kids) return "";
    if (s.lists === 0 && s.pending) return "The month shows pending transactions and no completed ones.";
    if (s.lists === 0 && s.empty) return "";
    if (s.lists === 0) return "The page drew neither the month's transactions nor its words for a month with none.";
    return "The month's transactions did not finish drawing.";
  }

  // Waits for the month to hold still, as read twice in a row, and longer for
  // the words for an empty month, which a page can say for a moment.
  async function settle(month) {
    let why = "The statement did not finish drawing.", last = null, held = 0, state = null;
    for (let i = 0; i < SETTLE_MS / POLL_MS; i++) {
      state = readState();
      why = settledWhy(state, month);
      const seen = `${state.rows}|${state.empty}`;
      held = !why && seen === last ? held + 1 : 0;
      if (held && (state.rows || held * POLL_MS >= EMPTY_HOLD_MS)) return { state };
      last = why ? null : seen;
      await sleep(POLL_MS);
    }
    return { why: why || "The statement did not hold still.", state };
  }

  // Whether the month just read has tabs. The server's yes or no settles it;
  // with neither, the page may learn of its tabs after it has drawn.
  async function drawsTabs() {
    const hasTabs = () => Boolean((statementQuery() || {})[TAB_KEY]);
    for (let i = 0; i < LAYOUT_HOLD_MS / POLL_MS; i++) {
      if (hasTabs()) return true;
      if (readState().told !== null) return false;
      await sleep(POLL_MS);
    }
    return hasTabs();
  }

  const extraMores = (s) => s.labels.filter((t) => LOAD_MORE.test(t)).length > (s.pager ? 1 : 0);

  function challengeOrSlow() {
    if (Array.from(document.querySelectorAll("input")).some((i) => monthOf(i.value))) return null;
    const words = `${document.title}\n${((document.body && document.body.innerText) || "").slice(0, 1500)}`.toLowerCase();
    if (EXPIRED_WORDS.some((w) => words.includes(w))) return { state: "signed_out" };
    if (CHECK_WORDS.some((w) => words.includes(w))) return { state: "challenge" };
    if (SLOW_WORDS.some((w) => words.includes(w))) return stopped("Venmo says to try again later.");
    return null;
  }

  // ---- The walk, kept in this tab's session storage across loads.
  function loadWalk() {
    try {
      const w = JSON.parse(sessionStorage.getItem(WALK_KEY) || "null");
      if (!w || typeof w.t !== "number" || Date.now() - w.t >= WALK_AGE_MS) return null;
      if (!Array.isArray(w.months) || !Number.isInteger(w.at) || w.at < 0 || w.at >= w.months.length) return null;
      if (!w.where || !PROFILE_ID.test(w.where.profileId || "") || w.where.accountType !== ACCOUNT_TYPE) return null;
      return w;
    } catch (e) {
      return null;
    }
  }
  function saveWalk(w) {
    try {
      sessionStorage.setItem(WALK_KEY, JSON.stringify({ ...w, t: Date.now() }));
      return Boolean(loadWalk());
    } catch (e) {
      return false;
    }
  }
  const dropWalk = () => { try { sessionStorage.removeItem(WALK_KEY); } catch (e) { /* not there */ } };

  // Loads an address in this tab a moment later, so this answer reaches the
  // sweep first, and until then this page answers that it is being left.
  function leaveFor(url) {
    globalThis.__venmoLeaving = true;
    setTimeout(() => location.assign(url), 100);
    return { state: "walking" };
  }

  function docOf(where, month, balance) {
    return {
      id: balance ? `${month}${BALANCE_ID}` : month,
      date: monthEnd(month),
      title: balance ? "Balance Statement" : "Statement",
      method: "print",
      url: urlFor(where, month, balance),
    };
  }

  async function readList({ walk: mayWalk = false } = {}) {
    // A read for a tab of yours, or the sweep's first look at a tab it kept
    // from an earlier run, ends any walk that run left behind.
    if (!mayWalk) dropWalk();
    if (mayWalk && globalThis.__venmoLeaving) return { state: "walking" };
    if (signedOut()) return { state: "signed_out" };
    const trouble = challengeOrSlow();
    if (trouble) return trouble;
    if (!onStatements()) return { state: "no_list" };
    // Printing needs a tab the sweep opened, so a tab of yours is left alone.
    if (!mayWalk) return stopped("Venmo's months are read only in a tab this opens itself. Run it again and let it open its own.");
    const query = await settledQuery();
    if (signedOut()) return { state: "signed_out" };
    if (!query) return stopped("The Statements page did not settle on a month's address.");
    if (query.accountType !== ACCOUNT_TYPE) return stopped("This Statements page is not a personal profile's.");

    let w = loadWalk();
    if (!w) {
      const months = monthsToWalk();
      trace(`Walk begins: ${months.length} month(s) to read${months.length ? `, ${months[0]} back to ${months[months.length - 1]}` : ""}.`);
      if (!months.length) return { state: "ok", docs: [] };
      w = { where: { accountType: query.accountType, profileId: query.profileId }, months, at: 0, balance: false, tabs: false, rows: 0, went: false };
      if (!saveWalk(w)) return stopped("Chrome would not keep this sweep's place on Venmo's page.");
    }
    if (query.profileId !== w.where.profileId || query.accountType !== w.where.accountType) {
      dropWalk();
      return stopped("Venmo changed to another profile during the sweep. Run it again.");
    }
    const month = w.months[w.at];
    if (!isAt(query, w.where, month, w.balance)) {
      // Each month is opened once by its own address. One that will not stay
      // is not taken for any other.
      if (w.went) {
        dropWalk();
        return stopped(`Venmo did not stay on ${month} when it was opened. Run it again.`);
      }
      w.went = true;
      saveWalk(w);
      return leaveFor(urlFor(w.where, month, w.balance));
    }

    let held = await settle(month);
    if (signedOut()) return { state: "signed_out" };
    if (held.why) {
      dropWalk();
      const s = held.state || {};
      if (w.balance && s.tabbed && s.asked === BALANCE_TAB && !s.balance) {
        return stopped(`Venmo did not open the Balance tab for ${month}. A profile with no Venmo balance looks the same, and this cannot tell them apart.`);
      }
      return stopped(`Stopped at ${month}. ${held.why} Run it again.`);
    }
    if (!w.balance && !w.tabs && (await drawsTabs())) {
      if (w.at > 0) {
        dropWalk();
        return stopped("Venmo's page drew Wallet and Balance tabs only after months read without them. Run it again.");
      }
      w.tabs = true;
      held = await settle(month);
      if (held.why) {
        dropWalk();
        return stopped(`Stopped at ${month}. ${held.why} Run it again.`);
      }
    }
    const s = held.state;
    if (extraMores(s)) {
      dropWalk();
      return stopped("The page shows a Load more control this does not know.");
    }
    if (!w.balance && s.wallet && !s.rows) {
      dropWalk();
      return stopped(`The Wallet tab says ${month} is empty, and only Venmo's own answer, which this cannot read, can confirm that.`);
    }
    const docs = s.rows ? [docOf(w.where, month, w.balance)] : [];
    w.rows = (w.balance ? w.rows : 0) + s.rows;
    trace(`${month} (${w.at + 1} of ${w.months.length}), ${w.tabs ? (w.balance ? "Balance tab" : "Wallet tab") : "no tabs"}: ${s.rows} row(s), ${docs.length ? "printed" : "nothing to print"}.`);
    // The oldest month read has transactions: older months may have them too.
    if (w.at === w.months.length - 1 && (w.balance || !w.tabs) && w.rows) {
      dropWalk();
      return stopped(`Venmo was read back ${w.months.length} months and the oldest has transactions, so older months may too. Those were not saved.`, docs);
    }
    if (!saveWalk(w)) return stopped("Chrome would not keep this sweep's place on Venmo's page.", docs);
    return { state: "ok", docs, more: true };
  }

  // The next view of the walk: the same month's Balance tab on a page with
  // tabs, or else the month before.
  function nextView() {
    const w = loadWalk();
    if (!w) return { why: "This sweep lost its place in Venmo's months. Run it again." };
    if (w.tabs && !w.balance) {
      w.balance = true;
    } else {
      w.at += 1;
      w.balance = false;
      w.rows = 0;
    }
    if (w.at >= w.months.length) {
      trace(`End of the walk: ${w.months.length} month(s) read, back to ${w.months[w.months.length - 1]}; the oldest had ${w.rows} row(s).`);
      dropWalk();
      return { moved: false };
    }
    w.went = true;
    if (!saveWalk(w)) return { why: "Chrome would not keep this sweep's place on Venmo's page." };
    leaveFor(urlFor(w.where, w.months[w.at], w.balance));
    return { moved: true };
  }

  // The month and tab a listed statement names, or null.
  function wanted(doc) {
    const m = DOC_ID.exec((doc && doc.id) || "");
    if (!m || typeof doc.url !== "string") return null;
    const month = `${m[1]}-${m[2]}`;
    if (doc.date !== monthEnd(month) || !finished(month)) return null;
    return { month, balance: Boolean(m[3]) };
  }

  // Opens the statement by its own address, the one the list read, on the
  // profile the page is signed in to now.
  async function showDoc(doc) {
    const want = wanted(doc);
    if (!want) return { ok: false, why: "This is not a statement this listed." };
    if (signedOut()) return { ok: false, why: SIGNED_OUT };
    const q = await settledQuery();
    if (!q || q.accountType !== ACCOUNT_TYPE) return { ok: false, why: "This is not Venmo's Statements page." };
    const url = urlFor(q, want.month, want.balance);
    if (doc.url !== url) return { ok: false, why: "Venmo is on another profile than the one this statement was listed on." };
    globalThis.__venmoLeaving = true;
    setTimeout(() => location.assign(url), 100);
    return { ok: true };
  }

  // Whether the tab is still on exactly this statement's address.
  function stillHere(doc, want) {
    const q = statementQuery();
    return Boolean(q) && urlFor(q, want.month, want.balance) === doc.url && isAt(q, q, want.month, want.balance);
  }

  // After a Show more press: the month drawn with more rows than before, the
  // same on two reads in a row. A string says why not.
  async function waitDrawn(doc, want, before) {
    let last = null;
    for (let i = 0; i < SETTLE_MS / POLL_MS; i++) {
      if (signedOut()) return SIGNED_OUT;
      if (!stillHere(doc, want)) return `Venmo left ${want.month} while its transactions were drawn.`;
      const s = readState();
      const seen = `${s.rows}|${s.pager}`;
      if (!settledWhy(s, want.month) && s.rows > before && seen === last) return s;
      last = seen;
      await sleep(POLL_MS);
    }
    return `A Show more press did not draw more of ${want.month}'s transactions, so it was not saved.`;
  }

  // Presses the list's own Show more until it is gone, each press required to
  // draw more rows. "" when every row is drawn, or else why not.
  async function showAll(doc, want) {
    let s = readState();
    for (let i = 0; i < SHOW_MORE_PRESSES && s.pager; i++) {
      const before = s.rows;
      const found = document.querySelectorAll(SHOW_MORE_CSS);
      if (found.length !== 1) return "The Show more control is not one this can read.";
      const control = found[0];
      if (!/^show more$/i.test(squash(control.textContent))) return "The list's last control is not Show more.";
      if (control.disabled || control.getAttribute("aria-disabled") === "true") return `${want.month}'s Show more is turned off on the page, so it was not saved.`;
      control.scrollIntoView({ block: "center" });
      const box = control.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (!top || !(top === control || control.contains(top))) return "Something on Venmo's page covers its Show more control.";
      control.click();
      const after = await waitDrawn(doc, want, before);
      if (typeof after === "string") return after;
      s = after;
    }
    return s.pager ? "Show more is still shown after the most presses this makes." : "";
  }

  // Ready once the page is this statement's month and tab, settled, with every
  // row drawn and no load-more control left.
  async function printReady(doc) {
    const want = wanted(doc);
    if (!want) return { ok: false, why: "This is not a statement this listed." };
    if (signedOut()) return { ok: false, why: SIGNED_OUT };
    const trouble = challengeOrSlow();
    if (trouble && trouble.state === "signed_out") return { ok: false, why: SIGNED_OUT };
    if (trouble && trouble.state === "challenge") return { ok: false, why: "Venmo is asking you to confirm something. Finish it in its tab, then run it again." };
    if (trouble) return { ok: false, why: trouble.why };
    if (!statementQuery()) return { ready: false, why: "The statement's address has not settled." };
    if (!stillHere(doc, want)) return { ok: false, why: `Venmo did not stay on ${want.month}.` };
    const held = await settle(want.month);
    if (held.why) return { ready: false, why: held.why };
    if (!held.state.rows) return { ok: false, why: `${want.month} now shows no transactions.` };
    if (extraMores(held.state)) return { ok: false, why: "The page shows a Load more control this does not know." };
    const why = await showAll(doc, want);
    if (why) return { ok: false, why };
    if (signedOut()) return { ok: false, why: SIGNED_OUT };
    if (!stillHere(doc, want)) return { ok: false, why: `Venmo did not stay on ${want.month}.` };
    const s = readState();
    const left = settledWhy(s, want.month);
    if (left) return { ready: false, why: left };
    if (s.pager || s.labels.some((t) => LOAD_MORE.test(t))) return { ok: false, why: "The page still shows a Load more control." };
    if (!s.rows) return { ok: false, why: `${want.month} now shows no transactions.` };
    return { ready: true };
  }

  globalThis.__sweep = { readList, nextView, showDoc, printReady };
})();
