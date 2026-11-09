// Runs inside TreasuryDirect's own page. It reads the page and nothing else:
// it presses nothing, opens nothing and asks the site for nothing.
//
// TreasuryDirect has no PDFs, so PaperPull renders each page from the tab it
// is already on, and moves only by the page's own links. Every saving route
// open here (print included) opens the page's address, and TreasuryDirect ends
// the session when a page is opened that way, so this never offers a document.
// It says where the person stands, and why nothing can be saved.
//
// Derived from PaperPull's apps/treasurydirect/treasurydirect_site.py (AGPL-3.0).
(() => {
  const SIGNED_IN_HOST = "www.treasurydirect.gov";
  const GATEWAY_PATH = "/RS/RSGatewayRW";
  const HOSTS = [SIGNED_IN_HOST, "treasurydirect.gov"];
  const LOGIN_MARKERS = ["/log-in", "authorization.oauth2", "/rs/un-display", "/rs/pw-display"];
  const SIGNED_OUT_WORDS = ["treasurydirect is unavailable", "you have been logged out", "you have been signed out",
    "session has expired", "session has timed out", "your session timed out"];
  const CODE_WORDS = ["one-time passcode", "one time passcode", "security question", "verification code", "enter the code", "we sent a code"];
  const CHECK_WORDS = ["captcha", "are you a robot", "verify your identity", "confirm your identity", "access denied"];
  const SLOW_WORDS = ["too many requests", "rate limit", "try again later", "temporarily unavailable", "http error 429", "unusual traffic"];
  const TABS = {
    "My Account": "misc.DisplayWelcome",
    "Current Holdings": "ch.DisplayCurrentHoldings",
    "ManageDirect®": "md.DisplayManageDirect",
    History: "hist.DisplayHistory",
  };
  const TAXES = /^\s*manage\s+my\s+taxes\s*$/i;
  const NO_TAX_YEAR = /^year\s+((?:19|20)[0-9]{2})\s*\(\s*no\s+taxable\s+transactions\s*\)$/i;
  const TAX_YEAR_LINK = /^year\s+((?:19|20)[0-9]{2})$/i;
  const WHY = "TreasuryDirect has no PDFs, and it ends the session when a page is opened by its address, "
    + "which is the only way this can print one. So nothing was saved here, and your session was left alone.";

  const squash = (text) => (text || "").replace(/\s+/g, " ").trim();
  const words = () => `${document.title}\n${(document.body && document.body.innerText) || ""}`.toLowerCase();

  function handlerOf(href) {
    let values;
    try { values = new URL(href, location.href).searchParams.getAll("UIHandler"); } catch (e) { return ""; }
    return values.length === 1 && /^[A-Za-z]+\.[A-Za-z0-9]+$/.test(values[0]) ? values[0] : "";
  }

  function hasTabs() {
    const links = Array.from(document.querySelectorAll("a[href]")).map((a) => [squash(a.textContent), handlerOf(a.getAttribute("href"))]);
    return Object.entries(TABS).every(([label, handler]) => links.some(([l, h]) => l === label && h === handler));
  }

  function askingForCode(tabs, text) {
    if (tabs) return false;
    const answer = Array.from(document.querySelectorAll("input, textarea"))
      .some((el) => el.tagName === "TEXTAREA" || ["text", "password", "tel", "number", "email"].includes((el.getAttribute("type") || "text").toLowerCase()));
    return answer && CODE_WORDS.some((w) => text.includes(w));
  }

  // The years ManageDirect's tax list shows with a 1099 to save by hand.
  function taxableYears() {
    const years = [];
    let section = "";
    for (const el of document.querySelectorAll("h1, h2, h3, h4, h5, h6, legend, caption, li")) {
      if (el.tagName !== "LI") { section = squash(el.textContent); continue; }
      if (!TAXES.test(section)) continue;
      const text = squash(el.textContent);
      if (NO_TAX_YEAR.test(text) && !el.querySelector("a")) continue;
      const year = TAX_YEAR_LINK.exec(text);
      if (year && el.querySelector("a")) years.push(year[1]);
    }
    return years;
  }

  function readList() {
    if (location.protocol !== "https:" || !HOSTS.includes(location.hostname)) return { state: "stopped", why: "This tab is not on TreasuryDirect.", docs: [] };
    const text = words();
    if (LOGIN_MARKERS.some((m) => location.href.toLowerCase().includes(m))
        || document.querySelector("input[type='password']")
        || SIGNED_OUT_WORDS.some((w) => text.includes(w))) {
      return { state: "signed_out" };
    }
    const tabs = hasTabs();
    if (askingForCode(tabs, text)) return { state: "challenge" };
    const lead = text.slice(0, 3000);
    if (CHECK_WORDS.some((w) => lead.includes(w))) return { state: "challenge" };
    if (SLOW_WORDS.some((w) => lead.includes(w))) return { state: "stopped", why: "TreasuryDirect says to try again later.", docs: [] };
    const onGateway = location.hostname === SIGNED_IN_HOST && location.pathname === GATEWAY_PATH;
    // Never no_list on this site: that answer sends the tab to another
    // address, which would end a session it is signed in to.
    if (!onGateway) return { state: "stopped", why: "This tab is not on your TreasuryDirect account. Sign in there, and leave it on your account.", docs: [] };
    if (!tabs) return { state: "stopped", why: "This is not a signed-in TreasuryDirect page with its top tabs.", docs: [] };
    const years = taxableYears();
    const more = years.length ? ` ManageDirect lists a 1099 for ${years.join(", ")}, to save by hand.` : "";
    return { state: "stopped", why: WHY + more, docs: [] };
  }

  globalThis.__sweep = { readList };
})();
