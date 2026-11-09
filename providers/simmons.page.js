// Runs inside Simmons Bank's own page (Banno). Reads and downloads only.
//
// The page's user id appears only in the address of its own list call, which
// the browser's resource timing shows here. Those addresses answer with the
// browser's cookies alone, so the list and PDFs are asked for in-page, and
// the rows drawn inside the page's open shadow roots are the check on them.
//
// Derived from PaperPull's apps/simmons/simmons_site.py (AGPL-3.0).
(() => {
  const UUID = "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}";
  const UUID_RE = new RegExp(`^${UUID}$`);
  const LIST_PATH = new RegExp(`^/a/consumer/api/v0/users/(${UUID})/documents/all$`);
  const LOGIN_PATHS = ["login", "auth", "logout", "sign-in", "signin"];
  const TYPES = { statement: "Statement", notice: "Notice", tax: "Tax" };
  const ENTRY_KEYS = new Set(["documentId", "documentType", "documentTitle", "description", "date", "documentFilename", "accountIds"]);
  const ROW = /^(.+) (Statement|Notice|Tax), (([^,()]+?) \(x([0-9]{4})\))$/;
  const ROW_TAIL = /\(x[0-9]{4}\)\s*$/;
  const CHALLENGE = ["enter the code", "verification code", "6-digit", "two-factor", "two-step", "authenticator",
    "confirm your identity", "verify your identity", "we sent a code", "one-time passcode", "are you a robot",
    "captcha", "check your email", "check your phone", "access denied"];
  const RATE_LIMIT = ["too many requests", "rate limit", "try again later", "temporarily unavailable",
    "http error 429", "unusual traffic"];

  const tidy = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const stop = (why, docs = []) => ({ state: "stopped", why, docs });

  function isoDate(text) {
    if (typeof text !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text)) return null;
    const d = new Date(`${text}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text ? text : null;
  }

  // Every element, through every open shadow root.
  function deep(root, out = []) {
    for (const el of root.querySelectorAll("*")) {
      out.push(el);
      if (el.shadowRoot) deep(el.shadowRoot, out);
    }
    return out;
  }

  function signedOut() {
    const first = (location.pathname.replace(/^\/+/, "").split("/")[0] || "").toLowerCase();
    if (LOGIN_PATHS.includes(first)) return true;
    return deep(document).some((el) => el.localName === "input" && (el.getAttribute("type") || "").toLowerCase() === "password");
  }

  function pageWord() {
    const body = ((document.body && document.body.innerText) || "").toLowerCase();
    const hay = `${(document.title || "").toLowerCase()}\n${body.slice(0, 1500)}`;
    if (CHALLENGE.some((m) => hay.includes(m))) return "challenge";
    if (RATE_LIMIT.some((m) => hay.includes(m))) return "rate";
    return "";
  }

  // The addresses of the page's own list calls: [{user, start}], each once.
  function listCalls() {
    const found = new Map();
    for (const entry of performance.getEntriesByType("resource")) {
      let url;
      try { url = new URL(entry.name); } catch (e) { continue; }
      if (url.origin !== location.origin) continue;
      const m = LIST_PATH.exec(url.pathname);
      if (!m) continue;
      const keys = Array.from(url.searchParams.keys());
      const start = url.searchParams.get("startDate");
      if (keys.length !== 1 || keys[0] !== "startDate" || !isoDate(start)) continue;
      found.set(`${m[1]}|${start}`, { user: m[1], start });
    }
    return Array.from(found.values());
  }

  async function ask(path) {
    const response = await fetch(path, { credentials: "same-origin", redirect: "manual" });
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) return { signedOut: true };
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const body = await response.text();
    if (type.startsWith("text/html") || body.trimStart().startsWith("<")) return { signedOut: true };
    if (response.status !== 200) return { why: `The bank answered ${response.status}.` };
    try { return { json: JSON.parse(body) }; } catch (e) { return { why: "The bank's answer was not JSON." }; }
  }

  function entriesOf(got, start) {
    if (!got || typeof got !== "object" || !Array.isArray(got.documents)) return { why: "The documents answer is not the expected shape." };
    if (Object.keys(got).some((k) => k !== "documents")) return { why: "The documents answer holds more than its list, which may mean there are more documents." };
    const out = [];
    const seen = new Set();
    for (const e of got.documents) {
      if (!e || typeof e !== "object" || Object.keys(e).some((k) => !ENTRY_KEYS.has(k))) return { why: "A document of the answer could not be read." };
      if (typeof e.documentId !== "string" || !UUID_RE.test(e.documentId)) return { why: "A document's id is not one this can read." };
      if (!Object.prototype.hasOwnProperty.call(TYPES, e.documentType)) return { why: "A document is of a type this does not know." };
      const title = e.documentTitle;
      if (typeof title !== "string" || !tidy(title) || title.length > 200 || tidy(title) !== title) return { why: "A document's title could not be read." };
      const date = isoDate(e.date);
      if (!date) return { why: "A document's date is not a calendar date." };
      if (date < start) return { why: "A document is dated before the day the list was asked from." };
      const name = e.documentFilename;
      if (typeof name !== "string" || !name.toLowerCase().endsWith(".pdf") || /[/\\]/.test(name)) return { why: "A document's file name is not a PDF's." };
      const accounts = e.accountIds;
      if (!Array.isArray(accounts) || accounts.length !== 1 || typeof accounts[0] !== "string" || !accounts[0].trim()) return { why: "A document does not name exactly one account." };
      if (seen.has(e.documentId)) return { why: "Two documents carry one id." };
      seen.add(e.documentId);
      out.push({ id: e.documentId, date, title, kind: e.documentType, account: accounts[0] });
    }
    if (new Set(out.map((x) => x.account)).size > 1) return { why: "The answer names more than one account, and this reads one." };
    return { entries: out };
  }

  // Every document row the page draws, or {why} when one cannot be trusted.
  function readRows() {
    const rows = [];
    const items = new Set();
    for (const el of deep(document)) {
      if (el.localName !== "button") continue;
      const text = tidy(el.innerText);
      const m = ROW.exec(text);
      if (!m) {
        if (ROW_TAIL.test(text)) return { why: "A document row's text could not be read." };
        continue;
      }
      let item = el;
      while (item && item.localName !== "jha-list-item") item = item.parentElement || (item.parentNode && item.parentNode.host) || null;
      if (!item) return { why: "A button reads like a document row outside the list." };
      if (typeof el.checkVisibility !== "function" || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return { why: "A document row is not drawn." };
      if (items.has(item)) return { why: "A list item holds two document rows." };
      items.add(item);
      rows.push({ title: m[1], type: m[2], account: m[3] });
    }
    return { rows };
  }

  function disagree(rows, entries) {
    if (new Set(rows.map((r) => r.account)).size > 1) return "The rows name more than one account.";
    if (rows.length !== entries.length) return "The page does not draw one row for each document.";
    const key = (title, type) => `${type}\u0000${title}`;
    const count = new Map();
    for (const e of entries) count.set(key(e.title, TYPES[e.kind]), (count.get(key(e.title, TYPES[e.kind])) || 0) + 1);
    for (const r of rows) {
      const left = count.get(key(r.title, r.type)) || 0;
      if (!left) return "The rows' titles are not the answer's.";
      count.set(key(r.title, r.type), left - 1);
    }
    return "";
  }

  async function readList() {
    if (signedOut()) return { state: "signed_out" };
    const word = pageWord();
    const path = location.pathname.replace(/\/$/, "");
    if (path !== "/documents") return word === "challenge" ? { state: "challenge" } : { state: "no_list" };
    let calls = listCalls();
    for (let waited = 0; !calls.length && waited < 5000; waited += 250) {
      await sleep(250);
      if (signedOut()) return { state: "signed_out" };
      calls = listCalls();
    }
    if (!calls.length) {
      if (word === "challenge") return { state: "challenge" };
      if (word === "rate") return stop("Simmons Bank says to try again later.");
      return { state: "no_list" };
    }
    if (calls.length !== 1) return stop("The page asked for its documents in two ways.");
    const { user, start } = calls[0];
    const list = await ask(`/a/consumer/api/v0/users/${user}/documents/all?startDate=${start}`);
    if (list.signedOut) return { state: "signed_out" };
    if (list.why) return stop(list.why);
    const read = entriesOf(list.json, start);
    if (read.why) return stop(read.why);
    const settings = await ask(`/a/consumer/api/users/${user}/documents/settings/institution`);
    if (settings.signedOut) return { state: "signed_out" };
    if (settings.why) return stop(settings.why);
    const first = settings.json && settings.json.settings && settings.json.settings.documentStartDate;
    if (!isoDate(first)) return stop("The bank's first day of documents could not be read.");
    if (first !== start) return stop("The list was asked from another day than the bank's own first day.");
    let drawn = readRows();
    for (let waited = 0; waited < 8000 && (drawn.why || disagree(drawn.rows, read.entries)); waited += 250) {
      await sleep(250);
      if (signedOut()) return { state: "signed_out" };
      drawn = readRows();
    }
    if (drawn.why) return stop(drawn.why);
    const wrong = disagree(drawn.rows, read.entries);
    if (wrong) return stop(wrong);
    const docs = read.entries.map(({ id, date, title }) => ({ id, date, title, method: "fetch" }));
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return { state: "ok", docs };
  }

  async function fetchPdf(doc) {
    const id = doc && doc.id;
    if (typeof id !== "string" || !UUID_RE.test(id)) return { ok: false, why: "not a document id" };
    const calls = listCalls();
    if (calls.length !== 1) return { ok: false, why: "The page's own list call was not found." };
    const response = await fetch(`/a/consumer/api/users/${calls[0].user}/documents/${id}`, { credentials: "same-origin", redirect: "manual" });
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) {
      return { ok: false, signedOut: true, why: "The site asked for a sign-in." };
    }
    if (response.status !== 200) return { ok: false, why: `The site sent ${response.status}.` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    return globalThis.__sweepPdf.pdfResult(bytes);
  }

  globalThis.__sweep = { readList, fetchPdf };
})();
