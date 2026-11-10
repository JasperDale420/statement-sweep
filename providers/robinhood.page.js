// Runs inside Robinhood's own page, where the sign-in already lives. It reads
// the statements and tax documents pages and presses a document's own
// download control, and in a tab the sweep opened also View More and the
// next of those pages, and nothing else. This is an account that can trade,
// so a control must read as a download and match nothing on the blocklist.
//
// The pages, in the order a walk takes them: the individual investing
// account's statements, the retirement account's, Robinhood Crypto's, and the
// tax documents. Each statement's own title names its month and its account,
// so a page that shows another account's list (the retirement address of an
// account with no IRA shows the individual one) only lists titles already
// listed. A tax form whose title names no year is dated by the tax year the
// page names beside it, and one with none is left and said.
//
// Since August or September 2026 a statement's control is an <a href="#">
// whose click asks api.robinhood.com for a signed link on
// mountain-storage.s3.amazonaws.com and opens that link in a NEW TAB
// (PaperPull's apps/robinhood/robinhood_site.py, the note above
// _click_and_capture). No download starts. So each document is "newtab": the
// engine (capture.js) takes the tab the press opens, fetches the PDF from
// that one bucket host (the meta's fileHosts), and closes the tab.
// Months offered only as "Download HTML" need printing, and are said.
//
// Derived from PaperPull's apps/robinhood/robinhood_site.py (AGPL-3.0).
(() => {
  const BASE = "https://robinhood.com";
  const PAGES = ["/account/reports-statements/individual", "/account/reports-statements/retirement",
    "/account/reports-statements/crypto", "/account/reports-statements/tax"];
  const RETIREMENT_PAGE = PAGES[1];
  const TAX_PAGE = PAGES[3];
  const LOGIN = ["/login", "/signin", "/sign-in", "/auth", "/mfa", "/verification", "/challenge"];
  const CHALLENGE = ["enter the code", "verification code", "6-digit", "two-factor", "two-step", "authenticator",
    "confirm your identity", "verify your identity", "we sent a code", "device approval", "approve this login",
    "unusual", "are you a robot", "captcha", "let's verify", "check your email", "check your phone",
    "your session has expired", "log back in"];
  const RATE_LIMIT = ["too many requests", "rate limit", "try again later", "temporarily unavailable",
    "http error 429", "unusual traffic"];
  const CONTROLS = "a[download], a, button, [role=button]";
  const TITLE = /([A-Z][a-z]+ \d{4}[^\n]*Statement|[^\n]*Consolidated[^\n]*1099[^\n]*|[^\n]*Form 1099[^\n]*|[^\n]*\b1099\b[^\n]*|[^\n]*\b1042-?S\b[^\n]*|[^\n]*\b5498\b[^\n]*)/;
  const TAX_TITLE = /\b(1099|1042-?S|5498)\b/i;
  const ANY_YEAR = /\b(19|20)\d{2}\b/;
  const MORE = /^\s*(show|load|view|see)\s+more\s*$|^\s*view\s+all\s*$|^\s*older\s*$/i;
  const WAIT_MS = 12000;
  const WALK_WAIT_MS = 20000;
  const MORE_WAIT_MS = 8000;
  const MAX_MORE = 60;
  const WALK_KEY = "__sweepRobinhoodWalk";
  const WALK_AGE_MS = 30 * 60 * 1000;
  const FORBIDDEN = new RegExp("(buy\\b|sell\\b|trade\\b|place\\s+order|review\\s+order|submit\\s+order|"
    + "cancel\\s+order|market\\s+order|limit\\s+order|stop\\s+order|transfer|withdraw|deposit|wire\\b|move\\s+money|send\\b|receive\\b|"
    + "convert|swap\\b|exchange\\b|stake\\b|unstake\\b|earn\\b|lend\\b|exercise|close\\s+position|sell\\s+all|liquidate|"
    + "options?\\b|margin\\b|borrow\\b|gold\\b|subscribe|apply|open\\s+\\w*\\s*account|fund\\b|add\\s+money|link\\s+(bank|account)|"
    + "enable|disable|activate|\\bchange\\s+|\\bedit\\s+|\\bupdate\\s+|set\\s+up|delete|remove|close\\s+account|beneficiar|password|"
    + "generate\\s+report|create\\s+report|generate\\b|confirm|continue|next\\b|agree|accept|authorize)", "i");
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  // What a document is called, from PaperPull's document_rules.json, tax first.
  const KINDS = [
    [/consolidated\s+(form\s+)?1099/i, "Consolidated 1099 Tax Form"],
    [/crypto\s+1099|1099\s+crypto/i, "Crypto 1099 Tax Form"],
    [/1099-?B\b/i, "1099-B Tax Form"], [/1099-?DIV\b/i, "1099-DIV Tax Form"], [/1099-?INT\b/i, "1099-INT Tax Form"],
    [/1099-?MISC\b/i, "1099-MISC Tax Form"], [/1099-?R\b/i, "1099-R Tax Form"], [/1099-?OID\b/i, "1099-OID Tax Form"],
    [/\b1099\b/i, "1099 Tax Form"], [/\b1042-?S\b/i, "1042-S Tax Form"], [/\b5498\b/i, "5498 Tax Form"],
    [/crypto/i, "Crypto Statement"], [/\bIRA\b|retirement/i, "Retirement Account Statement"],
    [/statement/i, "Account Statement"],
  ];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A short line for the run log (shared.js), never the page's own text.
  const trace = (text) => { if (globalThis.__sweepLog) globalThis.__sweepLog(text); };
  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const ownLabel = (el) => `${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`.trim();
  const shown = (el) => el.getClientRects().length > 0;
  const here = () => location.pathname.replace(/\/$/, "");
  const pageAt = () => (location.hostname === "robinhood.com" ? PAGES.indexOf(here()) : -1);
  const kindOf = (title) => (KINDS.find(([rx]) => rx.test(title)) || [null, "Document"])[1];

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']"));
  }

  function asking() {
    if (rawControls().length) return null;
    const text = `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 1500)}`.toLowerCase();
    if (CHALLENGE.some((m) => text.includes(m))) return "challenge";
    if (RATE_LIMIT.some((m) => text.includes(m))) return "rate";
    return null;
  }

  function real(year, month, day) {
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
      ? d.toISOString().slice(0, 10) : null;
  }

  // A statement's date as its title gives it: an exact day, or a month as that
  // month's last day. A title naming neither has no date.
  function titleDate(title) {
    const name = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
    let m = new RegExp(`${name}\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i").exec(title);
    if (m) return real(+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2]);
    m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(title);
    if (m) return real(+m[3], +m[1], +m[2]);
    m = /\b(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(title);
    if (m) return real(+m[1], +m[2], +m[3]);
    m = new RegExp(`${name}\\s+(\\d{4})`, "i").exec(title);
    if (m) return new Date(Date.UTC(+m[2], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, 0)).toISOString().slice(0, 10);
    // A tax form that names its year, "Form 1099 2025", is filed at that year's end.
    m = /\b((?:19|20)\d{2})\b/.exec(title.replace(/\b(1099|1042|5498)\b/g, ""));
    if (m && TAX_TITLE.test(title)) return `${m[1]}-12-31`;
    return null;
  }

  // ---- The tax year the page names beside a form whose title has none, read
  // as PaperPull reads it: the form's own card first, then the nearest text
  // above it that names a tax year as such ("Tax year 2025"), a chosen tab or
  // picker counting only when chosen. A bare year is never one.
  const Y = String.raw`(?<![\w.\-\/])((?:19|20)\d{2})(?!\d|[.\-\/]\d)`;
  const NAMED = [String.raw`tax\s+year\s*:?\s*` + Y, Y + String.raw`\s+tax\s+(?:year|documents?|forms?)\b`,
    String.raw`tax\s+(?:documents?|forms?)\s+for\s+` + Y];
  const PHRASES = NAMED.map((p) => new RegExp(String.raw`\b` + p, "gi"));
  const YEAR_HEADING = new RegExp(String.raw`^(?:` + NAMED.join("|") + String.raw`)\s*[▾▼⌄˅]?$`, "i");
  const A_DATE = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}\b|\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/i;

  function isDocControl(el) {
    const own = ownLabel(el);
    if (/download\s*csv/i.test(own)) return false;
    if (/download\s*(pdf|html)/i.test(own)) return true;
    return el.hasAttribute("download") && TITLE.test(own);
  }
  function holdsAnother(node, el) {
    for (const c of node.querySelectorAll(CONTROLS)) {
      if (c === el || c.contains(el) || el.contains(c)) continue;
      if (isDocControl(c)) return true;
    }
    return false;
  }
  function yearIn(text) {
    const said = new Set();
    for (const re of PHRASES) for (const m of text.matchAll(re)) said.add(m[1]);
    if (said.size > 1) return null;
    return said.size === 1 ? [...said][0] : undefined;
  }
  function cardOf(el) {
    let node = el;
    for (let i = 0; i < 8 && node && node !== document.body; i++) {
      const t = node.innerText || "";
      if (TITLE.test(t) && t.split("\n").filter((s) => s.trim()).length > 1) {
        return t.length > 600 || holdsAnother(node, el) ? null : node;
      }
      node = node.parentElement;
    }
    return null;
  }
  function labelOf(e) {
    if (e.tagName === "SELECT") {
      const o = e.options[e.selectedIndex];
      return o ? tidy(o.text) : "";
    }
    return e.closest("select") ? "" : tidy(e.innerText);
  }
  const isHeading = (e) => /^H[1-6]$/.test(e.tagName) || e.getAttribute("role") === "heading" || e.tagName === "LEGEND" || e.tagName === "CAPTION";
  function isChoice(e) {
    if (e.tagName === "SELECT") return true;
    if (e.closest("[role=tablist], [role=radiogroup], [role=listbox], [role=menu], [role=menubar], [role=tab], [role=radio], [role=option], [role=menuitemradio]")) return true;
    const box = e.closest("button, a, [role=button], label, li") || e;
    return [box.previousElementSibling, box.nextElementSibling].some((s) => s && YEAR_HEADING.test(labelOf(s)));
  }
  function isChosen(e) {
    if (e.tagName === "SELECT") return true;
    for (let n = e, i = 0; i < 4 && n; i++, n = n.parentElement) {
      if (["aria-selected", "aria-checked", "aria-pressed"].some((a) => n.getAttribute(a) === "true")) return true;
      const cur = n.getAttribute("aria-current");
      if (cur && cur !== "false") return true;
      if (n.tagName === "LABEL" && n.querySelector("input:checked")) return true;
    }
    return false;
  }
  function inAnotherCard(e, el) {
    for (let n = e; n && n !== document.body; n = n.parentElement) {
      if (n.contains(el)) return false;
      if (holdsAnother(n, el)) return true;
    }
    return false;
  }
  function headingYear(el) {
    const all = Array.from(document.body.querySelectorAll("*"));
    for (let i = all.indexOf(el) - 1; i >= 0; i--) {
      const e = all[i];
      if (e.contains(el)) continue;
      if (e.tagName !== "SELECT" && !e.getClientRects().length) continue;
      const text = labelOf(e);
      if (!text || text.length > 80) continue;
      if (!YEAR_HEADING.test(text) && !(isHeading(e) && !A_DATE.test(text))) continue;
      const y = yearIn(text);
      if (y === null) return "";
      if (!y || inAnotherCard(e, el) || (isChoice(e) && !isChosen(e))) continue;
      return y;
    }
    return "";
  }
  // Only a year that has ended: a form for a year still running is not out yet.
  function taxYearOf(el) {
    let y = "";
    const card = cardOf(el);
    if (card) {
      const own = yearIn(card.innerText || "");
      if (own === null) return "";
      if (own) y = own;
    }
    if (!y) y = headingYear(el);
    return y && +y < new Date().getFullYear() ? y : "";
  }

  function cleaned(title) {
    return tidy(title).replace(/\s*Download (PDF|CSV|HTML)\s*/gi, " ").trim();
  }

  // Every document control on the page, as {el, title, html}, in page order.
  // A statement link's own text is its title; a "Download PDF" button finds
  // the title in the box around it.
  function rawControls() {
    const out = [];
    for (const el of document.querySelectorAll(CONTROLS)) {
      const own = ownLabel(el);
      if (/download\s*csv/i.test(own)) continue;
      const button = /download\s*(pdf|html)/i.test(own);
      let title = "";
      if (el.hasAttribute("download") && TITLE.test(own)) {
        title = own;
      } else if (button) {
        let node = el;
        for (let i = 0; i < 12 && node; i++) {
          node = node.parentElement;
          const m = ((node && node.innerText) || "").match(TITLE);
          if (m) { title = m[1]; break; }
        }
      } else {
        continue;
      }
      const name = cleaned(title);
      if (name.length >= 4) out.push({ el, title: name, html: /download\s*html/i.test(own) });
    }
    return out;
  }

  // Each control with the id it is known by: its title, and on the tax page
  // a form whose title names no year also the tax year beside it.
  function controls() {
    const tax = here() === TAX_PAGE;
    return rawControls().map((c) => {
      let date = titleDate(c.title);
      let key = c.title;
      if (!date && tax && TAX_TITLE.test(c.title) && !ANY_YEAR.test(c.title)) {
        const year = taxYearOf(c.el);
        if (year) { date = `${year}-12-31`; key = `${c.title}|${year}`; }
      }
      return { ...c, date, key };
    });
  }

  // Whether a control may be pressed: it offers a download, it is no CSV, and
  // a control without the download attribute must pass the blocklist.
  function pressable(el) {
    const own = ownLabel(el);
    if (!el.hasAttribute("download") && !/download/i.test(own)) return false;
    if (/csv/i.test(own)) return false;
    return el.hasAttribute("download") || !FORBIDDEN.test(own);
  }

  const moreControl = () => Array.from(document.querySelectorAll("a, button, [role=button]"))
    .find((el) => MORE.test(tidy(el.innerText)) && shown(el) && !FORBIDDEN.test(ownLabel(el)));

  // Presses View More until it is gone, each press waited on until the list
  // grows or the control goes. False when it would not end.
  async function expand() {
    for (let i = 0; i < MAX_MORE; i++) {
      const more = moreControl();
      if (!more) return true;
      const before = rawControls().length;
      more.click();
      const until = Date.now() + MORE_WAIT_MS;
      while (Date.now() < until && rawControls().length === before && moreControl()) await sleep(250);
      if (rawControls().length === before && moreControl()) return false;
      await sleep(400);
    }
    return !moreControl();
  }

  // Which page a walk is on, kept in this tab's session storage, since going
  // to the next page loads it anew.
  function loadWalk() {
    try {
      const w = JSON.parse(sessionStorage.getItem(WALK_KEY) || "null");
      return w && Number.isInteger(w.at) && typeof w.t === "number" && Date.now() - w.t < WALK_AGE_MS ? w : null;
    } catch (e) { return null; }
  }
  const saveWalk = (w) => { try { sessionStorage.setItem(WALK_KEY, JSON.stringify(w)); } catch (e) { /* not kept */ } };
  const dropWalk = () => { try { sessionStorage.removeItem(WALK_KEY); } catch (e) { /* not there */ } };

  async function readList({ walk: mayWalk = false } = {}) {
    // A read for a tab of yours, or the sweep's first look at a tab it kept
    // from an earlier run, ends any walk that run left behind.
    if (!mayWalk) dropWalk();
    // This page is being left for the next one: wait for that one.
    if (mayWalk && globalThis.__robinhoodLeaving) return { state: "walking" };
    const until = Date.now() + (mayWalk ? WALK_WAIT_MS : WAIT_MS);
    for (;;) {
      if (signedOut()) return { state: "signed_out" };
      const check = asking();
      if (check === "challenge") return { state: "challenge" };
      if (check === "rate") return { state: "stopped", why: "Robinhood is asking for a pause. Try again later.", docs: [] };
      if (pageAt() < 0) return { state: "no_list" };
      if (rawControls().length > 0) break;
      if (Date.now() >= until) {
        // A page of an account the person may not have, or a year with no
        // forms: in a walk it is passed, anywhere else it is said.
        trace(`${here()}: no document controls after ${(mayWalk ? WALK_WAIT_MS : WAIT_MS) / 1000} s${mayWalk ? ", passed" : ""}.`);
        if (mayWalk) return { state: "ok", docs: [], more: true };
        return { state: "stopped", why: "Robinhood's page showed no documents.", docs: [] };
      }
      await sleep(300);
    }
    // A walk starts at the first page, wherever the tab was left.
    if (mayWalk && !loadWalk()) {
      saveWalk({ at: 0, t: Date.now() });
      if (pageAt() !== 0) return leaveFor(0);
    }
    if (mayWalk && !(await expand())) {
      return { state: "stopped", why: "Robinhood's View More would not finish showing the list.", docs: [] };
    }
    const docs = [];
    const seen = new Set();
    const shownKeys = new Set();
    let undated = 0, html = 0, refused = 0, twice = 0;
    for (const { el, title, html: isHtml, date, key } of controls()) {
      const id = key.toLowerCase();
      // A title shown twice is one document, unless both show: then the page
      // lists two accounts under one title, as two IRAs might.
      if (seen.has(id)) {
        if (shown(el) && shownKeys.has(id)) twice += 1;
        if (shown(el)) shownKeys.add(id);
        continue;
      }
      seen.add(id);
      if (shown(el)) shownKeys.add(id);
      if (isHtml) { html += 1; continue; }
      if (!pressable(el)) { refused += 1; continue; }
      if (!date) { undated += 1; continue; }
      docs.push({ id: key, date, title: kindOf(title), method: "newtab" });
    }
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    trace(`${here()} (page ${pageAt() + 1} of ${PAGES.length}${mayWalk ? `, walk at ${(loadWalk() || { at: 0 }).at + 1}` : ""}): ${docs.length} PDF(s), ${html} web-page only, ${undated} undated, ${refused} not pressable, ${twice} shown twice.`);
    if (twice && here() === RETIREMENT_PAGE) return { state: "stopped", why: "Robinhood lists one document title twice on this page, as two accounts of one kind would, and this cannot tell them apart.", docs: [] };
    if (refused) return { state: "stopped", why: "A document's control did not read as a download.", docs };
    if (undated) {
      const what = here() === TAX_PAGE ? "A tax form's year is not named on Robinhood's tax page." : "A statement's title named no date this can read.";
      return { state: "stopped", why: what, docs };
    }
    if (!mayWalk && moreControl()) return { state: "stopped", why: "Robinhood's list goes on behind View More, and this reads only what is shown in a tab of yours.", docs };
    const note = html ? `${html} Robinhood statement(s) are offered only as a web page, which this cannot save as a PDF.` : "";
    const answer = { state: "ok", docs, ...(note ? { note } : {}) };
    return mayWalk ? { ...answer, more: true } : answer;
  }

  // Loads one of Robinhood's document pages in this tab. The page is left a
  // moment later, so this answer reaches the sweep first, and until then
  // this page answers that it is being left.
  function leaveFor(at) {
    globalThis.__robinhoodLeaving = true;
    setTimeout(() => location.assign(BASE + PAGES[at]), 100);
    return { state: "walking" };
  }

  // The next page of the walk. Counted by the walk, not by the address, since
  // Robinhood may show one page's address as another page.
  function nextView() {
    const w = loadWalk() || { at: Math.max(pageAt(), 0) };
    const next = w.at + 1;
    if (next >= PAGES.length) { dropWalk(); trace(`End of the walk: all ${PAGES.length} pages visited.`); return { moved: false }; }
    trace(`Next: ${PAGES[next]}.`);
    saveWalk({ at: next, t: Date.now() });
    leaveFor(next);
    return { moved: true };
  }

  function clickDoc(doc) {
    const want = (doc && doc.id) || "";
    if (!want) return { ok: false, why: "not a document this listed" };
    if (signedOut() || pageAt() < 0) return { ok: false, why: "This is not a signed-in Robinhood documents page." };
    const hits = controls().filter((c) => c.key === want && !c.html && pressable(c.el));
    const hit = hits.find((c) => shown(c.el)) || hits[0];
    if (!hit) return { ok: false, why: "Its control was not there." };
    if (hit.date !== doc.date) return { ok: false, why: "Its date on the page has changed." };
    hit.el.click();
    return { ok: true };
  }

  globalThis.__sweep = { readList, clickDoc, nextView };
})();
