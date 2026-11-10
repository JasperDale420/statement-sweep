// Runs inside TreasuryDirect's own page. It reads the page, and in a tab the
// sweep opened it presses the page's own links, one at a time, and nothing
// else. It never opens an address: TreasuryDirect ends the session when a
// page is opened by its address, or by Back, Forward or Refresh.
//
// TreasuryDirect has no PDFs. Each document is a page of the signed-in site,
// printed by Chrome as it stands in the sweep's own tab (method "print"):
//   - Current Holdings (ch.DisplayCurrentHoldings), its summary page only;
//   - Security History (sechist.DisplaySecurityHistory) and Payment History
//     (payhist.DisplayPaymentHistorySummary), reached from History
//     (hist.DisplayHistory), as they first show.
// Each is a snapshot of the account, dated the day it is taken, one per day,
// with PaperPull's ids: "holdings-YYYY-MM-DD", "security-history-YYYY-MM-DD",
// "payment-history-YYYY-MM-DD".
//
// What is pressed, and only these: a link whose visible label AND whose one
// UIHandler are exactly one of the top tabs (My Account, Current Holdings,
// ManageDirect®, History) or one of History's two links (Security History,
// Payment History), that leads to the signed-in address on
// www.treasurydirect.gov, that is the only such link on the page, shown and
// not covered, and whose label and handler pass PaperPull's blocklists. The
// press is the anchor's own click(), as a person's click, and whatever the
// site does with that click (its own GET, or its own script posting its own
// form) is the site's. Nothing here submits a form, sets a field, or opens,
// assigns or fetches an address.
//
// The list is read from ManageDirect, whose Manage My Taxes list is read for
// each taxable year's 1099. A 1099 is never pressed to, since its page has
// never been surveyed, so it is named for saving by hand.
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
  const HISTORY_LINKS = {
    "Security History": "sechist.DisplaySecurityHistory",
    "Payment History": "payhist.DisplayPaymentHistorySummary",
  };
  // Each page's own h1, so a press is known to have landed where it was meant to.
  const HEADINGS = {
    "ch.DisplayCurrentHoldings": /^current\s+holdings$/i,
    "md.DisplayManageDirect": /^managedirect®?$/i,
    "hist.DisplayHistory": /^history$/i,
    "sechist.DisplaySecurityHistory": /^history\s*»\s*security\s+history$/i,
    "payhist.DisplayPaymentHistorySummary": /^history\s*»\s*payment\s+history$/i,
    "misc.DisplayWelcome": /^welcome\s+to\s+your\s+account\s+summary\b/i,
  };
  // The documents, in PaperPull's order. `via` is the tab pressed first.
  const KINDS = {
    holdings: { title: "Current Holdings", handler: TABS["Current Holdings"], via: "" },
    "security-history": { title: "Security History", handler: HISTORY_LINKS["Security History"], via: "History" },
    "payment-history": { title: "Payment History", handler: HISTORY_LINKS["Payment History"], via: "History" },
  };
  const DOC_ID = /^(holdings|security-history|payment-history)-([0-9]{4}-[0-9]{2}-[0-9]{2})$/;
  const TAXES = /^\s*manage\s+my\s+taxes\s*$/i;
  const NO_TAX_YEAR = /^year\s+((?:19|20)[0-9]{2})\s*\(\s*no\s+taxable\s+transactions\s*\)$/i;
  const TAX_YEAR_LINK = /^year\s+((?:19|20)[0-9]{2})$/i;
  const ACCOUNT_LINE = /['’]s[ \t]+account\s*:?\s*(\b[A-Z]-?[0-9]{3}-?[0-9]{3}-?[0-9]{3}\b)/g;
  const LISTING_LABEL = /^return\s+to\s+account\s+listing$/i;
  const LISTING_HANDLER = /multiaccount/i;
  // PaperPull's blocklists, a second wall behind the allowlists above.
  const FORBIDDEN_CONTROL = new RegExp("(\\bbuy|\\bpurchas|\\bredeem|\\bredemption|\\bcash\\s+(in|out)\\b|\\bconvert|\\bconversion\\b|"
    + "\\btransfer|\\bgift|\\bdeliver|\\breinvest|\\bschedul|\\bpayroll\\b|\\bc\\s+of\\s+i\\b|"
    + "\\bcertificate\\s+of\\s+indebtedness\\b|\\bbank|\\bwithdraw|\\bdeposit|\\bfunding\\b|\\bregistration\\b|"
    + "\\bbeneficiar|\\bsign\\s*(out|off)\\b|\\blog\\s*(out|off)\\b|\\blogoff\\b|\\blogout\\b|\\bsettings?\\b|"
    + "\\bprofile\\b|\\bpreferences?\\b|\\bpassword\\b|\\bsecurity\\s+questions?\\b|\\bpersonal\\s+information\\b|"
    + "\\bsave\\b|\\bsubmit\\b|\\bconfirm\\b|\\bcontinue\\b|\\bdelet|\\bde-?link|\\bremov|\\bcancel\\b|\\bedit|"
    + "\\bupdat|\\bchang|\\bmanage\\b|\\blinked\\b|\\bcustom\\b|\\bminor\\b|\\bestablish|\\bopen\\s+(an?\\s+)?account\\b|"
    + "\\bclose\\b|\\bupload\\b|\\bemail\\b|\\bshare|\\bagree\\b|\\baccept\\b|\\bapprove|\\bauthori[sz]e\\b|\\bverify\\b|"
    + "\\bsell\\b|\\border\\b|\\bwithholding\\b|\\bw-?9\\b|\\binbox\\b|\\brights\\b|\\baccount\\s+listing\\b|"
    + "\\baccount\\s+info|\\bpending\\b|\\bhere\\b|\\bcontact\\b|\\bmytreasury\\b)", "i");
  const FORBIDDEN_HANDLER = new RegExp("^(bd|gb|bank|al|la|ac|tr|trfrmyt|pt|ai|cofihist|psphist)\\.|"
    + "(exit|logoff|logout|multiaccount|buy|redeem|redemption|transfer|gift|bank|edit|change|delete|"
    + "delink|create|register|registration|reinvest|schedule|rights|funding|inbox|contactus|cancel|"
    + "submit|confirm|approve|accept|agree|process|send|request|update|remove|withhold)", "i");
  const PLAN_KEY = "__sweepTreasuryDirect";
  const PLAN_AGE_MS = 30 * 60 * 1000;
  const PRESS_WAIT_MS = 30000;
  const DRAW_WAIT_MS = 15000;
  const SALT = "statement sweep treasurydirect account";

  const SIGNED_OUT = "TreasuryDirect signed you out. Sign in in its tab, then run it again.";
  const CHECK = "TreasuryDirect is asking you to confirm something. Finish it in its tab, then run it again.";
  const SLOW = "TreasuryDirect says to try again later.";
  const OFF = "This tab is not on your TreasuryDirect account. Sign in there, and leave it on your account.";
  const NO_TABS = "This is not a signed-in TreasuryDirect page with its top tabs.";
  const OTHER = "This tab is on another TreasuryDirect account than the one listed, so nothing was saved. Run it again.";
  const MISSED = "TreasuryDirect opened a page other than the one meant, so nothing was saved.";
  const STILL = "TreasuryDirect did not open the page after the press.";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const squash = (text) => (text || "").replace(/\s+/g, " ").trim();
  const trace = (text) => { try { if (typeof globalThis.__sweepLog === "function") globalThis.__sweepLog(text); } catch (e) { /* never stops a sweep */ } };
  // For the log: the top-tab-like links on the page, label and handler only.
  const tabsSeen = () => Array.from(document.querySelectorAll("a[href*='UIHandler=']")).slice(0, 14)
    .map((a) => `${squash(a.textContent).slice(0, 24)}=${handlerOf(a.getAttribute("href")) || "?"}`).join(", ");
  const bodyText = () => (document.body && document.body.innerText) || "";
  const words = () => `${document.title}\n${bodyText()}`.toLowerCase();
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  function handlerOf(href) {
    let values;
    try { values = new URL(href || "", location.href).searchParams.getAll("UIHandler"); } catch (e) { return ""; }
    return values.length === 1 && /^[A-Za-z]+\.[A-Za-z0-9]+$/.test(values[0]) ? values[0] : "";
  }
  function isSignedInUrl(href) {
    let url;
    try { url = new URL(href, location.href); } catch (e) { return false; }
    return url.protocol === "https:" && url.hostname === SIGNED_IN_HOST && !url.port && !url.username && url.pathname === GATEWAY_PATH;
  }
  const links = () => Array.from(document.querySelectorAll("a[href]"));

  function hasTabs() {
    const seen = links().map((a) => [squash(a.textContent), handlerOf(a.getAttribute("href"))]);
    return Object.entries(TABS).every(([label, handler]) => seen.some(([l, h]) => l === label && h === handler));
  }
  function askingForCode(tabs, text) {
    if (tabs) return false;
    const answer = Array.from(document.querySelectorAll("input, textarea"))
      .some((el) => el.tagName === "TEXTAREA" || ["text", "password", "tel", "number", "email"].includes((el.getAttribute("type") || "text").toLowerCase()));
    return answer && CODE_WORDS.some((w) => text.includes(w));
  }
  const headingIs = (handler) => {
    const rx = HEADINGS[handler];
    return Boolean(rx) && Array.from(document.querySelectorAll("h1")).some((h) => rx.test(squash(h.textContent)));
  };
  const isOn = (handler) => handlerOf(location.href) === handler && headingIs(handler);

  // Where the tab stands: signed_out, challenge, slow, off, notabs, or in.
  function where() {
    if (location.protocol !== "https:" || !HOSTS.includes(location.hostname)) return "off";
    const text = words();
    if (LOGIN_MARKERS.some((m) => location.href.toLowerCase().includes(m))
        || document.querySelector("input[type='password']")
        || SIGNED_OUT_WORDS.some((w) => text.includes(w))) return "signed_out";
    const tabs = hasTabs();
    if (askingForCode(tabs, text)) return "challenge";
    const lead = text.slice(0, 3000);
    if (CHECK_WORDS.some((w) => lead.includes(w))) return "challenge";
    if (SLOW_WORDS.some((w) => lead.includes(w))) return "slow";
    if (location.hostname !== SIGNED_IN_HOST || location.pathname !== GATEWAY_PATH) return "off";
    return tabs ? "in" : "notabs";
  }
  const whyOf = (state) => ({ signed_out: SIGNED_OUT, challenge: CHECK, slow: SLOW, off: OFF, notabs: NO_TABS })[state] || NO_TABS;

  // The account the page is on, as a digest of the number its account line
  // shows, never the number itself; "" for a sign-in of one account whose
  // pages name none.
  async function digest(number) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(number), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(SALT), iterations: 200000 }, key, 48);
    return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function accountOf() {
    const numbers = [...new Set([...squash(bodyText()).matchAll(ACCOUNT_LINE)].map((m) => m[1].replace(/-/g, "").toUpperCase()))];
    if (numbers.length > 1) return { why: "This TreasuryDirect page names more than one account, so nothing was saved." };
    if (numbers.length) return { account: await digest(numbers[0]) };
    const several = links().some((a) => LISTING_LABEL.test(squash(a.textContent)) || LISTING_HANDLER.test(handlerOf(a.getAttribute("href"))));
    if (several) return { why: "Your sign-in holds several TreasuryDirect accounts and this page names none of them. Open one account, then run it again." };
    return { account: "" };
  }

  // What a walk or a document has pressed, kept in this tab's session
  // storage, since each press loads a new page. No account data is kept.
  function loadPlan() {
    try {
      const p = JSON.parse(sessionStorage.getItem(PLAN_KEY) || "null");
      return p && typeof p.at === "number" && Date.now() - p.at < PLAN_AGE_MS ? p : null;
    } catch (e) { return null; }
  }
  const savePlan = (p) => { try { sessionStorage.setItem(PLAN_KEY, JSON.stringify({ ...p, at: Date.now() })); } catch (e) { /* not kept */ } };
  const dropPlan = () => { try { sessionStorage.removeItem(PLAN_KEY); } catch (e) { /* not there */ } };
  // A press made from this very page, whose next page has not come yet.
  const pressedAt = () => (typeof globalThis.__treasuryDirectPressed === "number" ? globalThis.__treasuryDirectPressed : 0);

  const safeControl = (label) => {
    const name = squash(label);
    return Boolean(name) && !FORBIDDEN_CONTROL.test(name) && (name in TABS || name in HISTORY_LINKS);
  };
  const safeHandler = (handler) => Boolean(handler) && !FORBIDDEN_HANDLER.test(handler)
    && (Object.values(TABS).includes(handler) || Object.values(HISTORY_LINKS).includes(handler));

  // Presses the page's own link, labelled `label` and naming `handler`, once.
  function press(label, handler) {
    const name = label.replace(/®$/, "");
    if (!safeControl(label) || !safeHandler(handler) || (TABS[label] || HISTORY_LINKS[label]) !== handler) {
      return { ok: false, why: "That is not a link this presses." };
    }
    const found = links().filter((a) => squash(a.textContent) === label && handlerOf(a.getAttribute("href")) === handler);
    if (found.length !== 1) return { ok: false, why: `TreasuryDirect's ${name} link was not on the page once, so nothing was pressed.` };
    const a = found[0];
    const raw = (a.getAttribute("href") || "").trim();
    if (!raw || /^(javascript|data):/i.test(raw) || raw.startsWith("#") || !isSignedInUrl(raw)) {
      return { ok: false, why: `TreasuryDirect's ${name} link leads off your account's pages, so it was not pressed.` };
    }
    const target = (a.getAttribute("target") || "").toLowerCase();
    if (target && target !== "_self") return { ok: false, why: `TreasuryDirect's ${name} link opens another window, so it was not pressed.` };
    a.scrollIntoView({ block: "center", inline: "nearest" });
    const box = a.getBoundingClientRect();
    if (!box.width || !box.height) return { ok: false, why: `TreasuryDirect's ${name} link is not shown, so it was not pressed.` };
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (!top || (top !== a && !a.contains(top))) return { ok: false, why: `Something covers TreasuryDirect's ${name} link, so it was not pressed.` };
    globalThis.__treasuryDirectPressed = Date.now();
    a.click();
    return { ok: true };
  }

  // Waits while a page is drawn without its top tabs yet.
  async function drawn() {
    const until = Date.now() + DRAW_WAIT_MS;
    for (;;) {
      const state = where();
      if (state !== "notabs" || Date.now() >= until) return state;
      await sleep(250);
    }
  }

  // The kind of a doc this listed today, or {why}.
  function kindOf(doc) {
    const m = DOC_ID.exec((doc && doc.id) || "");
    if (!m || doc.method !== "print" || doc.date !== m[2]) return { why: "This is not a TreasuryDirect document this lists." };
    // A snapshot shows the account as it is when taken, so one listed on
    // another day is never taken under that day's name.
    if (m[2] !== today()) return { why: "This TreasuryDirect page was listed on another day. Run it again." };
    return { kind: m[1] };
  }

  function snapshots(account) {
    const day = today();
    return Object.entries(KINDS).map(([kind, k]) => ({ id: `${kind}-${day}`, date: day, title: k.title, method: "print", account }));
  }

  // The tax years ManageDirect's Manage My Taxes list offers a 1099 for,
  // newest first, or {why}.
  function taxYears() {
    let section = "";
    let sawSection = false;
    const items = [];
    for (const el of document.querySelectorAll("h1, h2, h3, h4, h5, h6, legend, caption, li")) {
      if (el.tagName !== "LI") {
        section = squash(el.textContent);
        if (TAXES.test(section)) sawSection = true;
        continue;
      }
      if (TAXES.test(section)) items.push(el);
    }
    if (!sawSection) return { why: "ManageDirect shows no Manage My Taxes section, so its tax forms were not read." };
    if (!items.length) return { why: "Manage My Taxes lists no tax year, so its tax forms were not read." };
    const years = [];
    for (const el of items) {
      const text = squash(el.textContent);
      const inside = Array.from(el.querySelectorAll("a"));
      if (NO_TAX_YEAR.test(text) && !inside.length) continue;
      const m = TAX_YEAR_LINK.exec(text);
      if (!m || inside.length !== 1 || squash(inside[0].textContent) !== text) return { why: "A Manage My Taxes item does not read as a tax year, so its tax forms were not read." };
      const handler = handlerOf(inside[0].getAttribute("href"));
      if (!handler || FORBIDDEN_HANDLER.test(handler)) return { why: "A Manage My Taxes year opens a page this does not know, so its tax forms were not read." };
      years.push(m[1]);
    }
    if (new Set(years).size !== years.length) return { why: "Manage My Taxes lists one tax year twice, so its tax forms were not read." };
    return { years: years.sort().reverse() };
  }

  async function readList({ walk = false } = {}) {
    // Straight after sign-in the gateway page is still drawing: wait for its
    // top tabs (up to DRAW_WAIT_MS) before deciding it is not a signed-in page.
    const state = await drawn();
    if (state !== "in") trace(`Page state ${state} at ${location.pathname} after waiting for the top tabs; links seen: ${tabsSeen() || "none"}.`);
    if (state === "signed_out") return { state: "signed_out" };
    if (state === "challenge") return { state: "challenge" };
    // Never no_list on this site: that answer sends the tab to another
    // address, which would end a session it is signed in to.
    if (state !== "in") return { state: "stopped", why: whyOf(state), docs: [] };
    // A read for a tab of yours, or the first look at a kept tab, ends any
    // walk an earlier run left behind.
    if (!walk) dropPlan();
    if (pressedAt()) {
      if (walk && Date.now() - pressedAt() < PRESS_WAIT_MS) return { state: "walking" };
      dropPlan();
      return { state: "stopped", why: "TreasuryDirect's ManageDirect page did not open, so nothing was read.", docs: [] };
    }
    const acct = await accountOf();
    if (acct.why) return { state: "stopped", why: acct.why, docs: [] };
    const docs = snapshots(acct.account);
    if (isOn(TABS["ManageDirect®"])) {
      const plan = loadPlan();
      dropPlan();
      if (plan && plan.step === "md" && plan.account !== acct.account) {
        return { state: "stopped", why: "ManageDirect showed another TreasuryDirect account than the page the sweep began on. Run it again.", docs: [] };
      }
      const tax = taxYears();
      if (tax.why) return { state: "stopped", why: tax.why, docs };
      const note = tax.years.length ? `ManageDirect lists a 1099 for ${tax.years.join(", ")}. Save it by hand from Manage My Taxes.` : "";
      return { state: "ok", docs, ...(note ? { note } : {}) };
    }
    // Signed in here, in a tab the sweep did not open. Opening TreasuryDirect
    // in a second tab would end this sign-in, so ask to carry on in this one.
    if (!walk) return { state: "ready", why: "Signed in to TreasuryDirect in this tab." };
    const plan = loadPlan();
    if (plan && plan.step === "md") {
      dropPlan();
      return { state: "stopped", why: "TreasuryDirect did not open ManageDirect, so its tax forms were not read.", docs };
    }
    savePlan({ step: "md", account: acct.account });
    const pressed = press("ManageDirect®", TABS["ManageDirect®"]);
    if (!pressed.ok) {
      dropPlan();
      return { state: "stopped", why: pressed.why, docs };
    }
    return { state: "walking" };
  }

  // Brings the document on screen by the page's own links: its top tab, or
  // History then the history's own link (the second press is printReady's).
  async function showDoc(doc) {
    const { kind, why } = kindOf(doc);
    if (why) return { ok: false, why };
    if (pressedAt()) return { ok: false, why: "TreasuryDirect was still opening a page. Run it again." };
    const state = await drawn();
    if (state !== "in") return { ok: false, why: whyOf(state) };
    const acct = await accountOf();
    if (acct.why) return { ok: false, why: acct.why };
    if (acct.account !== (doc.account || "")) return { ok: false, why: OTHER };
    const k = KINDS[kind];
    if (isOn(k.handler)) {
      savePlan({ id: doc.id, step: "there" });
      return { ok: true };
    }
    let label = k.title;
    let handler = k.handler;
    let step = k.via ? "sub" : "tab";
    if (k.via && !isOn(TABS[k.via])) {
      label = k.via;
      handler = TABS[k.via];
      step = "via";
    }
    savePlan({ id: doc.id, step });
    const pressed = press(label, handler);
    if (!pressed.ok) dropPlan();
    return pressed;
  }

  // Ready only on the document's own page, whole, of the account listed.
  async function printReady(doc) {
    const { kind, why } = kindOf(doc);
    if (why) return { ok: false, why };
    if (pressedAt()) {
      return Date.now() - pressedAt() < PRESS_WAIT_MS ? { ready: false, why: STILL } : { ok: false, why: STILL };
    }
    const state = where();
    if (state === "notabs") return { ready: false, why: NO_TABS };
    if (state !== "in") return { ok: false, why: whyOf(state) };
    const k = KINDS[kind];
    const plan = loadPlan();
    if (isOn(k.handler)) {
      if (document.readyState !== "complete") return { ready: false };
      const acct = await accountOf();
      if (acct.why) return { ok: false, why: acct.why };
      if (acct.account !== (doc.account || "")) return { ok: false, why: OTHER };
      return { ready: true };
    }
    // History came, from this document's own press: now its history's link.
    if (k.via && plan && plan.id === doc.id && plan.step === "via" && isOn(TABS[k.via])) {
      const acct = await accountOf();
      if (acct.why) return { ok: false, why: acct.why };
      if (acct.account !== (doc.account || "")) return { ok: false, why: OTHER };
      savePlan({ id: doc.id, step: "sub" });
      const pressed = press(k.title, k.handler);
      if (!pressed.ok) {
        dropPlan();
        return { ok: false, why: pressed.why };
      }
      return { ready: false };
    }
    return { ok: false, why: MISSED };
  }

  // Back to My Account by its own top tab, once the page has been printed.
  async function leaveDoc() {
    dropPlan();
    if (pressedAt()) return { ok: true };
    const state = where();
    if (state !== "in") return { ok: false, stayed: true, why: whyOf(state) };
    if (isOn(TABS["My Account"])) return { ok: true, stayed: true };
    const leaving = new Promise((resolve) => addEventListener("pagehide", () => resolve(true), { once: true }));
    const pressed = press("My Account", TABS["My Account"]);
    if (!pressed.ok) return { ...pressed, stayed: true };
    // Answered as the next page comes, so the sweep then waits for it.
    const went = await Promise.race([leaving, sleep(PRESS_WAIT_MS).then(() => false)]);
    return went ? { ok: true } : { ok: false, stayed: true, why: "TreasuryDirect's My Account page did not open." };
  }

  globalThis.__sweep = { readList, showDoc, printReady, leaveDoc };
})();
