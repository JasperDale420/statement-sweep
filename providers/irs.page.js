// Runs inside the IRS Online Account page, where the sign-in already lives.
// Reads and downloads only. It presses nothing and changes nothing.
//
// Derived from PaperPull's apps/irs/irs_site.py (AGPL-3.0).
(() => {
  const HOST = "sa.www4.irs.gov";
  const LIST_PAGE = "/ola/tax_records/transcripts";
  const LIST_API = "/ola/api/shared/accounts/taxrecords/1.0/taxpayers/transcripts";
  const TYPES = { account: "Account", return: "Return", wageAndIncome: "Wage and Income", recordOfAccount: "Record of Account" };
  const TYPE = /^[a-z][A-Za-z]{0,39}$/;
  const PERIOD = /^[0-9]{6}$/;
  const MFT = /^[0-9]{1,3}$/;
  const DOC_ID = /^transcript-([a-z][A-Za-z]{0,39})-([0-9]{6})-([0-9]{1,3})$/;
  const FORM = /^([0-9]{3,4}[A-Z]{0,2}( Series)?|All Forms)$/;
  const LOGIN_MARKERS = ["/secureaccess/", "/login", "/signin", "/sign-in", "/oauth", "/authorize", "/logout", "/sessiontimeout", "/session-expired"];
  const EXPIRED_WORDS = ["your session has expired", "session timed out"];
  const CHECK_WORDS = ["enter the code", "verification code", "two-factor", "two-step", "authenticator",
    "confirm your identity", "verify your identity", "we sent a code", "are you a robot", "captcha"];
  const DOWN_WORDS = ["access denied", "service unavailable", "system unavailable", "not available at this time",
    "too many requests", "rate limit", "try again later", "temporarily unavailable", "http error 429", "unusual traffic"];

  const onHost = () => location.protocol === "https:" && location.hostname === HOST;
  const pageWords = () => `${document.title}\n${((document.body && document.body.innerText) || "").slice(0, 1500)}`.toLowerCase();

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN_MARKERS.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']"));
  }

  // The last day of a YYYYMM tax period, or nothing for any other shape.
  function periodDate(period) {
    if (!/^(19|20)[0-9]{2}(0[1-9]|1[0-2])$/.test(period)) return null;
    const year = +period.slice(0, 4), month = +period.slice(4);
    return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  }

  const shaped = (type, period, mft) => TYPE.test(type) && PERIOD.test(period) && MFT.test(mft);
  const str = (v) => (v === null || v === undefined ? "" : String(v));
  const newestFirst = (docs) => docs.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // Two transcripts of one type and period are told apart by their forms when
  // those differ and are real form names, and otherwise by their MFT.
  function nameApart(docs) {
    const groups = new Map();
    for (const doc of docs) {
      const key = doc.id.slice(0, doc.id.lastIndexOf("-"));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(doc);
    }
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const forms = members.map((d) => d.form);
      const byForm = forms.every((f) => FORM.test(f)) && new Set(forms.map((f) => f.toLowerCase())).size === forms.length;
      for (const doc of members) doc.title += ` ${byForm ? doc.form : `MFT ${doc.id.slice(doc.id.lastIndexOf("-") + 1)}`}`;
    }
    for (const doc of docs) delete doc.form;
  }

  // Reads what the transcript page itself asks for, and answers either the
  // documents or why it could not.
  function transcripts(items) {
    const docs = [];
    const seen = new Set();
    const stop = (why) => ({ why, docs });
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return stop("A transcript in the list could not be read.");
      const type = str(item.transcriptType), period = str(item.taxPeriod), mft = str(item.mft);
      if (!shaped(type, period, mft)) return stop("A transcript's type, tax period or MFT is not of its usual shape.");
      if (!Object.prototype.hasOwnProperty.call(TYPES, type)) return stop("A kind of transcript this has not seen is listed.");
      const date = periodDate(period);
      if (!date) return stop("A transcript's tax period could not be read.");
      const languages = item.availableLanguages;
      if (!Array.isArray(languages) || !languages.map((l) => str(l).toLowerCase()).includes("en")) return stop("A transcript is not offered in English.");
      const id = `transcript-${type}-${period}-${mft}`;
      if (seen.has(id)) return stop("One transcript is listed twice.");
      seen.add(id);
      docs.push({ id, date, title: `${TYPES[type]} Transcript`, method: "fetch", form: str(item.taxForm).trim() });
    }
    return { docs };
  }

  async function askList() {
    let response;
    try {
      response = await fetch(LIST_API, { credentials: "same-origin", redirect: "manual" });
    } catch (e) {
      return { failed: "The transcript list could not be asked for." };
    }
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403
        || (response.status === 200 && type.startsWith("text/html"))) {
      return { signedOut: true };
    }
    if (response.status !== 200 || !type.includes("json")) return { failed: "The transcript list did not answer as a list." };
    let items;
    try { items = await response.json(); } catch (e) { return { failed: "The transcript list did not answer as a list." }; }
    if (!Array.isArray(items)) return { failed: "The transcript list is not the plain list this expects." };
    return { items };
  }

  async function readList() {
    if (!onHost()) return { state: "no_list" };
    if (signedOut()) return { state: "signed_out" };
    const words = pageWords();
    if (EXPIRED_WORDS.some((w) => words.includes(w))) return { state: "signed_out" };
    if (CHECK_WORDS.some((w) => words.includes(w))) return { state: "challenge" };
    const down = DOWN_WORDS.find((w) => words.includes(w));
    if (down) return { state: "stopped", why: "The IRS page says it is not available right now.", docs: [] };
    if (location.pathname.replace(/\/$/, "") !== LIST_PAGE) return { state: "no_list" };
    if (!document.querySelector("[role=main], main")) return { state: "no_list" };
    const answer = await askList();
    if (answer.signedOut) return { state: "signed_out" };
    if (answer.failed) return { state: "stopped", why: answer.failed, docs: [] };
    const read = transcripts(answer.items);
    nameApart(read.docs);
    const docs = newestFirst(read.docs);
    return read.why ? { state: "stopped", why: read.why, docs } : { state: "ok", docs };
  }

  async function fetchPdf(doc) {
    const match = DOC_ID.exec((doc && doc.id) || "");
    if (!match || !shaped(match[1], match[2], match[3])) return { ok: false, why: "not a transcript id" };
    if (!onHost()) return { ok: false, why: "This tab is not on the IRS Online Account." };
    // The list is read again, and the transcript is asked for only when
    // exactly one item still carries it.
    const answer = await askList();
    if (answer.signedOut) return { ok: false, signedOut: true, why: "The IRS asked for a sign-in." };
    if (answer.failed) return { ok: false, why: answer.failed };
    const still = answer.items.filter((i) => i && `transcript-${str(i.transcriptType)}-${str(i.taxPeriod)}-${str(i.mft)}` === doc.id);
    if (still.length !== 1) return { ok: false, why: "The transcript list no longer holds that transcript once." };
    let response;
    try {
      response = await fetch(`${LIST_API}/${match[1]}/${match[2]}/${match[3]}`, { credentials: "same-origin", redirect: "manual" });
    } catch (e) {
      return { ok: false, why: "The transcript could not be asked for." };
    }
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403
        || (response.status === 200 && (type.startsWith("text/") || type.includes("json")))) {
      return { ok: false, signedOut: true, why: "The IRS asked for a sign-in." };
    }
    if (response.status !== 200 || type !== "application/pdf") return { ok: false, why: `The site sent ${response.status} ${type}.` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    return globalThis.__sweepPdf.pdfResult(bytes);
  }

  globalThis.__sweep = { readList, fetchPdf };
})();
