// Runs inside NetBenefits, where the sign-in already lives. It presses
// nothing, changes nothing, and asks the site for nothing.
//
// Derived from PaperPull's apps/netbenefits/netbenefits_site.py (AGPL-3.0).
//
// NetBenefits keeps no archive of statements. Each one is built on request by
// a POST, and the answer has no address of its own to come back to. This
// extension prints only a page that has an address, so this knows when you
// are signed in and on the right site, and then stops and says why.
(() => {
  const STATEMENTS_HOST = "workplaceservices.fidelity.com";
  const LOGIN_URL_MARKERS = ["/login", "/logon", "/signin", "/sign-in", "/mfa", "/verify", "/onboarding"];
  const CHALLENGE_MARKERS = [
    "one-time passcode", "one time passcode", "enter the code", "verification code",
    "we sent a code", "text message", "authenticator", "confirm your identity",
    "verify your identity", "are you a robot", "captcha", "access denied",
    "your session has expired", "session timed out", "signed out",
  ];
  const RATE_LIMIT_MARKERS = ["too many requests", "rate limit", "try again later",
    "temporarily unavailable", "unusual traffic"];

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN_URL_MARKERS.some((m) => url.includes(m))
      || Boolean(document.querySelector("input[type='password']"));
  }

  function readList() {
    if (signedOut()) return { state: "signed_out" };
    const body = (document.body && document.body.innerText) || "";
    const screen = `${document.title}\n${body.slice(0, 2000)}`.toLowerCase();
    if (CHALLENGE_MARKERS.some((m) => screen.includes(m))) return { state: "challenge" };
    if (RATE_LIMIT_MARKERS.some((m) => screen.includes(m))) {
      return { state: "stopped", why: "NetBenefits says to slow down and try later.", docs: [] };
    }
    if (location.protocol !== "https:" || location.hostname !== STATEMENTS_HOST) return { state: "no_list" };
    return {
      state: "stopped",
      why: "NetBenefits builds each statement when it is asked, as a page with no address of its own, and this extension can only print a page that has one.",
      docs: [],
    };
  }

  globalThis.__sweep = { readList };
})();
