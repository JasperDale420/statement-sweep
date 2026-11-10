// Runs inside Spectrum's own page, www.spectrum.net, an Angular app. It reads
// the Statements and Mobile statements pages, and presses only what
// PaperPull presses, each under PaperPull's own guard: a statement's own row
// on Statements, that statement's "View Printable Statement", Billing's
// "Mobile Account Number" link, a finished Mobile statement's own row, and
// that statement's "Expand All". Nothing is typed, filled or submitted.
//
// INTERNET ("current:YYYY-MM-DD", "prior:YYYY-MM-DD", method "newtab").
// "View Printable Statement" makes the page turn the PDF into a Blob and open
// it in a new tab, blob: of www.spectrum.net, which the engine reads. An
// older statement's page opened by its address prints the NEWEST statement
// (PaperPull's live run of 2026-10-12/13), so a statement is chosen the way a
// person does: its own row on Statements is pressed, an in-app move to its
// own page, /billing/bill-details?pdfStatementId=..., whose id must name that
// statement's date. The one press of View Printable Statement follows in the
// same call. PaperPull opens the newest by its address, with the id the
// page's own API answer gives it; that answer is the page's alone, so here
// the newest is chosen by its row too. A statement page this tab loaded by
// its address is pressed only for the newest.
//
// MOBILE ("mobile:YYYY-MM-DD", method "print"). The site has no PDF of a
// Mobile statement. As PaperPull does: Billing is opened by its address, its
// "Mobile Account Number" link pressed, the statement's own row pressed,
// Expand All pressed once, and the page printed once it reads Collapse All
// with every section open. Only finished statements are listed.
//
// The sweep's own tab walks Statements, then Billing and the Mobile list. A
// tab of yours is read where it is, Statements only.
//
// Derived from PaperPull's apps/spectrum/spectrum_site.py (AGPL-3.0).
(() => {
  const BASE = "https://www.spectrum.net";
  const HOST = "www.spectrum.net";
  const STATEMENTS = "/billing/statements";
  const DETAIL = "/billing/bill-details";
  const BILLING = "/billing";
  const MOBILE_LIST = "/billing/mobile-statements";
  const MOBILE_DETAIL = "/mobile-billing/statement-history";
  const ROW_CSS = "a.kite-list-item__action";
  const LINK_CSS = "a[role=link]";
  const BUTTON_CSS = "button, [role=button]";
  const LOGIN_MARKERS = ["/login", "/logout", "id.spectrum.net", "/signin", "/error/session-expired"];
  const IDLE = ["your session is about to expire", "session is about to time out", "are you still there",
    "your session has expired", "session timed out", "you have been signed out"];
  const OTP = ["one-time passcode", "one time passcode", "one-time code", "verification code", "enter the code", "we sent a code"];
  const CHALLENGE = ["are you a robot", "captcha", "access denied", "unusual activity"];
  const RATE_LIMIT = ["too many requests", "rate limit", "try again later", "temporarily unavailable", "http error 429"];
  const BENIGN = /this info is currently not available\. please try again later\./g;
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const MONTH_WORDS = MONTHS.join("|");
  const ROW = new RegExp(`^Statement (${MONTH_WORDS}) (\\d{1,2}), (\\d{4})\\b`);
  // A finished Mobile statement's row, whole, with at most one amount after it.
  const MOBILE_ROW = new RegExp(`^Statement (${MONTH_WORDS}) (\\d{1,2}), (\\d{4})(?: -?\\$[0-9,]+\\.\\d{2})?$`);
  // The Mobile statement under way has no year after its day.
  const UNFINISHED_ROW = new RegExp(`^Statement (${MONTH_WORDS}) \\d{1,2}(?!\\d|, \\d{4})`);
  const FULL_DATE = new RegExp(`^(${MONTH_WORDS}) (\\d{1,2}), (\\d{4})$`, "i");
  const MOBILE_LINK = /^mobile account number ?:? ?([0-9*#•xX. -]{0,40})$/;
  const ACCOUNT_TOKEN = /[0-9*#•xX]/;
  const INTERNET_LINK = /^internet account number\b/;
  const PRINTABLE = /^view printable statement$/;
  const EXPAND_ALL = /^expand all$/;
  const ID_TEXT = /^Account=([0-9]{4,32})\|StatementDate=(\d{4}-\d{2}-\d{2})\|StatementCode=([0-9]{1,6})\|(PDF|DIGITAL)_DOCUMENT$/;
  // PaperPull's blocklist, and paperpull_core's settings and sign-in guards.
  const FORBIDDEN = new RegExp("(\\bpay\\b|\\bpaying\\b|\\bpayments?\\b|\\bautopay\\b|\\bauto\\s*-?\\s*pay\\b|\\bpaperless\\b|\\benroll|"
    + "\\bsettings?\\b|\\bequipment\\b|\\bupgrades?\\b|\\badd\\b|\\bchang(e|es|ed|ing)\\b|\\bcancel|"
    + "\\bservices?\\b|\\bappointments?\\b|\\bchat\\b|\\bsign\\s*(out|off)\\b|\\blog\\s*(out|off)\\b|\\blogout\\b|"
    + "\\bone\\s*-?\\s*time\\b|\\bverify\\b|\\bcodes?\\b|\\bmobile\\b|\\border\\b|\\bshop\\b|\\bdeals?\\b|\\bcall\\b|"
    + "\\bsubmit\\b|\\bconfirm\\b|\\bcontinue\\b|\\bdelete\\b|\\bremove\\b|\\bupdate\\b|\\bedit\\b|\\bmanage\\b|"
    + "\\bpreferences?\\b|\\bprofile\\b|\\bagree\\b|\\baccept\\b|\\bauthori[sz]e\\b|\\bpassword\\b|\\busername\\b)", "i");
  const SETTINGS = new RegExp("\\bchang(e|es|ed|ing)\\b|\\bedit(s|ed|ing)?\\b|\\bupdat(e|es|ed|ing)\\b|"
    + "\\bremov(e|es|ed|ing|al)\\b|\\bdelet(e|es|ed|ing|ion)\\b|"
    + "^\\s*save\\s*$|\\bsave\\s+(changes?|settings?|preferences?|profile)\\b|"
    + "\\bsettings?\\b|\\bpreferences?\\b|\\bmanage\\b|"
    + "\\bset\\s+up\\b|\\benabl(e|es|ed|ing)\\b|\\bdisabl(e|es|ed|ing)\\b|"
    + "\\bturn\\s+(on|off)\\b|\\bopt\\s*(in|out)\\b|"
    + "\\bconsent\\b|\\bauthoriz(e|es|ed|ing|ation)\\b|"
    + "\\bcertif(y|ies|ied|ication)\\b|\\bbeneficiar(y|ies)\\b|"
    + "\\bwithholding\\b|\\bautopay\\b|\\bauto-pay\\b|"
    + "\\bappl(y|ies|ied|ication)\\b|\\bplace\\s+order\\b|\\brebalance\\b|"
    + "\\breallocate\\b|\\bliquidat(e|es|ed|ing|ion)\\b|"
    + "\\bbuy\\b|\\bsell\\b|\\bschedule\\s+(a\\s+)?(payment|transfer)\\b|"
    + "\\bclose\\s+(?!of\\b)(?:[\\w'-]+\\s+){0,3}?accounts?\\b(?!\\s+menu\\b)|"
    + "\\b(?:sign|log)[\\s_-]?(?:out|off)\\b", "i");
  const AUTH = new RegExp("log[\\s_-]?(in|on)|sign[\\s_-]?(in|on|up)|signin|logon|"
    + "authenticat|credential|register|enroll(ment)?\\b|"
    + "username|user[\\s_-]?id|password|passcode|remember\\s*me", "i");
  // Every Mobile statement seen live had six sections. Fewer is a page still drawing.
  const MIN_SECTIONS = 6;
  const STEADY_READS = 3;
  const WALK_KEY = "__sweepSpectrumWalk";
  const IDS_KEY = "__sweepSpectrumMobilePages";
  const WALK_AGE_MS = 30 * 60 * 1000;
  const ROWS_WAIT_MS = 10000;
  const LINKS_WAIT_MS = 20000;
  const LAND_WAIT_MS = 20000;
  const BUTTON_WAIT_MS = 30000;

  const SIGNED_OUT = "Spectrum signed you out. Sign in and run it again.";
  const CONFIRM = "Spectrum is asking you to confirm something. Finish it in its tab, then run it again.";
  const PAUSE = "Spectrum says to try again later.";

  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const log = (text) => { if (globalThis.__sweepLog) globalThis.__sweepLog(text); };
  const normal = (s) => tidy(s).toLowerCase();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const bodyText = (limit) => ((document.body && document.body.innerText) || "").slice(0, limit).toLowerCase();
  const stop = (why, listed = []) => ({ state: "stopped", why, docs: [], listed });
  const here = () => (location.hostname === HOST ? location.pathname.replace(/\/$/, "") || "/" : "");
  const refuses = (words) => FORBIDDEN.test(words) || SETTINGS.test(words) || AUTH.test(words);
  const newestFirst = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  const familyOf = (doc) => {
    const m = /^(current|prior|mobile):(\d{4}-\d{2}-\d{2})$/.exec((doc && doc.id) || "");
    return m && m[2] === doc.date ? m[1] : "";
  };

  async function waitFor(test, ms, every = 250) {
    const until = Date.now() + ms;
    for (;;) {
      const got = test();
      if (got) return got;
      if (Date.now() >= until) return null;
      await sleep(every);
    }
  }

  function calendarDay(year, monthName, day) {
    const month = MONTHS.findIndex((m) => m.toLowerCase() === String(monthName).toLowerCase());
    const d = new Date(Date.UTC(year, month, day));
    if (month < 0 || d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
    return d.toISOString().slice(0, 10);
  }

  function rowDay(text) {
    const m = ROW.exec(tidy(text));
    return m ? calendarDay(+m[3], m[1], +m[2]) : null;
  }

  function mobileRowDay(text) {
    const m = MOBILE_ROW.exec(tidy(text));
    return m ? calendarDay(+m[3], m[1], +m[2]) : null;
  }

  function fullDate(text) {
    const m = FULL_DATE.exec(tidy(text));
    return m ? calendarDay(+m[3], m[1], +m[2]) : null;
  }

  function signedOut() {
    const url = location.href.toLowerCase();
    if (LOGIN_MARKERS.some((m) => url.includes(m))) return true;
    if (document.querySelector("input[type='password']")) return true;
    const body = bodyText(4000);
    return IDLE.some((m) => body.includes(m));
  }

  function pageWord() {
    const body = bodyText(4000);
    if (OTP.some((m) => body.includes(m))) return "challenge";
    const hay = bodyText(2500).replace(/\s+/g, " ");
    if (CHALLENGE.some((m) => hay.includes(m))) return "challenge";
    const rest = hay.replace(BENIGN, " ");
    if (RATE_LIMIT.some((m) => rest.includes(m))) return "rate";
    return "";
  }

  // Why nothing may be pressed on this page, or "".
  function blocked() {
    if (signedOut()) return SIGNED_OUT;
    const word = pageWord();
    if (word === "challenge") return CONFIRM;
    if (word === "rate") return PAUSE;
    return "";
  }

  // Loads a page of Spectrum's in this tab a moment later, so the answer
  // reaches the sweep first.
  function leaveFor(path) {
    globalThis.__spectrumLeaving = true;
    setTimeout(() => location.assign(BASE + path), 100);
  }

  // ---- Addresses -------------------------------------------------------

  // The name and value pairs of a query, each value percent-decoded as
  // written, a "+" kept a "+". null for a part with no "=" or no name.
  function queryPairs(query) {
    const pairs = [];
    for (const part of (query || "").split("&")) {
      const at = part.indexOf("=");
      if (at < 1) return null;
      try { pairs.push([decodeURIComponent(part.slice(0, at)), decodeURIComponent(part.slice(at + 1))]); } catch (e) { return null; }
    }
    return pairs;
  }

  const onSite = (u) => u.protocol === "https:" && u.hostname === HOST && !u.port && !u.username && !u.password;

  // The query of an Internet statement's own page: exactly pdfStatementId,
  // isNextBill=false and isAccountTransfer true or false, each once.
  function detailQuery(address) {
    let u;
    try { u = new URL(address); } catch (e) { return null; }
    if (!onSite(u) || u.hash || u.pathname !== DETAIL) return null;
    const pairs = queryPairs(u.search.slice(1));
    if (!pairs || pairs.length !== 3) return null;
    const q = Object.fromEntries(pairs);
    if (Object.keys(q).sort().join() !== "isAccountTransfer,isNextBill,pdfStatementId") return null;
    // The newest statement opens with isNextBill=true (live: the October row,
    // with its Payment Due note); the older ones with false. Its date, in its
    // statement id, still has to be the row's.
    if (!["true", "false"].includes(q.isNextBill) || !["true", "false"].includes(q.isAccountTransfer)) return null;
    return q;
  }

  // The date a statement id names, in the list's PDF spelling or the page's
  // digital one, padded or not, or null.
  function idDate(id) {
    let raw = String(id || "");
    raw += "=".repeat((4 - (raw.length % 4)) % 4);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
    let text;
    try { text = atob(raw); } catch (e) { return null; }
    const m = ID_TEXT.exec(text);
    if (!m) return null;
    const [y, mo, d] = m[2].split("-").map(Number);
    return calendarDay(y, MONTHS[mo - 1] || "", d) === m[2] ? m[2] : null;
  }

  // Whether this tab shows the statement's own page: its id names that date,
  // and isAccountTransfer is true only for an earlier account's statement.
  function landsOn(doc) {
    const q = detailQuery(location.href);
    if (!q) return false;
    // A prior account's row always opens as a transfer. A current row can too:
    // live, Nov 2025–Jan 2026 sit in the current list but open under the
    // earlier account number. Its date is what makes it this statement.
    const transfer = q.isAccountTransfer === "true";
    // Two rows of one date (live: Feb 2026, the month of a move, one bill from
    // each account) are told apart only by this: the earlier account's opens
    // as a transfer, the new one's does not.
    if (doc.twin) {
      if (transfer !== (familyOf(doc) === "prior")) return false;
    } else if (familyOf(doc) === "prior" ? !transfer : !(transfer || q.isAccountTransfer === "false")) return false;
    return idDate(q.pdfStatementId) === doc.date;
  }

  // The path this document was loaded at, which an in-app move does not change.
  function loadedAt() {
    try {
      const entry = performance.getEntriesByType("navigation")[0];
      return new URL(entry.name).pathname.replace(/\/$/, "");
    } catch (e) { return ""; }
  }

  function voidHref(href) {
    if (href == null) return true;
    const h = String(href).trim();
    // Angular's sanitizer writes a do-nothing link as "unsafe:javascript:void(0);".
    return !h || /^(unsafe:)?javascript:void\(0\);?$/i.test(h);
  }

  const addressWords = (part) => part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").trim();

  // Whether a statement row's own href may stand behind its press: it leads
  // nowhere, or to a www.spectrum.net address with no refused word in it.
  function safeHref(href) {
    if (voidHref(href)) return true;
    let h = String(href).trim();
    if (/[\\#]/.test(h) || /[\s\x00-\x1f\x7f]/.test(h)) return false;
    if (h.startsWith("/") && !h.startsWith("//")) h = BASE + h;
    if (!/^https:\/\/www\.spectrum\.net(?=[/?]|$)/i.test(h)) return false;
    let u;
    try { u = new URL(h); } catch (e) { return false; }
    if (!onSite(u)) return false;
    const pairs = u.search ? queryPairs(u.search.slice(1)) : [];
    if (!pairs) return false;
    let path;
    try { path = decodeURIComponent(u.pathname); } catch (e) { return false; }
    const words = [addressWords(path), ...pairs.map(([k]) => addressWords(k)), ...pairs.map(([, v]) => v)];
    return !words.some(refuses);
  }

  // The family a row's own address names: an earlier account's statement
  // only when it says isAccountTransfer=true.
  function rowFamily(el) {
    const href = el.getAttribute("href");
    if (voidHref(href)) return "current";
    const h = String(href).trim();
    const q = detailQuery(h.startsWith("/") && !h.startsWith("//") ? BASE + h : h);
    return q && q.isAccountTransfer === "true" ? "prior" : "current";
  }

  // ---- The walk, kept in this tab's session storage --------------------

  function loadWalk() {
    try {
      const w = JSON.parse(sessionStorage.getItem(WALK_KEY) || "null");
      return w && typeof w.at === "string" && typeof w.t === "number" && Date.now() - w.t < WALK_AGE_MS ? w : null;
    } catch (e) { return null; }
  }
  const saveWalk = (at) => { try { sessionStorage.setItem(WALK_KEY, JSON.stringify({ at, t: Date.now() })); } catch (e) { /* not kept */ } };
  const dropWalk = () => { try { sessionStorage.removeItem(WALK_KEY); } catch (e) { /* not there */ } };

  // ---- Internet --------------------------------------------------------

  // The rows reading "Statement ...", as {el, text, day}, or null for one
  // whose date this cannot read.
  function statementRows() {
    const rows = [];
    for (const el of document.querySelectorAll(ROW_CSS)) {
      const text = tidy(el.innerText);
      if (!/^statement\b/i.test(text)) continue;
      const day = rowDay(text);
      if (!day) return null;
      rows.push({ el, text, day });
    }
    return rows;
  }

  // The rows once they have drawn and held still, [] when none drew.
  async function steadyRows() {
    let last = -1, still = 0;
    const until = Date.now() + ROWS_WAIT_MS;
    for (;;) {
      const rows = statementRows();
      if (!rows) return null;
      still = rows.length === last ? still + 1 : 0;
      last = rows.length;
      if (rows.length && still >= STEADY_READS - 1) return rows;
      if (Date.now() >= until || signedOut()) return rows;
      await sleep(250);
    }
  }

  // The newest statement's row also says when it is due: "… Payment Due: Nov
  // 12 $80.00". Only that exact ending is set aside before the refused words
  // are looked for; anything else about paying still refuses the row.
  // (normal() has lowercased the label, hence /i.)
  const DUE_NOTE = /\s*payment due:?\s*[a-z]{3,9}\.?\s+\d{1,2}(?:,\s*\d{4})?\s+\$\d{1,3}(?:,\d{3})*\.\d{2}\s*$/i;
  const safeRow = (text, day) => {
    const label = normal(text).replace(DUE_NOTE, "");
    return Boolean(label) && !refuses(label) && rowDay(text) === day;
  };

  async function readInternet(mayWalk) {
    if (mayWalk) saveWalk("internet");
    const rows = await steadyRows();
    if (signedOut()) return { state: "signed_out" };
    if (!rows) return stop("A statement row has no date this can read.");
    if (!rows.length) return stop("The Statements page shows no statements.");
    const count = new Map();
    for (const r of rows) count.set(r.day, (count.get(r.day) || 0) + 1);
    const docs = [];
    let twice = 0, refused = 0;
    const paired = new Set();
    for (const r of rows) {
      const n = count.get(r.day);
      if (!safeRow(r.text, r.day) || !safeHref(r.el.getAttribute("href"))) { refused += 1; continue; }
      // A pair of one date is one statement from each account, told apart
      // once open (landsOn). Three or more are left.
      if (n === 2) {
        if (paired.has(r.day)) continue;
        paired.add(r.day);
        const pair = rows.filter((o) => o.day === r.day);
        if (!pair.every((o) => safeRow(o.text, o.day) && safeHref(o.el.getAttribute("href")))) { twice += 2; continue; }
        for (const family of ["current", "prior"]) docs.push({ id: `${family}:${r.day}`, date: r.day, title: "Internet Statement", method: "newtab", twin: true });
        continue;
      }
      if (n > 1) { twice += 1; continue; }
      const family = rowFamily(r.el);
      docs.push({ id: `${family}:${r.day}`, date: r.day, title: "Internet Statement", method: "newtab" });
    }
    docs.sort(newestFirst);
    const top = docs.find((d) => d.id.startsWith("current:") && !d.twin);
    if (top) top.newest = true;
    const notes = [];
    if (twice) notes.push(`${twice} statements share a date with another, so nothing tells them apart. Save those from Spectrum yourself.`);
    if (refused) notes.push(`${refused} statement row(s) did not read as only a statement, so they were not pressed. Save those from Spectrum yourself.`);
    if (!mayWalk) notes.push("Mobile statements are read only in a tab this opens itself.");
    return { state: "ok", docs, ...(notes.length ? { note: notes.join(" ") } : {}), ...(mayWalk ? { more: true } : {}) };
  }

  const ownButtons = (rx) => Array.from(document.querySelectorAll(BUTTON_CSS)).filter((b) => rx.test(normal(b.innerText)));
  const turnedOff = (b) => b.disabled || b.getAttribute("aria-disabled") === "true";

  // Presses the statement page's one View Printable Statement, once.
  async function pressPrintable(doc) {
    const found = await waitFor(() => blocked() || !landsOn(doc) || ownButtons(PRINTABLE).length > 0, BUTTON_WAIT_MS);
    const why = blocked();
    if (why) return { ok: false, why };
    if (!landsOn(doc)) return { ok: false, why: "Spectrum moved off the statement's page before it could be saved." };
    if (!found) return { ok: false, why: "Spectrum's statement page did not show View Printable Statement." };
    await sleep(300);
    const buttons = ownButtons(PRINTABLE);
    if (buttons.length !== 1) return { ok: false, why: "Spectrum's statement page did not show one View Printable Statement, so nothing was pressed." };
    const [button] = buttons;
    const label = normal(button.innerText);
    if (refuses(label) || !PRINTABLE.test(label)) return { ok: false, why: "View Printable Statement did not read as expected, so nothing was pressed." };
    if (turnedOff(button)) return { ok: false, why: "Spectrum kept View Printable Statement turned off. This one is tried again next time." };
    button.click();
    return { ok: true };
  }

  async function clickDoc(doc) {
    const family = familyOf(doc);
    if (family !== "current" && family !== "prior") return { ok: false, why: "not a document this listed" };
    let why = blocked();
    if (why) return { ok: false, why };
    if (here() === DETAIL) {
      // Loaded by its address, a statement's page may print the newest
      // statement in place of its own: only the newest is pressed there.
      if (loadedAt() === DETAIL) {
        if (doc.newest && landsOn(doc)) return pressPrintable(doc);
        leaveFor(STATEMENTS);
        return { ok: false, why: "Spectrum's statement page had been opened by its address, so it went back to Statements. This one is tried again next time." };
      }
      // Reached in the app: back to Statements the same way.
      history.back();
      if (!(await waitFor(() => here() === STATEMENTS, LAND_WAIT_MS))) return { ok: false, why: "Spectrum did not go back to its Statements page." };
    }
    if (here() !== STATEMENTS) return { ok: false, why: "Spectrum's Statements page was not open." };
    const rows = await steadyRows();
    why = blocked();
    if (why) return { ok: false, why };
    if (!rows) return { ok: false, why: "A statement row has no date this can read." };
    const mine = rows.filter((r) => r.day === doc.date);
    if (doc.twin) return pressTwin(doc, mine.length);
    if (mine.length > 1) return { ok: false, why: "Two statements carry this date, so neither was pressed. Save it from Spectrum yourself." };
    if (!mine.length) return { ok: false, why: "Its row is no longer on Spectrum's Statements page." };
    const [row] = mine;
    if (!safeRow(row.text, doc.date) || !safeHref(row.el.getAttribute("href"))) return { ok: false, why: "Its row did not read as only a statement, so it was not pressed." };
    if (rowFamily(row.el) !== family) return { ok: false, why: "Its row now names another account, so it was not pressed." };
    row.el.click();
    const moved = await waitFor(() => blocked() || here() !== STATEMENTS, LAND_WAIT_MS);
    why = blocked();
    if (why) return { ok: false, why };
    if (!moved) return { ok: false, why: "Pressing its row did not open its statement." };
    if (!landsOn(doc)) {
      const q = detailQuery(location.href);
      if (q && family === "current" && q.isAccountTransfer === "true" && idDate(q.pdfStatementId) === doc.date) {
        return { ok: false, why: "This statement is from an earlier Spectrum account, which its row does not say. Save it from Spectrum yourself." };
      }
      return { ok: false, why: "Pressing its row opened a page that is not that statement's, so nothing more was pressed." };
    }
    return pressPrintable(doc);
  }

  // One of a pair of rows of one date: each is pressed in turn until the one
  // that opens as this account's statement (landsOn), going back between.
  async function pressTwin(doc, rowCount) {
    if (rowCount !== 2) return { ok: false, why: "Spectrum no longer shows two statements of this date, so neither was pressed." };
    const seenFlags = [];
    for (let i = 0; i < 2; i += 1) {
      if (i) {
        history.back();
        if (!(await waitFor(() => here() === STATEMENTS, LAND_WAIT_MS))) return { ok: false, why: "Spectrum did not go back to its Statements page." };
      }
      const rows = await steadyRows();
      let why = blocked();
      if (why) return { ok: false, why };
      const mine = (rows || []).filter((r) => r.day === doc.date);
      if (mine.length !== 2) return { ok: false, why: "Spectrum no longer shows two statements of this date, so neither was pressed." };
      const row = mine[i];
      if (!safeRow(row.text, doc.date) || !safeHref(row.el.getAttribute("href"))) return { ok: false, why: "Its row did not read as only a statement, so it was not pressed." };
      row.el.click();
      const moved = await waitFor(() => blocked() || here() !== STATEMENTS, LAND_WAIT_MS);
      why = blocked();
      if (why) return { ok: false, why };
      if (!moved) return { ok: false, why: "Pressing its row did not open its statement." };
      if (landsOn(doc)) return pressPrintable(doc);
      const q = detailQuery(location.href);
      seenFlags.push(q ? `transfer=${q.isAccountTransfer}` : "another page");
    }
    log(`Spectrum ${doc.date}: neither of its two rows opened as the ${familyOf(doc)} account's (${seenFlags.join(", ")}).`);
    return { ok: false, why: "Neither of the two statements of this date opened as this account's, so nothing more was pressed. Save it from Spectrum yourself." };
  }

  // ---- Mobile ----------------------------------------------------------

  const linkTexts = () => Array.from(document.querySelectorAll(LINK_CSS)).map((a) => tidy(a.innerText));

  function mobileAccountNumber(label) {
    const m = MOBILE_LINK.exec(normal(label));
    return m && ACCOUNT_TOKEN.test(m[1]) ? m[1].trim() : null;
  }
  const isMobileLink = (label) => mobileAccountNumber(label) !== null && !SETTINGS.test(normal(label)) && !AUTH.test(normal(label));

  // Billing's account links once they hold still: {texts, mobile: [indexes], internet}.
  async function billingLinks() {
    let last = "", still = 0;
    const until = Date.now() + LINKS_WAIT_MS;
    for (;;) {
      const texts = linkTexts();
      const mobile = texts.map((t, i) => (mobileAccountNumber(t) !== null ? i : -1)).filter((i) => i >= 0);
      const internet = texts.some((t) => INTERNET_LINK.test(normal(t)));
      const now = JSON.stringify([mobile, internet]);
      still = now === last ? still + 1 : 0;
      last = now;
      if ((mobile.length || internet) && still >= STEADY_READS) return { texts, mobile, internet };
      if (Date.now() >= until || signedOut()) return null;
      await sleep(500);
    }
  }

  // Presses Billing's one Mobile Account Number link. Answers {why} when it
  // may not, {none: true} when Billing has no Mobile account, else {}.
  async function pressMobileLink() {
    const links = await billingLinks();
    const why = blocked();
    if (why) return { why };
    if (!links) return { why: "Spectrum's Billing page did not finish showing its account links." };
    const { texts, mobile, internet } = links;
    if (texts.some((t) => normal(t).startsWith("mobile account number") && mobileAccountNumber(t) === null)) {
      return { why: "Spectrum's Billing page shows a Mobile account link this does not know." };
    }
    if (!mobile.length) return internet ? { none: true } : { why: "Spectrum's Billing page did not show its statement links." };
    if (mobile.length !== 1) return { why: "Spectrum's Billing page shows more than one Mobile account, which this cannot tell apart." };
    const link = document.querySelectorAll(LINK_CSS)[mobile[0]];
    if (!link || tidy(link.innerText) !== texts[mobile[0]] || !isMobileLink(link.innerText)) return { why: "Spectrum's Mobile Account Number link did not read as expected, so it was not pressed." };
    if (!voidHref(link.getAttribute("href"))) return { why: "Spectrum's Mobile Account Number link leads somewhere of its own, so it was not pressed." };
    link.click();
    return {};
  }

  // The dates of the finished Mobile statements, in the list's order, or
  // {why} for a row of a shape not seen or two rows of one date.
  function mobileDays(texts) {
    const days = [];
    for (const t of texts) {
      if (!t.startsWith("Statement")) continue;
      const day = mobileRowDay(t);
      if (day) {
        if (days.includes(day)) return { why: "Two Mobile statements carry one date, so nothing tells them apart." };
        days.push(day);
      } else if (!UNFINISHED_ROW.test(t)) {
        return { why: "A Mobile statement row has a shape this does not know." };
      }
    }
    return { days };
  }

  // The Mobile list's rows once they have drawn and held still, or null.
  async function steadyMobileRows() {
    let last = -1, still = 0;
    const until = Date.now() + LAND_WAIT_MS;
    for (;;) {
      if (here() === MOBILE_LIST) {
        const n = linkTexts().filter((t) => t.startsWith("Statement")).length;
        still = n === last ? still + 1 : 0;
        last = n;
        if (n > 0 && still >= STEADY_READS) return linkTexts();
      }
      if (Date.now() >= until || signedOut()) return null;
      await sleep(500);
    }
  }

  async function onBilling() {
    const pressedAt = globalThis.__spectrumMobilePressed || 0;
    if (pressedAt) {
      if (Date.now() - pressedAt < LINKS_WAIT_MS) return { state: "walking" };
      return stop("Spectrum's Mobile Account Number link did not open the Mobile statements.");
    }
    const got = await pressMobileLink();
    if (got.why === SIGNED_OUT) return { state: "signed_out" };
    if (got.why === CONFIRM) return { state: "challenge" };
    if (got.why) return stop(got.why);
    if (got.none) {
      dropWalk();
      return { state: "ok", docs: [] };
    }
    globalThis.__spectrumMobilePressed = Date.now();
    return { state: "walking" };
  }

  async function readMobile() {
    const texts = await steadyMobileRows();
    if (signedOut()) return { state: "signed_out" };
    if (!texts) return stop("Spectrum's Mobile statements did not finish showing.");
    const { days, why } = mobileDays(texts);
    if (why) return stop(why);
    dropWalk();
    const docs = days.map((d) => ({ id: `mobile:${d}`, date: d, title: "Mobile Statement", method: "print" }));
    docs.sort(newestFirst);
    return { state: "ok", docs };
  }

  async function showDoc(doc) {
    if (familyOf(doc) !== "mobile") return { ok: false, why: "not a document this listed" };
    let why = blocked();
    if (why) return { ok: false, why };
    if (here() !== BILLING && here() !== MOBILE_LIST) {
      leaveFor(BILLING);
      return { ok: false, why: "Spectrum's tab was not on its Mobile statements, so it went back to Billing. This one is tried again next time." };
    }
    if (here() === BILLING) {
      const got = await pressMobileLink();
      if (got.why) return { ok: false, why: got.why };
      if (got.none) return { ok: false, why: "Spectrum's Billing page no longer shows a Mobile account." };
    }
    const texts = await steadyMobileRows();
    why = blocked();
    if (why) return { ok: false, why };
    if (!texts) return { ok: false, why: "Spectrum's Mobile statements did not finish showing." };
    const read = mobileDays(texts);
    if (read.why) return { ok: false, why: read.why };
    const mine = Array.from(document.querySelectorAll(LINK_CSS)).filter((a) => mobileRowDay(a.innerText) === doc.date);
    if (mine.length !== 1) return { ok: false, why: "Its row is no longer on Spectrum's Mobile statements." };
    const [row] = mine;
    const label = normal(row.innerText);
    if (!label || refuses(label) || mobileRowDay(row.innerText) !== doc.date) return { ok: false, why: "Its row did not read as only a statement, so it was not pressed." };
    if (!voidHref(row.getAttribute("href"))) return { ok: false, why: "Its row leads somewhere of its own, so it was not pressed." };
    row.click();
    await waitFor(() => here() !== MOBILE_LIST, LAND_WAIT_MS);
    return { ok: true };
  }

  // The query of a Mobile statement's own page: a statementId, with at most
  // newStatementVersion beside it, each once.
  function mobileQuery() {
    let u;
    try { u = new URL(location.href); } catch (e) { return null; }
    if (!onSite(u) || u.hash || u.pathname !== MOBILE_DETAIL) return null;
    const pairs = queryPairs(u.search.slice(1));
    if (!pairs) return null;
    const keys = pairs.map(([k]) => k);
    if (new Set(keys).size !== keys.length || !keys.includes("statementId")) return null;
    if (!keys.every((k) => k === "statementId" || k === "newStatementVersion")) return null;
    const q = Object.fromEntries(pairs);
    return q.statementId ? q : null;
  }

  // What the statement page draws: the drawn texts that are a whole date,
  // whether one reads "Statement Details", and whether "Mobile" sits beside a date.
  function detailState() {
    const full = new RegExp(`^(${MONTH_WORDS})\\s+\\d{1,2},\\s+\\d{4}$`, "i");
    const drawn = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const out = { dates: [], details: false, mobile: false };
    for (const el of document.querySelectorAll("body *")) {
      const raw = el.textContent || "";
      if (!raw.trim() || raw.length > 120 || !drawn(el)) continue;
      const t = tidy(el.innerText);
      if (t === "Statement Details") out.details = true;
      if (!full.test(t)) continue;
      if (!out.dates.includes(t)) out.dates.push(t);
      let a = el;
      for (let i = 0; i < 5 && a; i++, a = a.parentElement) {
        if ((a.innerText || "").split("\n").some((line) => tidy(line) === "Mobile")) { out.mobile = true; break; }
      }
    }
    return out;
  }

  // "" when the page reads Statement Details, the statement's date with
  // Mobile beside it, and, with `only`, no other date.
  function headingSays(state, day, only) {
    const days = state.dates.map(fullDate);
    if (!state.details) return "Its page does not read Statement Details.";
    if (!days.includes(day)) return "Its page does not show the statement's date.";
    if (only && days.some((d) => d !== day)) return "Its page shows another date beside the statement's.";
    if (!state.mobile) return "Its page does not say Mobile beside its date.";
    return "";
  }

  // The statement's section buttons and its one Expand All / Collapse All.
  function sections() {
    const all = Array.from(document.querySelectorAll("button"));
    const toggles = all.map((b) => tidy(b.innerText)).filter((t) => /^(expand|collapse) all$/i.test(t));
    const rows = all.filter((b) => /^accord-\d+-button-0$/.test(b.id || "") && b.classList.contains("kite-accordion-row__button"));
    return {
      toggles: toggles.length,
      toggle: toggles.length === 1 ? toggles[0].split(" ")[0].toLowerCase() : "",
      sections: rows.length,
      open: rows.filter((b) => b.getAttribute("aria-expanded") === "true").length,
    };
  }

  const allOpen = (s, before) => s.toggles === 1 && s.toggle === "collapse" && s.sections >= MIN_SECTIONS
    && (!before || s.sections === before) && s.open === s.sections;

  // The sections once STEADY_READS reads in a row show every one open and the same.
  async function steadyOpen(before, polls) {
    let last = "", run = 0;
    for (let i = 0; i < polls; i++) {
      if (i) await sleep(500);
      const s = sections();
      const now = JSON.stringify(s);
      if (allOpen(s, before)) {
        run = now === last ? run + 1 : 1;
        if (run >= STEADY_READS) return s;
      } else {
        run = 0;
      }
      last = now;
    }
    return null;
  }

  async function pageKey(id) {
    try {
      const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)));
      return Array.from(bytes.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
    } catch (e) { return ""; }
  }

  // Whether this statement page is one another date's row already opened.
  // Only a digest of the page's id is kept, in this tab's session storage.
  async function anotherDatesPage(id, day) {
    const key = await pageKey(id);
    if (!key) return false;
    let seen = {};
    try { seen = JSON.parse(sessionStorage.getItem(IDS_KEY) || "{}") || {}; } catch (e) { seen = {}; }
    if (seen[key] && seen[key] !== day) return true;
    seen[key] = day;
    try { sessionStorage.setItem(IDS_KEY, JSON.stringify(seen)); } catch (e) { /* not kept */ }
    return false;
  }

  async function printReady(doc) {
    if (familyOf(doc) !== "mobile") return { ok: false, why: "not a document this listed" };
    const why = blocked();
    if (why) return { ok: false, why };
    const q = mobileQuery();
    if (!q) return { ready: false, why: "Its statement page did not open." };
    const state = detailState();
    if (!state.dates.length || !state.details) return { ready: false, why: "Its statement page did not finish showing." };
    const where = location.href;
    const key = `${doc.id}|${where}`;
    const done = globalThis.__spectrumExpanded && globalThis.__spectrumExpanded.key === key ? globalThis.__spectrumExpanded : null;
    const said = headingSays(state, doc.date, !done);
    if (said) return { ok: false, why: said };
    if (await anotherDatesPage(q.statementId, doc.date)) return { ok: false, why: "Its row opened the page another date's row opened, so it was not saved." };
    if (done) {
      const held = await steadyOpen(done.before, 10);
      return held ? { ready: true } : { ready: false, why: "Not every section of its statement opened." };
    }
    const s = sections();
    if (s.toggle === "collapse") {
      const held = await steadyOpen(0, 10);
      return held ? { ready: true } : { ready: false, why: "Not every section of its statement opened." };
    }
    if (s.toggles !== 1 || s.toggle !== "expand" || s.sections < MIN_SECTIONS) return { ready: false, why: "Its statement's sections did not finish showing." };
    const buttons = ownButtons(EXPAND_ALL);
    if (buttons.length !== 1) return { ok: false, why: "Its statement page did not show one Expand All, so nothing was pressed." };
    const [button] = buttons;
    const label = normal(button.innerText);
    if (!EXPAND_ALL.test(label) || refuses(label)) return { ok: false, why: "Expand All did not read as expected, so nothing was pressed." };
    if (turnedOff(button)) return { ready: false, why: "Spectrum kept Expand All turned off." };
    globalThis.__spectrumExpanded = { key, before: s.sections };
    button.click();
    const held = await steadyOpen(s.sections, 14);
    if (!held) return { ready: false, why: "Not every section of its statement opened." };
    if (location.href !== where) return { ok: false, why: "Its statement page moved while its sections opened." };
    const after = headingSays(detailState(), doc.date, false);
    if (after) return { ok: false, why: after };
    return { ready: true };
  }

  // Back to Billing by its address, as PaperPull opens it for each Mobile statement.
  function leaveDoc(doc) {
    if (familyOf(doc) !== "mobile") return { ok: true, stayed: true };
    leaveFor(BILLING);
    return { ok: true };
  }

  // ---- The list --------------------------------------------------------

  async function readList({ walk: mayWalk = false } = {}) {
    if (!mayWalk) dropWalk();
    if (globalThis.__spectrumLeaving) return { state: "walking" };
    if (signedOut()) return { state: "signed_out" };
    const word = pageWord();
    if (word === "challenge") return { state: "challenge" };
    if (word === "rate") return stop(PAUSE);
    const path = here();
    if (path === STATEMENTS) return readInternet(mayWalk);
    const walk = mayWalk ? loadWalk() : null;
    if (walk && walk.at === "mobile") {
      if (path === BILLING) return onBilling();
      if (path === MOBILE_LIST) return readMobile();
    }
    return { state: "no_list" };
  }

  // From Statements to Billing, whose Mobile link the next read presses.
  function nextView() {
    const walk = loadWalk();
    if (!walk || walk.at !== "internet") { dropWalk(); return { moved: false }; }
    saveWalk("mobile");
    leaveFor(BILLING);
    return { moved: true };
  }

  globalThis.__sweep = { readList, nextView, clickDoc, showDoc, printReady, leaveDoc };
})();
