// Runs inside Bilt's own page. Reads what the wallet shows and presses nothing.
//
// A statement cannot be saved from here. Its data is on another host and
// needs headers only Bilt's page sends, and its button opens the PDF in a new
// tab on statements.cardless.com rather than starting a download, which a
// sweep has no way to catch. So this says who is needed, reads the dates the
// statements sheet shows, and then stops with that reason.
//
// Derived from PaperPull's apps/bilt/bilt_site.py (AGPL-3.0).
(() => {
  const SUMMARY = '[aria-label="View balance summary"]';
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
  const SENTENCES = ["Complete login to continue", "Log in or sign up"];
  const CHALLENGE = ["enter the code", "verification code", "6-digit", "two-factor", "two-step", "authenticator",
    "confirm your identity", "verify your identity", "we sent a code", "one-time passcode", "are you a robot",
    "captcha", "check your email", "check your phone", "access denied"];
  const RATE_LIMIT = ["too many requests", "rate limit", "try again later", "temporarily unavailable",
    "http error 429", "unusual traffic"];
  const NO_SAVE = "Bilt opens each statement in a new tab on another site instead of starting a download, so nothing here can save it. Nothing was pressed.";

  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shown = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    && getComputedStyle(el).visibility !== "hidden";
  const all = (css, root = document) => Array.from(root.querySelectorAll(css));
  const stop = (why, listed = []) => ({ state: "stopped", why, docs: [], listed });

  function dateOf(m) {
    if (!m) return null;
    const month = MONTHS.indexOf(m[1]), day = +m[2], year = +m[3];
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
    return d.toISOString().slice(0, 10);
  }

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

  function sheetDates(buttons) {
    const dates = [];
    for (const b of buttons) {
      const iso = dateOf(ARIA.exec(tidy(b.getAttribute("aria-label"))));
      const title = tidy(b.getAttribute("title"));
      if (!iso || !shown(b) || b.tagName !== "BUTTON" || dateOf(WORDS.exec(tidy(b.innerText))) !== iso) return null;
      if (title && dateOf(ARIA.exec(title) || WORDS.exec(title)) !== iso) return null;
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

  async function readList() {
    const first = (location.pathname.replace(/^\/+/, "").split("/")[0] || "").toLowerCase();
    if (LOGIN_PATHS.includes(first) || document.querySelector("input[type='password']")) return { state: "signed_out" };
    if (location.pathname !== "/wallet") return { state: "no_list" };
    if (await signInHolds()) return { state: "signed_out" };
    const word = pageWord();
    if (word === "challenge") return { state: "challenge" };
    if (word === "rate") return stop("Bilt says to try again later.");
    for (let waited = 0; !oneCard(); waited += 250) {
      if (waited >= 8000) return stop("The wallet does not show one Bilt Card this can read.");
      await sleep(250);
    }
    const buttons = all(STATEMENT);
    if (!buttons.length) return stop(NO_SAVE);
    const dates = sheetDates(buttons);
    if (!dates) return stop("A statement's date could not be read.");
    if (new Set(dates).size !== dates.length) return stop("Two statements carry one date.");
    if (hasPager(buttons)) return stop("The statements sheet offers more or older statements, so what it shows may be only part of the list.");
    dates.sort().reverse();
    return stop(`${dates.length} statement(s) are listed. ${NO_SAVE}`, dates);
  }

  globalThis.__sweep = { readList };
})();
