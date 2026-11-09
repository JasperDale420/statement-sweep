// Runs inside Wealthfront's own Documents page, where the sign-in already
// lives. Reads and downloads only. Its one press is a tax row's own Download,
// which opens the dialog holding that form's PDF link, and that dialog's close.
//
// Derived from PaperPull's apps/wealthfront/wealthfront_site.py (AGPL-3.0).
(() => {
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
  // /documents/87543673/document/DOCD-AA18 and
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
    return passedOver ? { why: passedOver, docs } : { docs };
  }

  async function readList() {
    if (signedOut()) return { state: "signed_out" };
    await settled();
    if (signedOut()) return { state: "signed_out" };
    if (!rows().length) {
      const words = pageWords();
      if (EXPIRED_WORDS.some((w) => words.includes(w))) return { state: "signed_out" };
      if (CHECK_WORDS.some((w) => words.includes(w))) return { state: "challenge" };
      if (SLOW_WORDS.some((w) => words.includes(w))) return { state: "stopped", why: "Wealthfront says to try again later.", docs: [] };
    }
    if (!DOC_PATHS.includes(location.pathname.replace(/\/$/, "")) || !rows().length) return { state: "no_list" };
    const read = readDocs();
    const docs = read.docs.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
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
          return url ? { url } : { why: "The form's link is not one of Wealthfront's document addresses." };
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

  globalThis.__sweep = { readList, fetchPdf };
})();
