// Runs inside NetBenefits, where the sign-in already lives.
//
// Derived from PaperPull's apps/netbenefits/netbenefits_site.py (AGPL-3.0).
//
// NetBenefits keeps no archive of statements. Its Statements page is a
// generator: it builds a statement on request, as a web page, from a POST
// with no address of its own. So this does what PaperPull does, and nothing
// more:
//
//   * The list. For each finished quarter, newest first, back to 2016 (the
//     oldest year the page's own picker offers), it asks the site for that
//     quarter's statement exactly as PaperPull does: a GET of the session's
//     transaction token (/mybenefits/employerservices/api/txntoken) and a
//     same-origin POST to /mybenefits/savings2/sod/soddetail with the six
//     fields txntoken, sodReqIndicator=HACK, dateRange=MM/DD/YYYY-MM/DD/YYYY,
//     ytdDateRange (empty), sodPreview=N and consentReq=N. That is the
//     statement request the page itself sends, and it only reads. The answer
//     is read for its title and period, never shown, and the walk stops at
//     the first quarter the site refuses after a real statement, since a
//     plan has one start.
//   * showDoc. The same token GET, then those same six fields posted by a
//     hidden form this adds to the page, so the statement comes up in this
//     tab. No control of the site is pressed.
//   * printReady. The tab is on the statement page this asked for, its
//     "Statement Period" is that quarter's, and its images and fonts are in.
//   * leaveDoc. Back to the Statements address, the page the site's own
//     Statements link opens.
//
// A sign-in with several plans: the "Choose a Plan" page is read (a GET, as
// PaperPull reads it), each plan is one view, and a plan is chosen the way
// PaperPull chooses it, by asking for that plan's own Statements address
// from inside the page (same-origin, so a redirect to another host is
// refused). The tab then loads the Statements address, and that page must
// show the plan's statement form and a heading naming the plan and its
// number, or the plan is left for you. A statement is made only while the
// tab shows its plan. The employer chooser is never used. Plan numbers are
// never part of an id or a file name: a plan is known by the SHA-256 of
// "plan:<number>", as PaperPull keys it.
(() => {
  const HOST = "workplaceservices.fidelity.com";
  const ORIGIN = `https://${HOST}`;
  const STATEMENTS_PATH = "/mybenefits/savings2/navigation/dc/OnlineStatement";
  const CHOOSER_PATH = "/mybenefits/definedcontributions/navigation/dc/OnlineStatement?planChooser=yes";
  const TOKEN_PATH = "/mybenefits/employerservices/api/txntoken";
  const STATEMENT_PATH = "/mybenefits/savings2/sod/soddetail";
  const FIRST_YEAR = 2016;
  const TITLE = "Quarterly Statement";
  const WALK_KEY = "__sweepNetBenefitsWalk";
  const ASKED_KEY = "__sweepNetBenefitsAsked";
  const WALK_AGE_MS = 3 * 60 * 60 * 1000;
  const ASKED_AGE_MS = 10 * 60 * 1000;
  const PAUSE_MS = 200;

  const LOGIN_URL_MARKERS = ["/login", "/logon", "/signin", "/sign-in", "/mfa", "/verify", "/onboarding"];
  const CHALLENGE_MARKERS = [
    "one-time passcode", "one time passcode", "enter the code", "verification code",
    "we sent a code", "text message", "authenticator", "confirm your identity",
    "verify your identity", "are you a robot", "captcha", "access denied",
    "your session has expired", "session timed out", "signed out",
  ];
  const RATE_LIMIT_MARKERS = ["too many requests", "rate limit", "try again later",
    "temporarily unavailable", "unusual traffic"];

  const SIGNED_OUT = "NetBenefits signed you out. Sign in again, then sweep again.";
  const YOUR_TAB = "NetBenefits makes each statement on request, and this does that only in a tab it opened itself.";

  // Why a plan was left for you. Fixed words, never an address.
  const LEAVES_THE_SITE = "its address leaves the NetBenefits statements page";
  const REDIRECTS = "its statements address sends you elsewhere";
  const NOT_ITS_PAGE = "its address did not answer as a plan of this site";
  const DID_NOT_OPEN = "its Statements page did not open";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A short line for the run log (shared.js), never the page's own text.
  const trace = (text) => { if (globalThis.__sweepLog) globalThis.__sweepLog(text); };

  // `how` is what made this think so, for the run log only.
  class Stop extends Error {
    constructor(why, how = "") { super(why); this.why = why; trace(`Stop: ${why}${how ? ` (${how})` : ""}`); }
  }

  // -- where the tab is ------------------------------------------------------

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN_URL_MARKERS.some((m) => url.includes(m))
      || Boolean(document.querySelector("input[type='password']"));
  }

  function screen() {
    const body = (document.body && document.body.innerText) || "";
    const hay = `${document.title}\n${body.slice(0, 2000)}`.toLowerCase();
    if (CHALLENGE_MARKERS.some((m) => hay.includes(m))) return "challenge";
    if (RATE_LIMIT_MARKERS.some((m) => hay.includes(m))) return "rate";
    return "";
  }

  const onSite = () => location.protocol === "https:" && location.hostname === HOST;

  // -- periods ---------------------------------------------------------------

  const pad = (n) => String(n).padStart(2, "0");
  const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mdy = (isoDate) => { const [y, m, d] = isoDate.split("-"); return `${m}/${d}/${y}`; };

  // Finished quarters, newest first, back to FIRST_YEAR.
  function periods(now = new Date()) {
    const today = iso(now.getFullYear(), now.getMonth() + 1, now.getDate());
    const out = [];
    let y = now.getFullYear(), q = Math.floor(now.getMonth() / 3) + 1;
    while (y >= FIRST_YEAR) {
      const start = iso(y, 3 * q - 2, 1);
      const end = iso(y, 3 * q, daysIn(y, 3 * q));
      if (end < today) out.push({ start, end, range: `${mdy(start)}-${mdy(end)}` });
      q -= 1;
      if (q === 0) { y -= 1; q = 4; }
    }
    return out;
  }

  // The quarter a listed statement is for, worked out again from its date.
  function periodOf(doc) {
    if (!doc || typeof doc.date !== "string" || typeof doc.id !== "string") return null;
    const p = periods().find((x) => x.end === doc.date);
    if (!p || (doc.start && doc.start !== p.start)) return null;
    const want = doc.plan ? `Statement:${doc.plan}:${p.end}:${TITLE}` : `Statement:${p.end}:${TITLE}`;
    return doc.id === want ? p : null;
  }

  // "Statement Period: 04/01/2026 to 06/30/2026" -> {start, end}, or null.
  function periodIn(text) {
    const m = /Statement Period:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+to\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(text || "");
    if (!m) return null;
    const day = (mo, d, y) => {
      const [M, D, Y] = [Number(mo), Number(d), Number(y)];
      return M >= 1 && M <= 12 && D >= 1 && D <= daysIn(Y, M) ? iso(Y, M, D) : "";
    };
    const start = day(m[1], m[2], m[3]), end = day(m[4], m[5], m[6]);
    return start && end ? { start, end } : null;
  }

  // -- names -----------------------------------------------------------------

  const squeeze = (s) => (s || "").replace(/\s+/g, " ").trim();
  const squeezed = (s) => (s || "").replace(/\s+/g, "").toUpperCase();
  const isUpper = (s) => /[A-Za-z]/.test(s) && s === s.toUpperCase();
  const noNumber = (s) => squeeze((s || "").replace(/\(\s*\d+\s*\)/g, ""));
  const samePlan = (a) => (b) => a.digest === b.digest;

  // A plan's name from a statement: its number dropped, title case if shouted.
  function planLabel(heading) {
    const s = noNumber(heading);
    return isUpper(s) ? s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : s;
  }

  const SMALL_WORDS = new Set(["of", "and", "the", "for", "to", "in", "at", "on"]);
  const NOT_INITIALS = new Set(["inc", "co", "ltd", "llp"]);
  const capitalize = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

  // A plan's name as the plan list gives it, as PaperPull's option_label.
  function optionLabel(text) {
    const s = noNumber(text);
    if (!isUpper(s)) return s;
    return s.split(" ").map((word, i) => {
      const letters = word.replace(/[^A-Za-z]/g, "");
      if (i && SMALL_WORDS.has(word.toLowerCase())) return word.toLowerCase();
      if (!word.includes("-") && letters.length >= 2 && letters.length <= 3
          && !NOT_INITIALS.has(letters.toLowerCase()) && letters === word) return word;
      return word.split("-").map(capitalize).join("-");
    }).join(" ");
  }

  async function sha256(text) {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  // -- plans -----------------------------------------------------------------

  const CHOOSER_LINK_RE = /^\/mybenefits\/(?:DefinedContributions|definedcontributions)\/navigation\/dc\/OnlineStatement\?plan=(\d{1,15})&?$/;
  const SELECT_LINK_RE = /^\/mybenefits\/savings2\/navigation\/dc\/OnlineStatement\?&?client=(\d{1,15})&plan=(\d{1,15})$/;

  function planIds(path) {
    const p = (path || "").trim();
    let m = CHOOSER_LINK_RE.exec(p);
    if (m) return ["", m[1]];
    m = SELECT_LINK_RE.exec(p);
    return m ? [m[1], m[2]] : null;
  }

  async function planFrom(text, value) {
    let label = optionLabel(text);
    const path = (value || "").trim();
    if (!label || !path) return null;
    const ids = planIds(path);
    if (!ids) return { label, digest: await sha256(`label:${label}`), path: "", heading: text, review: LEAVES_THE_SITE };
    for (const n of ids.filter(Boolean).sort((a, b) => b.length - a.length)) {
      label = squeeze(label.split(n).join("")).replace(/^[ -]+|[ -]+$/g, "");
    }
    return { label: label || "Plan", digest: await sha256(`plan:${ids[1]}`), path, heading: text };
  }

  async function plansFrom(entries) {
    const plans = [], seen = new Set();
    for (const e of entries) {
      const plan = await planFrom(e.text, e.value);
      if (!plan || seen.has(plan.digest)) continue;
      seen.add(plan.digest);
      plans.push(plan);
    }
    const names = plans.map((p) => p.heading.toUpperCase());
    for (const p of plans) p.shared = names.filter((n) => n === p.heading.toUpperCase()).length > 1;
    return plans;
  }

  // A same-origin GET with the session's cookies, as following the link
  // would. A redirect to another host is refused by the browser.
  async function look(path) {
    let r;
    try {
      r = await fetch(path, { credentials: "include", mode: "same-origin", redirect: "follow" });
    } catch (e) { return { kind: "redirect" }; }
    const html = await r.text();
    return {
      kind: "page", status: r.status, origin: r.type === "basic",
      redirected: Boolean(r.redirected) || r.url !== location.origin + path,
      password: /type=["']?password\b/i.test(html), html,
    };
  }
  const plain = (a) => a.kind === "page" && a.status === 200 && a.origin && !a.redirected && !a.password;
  const parse = (html) => new DOMParser().parseFromString(html || "", "text/html");
  const textOf = (d) => (d && d.body && d.body.textContent) || "";

  async function signedIn() {
    try {
      const r = await fetch(TOKEN_PATH, { credentials: "include", headers: { Accept: "application/json" }, redirect: "error" });
      if (r.status !== 200) return false;
      const j = await r.json();
      return Boolean(j && j.txnTokenValue);
    } catch (e) { return false; }
  }

  // The plans of a sign-in with several, or null for a sign-in with one.
  async function listPlans() {
    const chooser = await look(CHOOSER_PATH);
    let links = [];
    if (plain(chooser)) {
      const d = parse(chooser.html);
      if (/choose a plan/i.test(textOf(d))) {
        links = Array.from(d.querySelectorAll("a[href]"))
          .filter((a) => /[?&]plan=\d/i.test(a.getAttribute("href") || ""))
          .map((a) => ({ text: squeeze(a.textContent), value: a.getAttribute("href") || "" }));
      }
    } else if (chooser.kind === "page" && chooser.password) {
      throw new Stop(SIGNED_OUT, "the plan chooser answered with a password field");
    }
    const exact = new Set(links.map((l) => planIds(l.value)).filter(Boolean).map((ids) => ids[1]));
    const others = links.filter((l) => !planIds(l.value));
    if (exact.size >= 2) return plansFrom(links);
    if (exact.size === 1 && others.length) {
      throw new Stop("NetBenefits' Choose a Plan page shows one plan beside other plan links, so this cannot tell how many plans you have.");
    }
    if (exact.size === 1) return null;
    // No Choose a Plan page: the Select Account page, shown when the site
    // remembers no plan. Its Go button is never pressed.
    const page = await look(STATEMENTS_PATH);
    if (!plain(page)) return null;
    const d = parse(page.html);
    const sel = d.querySelector("select[name='accountSelect']");
    if (!sel || !/requires you to select an account/i.test(textOf(d))) return null;
    const options = Array.from(sel.options).filter((o) => !o.disabled)
      .map((o) => ({ text: squeeze(o.textContent), value: o.getAttribute("value") || "" }));
    const plans = await plansFrom(options);
    if (!plans.length) throw new Stop("NetBenefits' Select Account page listed no plan.");
    return plans.length === 1 ? null : plans;
  }

  // The plan's heading on its Statements page: its name, then its number in
  // brackets. Two plans with one name are told apart by the number.
  function headingRe(plan) {
    const name = noNumber(plan.heading || plan.label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ids = planIds(plan.path);
    const number = plan.shared && ids ? ids[1] : "\\d+";
    return new RegExp(`^[^A-Za-z0-9]*${name}\\s*\\(\\s*${number}\\s*\\)`, "i");
  }

  function showsPlan(plan) {
    if (!document.querySelector("form[name='frmRequest']")) return false;
    const re = headingRe(plan);
    return Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']"))
      .some((h) => re.test(squeeze(h.innerText || h.textContent)));
  }

  async function waitShows(plan, ms = 5000) {
    const until = Date.now() + ms;
    for (;;) {
      if (document.readyState === "complete" && showsPlan(plan)) return true;
      if (Date.now() >= until) return false;
      await sleep(250);
    }
  }

  // Chooses `plan` on the site, by asking for its own address from inside
  // the page, as PaperPull does. "" when chosen, else why not.
  async function choosePlan(plan) {
    const probe = await look(plan.path);
    if (probe.kind === "page" && probe.password) throw new Stop(SIGNED_OUT, "the plan's address answered with a password field");
    if (!(probe.kind === "page" && probe.status === 200 && probe.origin && !probe.redirected)) {
      if (!(await signedIn())) throw new Stop(SIGNED_OUT, `the plan's address answered ${probe.kind} ${probe.status || ""}, and the token check failed`);
      return probe.kind === "redirect" || probe.redirected ? REDIRECTS : NOT_ITS_PAGE;
    }
    // The Statements address is asked for the same way first, so a day it
    // redirects is seen without the tab following it.
    const ahead = await look(STATEMENTS_PATH);
    if (!plain(ahead)) {
      if (!(await signedIn())) throw new Stop(SIGNED_OUT, `the Statements address answered ${ahead.kind} ${ahead.status || ""}, and the token check failed`);
      return REDIRECTS;
    }
    return "";
  }

  // The longer names of the list taken out first, so ABC is not found inside
  // ABC DCP. A name two plans share counts only for `chosen`.
  const nameKey = (p) => squeezed(noNumber(p.heading || p.label).replace(/\s+plan\s*$/i, ""));
  function plansNamed(text, plans, chosen) {
    const hay = squeezed(text);
    const keyed = plans.filter((p) => p.path).map((p) => [p, nameKey(p)]);
    const keys = keyed.map(([, k]) => k);
    const out = [];
    for (const [plan, key] of keyed) {
      if (!key || out.some(samePlan(plan))) continue;
      if (keys.filter((k) => k === key).length > 1 && plan.digest !== chosen) continue;
      let rest = hay;
      for (const k of keys.filter((k) => k !== key && k.includes(key)).sort((a, b) => b.length - a.length)) rest = rest.split(k).join("");
      if (rest.includes(key)) out.push(plan);
    }
    return out;
  }

  function combinedLabel(plans, employer, text) {
    if (employer && squeezed(text).includes(squeezed(employer))) return `${optionLabel(employer).replace(/[ ,.]+$/, "")} Plans`;
    const names = plans.map((p) => p.label.replace(/\s+Plan$/, "")).sort();
    const joined = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    return `${joined} Plans`;
  }

  // -- the statement request -------------------------------------------------

  async function token() {
    let r;
    try {
      r = await fetch(TOKEN_PATH, { credentials: "include", headers: { Accept: "application/json" }, redirect: "error" });
    } catch (e) { throw new Stop(SIGNED_OUT, `the token request failed: ${(e && e.message) || e}`); }
    if (r.status === 401 || r.status === 403) throw new Stop(SIGNED_OUT, `the token request answered ${r.status}`);
    if (r.status !== 200) throw new Stop("NetBenefits did not answer. Try again later.", `the token request answered ${r.status}`);
    let j = {};
    try { j = await r.json(); } catch (e) { /* sent empty, as PaperPull sends it */ }
    return (j && j.txnTokenValue) || "";
  }

  const fields = (txntoken, range) => [["txntoken", txntoken], ["sodReqIndicator", "HACK"], ["dateRange", range],
    ["ytdDateRange", ""], ["sodPreview", "N"], ["consentReq", "N"]];

  // One quarter's statement, read and never shown.
  async function made(p) {
    const body = new URLSearchParams(fields(await token(), p.range));
    let r;
    try {
      r = await fetch(STATEMENT_PATH, {
        method: "POST", credentials: "include", redirect: "error",
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(),
      });
    } catch (e) {
      if (!(await signedIn())) throw new Stop(SIGNED_OUT, `the statement request failed (${(e && e.message) || e}), and the token check failed`);
      throw new Stop("NetBenefits refused a statement request. Try again later.", `${(e && e.message) || e}`);
    }
    if (r.status === 401 || r.status === 403) throw new Stop(SIGNED_OUT, `the statement request answered ${r.status}`);
    if (r.status !== 200) throw new Stop("NetBenefits answered a statement request with an error. Try again later.");
    const d = parse(await r.text());
    const title = squeeze(d.title);
    const text = textOf(d);
    const period = periodIn(text);
    let plan = "";
    const cell = d.querySelector("td[class='Header']");
    if (cell) plan = cell.innerHTML.replace(/<[^>]+>/g, " ");
    if (!squeeze(plan)) {
      const h1 = Array.from(d.querySelectorAll("h1")).map((h) => h.textContent || "").find((t) => /plan/i.test(t));
      plan = h1 || "";
    }
    const statement = /Statement Details/i.test(title) && Boolean(period);
    if (statement && (period.start !== p.start || period.end !== p.end)) {
      throw new Stop("NetBenefits answered one quarter's request with another quarter's statement.");
    }
    return { statement, plan: squeeze(plan), text };
  }

  // Every finished quarter the site makes a statement for, newest first.
  async function madeQuarters() {
    const out = [];
    for (const p of periods()) {
      const res = await made(p);
      if (res.statement) out.push({ ...p, ...res });
      else if (out.length) break;
      await sleep(PAUSE_MS);
    }
    return out;
  }

  // -- the walk, kept in this tab's session storage --------------------------

  function loadWalk() {
    try {
      const w = JSON.parse(sessionStorage.getItem(WALK_KEY) || "null");
      return w && Number.isInteger(w.at) && typeof w.t === "number" && Date.now() - w.t < WALK_AGE_MS ? w : null;
    } catch (e) { return null; }
  }
  const saveWalk = (w) => { try { sessionStorage.setItem(WALK_KEY, JSON.stringify(w)); } catch (e) { /* not kept */ } };
  const dropWalk = () => { try { sessionStorage.removeItem(WALK_KEY); } catch (e) { /* not there */ } };

  function loadAsked() {
    try {
      const a = JSON.parse(sessionStorage.getItem(ASKED_KEY) || "null");
      return a && typeof a.id === "string" && Date.now() - a.t < ASKED_AGE_MS ? a : null;
    } catch (e) { return null; }
  }
  const dropAsked = () => { try { sessionStorage.removeItem(ASKED_KEY); } catch (e) { /* not there */ } };

  function leaveForStatements() {
    globalThis.__netbenefitsLeaving = true;
    setTimeout(() => location.assign(ORIGIN + STATEMENTS_PATH), 100);
    return { state: "walking" };
  }

  // -- the list --------------------------------------------------------------

  async function onePlan() {
    const docs = (await madeQuarters()).map((q) => {
      const label = planLabel(q.plan);
      return { id: `Statement:${q.end}:${TITLE}`, date: q.end, start: q.start, title: label ? `${TITLE} - ${label}` : TITLE, method: "print" };
    });
    return { state: "ok", docs };
  }

  const leftForYou = (plan, reason) => ({
    state: "ok", docs: [], more: true,
    note: `${plan.label} was not swept: ${reason}. Open it in NetBenefits yourself.`,
  });

  async function planView(w) {
    const plan = w.plans[w.at];
    if (!plan) return { state: "ok", docs: [], more: true };
    if (!plan.path) return leftForYou(plan, plan.review || LEAVES_THE_SITE);
    if (w.stage !== "check") {
      const reason = await choosePlan(plan);
      if (reason) return leftForYou(plan, reason);
      saveWalk({ ...w, stage: "check", t: Date.now() });
      return leaveForStatements();
    }
    if (location.pathname !== STATEMENTS_PATH || !(await waitShows(plan))) return leftForYou(plan, DID_NOT_OPEN);
    const employer = squeeze((document.querySelector("#client-name") || {}).textContent || "");
    const docs = [];
    let unnamed = 0, covered = 0;
    const seen = { ...(w.made || {}) };
    for (const q of await madeQuarters()) {
      const named = plansNamed(q.text, w.plans, plan.digest);
      if (!named.some(samePlan(plan))) { unnamed += 1; continue; }
      // One combined statement for the plans of one employer, the very same
      // whichever of them asks: saved once, by the first plan that lists it.
      const key = `${q.end}|${await sha256(q.text.replace(/\s+/g, ""))}`;
      if (seen[key] && seen[key] !== plan.digest) { covered += 1; continue; }
      seen[key] = plan.digest;
      const label = named.length > 1 ? combinedLabel(named, employer, q.text) : plan.label;
      docs.push({ id: `Statement:${plan.digest}:${q.end}:${TITLE}`, date: q.end, start: q.start, title: `${TITLE} - ${label}`, method: "print", plan: plan.digest });
    }
    const now = loadWalk() || w;
    saveWalk({ ...now, made: seen, t: Date.now() });
    const notes = [];
    if (unnamed) notes.push(`${unnamed} statement(s) for ${plan.label} do not name it, so they were left for you.`);
    if (covered) notes.push(`${covered} statement(s) for ${plan.label} are another plan's combined statement, saved once.`);
    return { state: "ok", docs, more: true, ...(notes.length ? { note: notes.join(" ") } : {}) };
  }

  async function readList({ walk: mayWalk = false } = {}) {
    if (signedOut()) {
      const marker = LOGIN_URL_MARKERS.find((m) => location.href.toLowerCase().includes(m));
      trace(`Signed out on ${location.hostname}: ${marker ? `the address holds ${marker}` : "the page has a password field"}.`);
      return { state: "signed_out" };
    }
    const s = screen();
    if (s) {
      const hay = `${document.title}\n${((document.body && document.body.innerText) || "").slice(0, 2000)}`.toLowerCase();
      const marker = (s === "challenge" ? CHALLENGE_MARKERS : RATE_LIMIT_MARKERS).find((m) => hay.includes(m));
      trace(`On ${location.hostname}, the page reads as ${s === "rate" ? "a rate limit" : "a challenge or sign-out"}: it says "${marker}".`);
    } else if (!onSite()) {
      trace(`On ${location.hostname}, not ${HOST}: no list here.`);
    }
    if (s === "challenge") return { state: "challenge" };
    if (s === "rate") return { state: "stopped", why: "NetBenefits says to slow down and try later.", docs: [] };
    if (!onSite()) return { state: "no_list" };
    // Statements are made by asking the site, so a tab of yours is never asked.
    if (!mayWalk) { dropWalk(); return { state: "stopped", why: YOUR_TAB, docs: [] }; }
    if (globalThis.__netbenefitsLeaving) return { state: "walking" };
    try {
      let w = loadWalk();
      if (!w) {
        w = { at: 0, t: Date.now(), plans: await listPlans(), stage: "choose", made: {} };
        saveWalk(w);
      }
      return w.plans ? await planView(w) : await onePlan();
    } catch (e) {
      return { state: "stopped", why: (e && e.why) || "NetBenefits did not answer as expected.", docs: [] };
    }
  }

  // The next plan, on a sign-in with several.
  function nextView() {
    const w = loadWalk();
    if (!w || !w.plans || w.at + 1 >= w.plans.length) { dropWalk(); return { moved: false }; }
    saveWalk({ ...w, at: w.at + 1, stage: "choose", t: Date.now() });
    return { moved: true };
  }

  // -- one statement ---------------------------------------------------------

  async function showDoc(doc) {
    const p = periodOf(doc);
    if (!p) return { ok: false, why: "This is not a statement this listed." };
    const until = Date.now() + 15000;
    while (Date.now() < until && (document.readyState === "loading" || !onSite()) && !signedOut()) await sleep(250);
    if (signedOut()) return { ok: false, why: SIGNED_OUT };
    if (!onSite()) return { ok: false, why: "The tab is not on NetBenefits' statements site." };
    const w = loadWalk();
    if (doc.plan) {
      const plan = w && w.plans && w.plans.find((x) => x.digest === doc.plan);
      if (!plan) return { ok: false, why: "This statement's plan is not on the plan list read this run. Sweep again." };
      if (location.pathname !== STATEMENTS_PATH || !(await waitShows(plan))) {
        return { ok: false, why: `The Statements page is not showing ${plan.label}, so its statement was not made.` };
      }
    } else if (w && w.plans) {
      return { ok: false, why: "This sign-in has several plans, and this statement names none. Sweep again." };
    }
    let txntoken;
    try { txntoken = await token(); } catch (e) { return { ok: false, why: e.why || SIGNED_OUT }; }
    // The statement request, with the fields PaperPull sends, posted so the
    // statement comes up in this tab.
    const form = document.createElement("form");
    form.method = "post";
    form.action = STATEMENT_PATH;
    form.style.display = "none";
    for (const [name, value] of fields(txntoken, p.range)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    try { sessionStorage.setItem(ASKED_KEY, JSON.stringify({ id: doc.id, t: Date.now() })); } catch (e) {
      return { ok: false, why: "This tab would not keep track of the statement." };
    }
    document.body.appendChild(form);
    setTimeout(() => HTMLFormElement.prototype.submit.call(form), 100);
    return { ok: true };
  }

  function printReady(doc) {
    const p = periodOf(doc);
    if (!p) return { ok: false, why: "This is not a statement this listed." };
    if (signedOut()) return { ok: false, why: SIGNED_OUT };
    if (!onSite()) return { ok: false, why: "NetBenefits went to another page instead of the statement." };
    if (location.pathname !== STATEMENT_PATH) {
      if (screen() === "challenge") return { ok: false, why: "NetBenefits is asking you to confirm something. Finish it in its tab, then sweep again." };
      return { ready: false, why: "The statement did not come up." };
    }
    const asked = loadAsked();
    if (!asked || asked.id !== doc.id) return { ok: false, why: "The statement on screen is not the one this asked for." };
    if (document.readyState !== "complete") return { ready: false, why: "The statement did not finish loading." };
    const title = squeeze(document.title);
    if (!/Statement Details/i.test(title)) {
      return { ok: false, why: /error/i.test(title) ? "NetBenefits made no statement for this quarter." : "The page NetBenefits showed is not a statement." };
    }
    const text = (document.body && document.body.textContent) || "";
    const period = periodIn(text);
    if (!period) return { ok: false, why: "The statement does not say its period." };
    if (period.start !== p.start || period.end !== p.end) return { ok: false, why: "The statement on screen is for another quarter." };
    if (doc.plan) {
      const w = loadWalk();
      const plans = (w && w.plans) || [];
      if (!plans.some((x) => x.digest === doc.plan) || !plansNamed(text, plans, doc.plan).some((x) => x.digest === doc.plan)) {
        return { ok: false, why: "The statement on screen does not name its plan, so it was not saved." };
      }
    }
    if (!Array.from(document.images).every((img) => img.complete)) return { ready: false, why: "The statement's images did not finish loading." };
    if (document.fonts && document.fonts.status !== "loaded") return { ready: false, why: "The statement's fonts did not finish loading." };
    return { ready: true };
  }

  function leaveDoc() {
    dropAsked();
    if (!onSite() || signedOut() || location.pathname === STATEMENTS_PATH) return { ok: true, stayed: true };
    setTimeout(() => location.assign(ORIGIN + STATEMENTS_PATH), 100);
    return { ok: true };
  }

  globalThis.__sweep = { readList, nextView, showDoc, printReady, leaveDoc };
})();
