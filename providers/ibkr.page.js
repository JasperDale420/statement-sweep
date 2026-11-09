// Runs inside Interactive Brokers' Account Management, where the sign-in
// already lives. Reads and downloads only.
//
// Derived from PaperPull's apps/ibkr/ibkr_site.py (AGPL-3.0).
//
// A plain request for a statement is refused and ends the session, so the
// page's own controls are used, the same two PaperPull presses: Run on the row
// named exactly Activity Statement, and that dialog's Download PDF. Each is
// pressed only when it is the thing on top where the press lands.
(() => {
  const OURS = "data-statement-sweep-activity";
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];
  const MONTH_LABEL = /^\s*(January|February|March|April|May|June|July|August|September|October|November|December),?\s+((?:19|20)\d{2})\s*$/i;
  const MONTH_VALUE = /(?:^|[:_])((?:19|20)\d{2})(0[1-9]|1[0-2])$/;
  const MONTH_CODE = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])$/;
  const ACCOUNT_ID = /\b(D?[UFI]\d{6,9})\b/;
  const ACTIVITY_ROW = /^\s*Activity Statement\s*$/i;
  const DOWNLOAD_PDF = /^\s*Download PDF\s*$/i;
  const DEFAULT_STATEMENTS = /^\s*Default Statements\s*$/i;
  const BUTTONS = "button, [role=button], input[type=button], input[type=submit]";
  const PAGE_WAIT_MS = 15000, ROWS_WAIT_MS = 30000, DIALOG_WAIT_MS = 10000, MONTHS_WAIT_MS = 6500, STRAY_WAIT_MS = 20000;

  const LOGIN_URL_MARKERS = ["/sso/login", "/accountmanagement/expire"];
  const EXPIRED_TITLE = "your session has expired";
  const CHALLENGE_MARKERS = [
    "open the ibkr notification on your phone", "complete two factor authentication",
    "enter the code", "security code", "verify your identity",
  ];
  const RATE_LIMITS = [/too many (attempts|requests|login)/i, /temporarily (locked|unavailable|disabled)/i];

  // What a dropdown must not be, however it is named.
  const REFUSED = [
    /(\btrad(e|es|ed|ing|er)\b|\border(s|ed|ing)?\b|\bbuy(s|ing)?\b|\bsell(s|ing)?\b|\bshort(s|ing)?\b|\bexercis(e|es|ed|ing)\b|\brebalanc(e|es|ed|ing)\b|\bconvert(s|ed|ing)?\b|\bconversion\b|\bcurrenc(y|ies)\b|\bforex\b|\bfx\b|\btransfer(s|red|ring)?\b|\bdeposit(s|ed|ing)?\b|\bwithdraw(s|n|al|als|ing)?\b|\bfund(s|ed|ing)?\b|\bwire\b|\bach\b|\bpay(s|ed|ing|ment|ments)?\b|\bmargin\b|\bborrow(s|ed|ing)?\b|\blend(s|ing)?\b|\bcancel(s|led|ling)?\b|\bclos(e|es|ed|ing)\b|\bopen\s+(a\s+)?(new\s+)?account\b|\badd(s|ed|ing)?\b|\bremov(e|es|ed|ing|al)\b|\bdelet(e|es|ed|ing)\b|\bchang(e|es|ed|ing)\b|\bedit(s|ed|ing)?\b|\bupdat(e|es|ed|ing)\b|\benabl(e|es|ed|ing)\b|\bdisabl(e|es|ed|ing)\b|\bactivat(e|es|ed|ing)\b|\bsubscri(be|bes|bed|bing|ption|ptions)\b|\bunsubscri(be|bes|bed|bing)\b|\brequest(s|ed|ing)?\b|\bsubmit(s|ted|ting)?\b|\bconfirm(s|ed|ing)?\b|\bapply\b|\bupload(s|ed|ing)?\b|\bdeliver(y|ies|ed)\b|\bsettings?\b|\bpreferences?\b|\bnotifications?\b|\balerts?\b|\bsecurity\b|\btokens?\b|\bapi\b|\bsso\b)/i,
    /(from|to|source|destination|target)\s*_?-?account|transfer|payment|pay\b|bill|deposit|withdraw|zelle|wire|remit|send\s*money|move\s*money|recipient|payee|amount|frequency|schedule/i,
    /log[\s_-]?(in|on)|sign[\s_-]?(in|on|up)|signin|logon|authenticat|credential|register|enroll(ment)?\b|username|user[\s_-]?id|password|passcode|remember\s*me/i,
  ];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(look, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const found = look();
      if (found || Date.now() >= end) return found;
      await sleep(250);
    }
  }
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const optionsOf = (select) => Array.from(select.options, (o) => o.textContent.trim());
  const isPeriods = (opts) => opts.includes("Monthly") && opts.includes("Annual");
  const isMonths = (opts) => opts.length > 0 && opts.slice(0, 3).every((o) => MONTH_LABEL.test(o));

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN_URL_MARKERS.some((m) => url.includes(m))
      || document.title.toLowerCase().includes(EXPIRED_TITLE)
      || Boolean(document.querySelector("input[type='password']"));
  }

  function hasDefaultStatements() {
    return Array.from(document.querySelectorAll("body *")).some((el) => (
      el.children.length === 0 && DEFAULT_STATEMENTS.test(el.textContent)));
  }

  const inAccountManagement = () => location.protocol === "https:" && location.pathname.toLowerCase().includes("/accountmanagement/");

  // The regional host is the one signed in, and the list address is .com.
  function notHere() {
    if (location.hostname === "www.interactivebrokers.com") return { state: "no_list" };
    return {
      state: "stopped",
      why: `You are signed in on ${location.hostname}. Open Statements there yourself, then sweep again.`,
      docs: [],
    };
  }

  function identityOf(select, opts) {
    const bits = ["aria-label", "name", "id", "title"].map((a) => select.getAttribute(a) || "");
    const dialog = select.closest("[role='dialog']");
    if (dialog) {
      bits.push(dialog.getAttribute("aria-label") || "");
      const title = dialog.querySelector(".modal-title");
      if (title) bits.push(title.textContent.trim().slice(0, 60));
    }
    const form = select.closest("form, [ng-form]");
    if (form) bits.push(form.id || "", form.getAttribute("name") || "", form.getAttribute("ng-form") || "");
    const own = bits.filter(Boolean).join(" | ");
    if (own) return own;
    return isPeriods(opts) || isMonths(opts) ? `statement period ${opts.slice(0, 8).join(" ")}` : "";
  }

  // Chosen by what it offers, never by position.
  function findSelect(wanted) {
    for (const select of Array.from(document.querySelectorAll("select")).slice(0, 12)) {
      if (!visible(select)) continue;
      const opts = optionsOf(select);
      if (!wanted(opts)) continue;
      const identity = identityOf(select, opts);
      if (!identity || REFUSED.some((re) => re.test(identity))) continue;
      return select;
    }
    return null;
  }
  const periodSelect = () => findSelect(isPeriods);
  const monthSelect = () => findSelect(isMonths);

  function choose(select, index) {
    select.selectedIndex = index;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Brought to the middle of the window, and pressed only if it is on top.
  function press(el) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const box = el.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (!top || !(top === el || el.contains(top))) return false;
    el.click();
    return true;
  }

  function runControl() {
    const rows = Array.from(document.querySelectorAll("div.row")).filter((row) => (
      Array.from(row.querySelectorAll("strong")).some((s) => ACTIVITY_ROW.test(s.textContent))));
    for (const row of rows.slice(0, 6)) {
      const runs = row.querySelectorAll("a[aria-label='Run']");
      if (runs.length === 1 && visible(runs[0])) return runs[0];
    }
    return null;
  }

  // Leaves the Activity Statement dialog open on Monthly. Answers why not.
  async function openMonthly() {
    let period = periodSelect();
    if (period && !period.hasAttribute(OURS)) {
      return "Another statement's dialog is open on the page. Close it and sweep again.";
    }
    if (!period) {
      const run = await until(runControl, ROWS_WAIT_MS);
      if (!run) return "The Activity Statement row was not there.";
      if (!press(run)) return "Something is covering the Activity Statement row. Close it and sweep again.";
      period = await until(periodSelect, DIALOG_WAIT_MS);
      if (!period) return "The Activity Statement dialog did not open.";
      period.setAttribute(OURS, "1");
    }
    const selected = period.selectedOptions[0];
    if (!selected || !selected.textContent.includes("Monthly")) {
      choose(period, optionsOf(period).indexOf("Monthly"));
    }
    return (await until(monthSelect, MONTHS_WAIT_MS)) ? "" : "The dialog showed no list of months.";
  }

  function monthOf(label) {
    const m = MONTH_LABEL.exec(label);
    if (!m) return null;
    const lower = m[1].toLowerCase();
    return { year: +m[2], month: MONTHS.findIndex((n) => n.toLowerCase() === lower) + 1 };
  }

  const codeOf = ({ year, month }) => `${year}${String(month).padStart(2, "0")}`;
  const monthEnd = ({ year, month }) => new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

  // A regular expression's source for the file a press may bring, the same two
  // checks PaperPull makes of the download's name: <account>_<month>_<month>.pdf
  // must name this account and this month. A name of any other shape says
  // nothing and passes. Case does not count, and the name may come with a path.
  const FILE_MONTH = "(?:19|20)\\d{2}(?:0[1-9]|1[0-2])";
  const FILE_PDF = "\\.[pP][dD][fF]$";
  function nameMustMatch(account, code) {
    const own = account.replace(/[A-Za-z]/g, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`);
    const months = `${FILE_MONTH}_${FILE_MONTH}${FILE_PDF}`;
    const anotherMonth = `.*_(?!${code}_${code}${FILE_PDF})${months}`;
    const anotherAccount = `(?:.*[\\\\/])?(?!${own}_)[A-Za-z]{1,2}\\d{6,9}_${months}`;
    return `^(?!${anotherMonth})(?!${anotherAccount})`;
  }

  function accountOnPage() {
    const m = ACCOUNT_ID.exec((document.body && document.body.innerText) || "");
    return m ? m[1] : "";
  }

  async function readList() {
    if (signedOut()) return { state: "signed_out" };
    const body = (document.body && document.body.innerText) || "";
    const screen = `${document.title}\n${body.slice(0, 1500)}`.toLowerCase();
    if (CHALLENGE_MARKERS.some((m) => screen.includes(m))) return { state: "challenge" };
    if (RATE_LIMITS.some((re) => re.test(screen))) {
      return { state: "stopped", why: "Interactive Brokers says to slow down and try later.", docs: [] };
    }
    if (!inAccountManagement()) return notHere();
    if (!(await until(hasDefaultStatements, PAGE_WAIT_MS))) return signedOut() ? { state: "signed_out" } : notHere();

    const stop = (why, docs = []) => ({ state: "stopped", why, docs });
    const account = accountOnPage();
    if (!account) return stop("The page names no account number.");
    const problem = await openMonthly();
    if (problem) return stop(problem);

    const select = monthSelect();
    const values = Array.from(select.options, (o) => o.value);
    const docs = [];
    const labels = optionsOf(select);
    for (let i = 0; i < labels.length; i++) {
      const ym = monthOf(labels[i]);
      if (!ym) return stop("A month in the list could not be read.", docs);
      const coded = MONTH_VALUE.exec((values[i] || "").trim());
      if (coded && `${coded[1]}${coded[2]}` !== codeOf(ym)) {
        return stop("A month's label and value name different months.", docs);
      }
      docs.push({
        id: `${account}-${codeOf(ym)}`, date: monthEnd(ym), title: `Activity Statement ${account.slice(-4)}`,
        method: "click", account, code: codeOf(ym), nameMustMatch: nameMustMatch(account, codeOf(ym)),
      });
    }
    if (!docs.length) return stop("The dialog listed no months.");
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return { state: "ok", docs };
  }

  function downloadButton(select) {
    const scope = select.closest("[role='dialog']") || document;
    for (const button of scope.querySelectorAll(BUTTONS)) {
      const words = (button.innerText || button.value || button.getAttribute("aria-label") || "").replace(/ /g, " ");
      if (DOWNLOAD_PDF.test(words) && visible(button)) return button;
    }
    return null;
  }

  // A dialog left by the last press, the report-being-generated one for
  // instance, which goes away on its own.
  function strayDialog() {
    const stray = document.querySelector("#amModal.show");
    return Boolean(stray && visible(stray) && !periodSelect());
  }

  async function clickDoc(doc) {
    const code = (doc && doc.code) || "";
    if (!MONTH_CODE.test(code) || !doc.account) return { ok: false, why: "not a month this can ask for" };
    if (signedOut()) return { ok: false, signedOut: true, why: "Interactive Brokers asked for a sign-in." };
    if (accountOnPage() !== doc.account) return { ok: false, why: "The page now shows a different account." };
    if (!(await until(() => !strayDialog(), STRAY_WAIT_MS))) {
      return { ok: false, why: "A dialog is still open over the page. Close it and sweep again." };
    }
    const problem = await openMonthly();
    if (problem) return { ok: false, why: problem };
    const select = monthSelect();
    const label = `${MONTHS[+code.slice(4) - 1]}, ${code.slice(0, 4)}`;
    const index = optionsOf(select).indexOf(label);
    if (index < 0) return { ok: false, why: "That month is no longer in the list." };
    const coded = MONTH_VALUE.exec((select.options[index].value || "").trim());
    if (coded && `${coded[1]}${coded[2]}` !== code) return { ok: false, why: "That month's label and value disagree." };
    choose(select, index);
    await sleep(800);
    const button = downloadButton(select);
    if (!button) return { ok: false, why: "The Download PDF button was not there." };
    if (!press(button)) return { ok: false, why: "Something is covering the Download PDF button. Close it and sweep again." };
    return { ok: true };
  }

  globalThis.__sweep = { readList, clickDoc };
})();
