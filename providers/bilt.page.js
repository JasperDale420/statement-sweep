// Runs inside Bilt's own page. Saves the Bilt Card's statements.
//
// Bilt's statements sit behind two sheets on the wallet. Three read-only
// presses, PaperPull's own, and nothing else is ever pressed:
//   1. "View balance summary", that label exactly, opens a sheet holding
//   2. "View statements", that text exactly, which opens the statements sheet;
//   3. one statement's "Download statement for <Month DD, YYYY>", for that
//      statement's date only, which opens the PDF in a new tab on
//      statements.cardless.com. The engine takes that tab (method "newtab").
// Each press reads every label the control carries (text, aria-label,
// title), and every one must pass that press's own exact check and
// PaperPull's blocklist. A control the page has turned off is not pressed.
//
// readList may press the first two to reach the sheet, only when the sweep
// may walk this tab. clickDoc presses one statement's button, opening the
// sheet again first if it is not shown.
//
// Derived from PaperPull's apps/bilt/bilt_site.py (AGPL-3.0).
(() => {
  const SUMMARY = '[aria-label="View balance summary"]';
  const SUMMARY_LABEL = "View balance summary";
  const STATEMENTS_LABEL = "View statements";
  const OPENERS = 'button, [role="button"]';
  const LINK = 'a[href^="/wallet/transactions?cardId="]';
  const STATEMENT = '[aria-label^="Download statement for "]';
  const LOGIN_PATHS = ["login", "signin", "sign-in", "signup", "sign-up", "logout", "auth"];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const DAY = `(${MONTHS.join("|")}) (\\d{1,2}), (\\d{4})`;
  const ARIA = new RegExp(`^Download statement for ${DAY}$`);
  const WORDS = new RegExp(`^${DAY}$`);
  const CARD = /^Bilt [A-Za-z ]*Card\s*[•*]+\s*(\d{4})(?: View)?$/;
  const CARD_LINK = /^\/wallet\/transactions\?cardId=([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$/;
  const PAGER = /^(?:(?:load|show|see|view)\s+(?:more|older|earlier|previous)(?:\s+statements?)?|(?:load|show|see|view)\s+all\s+statements?|(?:more|older|earlier|previous)(?:\s+statements?)?|next\s+page)$/i;
  const ID = /^statement-(\d{4}-\d{2}-\d{2})$/;
  const TITLE = "Card Statement";

  // PaperPull's FORBIDDEN_CONTROL_RE, and the core's SETTINGS_CONTROL_RE and
  // AUTH_CONTROL_RE: a label any of them finds is never pressed.
  const FORBIDDEN = new RegExp(
    "(\\bpay\\b|\\bpays\\b|\\bpaying\\b|\\bpayments?\\b|\\bautopay\\b|\\bauto\\s*-?\\s*pay\\b|\\bpoints?\\b|"
    + "\\btransfers?\\b|\\btransferring\\b|\\block\\b|\\bunlock\\b|\\bfreeze\\b|\\bmanage\\b|\\bmanaging\\b|"
    + "\\bauthori[sz]ed\\b|\\busers?\\b|\\badd\\b|\\badding\\b|\\brefer|\\breferral|\\brewards?\\b|"
    + "\\bneighborhood\\b|\\bconcierge\\b|\\bchat\\b|\\bconversation\\b|\\bsuggestion\\b|\\bprofile\\b|"
    + "\\baccount\\b|\\bsettings?\\b|\\bpreferences?\\b|\\bsign\\s*(out|off|in|up)\\b|\\blog\\s*(out|off|in)\\b|"
    + "\\blogout\\b|\\blogin\\b|\\bdispute|\\breplace|\\breport\\b|\\bactivat|\\bredeem|\\bsubmit\\b|"
    + "\\bconfirm\\b|\\bcontinue\\b|\\bsave\\b|\\bdelet(e|es|ed|ing)\\b|\\bremov(e|es|ed|ing|al)\\b|"
    + "\\bclose\\b|\\bedit(s|ed|ing)?\\b|\\bupdat(e|es|ed|ing)\\b|\\bchang(e|es|ed|ing)\\b|\\blink|"
    + "\\boffers?\\b|\\bbenefits?\\b|\\bapply\\b|\\bupgrade\\b|\\bscheduled\\b|\\bcancel\\b|\\bsend\\b|"
    + "\\brequest(s|ed|ing)?\\b|\\bshare\\b|\\bemail\\b|\\bupload\\b|\\battachment\\b|\\bvoice\\b|"
    + "\\bmap\\b|\\bprevious\\b|\\bnext\\b|\\bwallet\\b|\\bactivity\\b|\\btransactions?\\b|\\bview\\s+all\\b|"
    + "\\bmembership\\b|\\bdefault\\b|\\bverify\\b|\\bpassword\\b|\\baccept\\b|\\bagree\\b|\\bauthori[sz]e\\b|"
    + "\\bmortgage\\b|\\bpartners?\\b|\\bsupport\\b|\\bhelp\\b|\\bmore\\b|\\bfullscreen\\b|\\bvisits?\\b|"
    + "\\bcash\\b|\\bcredit\\s+limit\\b|\\bdeposit|\\bwithdraw)", "i");
  const SETTINGS = new RegExp(
    "\\bchang(e|es|ed|ing)\\b|\\bedit(s|ed|ing)?\\b|\\bupdat(e|es|ed|ing)\\b|"
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
  const AUTH = /log[\s_-]?(in|on)|sign[\s_-]?(in|on|up)|signin|logon|authenticat|credential|register|enroll(ment)?\b|username|user[\s_-]?id|password|passcode|remember\s*me/i;

  const SENTENCES = ["Complete login to continue", "Log in or sign up"];
  const CHALLENGE = ["enter the code", "verification code", "6-digit", "two-factor", "two-step", "authenticator",
    "confirm your identity", "verify your identity", "we sent a code", "one-time passcode", "are you a robot",
    "captcha", "check your email", "check your phone", "access denied"];
  const RATE_LIMIT = ["too many requests", "rate limit", "try again later", "temporarily unavailable",
    "http error 429", "unusual traffic"];
  const HOW_TO = "Open View balance summary, then View statements, on the wallet in this tab, and sweep again.";
  const SIGNED_OUT = "Bilt signed you out. Sign in again, then run it again.";
  const WALLET_WAIT_MS = 8000;
  const SHEET_WAIT_MS = 20000;
  const SETTLE_MS = 1500;

  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shown = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    && getComputedStyle(el).visibility !== "hidden";
  const all = (css, root = document) => Array.from(root.querySelectorAll(css));
  const stop = (why, docs = []) => ({ state: "stopped", why, docs });
  const turnedOff = (el) => el.disabled === true || el.getAttribute("aria-disabled") === "true";

  async function waitFor(test, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const got = test();
      if (got) return got;
      if (Date.now() >= end) return null;
      await sleep(250);
    }
  }

  function dateOf(m) {
    if (!m) return null;
    const month = MONTHS.indexOf(m[1]), day = +m[2], year = +m[3];
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
    return d.toISOString().slice(0, 10);
  }
  // PaperPull's button_date: the whole label is one of the two forms.
  const buttonDate = (label) => dateOf(ARIA.exec(tidy(label)) || WORDS.exec(tidy(label)));

  // -- the three checks, one for each control this presses -------------------
  const refused = (label) => FORBIDDEN.test(label) || SETTINGS.test(label) || AUTH.test(label);
  const isSummary = (label) => Boolean(label) && !refused(label) && label === SUMMARY_LABEL;
  const isViewStatements = (label) => Boolean(label) && !refused(label) && label === STATEMENTS_LABEL;
  const isStatementButton = (label, iso) => Boolean(label) && Boolean(iso) && !refused(label) && buttonDate(label) === iso;

  const labelsOf = (el) => [el.innerText, el.getAttribute("aria-label"), el.getAttribute("title")].map(tidy).filter(Boolean);

  // Presses `el` once, only when every label it carries passes `guard`.
  // Answers "" once pressed, or why not.
  function press(el, guard, what) {
    if (!el || !shown(el)) return `${what} is not on the page.`;
    const labels = labelsOf(el);
    if (!labels.length || !labels.every(guard)) return `${what} did not read as expected, so it was not pressed.`;
    if (turnedOff(el)) return `${what} is turned off on the page.`;
    el.click();
    return "";
  }

  // -- who is needed ----------------------------------------------------------
  function signInDrawn() {
    const root = document.body || document.documentElement;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!shown(n.parentElement)) continue;
      for (const part of tidy(n.nodeValue).split(/(?<=[.!?])\s+/)) {
        if (SENTENCES.includes(part.replace(/[.!?]+$/, ""))) return true;
      }
    }
    return all('button, [role="button"], a, [role="link"]', root).some((el) => shown(el) && tidy(el.innerText) === "Sign up / Log in");
  }
  const summaries = () => all(SUMMARY).filter(shown);
  const signInShown = () => signInDrawn() && !summaries().some((el) => el.tagName === "BUTTON");

  // A wallet can draw the sign-in for a moment while it finds its session,
  // so one look never says signed out.
  async function signInHolds() {
    for (let waited = 0; waited < 4000; waited += 250) {
      if (!signInShown()) return false;
      await sleep(250);
    }
    return signInShown();
  }

  function pageWord() {
    if (document.querySelector(STATEMENT)) return "";
    const body = ((document.body && document.body.innerText) || "").toLowerCase();
    const hay = `${(document.title || "").toLowerCase()}\n${body.slice(0, 1500)}`;
    if (CHALLENGE.some((m) => hay.includes(m))) return "challenge";
    if (RATE_LIMIT.some((m) => hay.includes(m))) return "rate";
    return "";
  }

  function signedOutHere() {
    const first = (location.pathname.replace(/^\/+/, "").split("/")[0] || "").toLowerCase();
    return LOGIN_PATHS.includes(first) || Boolean(document.querySelector("input[type='password']"));
  }

  // -- the wallet and its sheets ---------------------------------------------
  function oneCard() {
    if (summaries().length !== 1 || summaries()[0].tagName !== "BUTTON") return false;
    const fours = new Set();
    for (const el of all("body *")) {
      const m = CARD.exec(tidy(el.innerText));
      if (!m || !shown(el) || Array.from(el.children).some((c) => CARD.test(tidy(c.innerText)))) continue;
      fours.add(m[1]);
    }
    const links = new Set(all(LINK).filter(shown).map((a) => {
      const m = CARD_LINK.exec(a.getAttribute("href") || "");
      return m ? m[1] : "";
    }));
    return fours.size === 1 && links.size === 1 && !links.has("");
  }

  const statementButtons = () => all(STATEMENT);
  const sheetShown = () => statementButtons().some(shown);
  // The shown controls whose own text is exactly "View statements". Its
  // accessible name carries a nested icon's name too, so it is found by text.
  const viewStatements = () => all(OPENERS).filter((el) => shown(el) && tidy(el.innerText) === STATEMENTS_LABEL);

  // Presses "View balance summary" and then "View statements", each only
  // when needed and at most once, until the statements sheet shows.
  // Answers "" once it shows, SIGNED_OUT, or why not.
  async function openSheet() {
    if (sheetShown()) return "";
    if (!viewStatements().length) {
      const box = summaries();
      if (box.length !== 1 || box[0].tagName !== "BUTTON") return "The balance summary button is not one control on the page.";
      const why = press(box[0], isSummary, "View balance summary");
      if (why) return why;
      if (!(await waitFor(() => viewStatements().length || sheetShown(), SHEET_WAIT_MS))) return "The balance summary did not show View statements.";
      if (signInShown()) return SIGNED_OUT;
      if (sheetShown()) return "";
    }
    const openers = viewStatements();
    if (openers.length !== 1) return "View statements is not one control on the page.";
    const why = press(openers[0], isViewStatements, "View statements");
    if (why) return why;
    if (!(await waitFor(sheetShown, SHEET_WAIT_MS))) return "The statements sheet did not show any statements.";
    if (signInShown()) return SIGNED_OUT;
    return "";
  }

  // The dates of the sheet's buttons, or null when one is hidden, is not a
  // button, or does not read one date alike in its label, text and title.
  function sheetDates(buttons) {
    const dates = [];
    for (const b of buttons) {
      const iso = dateOf(ARIA.exec(tidy(b.getAttribute("aria-label"))));
      const title = tidy(b.getAttribute("title"));
      if (!iso || !shown(b) || b.tagName !== "BUTTON" || dateOf(WORDS.exec(tidy(b.innerText))) !== iso) return null;
      if (title && buttonDate(title) !== iso) return null;
      dates.push(iso);
    }
    return dates;
  }

  function hasPager(buttons) {
    let sheet = buttons[0].parentElement;
    while (sheet && !buttons.every((b) => sheet.contains(b))) sheet = sheet.parentElement;
    const walletOwn = (el) => Boolean(el.querySelector(`${SUMMARY}, ${LINK}`));
    while (sheet && sheet.parentElement && sheet.parentElement !== document.body
      && sheet.parentElement !== document.documentElement && !walletOwn(sheet.parentElement)) sheet = sheet.parentElement;
    if (!sheet) return false;
    return all('button, [role="button"], a, [role="link"], input[type="button"], input[type="submit"], input[type="image"], input[type="reset"]', sheet)
      .filter(shown).some((el) => [el.innerText, el.getAttribute("aria-label"), el.getAttribute("title"), el.tagName === "INPUT" ? el.value : "", el.getAttribute("alt")]
        .map(tidy).some((s) => s && PAGER.test(s)));
  }

  // The sheet read whole: {dates} newest first, or {why}.
  function readSheet() {
    const buttons = statementButtons();
    if (!buttons.length) return { why: "The statements sheet shows no statements." };
    const dates = sheetDates(buttons);
    if (!dates) return { why: "A statement's date could not be read." };
    if (new Set(dates).size !== dates.length) return { why: "Two statements carry one date." };
    if (hasPager(buttons)) return { why: "The statements sheet offers more or older statements, so what it shows may be only part of the list." };
    return { dates: dates.sort().reverse() };
  }

  // -- the list ---------------------------------------------------------------
  async function readList({ walk = false } = {}) {
    if (signedOutHere()) return { state: "signed_out" };
    if (location.pathname !== "/wallet") return { state: "no_list" };
    if (await signInHolds()) return { state: "signed_out" };
    const word = pageWord();
    if (word === "challenge") return { state: "challenge" };
    if (word === "rate") return stop("Bilt says to try again later.");
    if (!(await waitFor(oneCard, WALLET_WAIT_MS))) return stop("The wallet does not show one Bilt Card this can read.");
    if (!sheetShown()) {
      if (!walk) return stop(`The statements sheet is not open. ${HOW_TO}`);
      const why = await openSheet();
      if (why === SIGNED_OUT) return { state: "signed_out" };
      if (why) return stop(`${why} ${HOW_TO}`);
    }
    const first = readSheet();
    if (first.why) return stop(first.why);
    // Read again once the sheet has settled, and the two must agree.
    await sleep(SETTLE_MS);
    if (!oneCard()) return stop("The wallet does not show one Bilt Card this can read.");
    const again = readSheet();
    if (again.why) return stop(again.why);
    if (again.dates.join() !== first.dates.join()) return stop("The statements changed while the list was read.");
    return {
      state: "ok",
      docs: again.dates.map((date) => ({ id: `statement-${date}`, date, title: TITLE, method: "newtab" })),
    };
  }

  // -- one statement ------------------------------------------------------------
  // Presses that one statement's own button, which opens its PDF in a new tab.
  async function clickDoc(doc) {
    const m = ID.exec((doc && doc.id) || "");
    if (!m || doc.date !== m[1]) return { ok: false, why: "That is not a statement of this list." };
    const iso = m[1];
    if (signedOutHere() || signInShown()) return { ok: false, why: SIGNED_OUT };
    if (location.pathname !== "/wallet") return { ok: false, why: "The wallet is not open in this tab." };
    if (!(await waitFor(oneCard, WALLET_WAIT_MS))) return { ok: false, why: "The wallet does not show one Bilt Card this can read." };
    const opened = await openSheet();
    if (opened) return { ok: false, why: opened };
    const sheet = readSheet();
    if (sheet.why) return { ok: false, why: sheet.why };
    const mine = statementButtons().filter((b) => dateOf(ARIA.exec(tidy(b.getAttribute("aria-label")))) === iso);
    if (mine.length !== 1) return { ok: false, why: "That statement is not on the statements sheet." };
    const why = press(mine[0], (label) => isStatementButton(label, iso), "That statement's button");
    if (why) return { ok: false, why: turnedOff(mine[0]) ? `${why} It is left for the next run.` : why };
    return { ok: true };
  }

  globalThis.__sweep = { readList, clickDoc };
})();
