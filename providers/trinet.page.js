// Runs inside TriNet's own HR Platform page (HR Passport), where the sign-in
// already lives. It asks TriNet's own addresses from the page: who is signed
// in, the list of paychecks, and each paycheck's PDF. It presses nothing.
//
// The list answers every paycheck there is, every year at once, newest first,
// including off-cycle ones (a bonus, a correction). Each is dated by its pay
// date, and saved under the id TriNet gives it.
(() => {
  const HOST = "trinet.hrpassport.com";
  const WHO = "/api-trinet-auth/services/v1.0/authentication/user/token-details";
  const MONEY = "/api-bs-hr-portal-money/v1/payroll";
  const CHALLENGE = ["verification code", "enter the code", "verify your identity", "confirm it's you",
    "two-step", "two-factor", "authenticator", "we sent a code", "security check"];
  const DAY = /^(\d{4})-(\d{2})-(\d{2})/;
  // TriNet's own id for a paycheck: letters and digits only, never a path.
  const KEY = /^[A-Za-z0-9_-]{8,80}$/;
  // TriNet's company and employee ids, as they sit in its addresses.
  const PART = /^[A-Za-z0-9]{1,40}$/;

  const visibleText = () => `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 1500)}`.toLowerCase();
  const signedOut = () => location.hostname !== HOST || Boolean(document.querySelector("input[type='password']"));

  // A day TriNet sent, as YYYY-MM-DD, or null.
  function dayOf(value) {
    const m = DAY.exec(typeof value === "string" ? value : "");
    if (!m) return null;
    const year = +m[1], month = +m[2], day = +m[3];
    const d = new Date(Date.UTC(year, month - 1, day));
    const real = d.getUTCMonth() === month - 1 && d.getUTCDate() === day && year >= 2000 && year <= 2100;
    return real ? `${m[1]}-${m[2]}-${m[3]}` : null;
  }

  // A request from inside the page. A 401 or 403, or an answer that landed
  // off TriNet's own host, is a sign-in.
  async function ask(path, accept) {
    const response = await fetch(path, { credentials: "same-origin", headers: { accept } });
    let landed;
    try { landed = new URL(response.url); } catch (e) { landed = null; }
    const signedOutAnswer = response.status === 401 || response.status === 403 || !landed || landed.hostname !== HOST;
    return { response, signedOutAnswer };
  }
  async function askJson(path) {
    const got = await ask(path, "application/json");
    if (got.signedOutAnswer) return { signedOut: true };
    if (!got.response.ok) return { status: got.response.status };
    try { return { body: await got.response.json() }; } catch (e) { return { status: got.response.status }; }
  }

  // Whose paychecks: the company and employee ids TriNet's own pages use,
  // from the sign-in it already holds, as lists side by side (companyid[i]
  // goes with emplid[i]), one pair for each company you were paid by through
  // TriNet. Never logged or kept: only the place in the list goes on a doc.
  async function whose() {
    const got = await askJson(WHO);
    if (got.signedOut || !got.body) return got.signedOut ? { signedOut: true } : null;
    const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(String);
    const companies = list(got.body.companyid);
    const employees = list(got.body.emplid);
    const person = String(got.body.personid || "");
    const bases = companies.map((company, i) => {
      const employee = employees[i] || person;
      return PART.test(company) && PART.test(employee) ? `${MONEY}/${company}/${employee}` : null;
    });
    return bases.length && bases.every(Boolean) ? { bases } : null;
  }

  async function readList() {
    if (signedOut()) return { state: "signed_out" };
    const text = visibleText();
    if (CHALLENGE.some((m) => text.includes(m))) return { state: "challenge" };
    let who;
    try { who = await whose(); } catch (e) { return { state: "stopped", why: "TriNet did not say who is signed in.", docs: [] }; }
    if (who && who.signedOut) return { state: "signed_out" };
    if (!who) return { state: "stopped", why: "TriNet's sign-in did not name a company and employee this reads.", docs: [] };

    const docs = [];
    const seen = new Set();
    let unread = false;
    for (const [at, base] of who.bases.entries()) {
      let got;
      try { got = await askJson(`${base}/paychecks`); } catch (e) { return { state: "stopped", why: "TriNet's paycheck list did not answer.", docs: [] }; }
      if (got.signedOut) return { state: "signed_out" };
      const checks = got.body && got.body.data && got.body.data.checkSummaries;
      if (!Array.isArray(checks)) return { state: "stopped", why: `TriNet's paycheck list was not the shape this reads${got.status ? ` (${got.status})` : ""}.`, docs: [] };
      for (const check of checks) {
        const key = check && typeof check.id === "string" ? check.id : "";
        const date = check && (dayOf(check.checkDt) || dayOf(check.checkIssueDate));
        if (!KEY.test(key) || !date) { unread = true; continue; }
        if (seen.has(key)) continue;
        seen.add(key);
        const offCycle = Boolean(check.checkKey && check.checkKey.offCycle === "Y");
        docs.push({ id: `${date}:${key}`, date, title: offCycle ? "Off-Cycle Paycheck" : "Paycheck", method: "fetch", key, at });
      }
    }
    // Newest first; two on one day keep the order TriNet gave them.
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    // Two paychecks of the same kind on one day get a number, so neither file is lost.
    const count = new Map();
    for (const d of docs) count.set(`${d.date}|${d.title}`, (count.get(`${d.date}|${d.title}`) || 0) + 1);
    const nth = new Map();
    for (const d of docs) {
      const k = `${d.date}|${d.title}`;
      if (count.get(k) > 1) {
        nth.set(k, (nth.get(k) || 0) + 1);
        d.title = `${d.title} ${nth.get(k)}`;
      }
    }
    if (unread) return { state: "stopped", why: "A paycheck in TriNet's list could not be read.", docs };
    return { state: "ok", docs };
  }

  async function fetchPdf(doc) {
    const key = doc && doc.key;
    if (!KEY.test(key || "") || !doc.id || doc.id !== `${doc.date}:${key}`) return { ok: false, why: "not a TriNet paycheck" };
    if (signedOut()) return { ok: false, signedOut: true, why: "The TriNet tab is not on a signed-in page." };
    let who;
    try { who = await whose(); } catch (e) { return { ok: false, why: "TriNet did not say who is signed in." }; }
    if (who && who.signedOut) return { ok: false, signedOut: true, why: "TriNet asked for a sign-in." };
    if (!who) return { ok: false, why: "TriNet's sign-in did not name a company and employee." };
    const base = who.bases[Number.isInteger(doc.at) ? doc.at : 0];
    if (!base) return { ok: false, why: "That paycheck's company is no longer in this sign-in." };
    let got;
    try { got = await ask(`${base}/paycheck-details-pdf/${encodeURIComponent(key)}`, "application/pdf"); } catch (e) { return { ok: false, why: "TriNet did not answer." }; }
    if (got.signedOutAnswer) return { ok: false, signedOut: true, why: "TriNet asked for a sign-in." };
    const { response } = got;
    const type = (response.headers.get("content-type") || "").toLowerCase();
    if (!response.ok) return { ok: false, why: `The site sent ${response.status} ${type.split(";")[0]}.` };
    // Kept only if its bytes start %PDF- (shared.js).
    return globalThis.__sweepPdf.pdfResult(new Uint8Array(await response.arrayBuffer()));
  }

  globalThis.__sweep = { readList, fetchPdf };
})();
