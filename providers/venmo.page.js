// Runs inside Venmo's own Statements page. It reads the month the page is
// showing, presses nothing, and asks Venmo for nothing.
//
// Venmo has no PDF statement, so a month's page is printed. Only the month on
// screen can be vouched for: its transactions come from a request this cannot
// see, and printing opens the month's address afresh.
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
  const QUERY_KEYS = ["accountType", "month", "profileId", "year"];
  const TAB_KEY = "accountTab";
  const WALLET_TAB = "venmo-account";
  const BALANCE_TAB = "venmo-balance";
  const PROFILE_ID = /^[A-Za-z0-9_-]{4,64}$/;
  const POLL_MS = 250;
  const SETTLE_MS = 12000;
  const EMPTY_HOLD_MS = 2000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const squash = (text) => (text || "").replace(/\s+/g, " ").trim();

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN_MARKERS.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']"));
  }

  function monthOf(text) {
    const m = MONTH_VALUE.exec(squash(text));
    if (!m) return null;
    const year = +m[2];
    if (year < 2000 || year > 2099) return null;
    return `${m[2]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, "0")}`;
  }

  const monthEnd = (month) => {
    const [y, m] = month.split("-").map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  };

  // A month counts as finished a whole day after its last day.
  function finished(month) {
    const d = new Date(Date.now() - 86400000);
    return month < `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  // The statement address's own fields, or null unless it is exactly that.
  function statementQuery() {
    if (location.protocol !== "https:" || location.hostname !== HOST || location.pathname.replace(/\/$/, "") !== PATH || location.hash) return null;
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

  function challengeOrSlow() {
    if (Array.from(document.querySelectorAll("input")).some((i) => monthOf(i.value))) return null;
    const words = `${document.title}\n${((document.body && document.body.innerText) || "").slice(0, 1500)}`.toLowerCase();
    if (EXPIRED_WORDS.some((w) => words.includes(w))) return { state: "signed_out" };
    if (CHECK_WORDS.some((w) => words.includes(w))) return { state: "challenge" };
    if (SLOW_WORDS.some((w) => words.includes(w))) return { state: "stopped", why: "Venmo says to try again later.", docs: [] };
    return null;
  }

  async function readList() {
    if (signedOut()) return { state: "signed_out" };
    const trouble = challengeOrSlow();
    if (trouble) return trouble;
    if (location.hostname !== HOST || location.pathname.replace(/\/$/, "") !== PATH) return { state: "no_list" };
    let query = statementQuery();
    for (let i = 0; !query && i < 20; i++) {
      await sleep(POLL_MS);
      query = statementQuery();
    }
    if (!query) return { state: "stopped", why: "The Statements page did not settle on a month's address.", docs: [] };
    if (query.accountType !== "personal") return { state: "stopped", why: "This Statements page is not a personal profile's.", docs: [] };
    const month = `${query.year}-${query.month.padStart(2, "0")}`;
    const held = await settle(month);
    if (signedOut()) return { state: "signed_out" };
    if (held.why) return { state: "stopped", why: held.why, docs: [] };
    const s = held.state;
    const mores = s.labels.filter((t) => LOAD_MORE.test(t)).length;
    if (mores > (s.pager ? 1 : 0)) return { state: "stopped", why: "The page shows a Load more control this does not know.", docs: [] };
    if (!finished(month)) return { state: "stopped", why: `${month} is still under way, so its statement is not final. Choose a finished month in the page's own picker, then sweep again.`, docs: [] };
    if (s.pager) return { state: "stopped", why: `${month} has more transactions behind Show more, and a print shows only the first ones, so it was not saved.`, docs: [] };
    const balance = s.asked === BALANCE_TAB;
    if (s.tabbed && !s.rows && !balance) {
      return { state: "stopped", why: "The Wallet tab says this month is empty, and only Venmo's own answer can confirm that, which this cannot read.", docs: [] };
    }
    if (!s.rows) return s.tabbed ? { state: "stopped", why: "The Balance tab holds nothing for this month, and the Wallet tab was not read.", docs: [] } : { state: "ok", docs: [] };
    const params = new URLSearchParams({ accountType: query.accountType, month: String(+query.month), profileId: query.profileId, year: query.year });
    if (balance) params.set(TAB_KEY, BALANCE_TAB);
    const docs = [{
      id: balance ? `${month}-balance` : month,
      date: monthEnd(month),
      title: balance ? "Balance Statement" : "Statement",
      method: "print",
      url: `https://${HOST}${PATH}?${params.toString()}`,
    }];
    if (s.tabbed) {
      return { state: "stopped", why: `Only the ${balance ? "Balance" : "Wallet"} tab of this month is on screen. Open the other tab, then sweep again.`, docs };
    }
    return { state: "ok", docs };
  }

  globalThis.__sweep = { readList };
})();
