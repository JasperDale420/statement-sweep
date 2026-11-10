// Runs inside the provider's own page, where the sign-in already lives.
// Reads and downloads. In a tab the sweep opened itself, it also chooses each
// account in SDG&E's own account list and sets the bill table to show every
// bill, page by page if it must. It presses nothing else.
//
// Derived from PaperPull's apps/sdge/sdge_site.py (AGPL-3.0). PaperPull reads
// the account on show and one page of the table only; the walk through
// accounts and table pages is this extension's own.
(() => {
  const BILL_PATH = "/portal/BillingHistory/DownloadBillPdf";
  const INVOICE = /^ISU[0-9]{12}$/;
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const TABLE_WAIT_MS = 10000;
  const SWITCH_WAIT_MS = 30000;
  const EMPTY_SETTLE_MS = 1500;
  const MAX_PAGES = 60;
  const MAX_ACCOUNTS = 40;
  const WALK_KEY = "statementSweep.sdgeWalk";
  const WALK_AGE_MS = 30 * 60 * 1000;
  const WALKING = { state: "walking" };
  const text = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // The table plugin's line under the table, "Showing 1 to 10 of 24 entries",
  // and the "(filtered from N total entries)" it adds under a search.
  const INFO_TOTAL = /\bof\s+([\d,]+)\s+entries\b/i;
  const INFO_FILTERED = /\bfiltered\b/i;
  const EMPTY_TEXT = /^no data available in table$/i;
  // The table plugin's own length menu and Next, by the names it gives them.
  const LENGTH = 'select[name="billHistoryTable_length"][aria-controls="billHistoryTable"]';
  const NEXT_WORDS = /^(next|›|»)$/i;

  // The whole cell must be one real date, or there is no date.
  function statementDate(cell) {
    const m = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+([0-9]{1,2}),\s+([0-9]{4})$/.exec(cell);
    if (!m) return null;
    const month = MONTHS.indexOf(m[1].toLowerCase());
    const year = +m[3], day = +m[2];
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
    return d.toISOString().slice(0, 10);
  }

  function signedOut() {
    const url = location.href.toLowerCase();
    return ["/prelogin/", "/accounts/logout", "/account/login", "/login"].some((m) => url.includes(m))
      || Boolean(document.querySelector("input[type='password']"));
  }

  async function waitFor(test, ms) {
    const end = Date.now() + ms;
    while (!test()) {
      if (Date.now() >= end) return false;
      await sleep(150);
    }
    return true;
  }

  const turnedOff = (el) => el.disabled === true || el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true"
    || el.classList.contains("disabled") || Boolean(el.closest("li.disabled"));

  // Each bill row starts with a hidden cell holding its row number, with no
  // header above it. Only that cell is passed over, and only in a row exactly
  // one wider than the header, so a table hiding a real column stops the list
  // rather than file a Due Date as a Statement Date.
  function cellsOf(row, width) {
    const cells = Array.from(row.cells);
    const first = cells[0];
    const numbered = cells.length === width + 1 && first
      && getComputedStyle(first).display === "none" && /^\d+$/.test(text(first));
    return numbered ? cells.slice(1) : cells;
  }

  // The bills the table draws now: {bills}, {none: true} with no table, or
  // {why}. The table is looked up afresh, since the page may draw it anew.
  function drawnBills() {
    const table = document.querySelector("#billHistoryTable");
    if (!table || !table.tHead) return { none: true, bills: [] };
    const heads = Array.from(table.tHead.rows[0].cells).map(text);
    const isDate = (h) => /\bstatement\b/i.test(h) && /\bdate\b/i.test(h);
    const column = heads.findIndex(isDate);
    if (column < 0 || heads.filter(isDate).length !== 1) return { why: "The table has no single Statement Date column.", bills: [] };
    const bills = [];
    const seen = new Set();
    for (const row of table.querySelectorAll("tbody tr[invoiceid]")) {
      const id = row.getAttribute("invoiceid") || "";
      if (!INVOICE.test(id)) return { why: "A bill's number was not one this can read.", bills };
      const cells = cellsOf(row, heads.length);
      if (cells.length !== heads.length || cells.some((c) => c.colSpan !== 1 || c.rowSpan !== 1)) {
        return { why: "A bill's row does not line up with the table's header.", bills };
      }
      const date = statementDate(text(cells[column]));
      if (!date) return { why: "A bill's statement date could not be read.", bills };
      if (seen.has(id)) return { why: "Two rows carry one bill number.", bills };
      seen.add(id);
      bills.push({ id, date, method: "fetch" });
    }
    return { bills };
  }

  function infoLine() {
    const line = document.querySelector("#billHistoryTable_info");
    return line ? text(line) : "";
  }
  // The table plugin's own count: {} with no such line, {filtered},
  // {unreadable}, or {total}.
  function tableCount() {
    const info = infoLine();
    if (!info) return {};
    if (INFO_FILTERED.test(info)) return { filtered: true };
    const m = INFO_TOTAL.exec(info);
    if (!m) return { unreadable: true };
    return { total: +m[1].replace(/,/g, "") };
  }
  const tableNow = () => `${infoLine()}|${drawnBills().bills.map((b) => b.id).join(",")}`;

  // "" when `count` bills are every bill the table holds, or why they are
  // not. The plugin keeps only the page it shows in the document. A table
  // showing no such line is read as its rows, as PaperPull does.
  function tableProblem(count) {
    const said = tableCount();
    if (said.filtered) return "The bill table is filtered by a search. Clear the search and sweep again.";
    if (said.unreadable) return "The bill table's own count could not be read.";
    if (said.total === undefined || said.total === count) return "";
    return `The bill table holds ${said.total} bills and ${count} are drawn. Set it to show them all and sweep again.`;
  }

  // The table's own length menu set to its longest choice, All when it has
  // one. {} when set, already so, or there is no such menu; {why} otherwise.
  async function longestPage() {
    const menus = document.querySelectorAll(LENGTH);
    if (!menus.length) return {};
    if (menus.length !== 1) return { why: "The bill table shows two length menus." };
    const menu = menus[0];
    const values = Array.from(menu.options).map((o) => o.value);
    if (!values.length || values.some((v) => !/^-?\d+$/.test(v))) return { why: "The bill table's length menu could not be read." };
    const numbers = values.map(Number);
    const best = numbers.includes(-1) ? -1 : Math.max(...numbers);
    if (Number(menu.value) === best) return {};
    if (turnedOff(menu)) return { why: "The bill table's length menu is turned off." };
    const before = tableNow();
    menu.value = String(best);
    menu.dispatchEvent(new Event("input", { bubbles: true }));
    menu.dispatchEvent(new Event("change", { bubbles: true }));
    if (!(await waitFor(() => tableNow() !== before, TABLE_WAIT_MS))) return { why: "The bill table did not redraw with more bills." };
    return {};
  }

  // The table plugin's one Next control: {el}, {why}, or null when it has
  // none. Its id is on the link in one style, on the item around it in another.
  function nextControl() {
    const found = new Set();
    const byId = document.getElementById("billHistoryTable_next");
    if (byId) found.add(byId.matches("a, button") ? byId : byId.querySelector("a, button"));
    for (const el of document.querySelectorAll('a[aria-controls="billHistoryTable"], button[aria-controls="billHistoryTable"]')) {
      const item = el.closest("li");
      if (el.classList.contains("next") || (item && item.classList.contains("next"))) found.add(el);
    }
    found.delete(null);
    if (!found.size) return null;
    if (found.size !== 1) return { why: "The bill table shows two Next controls." };
    const el = [...found][0];
    const labels = [text(el), (el.getAttribute("aria-label") || "").trim()].filter(Boolean);
    if (!labels.length || !labels.every((l) => NEXT_WORDS.test(l))) return { why: "The bill table's Next control reads in a way this cannot read." };
    return { el };
  }

  // Every bill of the table: its longest page first, then each page after
  // by the table's own Next, until the table's own count is reached.
  async function everyBill() {
    let drawn = drawnBills();
    if (drawn.why || drawn.none || !tableProblem(drawn.bills.length)) return drawn;
    const said = tableCount();
    if (said.total === undefined) return drawn;
    const longest = await longestPage();
    if (longest.why) return { why: longest.why, bills: drawn.bills };
    drawn = drawnBills();
    if (drawn.why) return drawn;
    const all = new Map(drawn.bills.map((b) => [b.id, b]));
    for (let page = 0; page < MAX_PAGES && all.size < said.total; page += 1) {
      const next = nextControl();
      if (!next) break;
      if (next.why) return { why: next.why, bills: [...all.values()] };
      if (turnedOff(next.el)) break;
      const before = tableNow();
      next.el.click();
      if (!(await waitFor(() => tableNow() !== before, TABLE_WAIT_MS))) return { why: "The bill table did not turn its page.", bills: [...all.values()] };
      drawn = drawnBills();
      if (drawn.why) return { why: drawn.why, bills: [...all.values()] };
      for (const b of drawn.bills) {
        if (all.has(b.id)) return { why: "Two pages of the bill table carry one bill number.", bills: [...all.values()] };
        all.set(b.id, b);
      }
    }
    return { bills: [...all.values()] };
  }

  // The accounts SDG&E's list offers, each by its option's value, and the
  // one it has selected. Looked up afresh each time.
  function accountsOf() {
    const select = document.querySelector("select#accountList");
    if (!select) return { list: [] };
    const list = Array.from(select.options).filter((o) => o.value.trim());
    if (new Set(list.map((o) => o.value)).size !== list.length) return { why: "Two accounts in SDG&E's account list carry one value.", list };
    const current = list.find((o) => o.selected && o.value === select.value) || null;
    return { select, list, current };
  }

  // Where the walk through accounts has been. Kept in this tab's session
  // storage, since choosing an account may load the page anew, and removed
  // when the walk ends.
  function loadWalk() {
    let w = null;
    try { w = JSON.parse(sessionStorage.getItem(WALK_KEY) || "null"); } catch (e) { w = globalThis.__sdgeWalk || null; }
    if (!w || !Array.isArray(w.done) || typeof w.at !== "number" || Date.now() - w.at > WALK_AGE_MS) return null;
    return w;
  }
  function saveWalk(w) {
    try { sessionStorage.setItem(WALK_KEY, JSON.stringify(w)); } catch (e) { globalThis.__sdgeWalk = w; }
  }
  function dropWalk() {
    try { sessionStorage.removeItem(WALK_KEY); } catch (e) { /* not there */ }
    delete globalThis.__sdgeWalk;
  }

  // The plugin's own empty line, the same twice a moment apart.
  async function saysEmpty() {
    const empty = () => {
      const cell = document.querySelector("#billHistoryTable tbody td.dataTables_empty");
      return Boolean(cell) && EMPTY_TEXT.test(text(cell)) && !document.querySelector("#billHistoryTable tbody tr[invoiceid]");
    };
    if (!empty()) return false;
    await sleep(EMPTY_SETTLE_MS);
    return empty();
  }

  async function readList({ walk: mayWalk = false } = {}) {
    if (signedOut()) return { state: "signed_out" };
    const w = mayWalk ? loadWalk() : null;
    const pending = Boolean(w && w.target);
    // Still on the way to the account chosen: waits, and stops once the
    // page has had its time, rather than read one account's bills as another's.
    const late = () => (Date.now() - w.at > SWITCH_WAIT_MS
      ? (dropWalk(), { state: "stopped", why: "SDG&E did not show the bills of the account chosen." })
      : WALKING);
    if (pending) {
      const now = accountsOf();
      if (now.why) { dropWalk(); return { state: "stopped", why: now.why }; }
      const old = new Set(w.old || []);
      if (!now.current || now.current.value !== w.target || drawnBills().bills.some((b) => old.has(b.id))) return late();
    }
    const read = mayWalk ? await everyBill() : drawnBills();
    if (read.none) return pending ? late() : { state: "no_list" };
    const bills = read.bills;
    if (read.why) return { state: "stopped", why: read.why, docs: bills };
    const accounts = accountsOf();
    if (!bills.length) {
      // An account the walk chose may hold no bills at all, which the table
      // says in its own words. Anywhere else, no rows is not yet a list.
      if (pending && !accounts.why && await saysEmpty()) {
        w.target = null;
        w.old = [];
        saveWalk(w);
        return { state: "ok", docs: [], more: true };
      }
      return pending ? late() : { state: "no_list" };
    }
    const problem = tableProblem(bills.length);
    if (problem) return { state: "stopped", why: problem, docs: bills };
    if (accounts.why) return { state: "stopped", why: accounts.why, docs: bills };
    if (pending) {
      w.target = null;
      w.old = [];
      saveWalk(w);
    }
    if (accounts.list.length > 1) {
      if (!accounts.current) return { state: "stopped", why: "The account on show could not be told.", docs: bills };
      if (mayWalk) return { state: "ok", docs: bills, more: true };
      return { state: "stopped", why: `Only the account on show was read. Choose each of the other ${accounts.list.length - 1} in SDG&E's account list and sweep again.`, docs: bills };
    }
    if (mayWalk) dropWalk();
    return { state: "ok", docs: bills };
  }

  // The next account in SDG&E's own list that has not been read, chosen as
  // a person would choose it. The next reading waits until the list shows it
  // and the last account's bills are gone.
  function nextView() {
    if (signedOut()) return { why: "SDG&E asked for a sign-in." };
    const accounts = accountsOf();
    if (accounts.why) { dropWalk(); return { why: accounts.why }; }
    if (accounts.list.length < 2) { dropWalk(); return { moved: false }; }
    if (!accounts.current) { dropWalk(); return { why: "The account on show could not be told." }; }
    const w = loadWalk() || { done: [], at: Date.now() };
    if (w.target) return { why: "SDG&E has not yet shown the account chosen." };
    if (!w.done.includes(accounts.current.value)) w.done.push(accounts.current.value);
    if (w.done.length > MAX_ACCOUNTS) { dropWalk(); return { why: "SDG&E's account list holds more accounts than expected." }; }
    const next = accounts.list.find((o) => !w.done.includes(o.value) && !o.disabled);
    if (!next) { dropWalk(); return { moved: false }; }
    if (turnedOff(accounts.select)) { dropWalk(); return { why: "SDG&E's account list is turned off." }; }
    w.old = drawnBills().bills.map((b) => b.id);
    w.target = next.value;
    w.at = Date.now();
    saveWalk(w);
    accounts.select.value = next.value;
    if (accounts.select.value !== next.value) { dropWalk(); return { why: "SDG&E's account list would not take the account chosen." }; }
    accounts.select.dispatchEvent(new Event("input", { bubbles: true }));
    accounts.select.dispatchEvent(new Event("change", { bubbles: true }));
    return { moved: true };
  }

  async function fetchPdf(doc) {
    const id = doc && doc.id;
    if (!INVOICE.test(id || "")) return { ok: false, why: "not a bill number" };
    const response = await fetch(`${BILL_PATH}?invoiceId=${id}`, { credentials: "same-origin", redirect: "manual" });
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) {
      return { ok: false, signedOut: true, why: "The site asked for a sign-in." };
    }
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!response.ok || type !== "application/pdf") return { ok: false, why: `The site sent ${response.status} ${type}.` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    return globalThis.__sweepPdf.pdfResult(bytes);
  }

  globalThis.__sweep = { readList, fetchPdf, nextView };
})();
