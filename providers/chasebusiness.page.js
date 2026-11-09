// Runs inside Chase's own page, on a business document center. Reads the
// statement rows Chase has drawn for the account on show and presses only
// that statement's own save control.
//
// Derived from PaperPull's apps/chasebusiness/chasebusiness_site.py (AGPL-3.0).
(() => {
  const READY_WAIT_MS = 30000;
  const SETTLE_MS = 1500;
  const MENU_WAIT_MS = 5000;
  const YEAR_WAIT_MS = 8000;
  const ACCOUNT_WAIT_MS = 15000;
  const OPTION_WAIT_MS = 5000;
  const YEAR_OPTION_ID = /^container-\d+-filterstyledselect-0$/;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DOCUMENTS = "/dashboard/documents/myDocs/index";
  const LOGIN_MARKERS = ["/logon", "/login", "/signin"];
  const CHECK_MARKERS = ["enter the code we sent", "enter your verification code", "verification code", "one-time", "one time passcode", "security code", "we sent a code", "two-factor", "two-step", "authenticator", "confirm your identity", "verify your identity", "we need to verify", "unusual activity", "are you a robot", "captcha", "unable to verify", "trouble verifying"];
  const ENDED_MARKERS = ["your session has expired", "please log in again", "you've been logged out", "for your security, we signed you out"];
  const RATE_MARKERS = ["too many requests", "rate limit", "try again later", "temporarily unavailable", "http error 429", "unusual traffic"];
  const STATEMENTS = "button-accountsAccordian-STATEMENTS";
  const ROW_ID = /^accountsTable-STATEMENTS-row([0-9]+)$/;
  const DATE = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2},\\s+\\d{4}";
  const ENTRY = /^[A-Za-z0-9 .&'-]+ \(\.\.\.(\d{4})\)(\s*,\s*current selection)?$/i;
  const ENTRY_ACTION = /\bpay\b|\bpayment|transfer|redeem|activat|\block\b|unlock|replace|dispute|\bclose\b|appl(y|ies|ied|ication)\b|request|increase|advance|authorized\s+user|set\s+up|\bchang(e|es|ed|ing)\b|\bupdat(e|es|ed|ing)\b|\bmanage\b|autopay|auto-?pay|zelle|\bwires?\b|deposit|withdraw|\bsend\b|enroll|\bopen\b|\bcancel\b|\bsettings?\b|\bpreferences?\b|\bach\b|collect|quick\s*accept|merchant|approv|\busers?\b|catalog|employee|offers?\b|paperless|sign\s*out|stay\s+signed|continue|show\s+or\s+hide/i;
  const CLASSES = [[/\b(CHK|CHECKING)\b/i, "Business Checking", "chk"], [/\bCARD\b/i, "Business Card", "card"], [/\bDEBIT\b/i, "Business Debit", "debit"]];
  const SAVE_MENU = new RegExp(`^(${DATE}) opens menu to save document$`, "i");
  const SAVES_DOC = new RegExp(`^(${DATE}) saves document$`, "i");
  const SAVE_AS_PDF = /^save as pdf(\s*\d{1,2} of \d{1,2} items?)?$/i;
  const ID = /^(chk|card|debit)\|(\d{4})\|(\d{4}-\d{2}-\d{2})$/;
  const YEAR_OPTIONS = "[role='option'], [id^='container-'][id*='filterstyledselect']";
  const YEAR_LEADS = /^((?:19|20)\d{2})\b/;

  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const shown = (el) => Boolean(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const labelsOf = (el) => [tidy(el.innerText), tidy(el.getAttribute("aria-label")), tidy(el.getAttribute("title"))].filter(Boolean);
  const turnedOff = (el) => el.disabled === true || el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

  function rowDate(text) {
    const m = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4})$/.exec(tidy(text));
    if (!m) return null;
    const month = MONTHS.indexOf(m[1]);
    const d = new Date(Date.UTC(+m[3], month, +m[2]));
    if (d.getUTCFullYear() !== +m[3] || d.getUTCMonth() !== month || d.getUTCDate() !== +m[2]) return null;
    return d.toISOString().slice(0, 10);
  }

  // The session dialog is in the page all the time, and only counts drawn open.
  function dialogOpen() {
    const drawn = (el) => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && parseFloat(s.opacity) > 0;
    };
    return Array.from(document.querySelectorAll("mds-dialog#octagonSessionTimeoutDialogue")).some((d) => {
      if (!d.hasAttribute("open") || /^false$/i.test(d.getAttribute("open") || "")) return false;
      const st = getComputedStyle(d);
      if (st.visibility === "hidden" || st.display === "none" || parseFloat(st.opacity) === 0) return false;
      return drawn(d) || (Boolean(d.shadowRoot) && Array.from(d.shadowRoot.querySelectorAll("*")).some(drawn));
    });
  }

  function signedOut() {
    const url = location.href.toLowerCase();
    // Chase can keep a page's address and draw its sign-in in a frame over it.
    const frame = document.querySelector("iframe[name='logonbox'], iframe#logonbox");
    return dialogOpen() || LOGIN_MARKERS.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']")) || shown(frame);
  }

  const rowNodes = () => Array.from(document.querySelectorAll('tr[id^="accountsTable-STATEMENTS-row"]')).filter((r) => ROW_ID.test(r.id));

  function held() {
    if (rowNodes().length) return null;
    const hay = `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 1500)}`.toLowerCase();
    if (ENDED_MARKERS.some((m) => hay.includes(m))) return { state: "signed_out" };
    if (CHECK_MARKERS.some((m) => hay.includes(m))) return { state: "challenge" };
    if (RATE_MARKERS.some((m) => hay.includes(m))) return { state: "stopped", why: "Chase asked for a pause. Try again later." };
    return null;
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

  const onDocuments = () => location.hostname === "secure.chase.com" && location.pathname === "/web/auth/dashboard" && location.hash.slice(1).startsWith(DOCUMENTS);
  const menu = () => Array.from(document.querySelectorAll('a[id^="bottom-"]'));
  const accordions = () => Array.from(document.querySelectorAll('button[id^="button-accountsAccordian-"]'));
  const ready = () => menu().some(shown) && accordions().some(shown);
  const menuText = () => menu().map((a) => `${a.id}:${labelsOf(a).join("/")}`).join("|");
  const current = (a) => labelsOf(a).concat(tidy(a.textContent)).some((t) => /,\s*current selection\s*$/i.test(t));

  function accountClass(label) {
    const name = label.replace(/\s*\(\.\.\.\d{4}\)(\s*,\s*current selection)?\s*$/i, "");
    const found = CLASSES.filter(([rx]) => rx.test(name));
    return found.length === 1 ? found[0] : null;
  }

  // The account the menu has selected, or why it cannot be named.
  function accountOnShow() {
    const on = menu().filter(current);
    if (on.length !== 1 || !shown(on[0])) return { why: "The account on show could not be told." };
    const labels = labelsOf(on[0]);
    const tails = labels.map((l) => (ENTRY.exec(l) || [])[1]);
    if (!labels.length || tails.some((t) => !t) || new Set(tails).size !== 1 || labels.some((l) => ENTRY_ACTION.test(l))) {
      return { why: "The account on show reads in a way this cannot read." };
    }
    const klass = accountClass(labels[0]);
    if (!klass || labels.some((l) => (accountClass(l) || [])[2] !== klass[2])) {
      return { skip: true, why: "The account on show is not a checking, card or debit account. Choose one in Chase's menu and sweep again." };
    }
    return { tail: tails[0], name: klass[1], code: klass[2] };
  }

  function readRows() {
    const rows = [];
    for (const tr of rowNodes()) {
      if (!shown(tr)) return { why: "A statement row is in the page and not shown." };
      const cells = Array.from(tr.querySelectorAll("th, td")).map((c) => tidy(c.innerText));
      if (cells.length < 3) return { why: "A statement row does not line up with its columns." };
      const date = rowDate(cells[0]);
      const pages = /^(\d+) pages?$/i.exec(cells[2]);
      if (!date || !cells[1] || !pages || +pages[1] <= 0) return { why: "A statement's row could not be read." };
      if (cells[1].toLowerCase() !== "statement") return { why: "A row of another document type is on the list." };
      rows.push({ tr, date, n: +ROW_ID.exec(tr.id)[1] });
    }
    return { rows };
  }

  function shapeOf(row) {
    const menuLink = row.tr.querySelector(`a#header-accountsTable-STATEMENTS-row${row.n}-cell3-downloadDocumentDropdown`);
    const anchor = row.tr.querySelector(`a#accountsTable-STATEMENTS-row${row.n}-cell3-requestThisDocumentAnchor-download`);
    if (Boolean(menuLink) === Boolean(anchor)) return { why: "A statement's row shows both ways to save it, or neither." };
    return menuLink ? { kind: "menu", el: menuLink } : { kind: "anchor", el: anchor };
  }

  const firstCellDate = (tr) => rowDate(tidy((tr.querySelector("th, td") || {}).innerText)) || "";
  const rowsWord = () => rowNodes().map((r) => tidy(r.innerText)).join("|");
  const yearPicker = () => document.getElementById("header-filterstyledselect-0");
  const yearNodes = () => Array.from(document.querySelectorAll(YEAR_OPTIONS)).filter((el) => YEAR_OPTION_ID.test(el.id) && shown(el));

  function pickerYear() {
    const picker = yearPicker();
    const m = picker && [tidy(picker.value || picker.getAttribute("value"))].concat(labelsOf(picker)).map((t) => /^(?:view:{0,2}\s*)?(\d{4})$/i.exec(t)).find(Boolean);
    return m ? m[1] : "";
  }

  async function waitFor(test, ms) {
    const end = Date.now() + ms;
    while (!test()) {
      if (Date.now() >= end) return false;
      await sleep(150);
    }
    return true;
  }

  // Where the walk through accounts and years has been, kept on the page
  // between askings, since this file is run afresh each time.
  const walk = () => (globalThis.__chaseBusinessWalk = globalThis.__chaseBusinessWalk || { done: new Set(), opened: new Set(), passedOver: new Set(), account: null, years: null });

  async function openYears() {
    if (yearNodes().length) return true;
    yearPicker().click();
    return waitFor(() => yearNodes().length > 0, OPTION_WAIT_MS);
  }

  // Waits until the rows on the page are the chosen year's, so the last
  // year's rows are never read as this one's.
  async function chooseYear(year) {
    if (!(await openYears())) return { why: "Chase's year picker did not open." };
    const option = yearNodes().find((el) => [tidy(el.textContent), tidy(el.getAttribute("aria-label"))].some((l) => (YEAR_LEADS.exec(l) || [])[1] === year));
    if (!option) return { why: `Chase's year picker no longer offers ${year}.` };
    option.click();
    if (!(await waitFor(() => pickerYear() === year, OPTION_WAIT_MS))) return { why: `Chase did not change to ${year}.` };
    const inYear = () => rowNodes().length > 0 && rowNodes().every((r) => firstCellDate(r).startsWith(year));
    if (!(await waitFor(inYear, YEAR_WAIT_MS)) && rowNodes().length) return { why: `Chase did not redraw its statements for ${year}.` };
    return { moved: true };
  }

  // Waits until the account is selected and the old account's rows are gone,
  // so they are never saved under the new account's name.
  async function chooseAccount(entry) {
    const old = new WeakSet(rowNodes());
    const before = rowsWord();
    const { id } = entry;
    entry.click();
    // By its id, since the page may draw its menu anew.
    const selected = () => { const now = document.getElementById(id); return Boolean(now) && current(now); };
    if (!(await waitFor(selected, ACCOUNT_WAIT_MS))) return { why: "The account chosen does not show as selected." };
    const redrawn = () => !rowNodes().length || rowNodes().some((r) => !old.has(r)) || rowsWord() !== before;
    if (!(await waitFor(redrawn, ACCOUNT_WAIT_MS))) return { why: "Chase did not redraw its statements for the account chosen." };
    return { moved: true };
  }

  // One step on: this account's next year, or else the next account.
  async function nextView() {
    const w = walk();
    const on = menu().find(current);
    if (!on) return { why: "The account on show could not be told." };
    if (w.account !== on.id) {
      w.account = on.id;
      w.years = null;
      w.done.add(on.id);
    }
    // A cardholder's entry can show a year picker over nothing but notices.
    if (yearPicker() && shown(yearPicker()) && !w.passedOver.has(on.id)) {
      if (w.years === null) {
        if (!(await openYears())) return { why: "Chase's year picker did not open." };
        const now = pickerYear();
        w.years = [...yearsOffered()].filter((y) => y !== now).sort().reverse();
        if (!w.years.length) yearPicker().click();
      }
      if (w.years.length) return chooseYear(w.years.shift());
    }
    const next = menu().find((a) => shown(a) && !w.done.has(a.id));
    if (next) return chooseAccount(next);
    const passed = w.passedOver.size;
    const note = passed ? `Passed over ${passed} Chase ${passed === 1 ? "entry that is" : "entries that are"} not a checking, card or debit account.` : "";
    delete globalThis.__chaseBusinessWalk;
    return note ? { moved: false, note } : { moved: false };
  }

  async function readList({ walk: mayWalk = false } = {}) {
    if (signedOut()) return { state: "signed_out" };
    let stop = held();
    if (stop) return stop;
    if (!onDocuments()) return { state: "no_list" };
    const end = Date.now() + READY_WAIT_MS;
    while (!ready()) {
      if (Date.now() >= end) return { state: "stopped", why: "Chase did not draw its account menu and document sections." };
      await sleep(250);
      if (signedOut()) return { state: "signed_out" };
      stop = held();
      if (stop) return stop;
    }
    const first = menuText();
    await sleep(SETTLE_MS);
    if (signedOut()) return { state: "signed_out" };
    if (menuText() !== first) return { state: "stopped", why: "Chase's account menu read differently twice over." };
    const account = accountOnShow();
    if (account.skip && mayWalk) {
      walk().passedOver.add(menu().find(current).id);
      return { state: "ok", docs: [], more: true };
    }
    if (account.why) return { state: "stopped", why: account.why };
    const nodes = accordions().filter((a) => a.id === STATEMENTS);
    if (!nodes.length && mayWalk) return { state: "ok", docs: [], more: true };
    if (!nodes.length) return { state: "stopped", why: "The account on show has no Statements section. Choose another in Chase's menu and sweep again." };
    if (nodes.length !== 1 || !shown(nodes[0])) return { state: "stopped", why: "The Statements section is hidden or drawn twice." };
    if ((nodes[0].getAttribute("aria-expanded") || "").toLowerCase() !== "true") {
      const key = menu().find(current).id;
      if (mayWalk && !walk().opened.has(key)) {
        walk().opened.add(key);
        nodes[0].click();
        return { state: "walking" };
      }
      return { state: "stopped", why: "Chase has the Statements section closed. Open it and sweep again." };
    }
    if (mayWalk && !rowNodes().length) await waitFor(() => rowNodes().length > 0, YEAR_WAIT_MS);
    const yearNow = pickerYear();
    const year = yearNow ? [yearNow, yearNow] : null;
    if (!year) return { state: "stopped", why: "The year picker shows no year." };
    const read = readRows();
    if (read.why) return { state: "stopped", why: read.why };
    if (new Set(read.rows.map((r) => r.date)).size !== read.rows.length) return { state: "stopped", why: "Two statements of this account carry one date." };
    const docs = [];
    for (const row of read.rows) {
      const shape = shapeOf(row);
      if (shape.why) return { state: "stopped", why: shape.why, docs };
      docs.push({ id: `${account.code}|${account.tail}|${row.date}`, date: row.date, title: account.name, method: "click" });
    }
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (mayWalk) return { state: "ok", docs, more: true };
    if (!docs.length) return { state: "stopped", why: `Chase shows no statements for ${year[1]}. Pick another year in its View picker and sweep again.`, docs };
    const others = menu().length - 1;
    if (others) return { state: "stopped", why: `Only the account on show was read. Choose each of the other ${others} in Chase's menu and sweep again.`, docs };
    const offered = yearsOffered();
    if (offered.size !== 1 || !offered.has(year[1])) return { state: "stopped", why: `Only ${year[1]} was read. Chase's View picker may hold other years. Choose each there and sweep again.`, docs };
    return { state: "ok", docs };
  }

  // Every label the control carries must be the one shape, whole.
  function labelsAre(el, rx, date) {
    const labels = labelsOf(el);
    return labels.length > 0 && labels.every((l) => {
      const m = rx.exec(l);
      return Boolean(m) && (!date || rowDate(m[1]) === date);
    });
  }

  function ownOption(row, trigger) {
    const option = document.getElementById(`item-0-${row.n}-downloadPDFOption`);
    const drawn = (el) => Boolean(el) && shown(el) && tidy(el.innerText).length > 0;
    if (!drawn(option)) return null;
    if (Array.from(document.querySelectorAll('a[id^="item-"][id$="-downloadPDFOption"]')).filter(drawn).length !== 1) return null;
    if ((trigger.getAttribute("aria-expanded") || "").toLowerCase() !== "true") return null;
    if (Array.from(document.querySelectorAll('a[id^="header-"][id$="-cell3-downloadDocumentDropdown"]'))
      .some((t) => t !== trigger && (t.getAttribute("aria-expanded") || "").toLowerCase() === "true")) return null;
    if (row.tr.contains(option)) return option;
    const named = `${trigger.getAttribute("aria-controls") || ""} ${trigger.getAttribute("aria-owns") || ""}`.split(/\s+/).filter(Boolean)
      .map((i) => document.getElementById(i)).filter((m) => m && m.contains(option));
    return named.length === 1 ? option : null;
  }

  async function clickDoc(doc) {
    const parts = ID.exec((doc && doc.id) || "");
    if (!parts) return { ok: false, why: "not a statement of this list" };
    const [, code, tail, date] = parts;
    const account = accountOnShow();
    if (account.why || account.code !== code || account.tail !== tail) return { ok: false, why: "Another account is on show on Chase's page." };
    const read = readRows();
    if (read.why) return { ok: false, why: read.why };
    const rows = read.rows.filter((r) => r.date === date);
    if (rows.length !== 1) return { ok: false, why: "That statement's row is not on the page once." };
    const shape = shapeOf(rows[0]);
    if (shape.why) return { ok: false, why: shape.why };
    if (turnedOff(shape.el)) return { ok: false, why: "Chase has that statement's control turned off." };
    if (shape.kind === "anchor") {
      if (!labelsAre(shape.el, SAVES_DOC, date)) return { ok: false, why: "That link is not one this will press." };
      shape.el.click();
      return { ok: true };
    }
    if (!labelsAre(shape.el, SAVE_MENU, date)) return { ok: false, why: "That menu is not one this will press." };
    shape.el.click();
    const end = Date.now() + MENU_WAIT_MS;
    let option = ownOption(rows[0], shape.el);
    while (!option && Date.now() < end) {
      await sleep(150);
      option = ownOption(rows[0], shape.el);
    }
    if (!option) return { ok: false, why: "Save as PDF did not show in that statement's own menu." };
    if (turnedOff(option)) return { ok: false, why: "Chase has that statement's Save as PDF turned off." };
    if (!labelsAre(option, SAVE_AS_PDF)) return { ok: false, why: "That option is not one this will press." };
    option.click();
    return { ok: true };
  }

  globalThis.__sweep = { readList, clickDoc, nextView };
})();
