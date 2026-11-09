// Runs inside Chase's own page, where the sign-in already lives. Reads the
// statement rows Chase has drawn and presses only a row's "Saves document".
//
// Derived from PaperPull's apps/chase/chase_site.py (AGPL-3.0).
(() => {
  const DRAW_WAIT_MS = 30000;
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const LOGIN_MARKERS = ["/logon", "/login", "/signin", "/sign-in", "/auth/logon", "/idp", "/mfa", "/verify", "chase.com/web/auth#/logon"];
  const CHECK_MARKERS = ["enter the code we sent", "enter your verification code", "verification code", "one-time", "one time passcode", "security code", "we sent a code", "two-factor", "two-step", "authenticator", "confirm your identity", "verify your identity", "we need to verify", "unusual activity", "are you a robot", "captcha", "unable to verify", "trouble verifying"];
  const ENDED_MARKERS = ["your session has expired", "please log in again", "you've been logged out", "for your security, we signed you out"];
  const RATE_MARKERS = ["too many requests", "rate limit", "try again later", "temporarily unavailable", "http error 429", "unusual traffic"];
  const DOC_ROWS = "table tbody tr, [role='row'], [class*='statement-row'], [class*='StatementRow'], [class*='documentRow'], [data-testid*='statement'], [data-testid*='document'], li[class*='statement'], li[class*='document']";
  const ROUTE = "#/dashboard/documents/";
  const YEAR_PICKER = "input[id*='filterstyledselect']";
  const YEAR_OPTIONS = "[role='option'], [id^='container-'][id*='filterstyledselect']";
  const YEAR_LEADS = /^((?:19|20)\d{2})\b/;
  const CARD = /\(\s*\.{2,}\s*\d{4}\s*\)/;
  const ROW_NAME = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{1,2}),\s*(20\d{2})\s+(.*?)\s+([A-Z0-9][^()]*\(\s*\.{2,}\s*\d{4}\s*\))/i;
  // Chase sells cards named "...REWARDS...", so a row or a card is judged on
  // action verbs, not on the words of a product's name.
  const CARD_ACTION = /\bpay\b|\bpayment\b|transfer|redeem|activat|\block\b|unlock|replace|dispute|\bclose\b|appl(y|ies|ied|ication)\b|request|increase|advance|authorized\s+user|set\s+up|\bchang(e|es|ed|ing)\b|\bupdat(e|es|ed|ing)\b|\bmanage\b|autopay|auto-?pay|zelle|\bwire\b|deposit|withdraw|\bsend\b|enroll|\bopen\b|\bcancel\b|\bsettings?\b|\bpreferences?\b/i;
  const SAFE_DOC = /(download|view|open|print|pdf|statement|document|1099|1098|5498|tax|e-?statement|year.?end)/i;

  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const shown = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function day(year, month, date) {
    const d = new Date(Date.UTC(year, month, date));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== date) return null;
    return d.toISOString().slice(0, 10);
  }

  function signedOut() {
    const url = location.href.toLowerCase();
    // Chase can keep a page's address and draw its sign-in in a frame over it.
    const frame = document.querySelector("iframe[name='logonbox'], iframe#logonbox");
    return LOGIN_MARKERS.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']")) || Boolean(frame && shown(frame));
  }

  // A page drawing its list is a normal page, whatever its words.
  function held() {
    if (document.querySelectorAll(DOC_ROWS).length > 2) return null;
    const hay = `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 1500)}`.toLowerCase();
    if (ENDED_MARKERS.some((m) => hay.includes(m))) return { state: "signed_out" };
    if (CHECK_MARKERS.some((m) => hay.includes(m))) return { state: "challenge" };
    if (RATE_MARKERS.some((m) => hay.includes(m))) return { state: "stopped", why: "Chase asked for a pause. Try again later." };
    return null;
  }

  const anotherTab = () => {
    const found = /documentType=([A-Za-z_]+)/i.exec(location.href);
    return Boolean(found) && found[1].toUpperCase() !== "STATEMENTS";
  };

  function cards() {
    return Array.from(document.querySelectorAll("button, [role='button']"))
      .filter((el) => shown(el))
      .map((el) => ({ el, label: tidy(el.innerText) }))
      .filter((c) => CARD.test(c.label) && !CARD_ACTION.test(c.label));
  }

  function centerDrawn() {
    if (!location.href.includes(ROUTE)) return false;
    return Boolean(yearShown()) && cards().length > 0;
  }

  function yearShown() {
    return Array.from(document.querySelectorAll(YEAR_PICKER)).slice(0, 5)
      .map((p) => tidy(p.value || p.getAttribute("value")))
      .find((v) => /^20\d{2}$/.test(v)) || "";
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

  // Every row a "Saves document" link names, read from its full label.
  function rowsOf() {
    const rows = [];
    for (const link of document.querySelectorAll("a, [role='link']")) {
      const labels = [tidy(link.innerText), tidy(link.getAttribute("aria-label"))].filter((l) => /saves document/i.test(l));
      const found = labels.map((l) => [l, ROW_NAME.exec(l)]).find(([, m]) => m);
      if (!found) continue;
      const [label, m] = found;
      const date = day(+m[3], MONTHS.indexOf(m[1].toLowerCase()), +m[2]);
      rows.push({ link, label, date, type: tidy(m[4]), card: tidy(m[5]) });
    }
    return rows;
  }

  const idOf = (row) => `${row.date}|${row.type}|${row.card}`;
  const safeRow = (label) => Boolean(label) && !CARD_ACTION.test(label) && SAFE_DOC.test(label);

  async function readList() {
    if (signedOut()) return { state: "signed_out" };
    let stop = held();
    if (stop) return stop;
    if (location.hostname !== "secure.chase.com" || anotherTab() || !location.href.includes(ROUTE)) return { state: "no_list" };
    const end = Date.now() + DRAW_WAIT_MS;
    while (!centerDrawn()) {
      if (Date.now() >= end) return { state: "stopped", why: "Chase did not draw its statements page. Open Statements & documents in this tab and sweep again." };
      await sleep(250);
      if (signedOut()) return { state: "signed_out" };
      stop = held();
      if (stop) return stop;
    }
    const all = cards();
    const open = all.filter((c) => (c.el.getAttribute("aria-expanded") || "").toLowerCase() === "true");
    if (!open.length) return { state: "stopped", why: "No card is open on Chase's statements page. Open a card there and sweep again." };
    const labels = new Set(open.map((c) => c.label));
    const docs = [];
    const seen = new Set();
    for (const row of rowsOf()) {
      // Rows of a collapsed card can still be in the page.
      if (!labels.has(row.card) || !/^statement$/i.test(row.type)) continue;
      if (!row.date) return { state: "stopped", why: "A statement's date could not be read.", docs };
      if (!safeRow(row.label)) return { state: "stopped", why: "A statement's link was not one this will press.", docs };
      const id = idOf(row);
      if (seen.has(id)) continue;
      seen.add(id);
      docs.push({ id, date: row.date, title: row.card, method: "click" });
    }
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (!docs.length) return { state: "stopped", why: "The open card shows no statements for the year chosen. Pick another year in Chase's View picker and sweep again.", docs };
    const closed = all.length - open.length;
    if (closed) return { state: "stopped", why: `Only the open card was read. Open each of the other ${closed} on Chase's page and sweep again.`, docs };
    const year = yearShown();
    const offered = yearsOffered();
    if (offered.size !== 1 || !offered.has(year)) return { state: "stopped", why: `Only ${year} was read. Chase's View picker may hold other years. Choose each there and sweep again.`, docs };
    return { state: "ok", docs };
  }

  function clickDoc(doc) {
    const id = doc && doc.id;
    if (typeof id !== "string" || !id) return { ok: false, why: "not a statement of this list" };
    const row = rowsOf().find((r) => idOf(r) === id && shown(r.link));
    if (!row) return { ok: false, why: "That statement's row is not on the page. Open its card and year." };
    if (!safeRow(row.label)) return { ok: false, why: "That link is not one this will press." };
    row.link.click();
    return { ok: true };
  }

  globalThis.__sweep = { readList, clickDoc };
})();
