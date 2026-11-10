// Runs inside Wealthfront's own Documents page, where the sign-in already
// lives. Reads and downloads only. Its presses are a tax row's own Download,
// which opens the dialog holding that form's PDF link, and that dialog's close.
// In a tab the sweep opened, it also chooses each year in the Tax Year menu,
// then sets the document-type menu to Statements and presses Older until the
// list ends, then to Quarterly Statements and the same, the way PaperPull's
// cmd_discover reads it whole. The accounts menu is kept on All Accounts and
// the date menu on its All option, so every account's statements are listed.
//
// Derived from PaperPull's apps/wealthfront/wealthfront_site.py (AGPL-3.0).
(() => {
  const OPTION_WAIT_MS = 5000;
  const YEAR_WAIT_MS = 4000;
  const OLDER_WAIT_MS = 10000;
  const MAX_YEARS = 40;
  const MAX_OLDER = 200;
  // The wording PaperPull chooses a tax year by: "Tax Year: 2025", or "2025".
  const YEAR_OPTION = /^(?:tax\s+year:\s*)?((?:19|20)\d{2})$/i;
  // Older's own words. Its text must be "Older" alone; a label or title, when
  // it has one, may name what is older and nothing else.
  const OLDER_TEXT = /^older$/i;
  const OLDER_LABEL = /^older(\s+(documents?|statements?|page|results))?$/i;
  // The page's own filter menus, native selects, as PaperPull found them
  // (wealthfront_site.py FALLBACK). Each is set only to an option whose whole
  // text is the one named here.
  const ACCOUNT_MENU = "select[name='selectedAccountId']";
  const TYPE_MENU = "select[name='selectedDocumentType']";
  const DATE_MENU = "select[name='selectedYearMonth']";
  const ALL_ACCOUNTS = /^all accounts$/i;
  const ALL_DATES = /^all( dates| time| years| months)?$/i;
  // PaperPull's order: Statements, then Quarterly Statements.
  const STATEMENT_TYPES = ["Statements", "Quarterly Statements"];
  const FILTER_WAIT_MS = 6000;
  const DOC_PATHS = ["/documents", "/account/documents", "/dashboard/documents"];
  const LOGIN_MARKERS = ["/login", "/signin", "/auth", "/mfa", "/verify"];
  const CHECK_WORDS = ["enter the code we sent", "verification code", "two-factor", "two-step verification",
    "authenticator app", "confirm your identity", "we need to verify", "are you a robot", "captcha",
    "unusual activity", "suspicious activity"];
  const EXPIRED_WORDS = ["session has expired", "please sign in again"];
  const SLOW_WORDS = ["too many requests", "rate limit", "try again later", "temporarily blocked", "http error 429"];
  const ROW = "table tbody tr, [data-testid*='document'], [class*='documentRow'], [class*='DocumentRow'], li[class*='document']";
  const TRIGGER = "[data-testid='tax-forms-account-view-dialog-trigger']";
  const DISMISS = "[data-testid='dismiss-dialog']";
  const DIALOG = "[role='dialog'], [aria-modal='true'], dialog";
  // /documents/90000017/document/DOCD-AA18 and
  // /documents/<id>/<year>/FORM_1099_PDF?idx=0, the two shapes seen.
  const DOC_PATH = /^\/documents\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  const DOC_QUERY = /^(\?idx=[0-9]{1,3})?$/;
  const NOISE = /^(download|link|view|open)$/i;
  const DATE_CELL = /^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})$/;
  const FORM_CELL = /(form\s|1099|5498|1042|480\.6|statement|confirmation)/i;
  const ACCOUNT_CELL = /(account|\bIRA\b|\b529\b|cash|investing|brokerage|credit)/i;
  const YEAR = /(\d{4})/;
  const CONTROL = /^(download|view|open)(\s+pdf)?$/i;
  const SKIP = [/trade\s+confirmation/i, /confirmation\s+of\s+trade/i, /prospectus/i, /advisory\s+agreement/i, /form\s+adv/i,
    /privacy\s+(notice|policy)/i, /terms\s+of\s+service/i];
  const TAX = [[/1099-?B\b/i, "1099-B Tax Form"], [/1099-?DIV\b/i, "1099-DIV Tax Form"], [/1099-?INT\b/i, "1099-INT Tax Form"],
    [/1099-?R\b/i, "1099-R Tax Form"], [/1099-?MISC\b/i, "1099-MISC Tax Form"], [/1099-?NEC\b/i, "1099-NEC Tax Form"],
    [/1099-?Q\b/i, "1099-Q Tax Form"], [/consolidated\s+(form\s+)?1099/i, "Consolidated 1099 Tax Form"], [/\b1099\b/i, "1099 Tax Form"],
    [/\b1042-?S\b/i, "1042-S Tax Form"], [/\b5498\b/i, "5498 Tax Form"], [/\b480\.6\b/i, "480.6 Tax Form"],
    [/tax\s+(document|form|statement|package)/i, "Tax Document"], [/cost\s+basis/i, "Cost Basis Tax Document"],
    [/realized\s+(gain|loss)/i, "Realized Gains Tax Document"]];
  const STATEMENT = [[/monthly\s+statement/i, "Monthly Statement"], [/quarterly\s+statement/i, "Quarterly Statement"],
    [/annual\s+statement|yearly\s+statement/i, "Annual Statement"], [/account\s+statement/i, "Account Statement"],
    [/cash\s+account\s+statement/i, "Cash Account Statement"], [/brokerage\s+statement/i, "Brokerage Statement"],
    [/\bstatement\b/i, "Account Statement"]];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A short line for the run log (shared.js), never the page's own text.
  const trace = (text) => { if (globalThis.__sweepLog) globalThis.__sweepLog(text); };
  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const shown = (el) => Boolean(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const turnedOff = (el) => el.disabled === true || el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
  const pageWords = () => `${document.title}\n${((document.body && document.body.innerText) || "").slice(0, 1200)}`.toLowerCase();

  function rows() {
    // A filter menu can carry a "document" name of its own, and is no row.
    const all = Array.from(document.querySelectorAll(ROW)).filter((row) => !row.matches("select") && !row.querySelector("select"));
    return all.filter((row) => !all.some((other) => other !== row && row.contains(other)));
  }

  // Waits for the list to stop growing: the page draws its tables after load.
  async function settled() {
    let last = -1;
    for (let i = 0; i < 8; i++) {
      const count = rows().length;
      if (count === last && count > 0) return;
      last = count;
      await sleep(350);
    }
  }

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN_MARKERS.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']"));
  }

  const cellsOf = (row) => (row.innerText || "").split(/[\n\t]+/).map((c) => c.trim()).filter((c) => c && !NOISE.test(c));

  // The whole cell must be one real date, or there is no date.
  function rowDate(cell) {
    const m = DATE_CELL.exec(cell);
    if (!m) return null;
    const month = +m[1], day = +m[2], year = +m[3];
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return d.toISOString().slice(0, 10);
  }

  function parseRow(cells) {
    if (!cells.length) return null;
    if (DATE_CELL.test(cells[0])) {
      const title = cells.slice(1).find((c) => FORM_CELL.test(c)) || cells[1] || "";
      if (!title) return null;
      const m = /\bfor\s+(.+)$/.exec(title);
      const account = m ? m[1].trim().replace(/\s*\([^)]*\)\s*$/, "").trim() : "";
      return { kind: "dated", title, account, dateCell: cells[0] };
    }
    const form = cells.find((c) => FORM_CELL.test(c));
    if (!form) return null;
    return { kind: "tax", title: form, account: cells.find((c) => ACCOUNT_CELL.test(c) && c !== form) || "" };
  }

  // A link read off the page, and only one of Wealthfront's own document
  // addresses. Everything else is never asked for.
  function documentUrl(href) {
    let url;
    try { url = new URL(href, location.href); } catch (e) { return null; }
    if (url.origin !== location.origin || !DOC_PATH.test(url.pathname) || !DOC_QUERY.test(url.search)) return null;
    return url;
  }

  const summary = (title) => {
    if (SKIP.some((rx) => rx.test(title))) return null;
    for (const [rx, name] of TAX) if (rx.test(title)) return name;
    for (const [rx, name] of STATEMENT) if (rx.test(title)) return name;
    return null;
  };

  const taxYearSelect = () => document.querySelector("select[aria-label='tax year']");
  function shownTaxYear() {
    const select = taxYearSelect();
    const m = select ? YEAR.exec(select.value || "") : null;
    return m ? m[1] : "";
  }

  function older() {
    return Array.from(document.querySelectorAll("button"))
      .some((b) => /^\s*older\s*$/i.test(b.textContent || "") && !b.disabled);
  }

  function more() {
    const select = taxYearSelect();
    const years = select ? Array.from(select.options).filter((o) => !o.disabled && /tax\s*year\s*:?\s*\d{4}/i.test(o.textContent || "")).length : 0;
    const parts = [];
    if (years > 1) parts.push("other tax years under the Tax Year menu");
    if (older()) parts.push("older documents behind Older");
    return parts;
  }

  async function waitFor(test, ms) {
    const end = Date.now() + ms;
    while (!test()) {
      if (Date.now() >= end) return false;
      await sleep(150);
    }
    return true;
  }

  // The years the Tax Year menu offers under the wording PaperPull chooses
  // by, each with its own option. A year worded otherwise is not chosen.
  function yearOptions() {
    const select = taxYearSelect();
    if (!select) return [];
    return Array.from(select.options).filter((o) => !o.disabled)
      .map((option) => ({ option, m: YEAR_OPTION.exec(tidy(option.textContent)) }))
      .filter((x) => x.m).map((x) => ({ option: x.option, year: x.m[1] }));
  }

  // An Older whose nearest rows are tax forms alone pages the tax list, which
  // PaperPull never pages, and is never pressed.
  function taxOlder(button) {
    const all = rows();
    for (let n = button.parentElement; n; n = n.parentElement) {
      const inside = all.filter((r) => n.contains(r));
      if (inside.length) return inside.every((r) => r.querySelector(TRIGGER));
    }
    return false;
  }

  // Older, only when the page draws exactly one that reads as nothing else.
  function olderButton() {
    const found = Array.from(document.querySelectorAll("button"))
      .filter((b) => OLDER_TEXT.test(tidy(b.textContent)) && shown(b) && !taxOlder(b));
    if (!found.length) return { none: true };
    // The page can draw an Older for tax documents as well. The statements'
    // own is the one sharing the smallest section with the statements rows;
    // when two are as close, neither is pressed.
    let pick = found[0];
    if (found.length > 1) {
      // A statement row: a document link, and no tax form's files button.
      const first = rows().find((r) => r.querySelector("a[href]") && !r.querySelector("[data-testid='tax-forms-account-view-dialog-trigger']"));
      if (!first) return { why: "Wealthfront's page shows more than one Older." };
      const depth = (el) => { let d = 0; for (let n = el; n; n = n.parentElement) d += 1; return d; };
      const closeness = (b) => { let n = b; while (n && !n.contains(first)) n = n.parentElement; return n ? depth(n) : 0; };
      const ranked = found.map((b) => ({ b, c: closeness(b) })).sort((x, y) => y.c - x.c);
      if (ranked[0].c === ranked[1].c) return { why: "Wealthfront's page shows more than one Older." };
      pick = ranked[0].b;
    }
    const labels = [pick.getAttribute("aria-label"), pick.getAttribute("title")].map(tidy).filter(Boolean);
    if (labels.some((l) => !OLDER_LABEL.test(l))) return { why: "Wealthfront's Older does not read as one this will press." };
    if (turnedOff(pick)) return { none: true };
    return { button: pick };
  }

  // What the list shows now, so a press can be seen to have changed it.
  const rowsWord = () => rows().map((r) => `${tidy(r.innerText)}|${(r.querySelector("a[href]") || { getAttribute: () => "" }).getAttribute("href") || ""}`).join("\n");

  // Where the walk through tax years and Older has been, kept on the page
  // between askings, since this file is run afresh each time. `listed` holds
  // every id already handed over, so a list drawn again is not handed over twice.
  const walk = () => (globalThis.__wealthfrontWalk = globalThis.__wealthfrontWalk
    || { steps: null, wanted: [], yearsRead: new Set(), listed: new Set(), older: 0, notes: new Set() });

  const optionWords = (o) => tidy(o.textContent);
  function chosenWords(select) {
    const o = select && select.options[select.selectedIndex];
    return o ? optionWords(o) : "";
  }

  // Sets a filter menu to its one option that `test` passes, the way a
  // person's choice does, and waits for the list to be drawn again. A menu
  // the page does not draw is { absent }, one already there { already }, and
  // one offering no such option, or two, { missing }.
  async function chooseOption(selector, test, what) {
    const menus = document.querySelectorAll(selector);
    if (menus.length > 1) return { why: `Wealthfront's page shows two ${what} menus.` };
    const select = menus[0];
    if (!select) return { absent: true };
    if (test(chosenWords(select))) return { already: true };
    const hits = Array.from(select.options).filter((o) => !o.disabled && test(optionWords(o)));
    if (hits.length !== 1) return { missing: true };
    const before = rowsWord();
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, hits[0].value);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    if (!(await waitFor(() => test(chosenWords(document.querySelector(selector))), OPTION_WAIT_MS))) {
      return { why: `Wealthfront's ${what} menu did not change.` };
    }
    await waitFor(() => rowsWord() !== before, FILTER_WAIT_MS);
    return { moved: true };
  }

  const exactly = (words) => (t) => t.toLowerCase() === words.toLowerCase();

  // Whether a walk has filters to set even when the page shows no Older and
  // no other tax year: the document-type menu is always walked, and an
  // accounts menu that is not on All Accounts is put there.
  function filtersToSet() {
    if (document.querySelector(TYPE_MENU)) return true;
    const accounts = document.querySelector(ACCOUNT_MENU);
    return Boolean(accounts) && !ALL_ACCOUNTS.test(chosenWords(accounts));
  }

  // Chooses a year the way a person's choice does: the select's own value,
  // and the change event Wealthfront's page listens for.
  async function chooseYear(year) {
    const select = taxYearSelect();
    const hit = yearOptions().filter((y) => y.year === year);
    if (!select || hit.length !== 1) return { why: `Wealthfront's Tax Year menu no longer offers ${year} once.` };
    const old = new WeakSet(rows());
    const before = rowsWord();
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, hit[0].option.value);
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    if (!(await waitFor(() => shownTaxYear() === year, OPTION_WAIT_MS))) return { why: `Wealthfront did not change to tax year ${year}.` };
    // One year's forms can read just as another's, so a list that looks the
    // same is waited on and then read. A form's year is checked again on its
    // own link when it is saved.
    await waitFor(() => rows().some((r) => !old.has(r)) || rowsWord() !== before, YEAR_WAIT_MS);
    return { moved: true };
  }

  async function pressOlder(w) {
    const found = olderButton();
    if (found.why) return found;
    if (found.none) return null;
    if (w.older >= MAX_OLDER) return { why: `Wealthfront's list went on past ${MAX_OLDER} presses of Older.` };
    w.older += 1;
    const before = rowsWord();
    found.button.click();
    if (!(await waitFor(() => rowsWord() !== before, OLDER_WAIT_MS))) return { why: "Wealthfront's list did not change after Older was pressed." };
    return { moved: true };
  }

  // The walk's steps, in PaperPull's order (wealthfront_docs.py cmd_discover):
  // every tax year, then the statements. Before the statements, the accounts
  // menu goes to All Accounts and the date menu to its All option. Then the
  // document-type menu goes to Statements and Older is pressed until the list
  // ends, then the same for Quarterly Statements. A page with no
  // document-type menu has its list paged as it is shown.
  function plan() {
    const now = shownTaxYear();
    const offered = [...new Set(yearOptions().map((y) => y.year))];
    if (offered.length > MAX_YEARS) return { why: `Wealthfront's Tax Year menu offers more than ${MAX_YEARS} years.` };
    const steps = offered.filter((y) => y !== now).sort().reverse().map((year) => ({ year }));
    steps.push({ filter: "accounts" }, { filter: "dates" });
    if (document.querySelector(TYPE_MENU)) {
      for (const type of STATEMENT_TYPES) steps.push({ type }, { older: true });
    } else {
      steps.push({ older: true });
    }
    return { offered, steps };
  }

  // One step on. Steps with nothing to do (a menu already set, or an Older
  // that has ended) are passed in the same asking.
  async function nextView() {
    const w = walk();
    if (w.steps === null) {
      if (document.querySelectorAll("select[aria-label='tax year']").length > 1) return { why: "Wealthfront's page shows two Tax Year menus." };
      const planned = plan();
      if (planned.why) return planned;
      w.wanted = planned.offered;
      w.steps = planned.steps;
      const accounts = document.querySelector(ACCOUNT_MENU);
      trace(`Walk planned: tax years ${planned.offered.join(", ") || "none"}; ${planned.steps.length} step(s): ${planned.steps.map((s) => s.year || s.filter || s.type || "older").join(", ")}; accounts menu ${accounts ? `with ${accounts.options.length} option(s)` : "not drawn"}.`);
      const loose = taxYearSelect() ? Array.from(taxYearSelect().options).filter((o) => !o.disabled && /tax\s*year\s*:?\s*\d{4}/i.test(o.textContent || "") && !YEAR_OPTION.test(tidy(o.textContent))).length : 0;
      if (loose) w.notes.add("A tax year in Wealthfront's menu was worded in a way this does not choose by, and was passed over.");
    }
    while (w.steps.length) {
      const step = w.steps[0];
      if (step.year) {
        w.steps.shift();
        return chooseYear(step.year);
      }
      if (step.filter) {
        w.steps.shift();
        const accounts = step.filter === "accounts";
        const got = accounts ? await chooseOption(ACCOUNT_MENU, (t) => ALL_ACCOUNTS.test(t), "accounts")
          : await chooseOption(DATE_MENU, (t) => ALL_DATES.test(t), "date");
        trace(`Filter ${step.filter}: ${got.why || Object.keys(got).join(", ") || "nothing"}.`);
        if (got.why) return got;
        if (got.missing && accounts) w.notes.add("Wealthfront's accounts menu offers no All Accounts, so only the account it shows was read.");
        if (got.moved) return { moved: true };
        continue;
      }
      if (step.type) {
        w.steps.shift();
        const got = await chooseOption(TYPE_MENU, exactly(step.type), "document type");
        trace(`Document type ${step.type}: ${got.why || Object.keys(got).join(", ") || "nothing"}.`);
        if (got.why) return got;
        w.older = 0;
        // PaperPull passes over a type the menu does not offer. Without
        // Statements, the list is paged as it is shown instead.
        if (got.missing || got.absent) {
          if (step.type === STATEMENT_TYPES[0]) w.notes.add("Wealthfront's document-type menu offers no Statements, so its list was read as shown.");
          else w.steps.shift();
        }
        if (got.moved) return { moved: true };
        continue;
      }
      const older = await pressOlder(w);
      if (older) return older;
      w.steps.shift();
      w.older = 0;
    }
    const missed = w.wanted.filter((y) => !w.yearsRead.has(y));
    trace(`End of the walk: tax years read ${[...w.yearsRead].join(", ") || "none"}; ${w.listed.size} document(s) listed${missed.length ? `; never shown: ${missed.join(", ")}` : ""}.`);
    const notes = [...w.notes];
    delete globalThis.__wealthfrontWalk;
    if (missed.length) return { why: `Wealthfront's page never showed tax year ${missed.join(", ")}.` };
    return notes.length ? { moved: false, note: notes.join(" ") } : { moved: false };
  }

  function readDocs() {
    const docs = [];
    const seen = new Set();
    const stop = (why) => ({ why, docs });
    const taxYear = shownTaxYear();
    let passedOver = "";
    for (const row of rows()) {
      const parsed = parseRow(cellsOf(row));
      if (!parsed) continue;
      const name = summary(parsed.title);
      if (!name) continue;
      const title = parsed.account ? `${name} ${parsed.account}` : name;
      const link = row.querySelector("a[href]");
      const href = link ? link.getAttribute("href") : "";
      const url = href && !href.startsWith("#") ? documentUrl(href) : null;
      if (parsed.kind === "dated") {
        const date = rowDate(parsed.dateCell);
        if (!date) return stop("A document's date could not be read.");
        if (!url) return stop("A statement's link is not one of Wealthfront's document addresses.");
        const id = url.pathname + url.search;
        if (seen.has(id)) continue;
        seen.add(id);
        docs.push({ id, date, title, method: "fetch", url: url.href });
        continue;
      }
      if (!taxYear) return stop("A tax form is shown, and the Tax Year menu that dates it could not be read.");
      const date = `${taxYear}-12-31`;
      if (url) {
        const id = url.pathname + url.search;
        if (seen.has(id)) continue;
        seen.add(id);
        docs.push({ id, date, title, method: "fetch", url: url.href });
        continue;
      }
      if (!row.querySelector(TRIGGER)) { passedOver = "A tax form has no Download of the kind this knows, and was left out."; continue; }
      const id = `tax-${taxYear}-${parsed.account}-${parsed.title}`;
      if (seen.has(id)) continue;
      seen.add(id);
      docs.push({ id, date, title, method: "fetch", account: parsed.account, form: parsed.title, year: taxYear });
    }
    return passedOver ? { why: passedOver, passed: true, docs } : { docs };
  }

  async function readList({ walk: mayWalk = false } = {}) {
    if (!mayWalk) delete globalThis.__wealthfrontWalk;
    if (signedOut()) return { state: "signed_out" };
    await settled();
    if (signedOut()) return { state: "signed_out" };
    if (!rows().length) {
      const words = pageWords();
      if (EXPIRED_WORDS.some((w) => words.includes(w))) return { state: "signed_out" };
      if (CHECK_WORDS.some((w) => words.includes(w))) return { state: "challenge" };
      if (SLOW_WORDS.some((w) => words.includes(w))) return { state: "stopped", why: "Wealthfront says to try again later.", docs: [] };
    }
    const onDocs = DOC_PATHS.includes(location.pathname.replace(/\/$/, ""));
    // A year in the middle of a walk can show nothing at all.
    if (onDocs && !rows().length && mayWalk && globalThis.__wealthfrontWalk) {
      walk().yearsRead.add(shownTaxYear());
      return { state: "ok", docs: [], more: true };
    }
    if (!onDocs || !rows().length) return { state: "no_list" };
    const read = readDocs();
    const sorted = read.docs.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    trace(`${location.pathname}: ${rows().length} row(s), ${read.docs.length} document(s), tax year shown ${shownTaxYear() || "none"}${read.why ? `, why: ${read.why}` : ""}.`);
    if (mayWalk) {
      const parts = more();
      if (!parts.length && !filtersToSet() && !globalThis.__wealthfrontWalk) {
        return read.why ? { state: "stopped", why: read.why, docs: sorted } : { state: "ok", docs: sorted };
      }
      const w = walk();
      w.yearsRead.add(shownTaxYear());
      const docs = sorted.filter((d) => !w.listed.has(d.id));
      docs.forEach((d) => w.listed.add(d.id));
      if (read.why && !read.passed) {
        delete globalThis.__wealthfrontWalk;
        return { state: "stopped", why: read.why, docs };
      }
      // A form passed over in one year is said at the end, and the walk goes on.
      if (read.why) w.notes.add(read.why);
      return { state: "ok", docs, more: true };
    }
    const docs = sorted;
    if (read.why) return { state: "stopped", why: read.why, docs };
    const parts = more();
    if (parts.length) {
      return { state: "stopped", why: `Only what is on screen was read. There are ${parts.join(" and ")}. Open those on the page, then sweep again.`, docs };
    }
    return { state: "ok", docs };
  }

  function rowOf(doc) {
    return rows().filter((row) => {
      const text = row.innerText || "";
      return (!doc.account || text.includes(doc.account)) && text.includes(doc.form) && row.querySelector(TRIGGER);
    });
  }

  function closeDialog() {
    const button = document.querySelector(DISMISS);
    if (button) button.click();
  }

  // A tax row's Download opens a dialog holding the form's PDF link. A press
  // of that one control, the link read, the dialog closed.
  async function taxLink(doc) {
    if (shownTaxYear() !== doc.year) return { why: `The page is not showing tax year ${doc.year}.` };
    const hits = rowOf(doc);
    if (hits.length !== 1) return { why: "That tax form could not be found once on the page." };
    const trigger = hits[0].querySelector(TRIGGER);
    if (!CONTROL.test((trigger.textContent || "").trim())) return { why: "That form's control does not read as a download." };
    trigger.click();
    try {
      for (let i = 0; i < 25; i++) {
        await sleep(200);
        const dialog = document.querySelector(DIALOG);
        const hrefs = dialog ? Array.from(dialog.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")).filter((h) => h && !h.startsWith("#")) : [];
        if (hrefs.length) {
          const url = documentUrl(hrefs[0]);
          if (!url) return { why: "The form's link is not one of Wealthfront's document addresses." };
          // /documents/<id>/<year>/FORM_1099_PDF: a link naming another
          // year is another year's form, drawn before the menu's year was.
          const named = url.pathname.split("/")[3];
          if (/^(19|20)\d{2}$/.test(named) && named !== doc.year) return { why: `The form's link is for ${named}, not tax year ${doc.year}.` };
          return { url };
        }
      }
      return { why: "The form's dialog held no link." };
    } finally {
      closeDialog();
    }
  }

  async function fetchPdf(doc) {
    let url;
    if (doc && doc.url) {
      url = documentUrl(doc.url);
      if (!url) return { ok: false, why: "not a document address" };
    } else if (doc && doc.form && doc.year) {
      const found = await taxLink(doc);
      if (found.why) return { ok: false, why: found.why };
      url = found.url;
    } else {
      return { ok: false, why: "not a document" };
    }
    let response;
    try {
      response = await fetch(url.href, { credentials: "same-origin" });
    } catch (e) {
      return { ok: false, why: "The document could not be asked for." };
    }
    const final = new URL(response.url || url.href);
    if (final.origin !== location.origin || LOGIN_MARKERS.some((m) => final.pathname.toLowerCase().includes(m)) || response.status === 401 || response.status === 403) {
      return { ok: false, signedOut: true, why: "The site asked for a sign-in." };
    }
    if (!response.ok) return { ok: false, why: `The site sent ${response.status}.` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    return globalThis.__sweepPdf.pdfResult(bytes);
  }

  globalThis.__sweep = { readList, fetchPdf, nextView };
})();
