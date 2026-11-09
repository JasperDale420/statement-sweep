// Runs inside Schwab's client site, where the sign-in already lives. It
// presses nothing, changes nothing, and asks the site for nothing.
//
// Derived from PaperPull's apps/schwab/schwab_site.py (AGPL-3.0).
//
// Schwab's accounts, document list and PDFs all come from its gateway,
// ausgateway.schwab.com, which is another origin from this page. This
// extension asks only the page's own origin, so this recognises the page and
// then stops and says why. The page's own row buttons are not pressed:
// PaperPull stays off them on purpose, since the page shares its shell with a
// trade ticket.
(() => {
  const HOST = "client.schwab.com";
  const LOGIN_URL_MARKERS = ["/areas/access/login", "/areas/login/", "sessiontimeout=",
    "/login", "/logon", "/signin", "/sign-in", "/mfa", "www.schwab.com/"];
  const CHALLENGE_MARKERS = [
    "enter the code we sent", "enter your verification code", "verification code",
    "one-time", "one time passcode", "security code", "we sent a code",
    "two-factor", "two-step", "authenticator", "confirm your identity",
    "verify your identity", "we need to verify", "unusual activity",
    "are you a robot", "captcha", "unable to verify", "trouble verifying",
    "your session has expired", "please log in again", "you've been logged out",
    "for your security, we signed you out", "for your security we've signed",
  ];
  const RATE_LIMITS = [
    /too many requests/i,
    /rate limit(ed|ing)?\b/i,
    /unusual traffic/i,
    /\b(http\s*)?(error\s*)?429\b/i,
    /(site|service|page|system|application)\s+(is\s+)?(currently\s+|temporarily\s+)*unavailable/i,
    /we'?re\s+(currently\s+)?(experiencing|having)\s+(technical\s+)?(difficulties|issues)/i,
  ];
  const WAIT_MS = 10000;

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN_URL_MARKERS.some((m) => url.includes(m))
      || Boolean(document.querySelector("input[type='password']"));
  }

  // Only the page's own path counts, never an address named in its query, as
  // a sign-in page's return address is.
  function onStatementsPath() {
    const path = location.pathname.toLowerCase();
    return location.protocol === "https:" && location.hostname === HOST
      && (path.includes("/app/accounts/statements") || path.includes("/retail/accounts/statements"));
  }

  const titled = () => document.title.toLowerCase().includes("statements");

  async function readList() {
    if (signedOut()) return { state: "signed_out" };
    if (onStatementsPath()) {
      // The page names itself a moment after it loads.
      const until = Date.now() + WAIT_MS;
      while (!titled() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 250));
      if (signedOut()) return { state: "signed_out" };
    }
    if (onStatementsPath() && titled()) {
      return {
        state: "stopped",
        why: "Schwab sends its documents from ausgateway.schwab.com, another address from this page, and this extension only asks the page's own.",
        docs: [],
      };
    }
    const body = (document.body && document.body.innerText) || "";
    const screen = `${document.title}\n${body.slice(0, 1500)}`.toLowerCase();
    if (CHALLENGE_MARKERS.some((m) => screen.includes(m))) return { state: "challenge" };
    if (RATE_LIMITS.some((re) => re.test(screen))) {
      return { state: "stopped", why: "Schwab says it is busy or asks to slow down.", docs: [] };
    }
    return { state: "no_list" };
  }

  globalThis.__sweep = { readList };
})();
