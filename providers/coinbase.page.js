// Runs inside Coinbase's own page, where the sign-in already lives. It reads
// the Statements page and presses a month's own PDF button and, in a tab the
// sweep opened itself, the list's own Load more, the page's own Credit Card
// tab and a card statement row's own PDF button, and nothing else: never the
// custom statement generator, never another tab.
//
// Tax forms and the pregenerated gain and loss reports are read from the
// list calls Coinbase's Taxes page makes, asked here of Coinbase's own
// address with the page's sign-in, and fetched from the one host those lists
// link them on. Nothing on the Taxes page is pressed.
//
// Coinbase One Card statements are a second view, walked only in a tab the
// sweep opened: nextView presses the Credit Card tab, its list draws one
// "<Month YYYY>" row with one PDF button each, and a row's PDF button sends
// this same tab to the statement on statements.cardless.com, which the engine
// fetches ("newtab") and then goes back. The rows name only their month.
// PaperPull dates a card statement by its closing day, which it hears in the
// page's own list answer; a recipe here cannot hear that answer, and the day
// is not drawn, so a card statement is dated by the month its row shows.
//
// Derived from PaperPull's apps/coinbase/coinbase_site.py (AGPL-3.0).
(() => {
  const PDF_BUTTON = "button[data-testid='statements-pdf-v2']";
  const LOAD_MORE = "button[data-testid='load-more']";
  const OWNER_INFO = "/v2/tax/owner-info";
  const TAX_FORMS = "/v2/tax/forms";
  const TAX_REPORTS = "/v2/tax/tax-reports";
  const TAX_FORM_TYPES = ["1042-S", "1099-K", "1099-B", "1099-MISC", "1099-DA"];
  const TAX_HOST = "tax-center-forms-production.s3.amazonaws.com";
  const REPORTS_LIMIT = 200;
  const FORM_PAGES = 20;
  const CARD_TAB = "a[data-testid='subpage-navigation-item']";
  const CARD_PATH = "/statements/credit-card";
  const CARD_TITLE = "Coinbase One Card Statement";
  const CARD_ID = /^card:(\d{4})-(\d{2})$/;
  // The Transactions list's PDF button carries this test id; a card row's
  // does not.
  const STATEMENT_PDF_ID = "statements-pdf-v2";
  // The icon glyphs Coinbase draws in a button, from Unicode's private use
  // areas, which a button's words are read without.
  const GLYPHS = /[\s\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;
  // The card walk, kept in this tab's session storage: it began when
  // nextView pressed the Credit Card tab, and the tab's move to a statement
  // and back loads the page anew.
  const CARD_KEY = "statementSweep.coinbase.cardWalk";
  const CARD_WALK_AGE_MS = 30 * 60 * 1000;
  // How long the card list is given to show once its tab is pressed, and
  // how long its rows must stay the same before they are read.
  const CARD_OPEN_MS = 20000;
  const CARD_SETTLE_MS = 1000;
  const CARD_ROW_WAIT_MS = 3000;
  const CARD_TAB_HYDRATE_MS = 2000;
  const LOGIN = ["/signin", "/sign-in", "/login", "/oauth", "/2fa", "/mfa", "/verify", "/verification", "/challenge", "/sso",
    "//login.coinbase.com"];
  const CHALLENGE = ["enter the code", "verification code", "6-digit", "7-digit", "two-factor", "two-step", "authenticator",
    "confirm your identity", "verify your identity", "we sent a code", "device approval", "approve this login",
    "are you a robot", "captcha", "let's verify", "check your email", "check your phone",
    "your session has expired", "log back in", "access denied"];
  const RATE_LIMIT = ["too many requests", "rate limit", "try again later", "temporarily unavailable",
    "http error 429", "unusual traffic"];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const WINDOW_ROW = "Last 30 days";
  const ID = /^(\d{4})-(\d{2})$/;
  const TAX_ID = /^tax-(form|report):([A-Za-z0-9_-]{1,80})$/;
  const WAIT_MS = 12000;
  // As many presses as PaperPull allows, so a list that never ends stops.
  const MAX_LOAD_MORE = 60;
  const GROW_WAIT_MS = 10000;
  const LOOK_AGAIN_MS = 1500;

  const FORBIDDEN = new RegExp("(\\bbuy\\b|\\bsell\\b|\\btrad(e|es|ed|ing)\\b|\\bconvert(s|ed|ing)?\\b|\\bswap(s|ped|ping)?\\b|"
    + "\\bsend\\b|\\breceive\\b|\\bwithdraw(al|als|s)?\\b|\\bdeposit(s|ed)?\\b|\\btransfer(s|red|ring)?\\b|"
    + "\\bstak(e|es|ed|ing)\\b|\\bunstak(e|es|ed|ing)\\b|\\bearn\\b|\\bborrow\\b|\\blend(ing)?\\b|\\bloan\\b|"
    + "\\bcard\\b|\\bpay\\b|\\bpayment(s)?\\b|\\brecurring\\b|\\border(s)?\\b|\\badvanced\\b|\\bwallet\\b|"
    + "\\baddress(es)?\\b|\\bwhitelist\\b|\\ballowlist\\b|\\bapi\\b|\\bkey(s)?\\b|"
    + "\\bgenerat(e|es|ed|ing)\\b|\\bcreat(e|es|ed|ing)\\b|\\bcustom\\b|\\brequest(s|ed|ing)?\\b|"
    + "\\bapprov(e|es|ed|ing|al)\\b|\\bcontinue\\b|\\bsubmit\\b|\\bconfirm\\b|\\bagree\\b|\\baccept\\b|"
    + "\\bauthori[sz]e\\b|\\bverify\\b|\\bidentity\\b|\\bpassword\\b|\\bpasskey\\b|\\b2fa\\b|\\bsecurity\\b|"
    + "\\bsettings?\\b|\\bprofile\\b|\\benabl(e|es|ed|ing)\\b|\\bdisabl(e|es|ed|ing)\\b|"
    + "\\bchang(e|es|ed|ing)\\b|\\bedit(s|ed|ing)?\\b|\\bupdat(e|es|ed|ing)\\b|\\bdelet(e|es|ed|ing)\\b|"
    + "\\bremov(e|es|ed|ing)\\b|\\bcancel\\b|\\bclose\\b|\\bexport\\b|\\bemail\\b|\\bshare\\b|"
    + "\\bsign\\s*up\\b|\\bupgrade\\b|\\bsubscribe\\b|\\bone\\b|\\bchat\\b|\\bcontact\\b|\\bmark\\b)", "i");

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const buttons = () => Array.from(document.querySelectorAll(PDF_BUTTON));
  const onStatements = () => location.hostname === "accounts.coinbase.com" && location.pathname.replace(/\/$/, "") === "/statements";

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']"));
  }

  function asking() {
    if (buttons().length > 0 || cardButtons().length > 0) return null;
    const text = `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 1500)}`.toLowerCase();
    if (CHALLENGE.some((m) => text.includes(m))) return "challenge";
    if (RATE_LIMIT.some((m) => text.includes(m))) return "rate";
    return null;
  }

  // The label of the row a PDF button sits in. An ancestor holding a second
  // PDF button is the list around the rows, and the climb stops there with no
  // label, so a row that does not start with its month is never read as
  // another row's.
  function labelOf(button) {
    let el = button;
    for (let k = 0; k < 8 && el; k++, el = el.parentElement) {
      if (el.querySelectorAll(PDF_BUTTON).length > 1) return "";
      const m = (el.innerText || "").trim().match(/^(Last 30 days|[A-Z][a-z]+ (?:19|20)\d{2})(?!\S)/);
      if (m) return m[1];
    }
    return "";
  }

  // "September 2026" as its own last day, or null.
  function monthEnd(label) {
    const m = /^([A-Z][a-z]+) ((?:19|20)\d{2})$/.exec(label);
    if (!m) return null;
    const month = MONTHS.indexOf(m[1]);
    if (month < 0) return null;
    return new Date(Date.UTC(+m[2], month + 1, 0)).toISOString().slice(0, 10);
  }

  function isPdfLabel(button) {
    const label = tidy(button.innerText || button.getAttribute("aria-label"));
    return /\bpdf\b/i.test(label) && !FORBIDDEN.test(label);
  }

  const shown = (el) => Boolean(el) && Boolean(el.offsetWidth || el.getClientRects().length);
  const turnedOff = (el) => el.disabled || el.getAttribute("aria-disabled") === "true";

  function loadMoreShowing() {
    const button = document.querySelector(LOAD_MORE);
    return shown(button) && !turnedOff(button);
  }

  async function waitFor(test, ms) {
    const end = Date.now() + ms;
    while (!test()) {
      if (Date.now() >= end) return false;
      await sleep(150);
    }
    return true;
  }

  // The list's one Load more, shown and on, its every label reading exactly
  // "Load more", or why not. Looked for again after a moment before it is
  // taken for gone, since a list still drawing can hide it.
  async function loadMoreButton() {
    for (let look = 1; look <= 2; look++) {
      const found = Array.from(document.querySelectorAll(LOAD_MORE)).filter(shown);
      if (found.length > 1) return { why: "Coinbase's list shows two Load more buttons." };
      if (found.length === 1 && !turnedOff(found[0])) {
        const said = [found[0].innerText, found[0].getAttribute("aria-label"), found[0].getAttribute("title")].map(tidy).filter(Boolean);
        if (!said.length || !said.every((l) => /^load more$/i.test(l))) return { why: "Coinbase's Load more did not read as Load more." };
        return { button: found[0] };
      }
      if (look === 1) await sleep(LOOK_AGAIN_MS);
    }
    return { none: true };
  }

  // Presses Load more until the list is whole. The rows only ever grow.
  async function loadAll() {
    for (let presses = 0; ; presses++) {
      if (signedOut()) return { signedOut: true };
      const found = await loadMoreButton();
      if (found.why) return { why: found.why };
      if (found.none) return {};
      if (presses >= MAX_LOAD_MORE) return { why: `Coinbase's list ran past ${MAX_LOAD_MORE} presses of Load more.` };
      const before = buttons().length;
      found.button.click();
      if (!(await waitFor(() => buttons().length > before, GROW_WAIT_MS))) {
        return { why: "Coinbase's list showed no more months after Load more." };
      }
    }
  }

  // The Statements page's own Credit Card tabs: the words exactly "Credit
  // Card", and no address or exactly the card list's. A "Credit Card" link to
  // anywhere else, the product page say, is not one. Its words are never put
  // to FORBIDDEN, which refuses "card" for every other control.
  const cardHref = (href) => href === null || href.trim() === "" || href.trim() === CARD_PATH
    || href.trim() === `https://accounts.coinbase.com${CARD_PATH}`;
  const cardTabs = () => Array.from(document.querySelectorAll(CARD_TAB))
    .filter((a) => shown(a) && tidy(a.innerText) === "Credit Card" && cardHref(a.getAttribute("href")));
  const onCardList = () => location.hostname === "accounts.coinbase.com" && location.pathname.replace(/\/$/, "") === CARD_PATH;

  // A card row's PDF button: a button that is not the Transactions list's,
  // its words an icon and "PDF" and nothing else.
  const isCardButton = (b) => b.tagName === "BUTTON" && b.getAttribute("data-testid") !== STATEMENT_PDF_ID
    && (b.innerText || "").replace(GLYPHS, "") === "PDF" && !FORBIDDEN.test(tidy(b.innerText));
  const cardButtons = () => Array.from(document.querySelectorAll("button")).filter(isCardButton);

  // The month a card row's PDF button sits in, "September 2026", read upward
  // as labelOf does. An ancestor holding a second card PDF button is the list
  // around the rows, and the climb stops there with no label.
  function cardLabelOf(button) {
    let el = button;
    for (let k = 0; k < 8 && el; k++, el = el.parentElement) {
      if (Array.from(el.querySelectorAll("button")).filter(isCardButton).length > 1) return "";
      const m = (el.innerText || "").trim().match(/^([A-Z][a-z]+ (?:19|20)\d{2})(?!\S)/);
      if (m) return monthEnd(m[1]) ? m[1] : "";
    }
    return "";
  }

  function loadCardWalk() {
    try {
      const w = JSON.parse(sessionStorage.getItem(CARD_KEY) || "null");
      return w && typeof w.t === "number" && typeof w.p === "number" && Date.now() - w.t < CARD_WALK_AGE_MS ? w : null;
    } catch (e) { return null; }
  }
  const saveCardWalk = (w) => { try { sessionStorage.setItem(CARD_KEY, JSON.stringify(w)); } catch (e) { /* not kept */ } };
  const dropCardWalk = () => { try { sessionStorage.removeItem(CARD_KEY); } catch (e) { /* not there */ } };

  // Waits for the card list's rows to be drawn and to stay the same, rows and
  // months, a moment. True once they have; whether each row reads a month is
  // readCardRows' to say.
  async function cardRowsSettled(ms) {
    const end = Date.now() + ms;
    let last = null, since = Date.now();
    for (;;) {
      const rows = cardButtons();
      const now = rows.map((b) => cardLabelOf(b)).join("|");
      if (now !== last) { last = now; since = Date.now(); }
      if (rows.length > 0 && Date.now() - since >= CARD_SETTLE_MS) return true;
      if (Date.now() >= end) return rows.length > 0;
      await sleep(150);
    }
  }

  // Each card statement, newest first, under "card:YYYY-MM", dated by the
  // month its row shows (the closing day is not drawn), or why not.
  function readCardRows() {
    const docs = [];
    const seen = new Set();
    for (const button of cardButtons()) {
      const label = cardLabelOf(button);
      if (!label) return { why: "A card statement row has no month this can read.", docs };
      const month = monthEnd(label).slice(0, 7);
      if (seen.has(month)) return { why: "Two card statement rows read one month.", docs };
      seen.add(month);
      docs.push({ id: `card:${month}`, date: month, title: CARD_TITLE, method: "newtab" });
    }
    docs.sort((a, b) => (a.date < b.date ? 1 : -1));
    // The page's own list answer, which PaperPull hears to know the list is
    // whole, cannot be heard here, so the months have to follow one another.
    for (let i = 1; i < docs.length; i++) {
      const [y1, m1] = docs[i].date.split("-").map(Number);
      const [y0, m0] = docs[i - 1].date.split("-").map(Number);
      if ((y0 * 12 + m0) - (y1 * 12 + m1) !== 1) return { why: "Coinbase's card statements skip a month, so the list may not be whole.", docs };
    }
    return { docs };
  }

  // The card list, in the walk nextView began.
  async function readCardList() {
    if (!(await cardRowsSettled(CARD_OPEN_MS))) {
      if (signedOut()) return { state: "signed_out" };
      return { state: "stopped", why: "Coinbase's Credit Card tab showed no statements.", docs: [] };
    }
    const { why, docs } = readCardRows();
    if (why) return { state: "stopped", why, docs };
    if (document.querySelector(LOAD_MORE)) {
      return { state: "stopped", why: "Coinbase's card statements go on behind Load more, which this does not read.", docs };
    }
    return { state: "ok", docs };
  }

  function readRows() {
    const docs = [];
    const seen = new Set();
    let windows = 0;
    for (const button of buttons()) {
      const label = labelOf(button);
      if (label === WINDOW_ROW) {
        windows += 1;
        if (windows > 1) return { why: "Two rows read Last 30 days.", docs };
        continue;
      }
      const date = label && monthEnd(label);
      if (!date) return { why: "A statement row has no month this can read.", docs };
      if (!isPdfLabel(button)) return { why: "A statement's button did not read as PDF.", docs };
      if (seen.has(date)) return { why: "Two rows read one month.", docs };
      seen.add(date);
      docs.push({ id: date.slice(0, 7), date, title: "Monthly Statement", method: "click" });
    }
    return { docs };
  }

  // The list is whole only when it reaches back to the month of the account's
  // first transaction, which Coinbase gives at this address of its own.
  async function firstTransaction() {
    try {
      const response = await fetch(OWNER_INFO, { credentials: "same-origin", redirect: "error" });
      if (!response.ok) return "";
      const data = await response.json();
      const m = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-\d{2}/.exec(String((data && data.first_transaction_date) || ""));
      return m ? m[0] : "";
    } catch (e) {
      return "";
    }
  }

  // A Coinbase list call, by its own path on this host, or null.
  async function getJson(path) {
    try {
      const response = await fetch(path, { credentials: "same-origin", redirect: "error", headers: { Accept: "application/json" } });
      if (!response.ok) return null;
      return await response.json();
    } catch (e) {
      return null;
    }
  }

  const isList = (data) => Boolean(data) && typeof data === "object" && Array.isArray(data.data)
    && data.data.every((it) => it && typeof it === "object" && !Array.isArray(it));
  const yearOf = (item) => String(item.tax_year ?? item.year ?? "").trim();
  const formType = (item) => {
    const t = tidy(String(item.form_type || ""));
    return /^[A-Za-z0-9-]{1,20}$/.test(t) ? t : "Tax Form";
  };
  // "PregeneratedGainLossPDF" as "Gain Loss Report".
  const reportName = (name) => {
    const n = String(name || "").replace(/^Pregenerated/, "").replace(/(PDF|CSV)$/, "").replace(/(?<=[a-z])(?=[A-Z])/g, " ").trim();
    return /^[A-Za-z0-9 ]{1,40}$/.test(n) ? `${n} Report` : "Tax Report";
  };
  const isPdfReport = (r) => String((r.file && r.file.file_type) || "").toLowerCase() === "pdf";

  // Every form the list call gives for `year`, every page of it, or why not.
  async function formsFor(year) {
    const types = TAX_FORM_TYPES.map((t) => `types=${encodeURIComponent(t)}`).join("&");
    const base = `${TAX_FORMS}?${types}&sort_direction=DESC&year=${year}&is_hidden=false`;
    const items = [];
    let cursor = "";
    for (let page = 0; page < FORM_PAGES; page++) {
      const data = await getJson(cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base);
      if (!isList(data)) return { why: `Coinbase's tax forms list for ${year} could not be read.` };
      if (data.data.some((it) => yearOf(it) && yearOf(it) !== String(year))) {
        return { why: `Coinbase's tax forms list for ${year} holds a form of another year.` };
      }
      items.push(...data.data);
      const next = String(data.next_cursor || "");
      if (!next) return { items };
      if (next === cursor) return { why: `Coinbase's tax forms list for ${year} repeats a page.` };
      cursor = next;
    }
    return { why: `Coinbase's tax forms list for ${year} runs past ${FORM_PAGES} pages.` };
  }

  // The pregenerated reports, PDFs only, from one page that must not be full.
  async function reports() {
    const data = await getJson(`${TAX_REPORTS}?from_date=2012-01-01T00:00:00Z&to_date=${new Date().getFullYear()}-12-31T23:59:59Z&limit=${REPORTS_LIMIT}`);
    if (!isList(data)) return { why: "Coinbase's tax reports list could not be read." };
    const more = data.pagination && typeof data.pagination === "object"
      && ["next_cursor", "next_uri", "next_starting_after"].some((k) => String(data.pagination[k] || ""));
    if (String(data.next_cursor || "") || more || data.data.length >= REPORTS_LIMIT) {
      return { why: "Coinbase's tax reports list has more than the one page this reads." };
    }
    return { items: data.data.filter(isPdfReport) };
  }

  // Each form and PDF report, under its own id from Coinbase's list, titled
  // "<form> Tax Year <year>", with the id's start added only where one year
  // has two of one form, so a corrected form keeps a name of its own.
  async function taxDocs(first) {
    const thisYear = new Date().getFullYear();
    const found = [];
    for (let year = first ? +first.slice(0, 4) : 2012; year <= thisYear; year++) {
      const got = await formsFor(year);
      if (got.why) return { why: got.why, docs: [] };
      for (const item of got.items) found.push({ kind: "form", item, year: String(year), name: formType(item) });
    }
    const got = await reports();
    if (got.why) return { why: got.why, docs: [] };
    for (const item of got.items) {
      const year = String(item.year ?? item.timeframe_year ?? "").trim();
      if (!/^(?:19|20)\d{2}$/.test(year)) return { why: "A Coinbase tax report names no year this can read.", docs: [] };
      found.push({ kind: "report", item, year, name: reportName(item.name) });
    }
    const ids = new Set();
    const titles = new Map();
    for (const f of found) {
      const id = String(f.item.id || "").trim();
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return { why: "A Coinbase tax document has no id this can read.", docs: [] };
      if (ids.has(id)) return { why: "Two Coinbase tax documents share one id.", docs: [] };
      ids.add(id);
      f.id = id;
      const title = `${f.name} Tax Year ${f.year}`;
      titles.set(title, (titles.get(title) || 0) + 1);
    }
    const docs = found.map((f) => {
      let title = `${f.name} Tax Year ${f.year}`;
      if (titles.get(title) > 1) title += ` (#${f.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 40)})`;
      return { id: `tax-${f.kind}:${f.id}`, date: `${f.year}-12-31`, title, method: "fetch", year: f.year };
    });
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return { docs };
  }

  async function readList(options = {}) {
    const mayWalk = Boolean(options && options.walk);
    // A read for a tab of yours, or the sweep's first look at a tab it kept
    // from an earlier run, ends any card walk that run left behind.
    if (!mayWalk) dropCardWalk();
    const until = Date.now() + WAIT_MS;
    for (;;) {
      if (signedOut()) return { state: "signed_out" };
      const check = asking();
      if (check === "challenge") return { state: "challenge" };
      if (check === "rate") return { state: "stopped", why: "Coinbase is asking for a pause. Try again later.", docs: [] };
      if (onCardList()) {
        if (!mayWalk) return { state: "stopped", why: CARD_ONLY_OURS, docs: [] };
        // Not this run's walk: the engine takes the tab to the Statements page.
        if (!loadCardWalk()) return { state: "no_list" };
        return readCardList();
      }
      // The Credit Card tab was pressed and its list is still to come.
      const walking = mayWalk && onStatements() ? loadCardWalk() : null;
      if (walking) {
        if (Date.now() - walking.p >= CARD_OPEN_MS) {
          return { state: "stopped", why: "Coinbase's Credit Card tab did not open its statements.", docs: [] };
        }
        await sleep(300);
        continue;
      }
      if (!onStatements()) return { state: "no_list" };
      if (buttons().some((b) => monthEnd(labelOf(b) || ""))) break;
      if (Date.now() >= until) {
        return { state: "stopped", why: "Coinbase's Statements page showed no months.", docs: [] };
      }
      await sleep(300);
    }
    let loading = null;
    if (mayWalk) {
      const loaded = await loadAll();
      if (loaded.signedOut) return { state: "signed_out" };
      loading = loaded.why || null;
    }
    const { why, docs } = readRows();
    docs.sort((a, b) => (a.date < b.date ? 1 : -1));
    const first = await firstTransaction();
    let problem = loading || why;
    if (!problem && loadMoreShowing()) problem = "Coinbase's list goes on behind Load more, and this reads only the months shown.";
    if (!problem && !first) problem = "Coinbase did not say when the account began, so the list cannot be checked whole.";
    if (!problem) {
      const oldest = docs[docs.length - 1];
      const today = new Date();
      const hasMonths = first.slice(0, 7) < `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
      if (hasMonths && (!oldest || oldest.date.slice(0, 7) > first.slice(0, 7))) problem = "Coinbase's list stops short of the account's first month.";
    }
    // Statements first, so tax documents that will not save never keep a
    // month from being saved.
    const tax = await taxDocs(first);
    const all = docs.concat(tax.docs);
    if (problem) return { state: "stopped", why: problem, docs: all };
    if (tax.why) return { state: "stopped", why: tax.why, docs: all };
    // The card statements are the next view, walked only in a tab the sweep
    // opened, since reading them presses the Credit Card tab.
    const tabs = cardTabs();
    if (tabs.length > 1) return { state: "ok", docs: all, note: "Coinbase shows two Credit Card tabs, so its card statements were not read." };
    if (tabs.length === 1 && !mayWalk) return { state: "ok", docs: all, note: CARD_ONLY_OURS };
    if (tabs.length === 1) return { state: "ok", docs: all, more: true };
    return { state: "ok", docs: all };
  }

  const CARD_ONLY_OURS = "Coinbase One Card statements are read only in a tab Statement Sweep opens. Close your Coinbase tab, then run it again.";

  // The card view: the Statements page's own Credit Card tab, pressed once.
  function nextView() {
    if (signedOut() || !onStatements()) return { why: "This is not a signed-in Coinbase Statements page." };
    const tabs = cardTabs();
    if (tabs.length !== 1) return { why: "Coinbase's Credit Card tab was not there once." };
    const now = Date.now();
    saveCardWalk({ t: now, p: now });
    tabs[0].click();
    return { moved: true };
  }

  // A card statement's own PDF button, pressed once. The press sends this tab
  // to the statement; the engine fetches it and goes back, which may land on
  // the card list or on the Transactions list, where the Credit Card tab is
  // pressed again. Only in the tab whose card walk this is.
  async function clickCard(doc) {
    const m = CARD_ID.exec((doc && doc.id) || "");
    if (!m || +m[2] < 1 || +m[2] > 12) return { ok: false, why: "not a card statement month" };
    if (signedOut()) return { ok: false, why: "Coinbase asked for a sign-in." };
    const walk = loadCardWalk();
    if (!walk) return { ok: false, why: "Card statements are pressed only in the tab that opened Coinbase's Credit Card tab." };
    saveCardWalk({ ...walk, t: Date.now() });
    const label = `${MONTHS[+m[2] - 1]} ${m[1]}`;
    const end = Date.now() + CARD_OPEN_MS;
    let pressedTab = false;
    let tabSince = 0;
    for (;;) {
      if (signedOut()) return { ok: false, why: "Coinbase asked for a sign-in." };
      if (onCardList() && cardButtons().some((b) => cardLabelOf(b))) break;
      if (!pressedTab && onStatements()) {
        const tabs = cardTabs();
        if (tabs.length > 1) return { ok: false, why: "Coinbase shows two Credit Card tabs." };
        if (tabs.length === 1) {
          if (!tabSince) tabSince = Date.now();
          // Once the page has drawn its list, or a moment after its tab shows.
          if (buttons().length > 0 || Date.now() - tabSince >= CARD_TAB_HYDRATE_MS) {
            pressedTab = true;
            saveCardWalk({ t: Date.now(), p: Date.now() });
            tabs[0].click();
          }
        }
      }
      if (Date.now() >= end) return { ok: false, why: "Coinbase's card statements did not show again." };
      await sleep(150);
    }
    await waitFor(() => cardButtons().some((b) => cardLabelOf(b) === label), CARD_ROW_WAIT_MS);
    const hits = cardButtons().filter((b) => cardLabelOf(b) === label);
    if (hits.length !== 1) return { ok: false, why: "Its row was not there exactly once." };
    const button = hits[0];
    if (turnedOff(button)) return { ok: false, why: "Its PDF button is turned off." };
    button.click();
    return { ok: true };
  }

  // A tax document, asked of its list again for its short-lived link, which
  // is fetched only on the one host the lists link to.
  async function fetchPdf(doc) {
    const m = TAX_ID.exec((doc && doc.id) || "");
    const year = String((doc && doc.year) || "");
    if (!m || !/^(?:19|20)\d{2}$/.test(year)) return { ok: false, why: "not a tax document this reads" };
    if (signedOut()) return { ok: false, why: "Coinbase asked for a sign-in.", signedOut: true };
    const listed = m[1] === "form" ? await formsFor(+year) : await reports();
    if (listed.why) return { ok: false, why: listed.why };
    const hits = listed.items.filter((it) => String(it.id || "").trim() === m[2]);
    if (hits.length !== 1) return { ok: false, why: "Coinbase's tax list did not name it once." };
    const files = Array.isArray(hits[0].files) ? hits[0].files : [hits[0].file];
    const pdfs = files.filter((f) => f && typeof f === "object" && String(f.file_type || "").toLowerCase() === "pdf" && f.url);
    if (pdfs.length !== 1) return { ok: false, why: "Coinbase's tax list gave no one PDF for it." };
    let url;
    try { url = new URL(String(pdfs[0].url)); } catch (e) { return { ok: false, why: "Its link could not be read." }; }
    if (url.protocol !== "https:" || url.hostname !== TAX_HOST || url.port || url.username || url.password) {
      return { ok: false, why: "Its link is not on Coinbase's tax forms host." };
    }
    // The page may not read that host (it is not Coinbase's own), so the
    // checked link goes to the extension, which may, and fetches it there.
    return { ok: true, fetchUrl: url.href };
  }

  function clickDoc(doc) {
    if (/^card:/.test((doc && doc.id) || "")) return clickCard(doc);
    const m = ID.exec((doc && doc.id) || "");
    if (!m || +m[2] < 1 || +m[2] > 12) return { ok: false, why: "not a statement month" };
    if (signedOut() || !onStatements()) return { ok: false, why: "This is not a signed-in Statements page." };
    const label = `${MONTHS[+m[2] - 1]} ${m[1]}`;
    const hits = buttons().filter((b) => labelOf(b) === label);
    if (hits.length !== 1) return { ok: false, why: "Its row was not there exactly once." };
    const button = hits[0];
    if (!isPdfLabel(button)) return { ok: false, why: "That button did not read as PDF." };
    if (button.disabled || button.getAttribute("aria-disabled") === "true") return { ok: false, why: "Its PDF button is turned off." };
    button.click();
    return { ok: true };
  }

  globalThis.__sweep = { readList, clickDoc, fetchPdf, nextView };
})();
