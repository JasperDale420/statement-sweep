// Runs inside Spectrum's own page. Reads what the page shows and presses nothing.
//
// A statement cannot be saved from here. Its id and PDF come only from the
// page's own calls to apis.spectrum.net, with a token it keeps for itself,
// and its "View Printable Statement" opens a Blob in a new tab rather than
// starting a download. Mobile statements have no PDF, and no address to print
// until their row has been pressed. So this says who is needed, reads the
// dates of the Statements rows, and then stops with that reason.
//
// Derived from PaperPull's apps/spectrum/spectrum_site.py (AGPL-3.0).
(() => {
  const ROW_CSS = "a.kite-list-item__action";
  const LOGIN_MARKERS = ["/login", "/logout", "id.spectrum.net", "/signin", "/error/session-expired"];
  const IDLE = ["your session is about to expire", "session is about to time out", "are you still there",
    "your session has expired", "session timed out", "you have been signed out"];
  const OTP = ["one-time passcode", "one time passcode", "one-time code", "verification code", "enter the code", "we sent a code"];
  const CHALLENGE = ["are you a robot", "captcha", "access denied", "unusual activity"];
  const RATE_LIMIT = ["too many requests", "rate limit", "try again later", "temporarily unavailable", "http error 429"];
  const BENIGN = /this info is currently not available\. please try again later\./g;
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const ROW = new RegExp(`^Statement (${MONTHS.join("|")}) (\\d{1,2}), (\\d{4})\\b`);
  const NO_SAVE = "Spectrum sends each statement only to its own page, which opens it in a new tab instead of starting a download, so nothing here can save it. Nothing was pressed.";

  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const bodyText = (limit) => ((document.body && document.body.innerText) || "").slice(0, limit).toLowerCase();
  const stop = (why, listed = []) => ({ state: "stopped", why, docs: [], listed });

  function rowDay(text) {
    const m = ROW.exec(tidy(text));
    if (!m) return null;
    const month = MONTHS.indexOf(m[1]), day = +m[2], year = +m[3];
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
    return d.toISOString().slice(0, 10);
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

  // The dates of the rows reading "Statement ...", or null for one this
  // cannot read.
  function rowDays() {
    const days = [];
    for (const a of document.querySelectorAll(ROW_CSS)) {
      if (!/^\s*statement\b/i.test(a.innerText || "")) continue;
      const day = rowDay(a.innerText);
      if (!day) return null;
      days.push(day);
    }
    return days;
  }

  async function readList() {
    if (signedOut()) return { state: "signed_out" };
    const word = pageWord();
    if (word === "challenge") return { state: "challenge" };
    if (word === "rate") return stop("Spectrum says to try again later.");
    if (location.pathname.replace(/\/$/, "") !== "/billing/statements") return { state: "no_list" };
    let days = rowDays();
    for (let waited = 0; days && !days.length && waited < 10000; waited += 250) {
      await sleep(250);
      if (signedOut()) return { state: "signed_out" };
      days = rowDays();
    }
    if (!days) return stop("A statement row has no date this can read.");
    if (!days.length) return stop("The Statements page shows no statements.");
    days.sort().reverse();
    return stop(`${days.length} statement(s) are listed. ${NO_SAVE}`, days);
  }

  globalThis.__sweep = { readList };
})();
