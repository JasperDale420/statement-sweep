// Runs inside State Farm's Document Center. Reads and downloads only. It
// presses a row's own "View Documents" and then the one document that row
// reveals, and nothing else.
//
// The document list is an answer only the page can get: the same address
// asked with cookies alone is refused, and the headers it needs are the
// page's own. So the list is read off the page. A control that carries its
// own PDF link is fetched (method "fetch"). A row behind "View Documents" is
// listed as one document (method "newtab"): clickDoc finds the row again by
// its View Documents and the date it reads, presses that View Documents once
// (pressing it again folds the row away), waits for the "<type> - <description>"
// link the row reveals inside itself, and presses it. The site opens the PDF
// in a new tab, most likely a blob: the page made on edocuments.statefarm.com,
// and the engine reads it there.
//
// A row is pressed only when it is the one row on the page carrying its date,
// no other control outside it carries that date, and no other row's View
// Documents sits inside it. Its document is pressed only when it sits inside
// that row, is the one document of the row's type (or the only one, when the
// row names no type), and every name it gives passes the guard. A press can
// draw the row anew, so the row is found again by its date after the press.
//
// KEPT OFF ("enabled": false) until the new-tab press is checked on the real
// site. Only the Time Period the Document Center shows first is read.
// PaperPull reaches earlier years by changing the year in the page's own
// list call as the page loads, and never presses the Time Period menu; a
// recipe cannot change the page's own request, so earlier years are left.
//
// Derived from PaperPull's apps/statefarm/statefarm_site.py (AGPL-3.0).
(() => {
  const HOST = "edocuments.statefarm.com";
  const CONTROLS = "a, button, [role=button], [role=link], input[type=button], input[type=submit], input[type=image], input[type=reset]";
  const LOGIN_MARKERS = ["/login", "/signin", "/sign-in", "/auth/", "/mfa", "/verification", "/challenge", "/authenticate"];
  const CHALLENGE = ["enter the code", "verification code", "6-digit", "two-factor", "two-step", "authenticator",
    "confirm your identity", "verify your identity", "we sent a code", "device approval", "approve this login",
    "unusual", "are you a robot", "captcha", "let's verify", "check your email", "check your phone",
    "your session has expired", "log back in", "access denied", "reference #"];
  const RATE_LIMIT = ["too many requests", "rate limit", "try again later", "temporarily unavailable",
    "http error 429", "unusual traffic"];
  const FORBIDDEN = /(transfer|zelle|\bwire\b|\bpay\b|payment(?!\s+(receipts?|history))|bill\s*pay|autopay|auto\s*pay|deposit|withdraw|send\s+money|request\s+money|move\s+money|\bapply\b|open\s+(an?\s+)?account|close\s+account|\bloan\b|\bborrow|(?<!id )\bcards?\b|replace|activate|lock|unlock|\bpin\b|limit|overdraft|alerts?\b|\bbudget|\bgoal|\brewards?\b|\boffers?\b|enroll|unenroll|sign\s+up|paperless|delivery\s+preference|enable|disable|change\b|edit\b|update\b|modify|manage\b|set\s+up|delete|remove|cancel|dispute|password|passcode|username|profile\b|settings|preferences|contact\s+info|\baddress\b|confirm\b|submit|agree|accept|authorize|\bchat\b|contact\s+us|beneficiar|nickname|order\s+checks|stop\s+payment|(?<!excludes )\bclaims?\b|file\s+a\s+claim|report\s+(a\s+)?claim|coverage|\bquote\b|add\s+(a\s+)?(vehicle|driver|car|home|policy)|change\s+(my\s+)?policy|cancel\s+policy|renew\s+now|drive\s+safe|start\s+(a\s+)?quote|roadside|\bagent\b|contact\s+(my\s+)?agent|policy\s+change)/i;
  // PaperPull's core guard on controls that commit something or sign in.
  const SETTINGS = /\bchang(e|es|ed|ing)\b|\bedit(s|ed|ing)?\b|\bupdat(e|es|ed|ing)\b|\bremov(e|es|ed|ing|al)\b|\bdelet(e|es|ed|ing|ion)\b|^\s*save\s*$|\bsave\s+(changes?|settings?|preferences?|profile)\b|\bsettings?\b|\bpreferences?\b|\bmanage\b|\bset\s+up\b|\benabl(e|es|ed|ing)\b|\bdisabl(e|es|ed|ing)\b|\bturn\s+(on|off)\b|\bopt\s*(in|out)\b|\bconsent\b|\bauthoriz(e|es|ed|ing|ation)\b|\bcertif(y|ies|ied|ication)\b|\bbeneficiar(y|ies)\b|\bwithholding\b|\bautopay\b|\bauto-pay\b|\bappl(y|ies|ied|ication)\b|\bplace\s+order\b|\brebalance\b|\breallocate\b|\bliquidat(e|es|ed|ing|ion)\b|\bbuy\b|\bsell\b|\bschedule\s+(a\s+)?(payment|transfer)\b|\bclose\s+(?!of\b)(?:[\w'-]+\s+){0,3}?accounts?\b(?!\s+menu\b)|\b(?:sign|log)[\s_-]?(?:out|off)\b/i;
  const AUTH = /log[\s_-]?(in|on)|sign[\s_-]?(in|on|up)|signin|logon|authenticat|credential|register|enroll(ment)?\b|username|user[\s_-]?id|password|passcode|remember\s*me/i;
  const SAFE = /(download|view|open|print|\bpdf\b|statement|document|\bletter\b|notice|1099|1098|5498|tax\s+(form|document)|history|id\s+cards?|renewal\s+(notice|bill)|receipts?\b|\bbills?\b|billing\b|policy\s+documents?|declarations?)/i;
  const BILL = /((download|view|print|open|get)\s*(my\s+|the\s+|this\s+|your\s+)?(statement|document|pdf|tax|letter|notice|1099|1098)|(statement|document|tax\s+form|1099|1098|5498)\s*\(?\s*pdf\s*\)?|\bpdf\b|^\s*(renewal\s+(notice|bill)|declarations?(\s+page)?|policy\s+documents?|id\s+cards?|insurance\s+cards?|premium\s+notice|billing\s+statement)\b|^\s*(view|download|open)\s*$)/i;
  const PDF_HREF = /\.pdf(\?|$)|\/pdf\b|format=pdf|statement.*download|download.*statement|docId|documentId/i;
  const VIEW_DOCUMENTS = /^\s*view\s+documents?\s*\d*\s*$/i;
  // What a row's View Documents reveals: "Renewal Notice - <vehicle>",
  // "Payment Receipt - Payment Receipt" (PaperPull's REVEALED_DOC_RE).
  const REVEALED = /^[A-Za-z][A-Za-z0-9&\/'(). ]{1,60}?\s+-\s+\S.{0,80}$/;
  const PARTS = /^(.+?)\s+-\s+(.*?)$/;
  // A description refused for telling someone to do something.
  const ACTION = /^\s*(pay|transfer|send|request|move|apply|activate|replace|lock|unlock|enroll|unenroll|enable|disable|change|edit|update|modify|manage|set\s+up|delete|remove|cancel|dispute|confirm|submit|agree|accept|authorize|consent|certify|add|renew|stop|schedule|close|open|withdraw|deposit|buy|sell|place\s+(an\s+)?order|rebalance|reallocate|liquidate|turn\s+(on|off)|opt\s*(in|out)|save\s+(changes?|settings?|preferences?)|sign\s+(up|in|on)|log\s*in|chat|contact|call)\b|\bpay\s+(now|online|today|(your|my|the)\s+(bill|premium|balance))\b|\bmake\s+(a\s+)?payment|\bsign\s+up\b|\bfile\s+a\s+claim|\breport\s+(a\s+)?claim|\brenew\s+now|\bstart\s+(a\s+)?quote|\b(send|move|request)\s+money/i;
  // A description that is only one of these nouns, or only a vehicle, is let
  // off the whole guard (less a trim "Limited" in a vehicle's name).
  const WHOLE_NOUN = /^(?:billing\s*\/\s*payments?|\b((credit|debit)\s+)?card\s+ending(\s+in)?\s+[\dxX*•.]{2,}|auto\s*pay|payments?|wire|bill\s*pay)$/i;
  const VEHICLE = /^(?:19|20)\d\d(?:\s+[A-Za-z0-9][A-Za-z0-9&'.\/-]*)+$/;
  const LIMITED_TRIM = /\blimited(?=(\s+(edition|awd|fwd|rwd|4wd|4x4|platinum|hybrid))*$)/gi;
  const KNOWN_TYPES = {
    renewalnotice: "Renewal Notice", renewalbill: "Renewal Bill", paymentreceipt: "Payment Receipt",
    premiumnotice: "Premium Notice", billingstatement: "Billing Statement", bill: "Bill",
    declarations: "Declarations", declarationspage: "Declarations Page", idcard: "ID Card", idcards: "ID Cards",
    autoidcard: "Auto ID Card", insurancecard: "Insurance Card", insurancecards: "Insurance Cards",
    policydocument: "Policy Document", policydocuments: "Policy Documents",
  };
  // Every type name is letters and spaces, longest first.
  const TYPE_ALTERNATIVES = Object.values(KNOWN_TYPES).sort((a, b) => b.length - a.length)
    .map((v) => v.replace(/ /g, "\\s+")).join("|");
  const TYPE_NAME = new RegExp("\\b(" + TYPE_ALTERNATIVES + ")\\b", "gi");
  const DATES = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|(?<!\d)\d{1,2}\/\d{1,2}\/\d{4}(?!\d)|(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/gi;
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const ROW_WAIT_MS = 20000;
  const REVEAL_WAIT_MS = 12000;
  const SETTLE_MS = 1500;
  const LOOK_MS = 250;
  const PERIOD_NOTE = "Only the Time Period the Document Center shows first is read; earlier years are not saved yet.";
  const SIGN_IN = "State Farm asked for a sign-in. Sign in, then run it again.";

  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nameOf = (el) => tidy(el.getAttribute("aria-label") || el.innerText || el.value);
  const textOf = (el) => tidy(el.innerText || el.value);
  const shown = (el) => el.isConnected && el.getClientRects().length > 0;
  const stop = (why, docs = []) => ({ state: "stopped", why, docs });
  const no = (why) => ({ ok: false, why });

  function iso(text) {
    let m, y, mo, d;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text))) { y = +m[1]; mo = +m[2] - 1; d = +m[3]; }
    else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text))) { mo = +m[1] - 1; d = +m[2]; y = +m[3]; }
    else if ((m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text))) { mo = MONTHS.indexOf(m[1].toLowerCase()); d = +m[2]; y = +m[3]; }
    else return null;
    const t = new Date(Date.UTC(y, mo, d));
    if (mo < 0 || t.getUTCFullYear() !== y || t.getUTCMonth() !== mo || t.getUTCDate() !== d) return null;
    return t.toISOString().slice(0, 10);
  }

  // No document is dated after tomorrow; such a day is "available until".
  function datesIn(text) {
    const limit = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const days = (String(text || "").match(DATES) || []).map((s) => iso(tidy(s)));
    if (days.some((d) => d === null)) return null;
    return Array.from(new Set(days.filter((d) => d < limit)));
  }

  const rowOf = (el) => el.closest("[role=row], tr, li");

  // The control's own date, else the one date its own row shows.
  function dateOf(el) {
    const own = datesIn(nameOf(el));
    if (own === null) return null;
    if (own.length === 1) return own[0];
    if (own.length > 1) return null;
    const row = rowOf(el);
    if (!row) return null;
    const near = datesIn(row.innerText);
    return near && near.length === 1 ? near[0] : null;
  }

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN_MARKERS.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']"));
  }

  const onCenter = () => location.hostname === HOST && location.pathname.startsWith("/DocumentCenterUI");
  const all = () => Array.from(document.querySelectorAll(CONTROLS)).filter(shown);
  const isOpener = (el) => VIEW_DOCUMENTS.test(nameOf(el));
  const controls = () => all().filter((el) => {
    const name = nameOf(el);
    return VIEW_DOCUMENTS.test(name) || BILL.test(name);
  });

  function pageWord() {
    if (controls().length) return "";
    const body = ((document.body && document.body.innerText) || "").toLowerCase();
    const hay = `${(document.title || "").toLowerCase()}\n${body.slice(0, 1500)}`;
    if (CHALLENGE.some((m) => hay.includes(m))) return "challenge";
    if (RATE_LIMIT.some((m) => hay.includes(m))) return "rate";
    return "";
  }

  const safeName = (name) => Boolean(name) && !FORBIDDEN.test(name) && SAFE.test(name);
  const guardRefuses = (text) => FORBIDDEN.test(text) || SETTINGS.test(text) || AUTH.test(text);

  // "Payment Receipt - Billing/Payments" and "Payment Receipt - Payment
  // Receipt" both give "paymentreceipt".
  const typeKey = (text) => String(text || "").split(" - ")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
  const sameType = (a, b) => Boolean(a) && a.replace(/s+$/, "") === String(b || "").replace(/s+$/, "");

  // What of a description faces the whole guard.
  function descriptionLeft(description) {
    const text = tidy(description);
    if (WHOLE_NOUN.test(text)) return "";
    if (VEHICLE.test(text)) return text.replace(LIMITED_TRIM, " ");
    return text;
  }

  const shaped = (text) => REVEALED.test(text) && !VIEW_DOCUMENTS.test(text);

  // A document a row revealed, once the guard has had its say. Its type
  // faces the whole guard; its description the words that act, and the
  // whole guard less the nouns a document is known to be named by.
  function isRevealed(label) {
    const text = tidy(label);
    if (!text || !shaped(text)) return false;
    const parts = PARTS.exec(text);
    if (!parts) return false;
    const [, kind, description] = parts;
    if (guardRefuses(kind)) return false;
    const left = descriptionLeft(description);
    return !(ACTION.test(description) || AUTH.test(description) || FORBIDDEN.test(left) || SETTINGS.test(left));
  }

  // A name the control gives a screen reader, read as a document's own words
  // when it is shaped like one of the wanted type, else by the whole guard.
  function nameRefused(text, want) {
    const t = tidy(text);
    if (!t) return false;
    if (shaped(t) && (!want || sameType(typeKey(t), want))) return !isRevealed(t);
    return guardRefuses(t);
  }

  function screenNames(el) {
    const by = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map((id) => { const n = document.getElementById(id); return n ? n.textContent || "" : ""; }).join(" ");
    return [el.getAttribute("aria-label"), by, el.getAttribute("title")].map(tidy).filter(Boolean);
  }

  // The one known type a row's words name, or "".
  function rowType(row) {
    const keys = [];
    for (const m of String(row.innerText || "").matchAll(TYPE_NAME)) {
      const key = typeKey(m[0]);
      if (!keys.some((k) => sameType(k, key))) keys.push(key);
    }
    return keys.length === 1 ? keys[0] : "";
  }

  // A control's own PDF link on this host, or "" when it has none.
  function pdfLink(el) {
    const raw = el.tagName === "A" ? el.getAttribute("href") || "" : "";
    if (!raw || /^(javascript|#)/i.test(raw.trim()) || !PDF_HREF.test(raw)) return "";
    let url;
    try { url = new URL(raw, location.href); } catch (e) { return ""; }
    return url.protocol === "https:" && url.origin === location.origin && url.hostname === HOST ? url.href : "";
  }

  // A control inside a row that has a View Documents of its own: one of the
  // documents that row shows, which belongs to the row.
  function inOpenerRow(el) {
    const row = rowOf(el);
    return Boolean(row) && all().some((c) => c !== el && row.contains(c) && isOpener(c));
  }

  async function readList() {
    if (signedOut()) return { state: "signed_out" };
    const word = pageWord();
    if (word === "challenge") return { state: "challenge" };
    if (word === "rate") return stop("State Farm says to try again later.");
    if (!onCenter()) return { state: "no_list" };
    let found = controls();
    for (let waited = 0; !found.length && waited < 10000; waited += 250) {
      await sleep(250);
      if (signedOut()) return { state: "signed_out" };
      found = controls();
    }
    if (!found.length) return stop("The Document Center shows no document controls this can read.");
    const docs = [];
    const urls = new Set();
    const openers = new Map(); // date -> the View Documents carrying it
    let left = 0;
    for (const el of found) {
      const name = nameOf(el);
      if (VIEW_DOCUMENTS.test(name)) {
        const date = dateOf(el);
        if (!date) return stop("A row's date could not be read.", docs);
        if (!openers.has(date)) openers.set(date, []);
        openers.get(date).push(el);
        continue;
      }
      if (inOpenerRow(el)) continue;
      const url = safeName(name) ? pdfLink(el) : "";
      if (!url) { left += 1; continue; }
      const date = dateOf(el);
      if (!date) return stop("A document's date could not be read.", docs);
      if (urls.has(url)) continue;
      urls.add(url);
      const row = rowOf(el);
      const title = /1099|1098|5498|tax/i.test(`${name} ${row ? row.innerText : ""}`) ? "Tax Document" : "Account Statement";
      const parsed = new URL(url);
      docs.push({ id: `${parsed.pathname}${parsed.search}`, date, title, method: "fetch", url });
    }
    let shared = 0;
    for (const [date, els] of openers) {
      const row = els.length === 1 ? rowOf(els[0]) : null;
      // A row is known by its View Documents and the date it reads, so two
      // rows with one date, or another control carrying it, cannot be told apart.
      const others = row ? found.filter((c) => c !== els[0] && !row.contains(c) && dateOf(c) === date) : [];
      if (!row || others.length) { shared += els.length; continue; }
      docs.push({ id: `row:${date}`, date, title: KNOWN_TYPES[rowType(row)] || "Document", method: "newtab" });
    }
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const said = [];
    if (shared) said.push(`${shared} row(s) share their date with another, so which document is whose cannot be told, and they were left.`);
    if (left) said.push(`${left} document control(s) have no PDF link and no "View Documents" row, so they were left.`);
    if (said.length) return stop(said.join(" "), docs);
    return { state: "ok", docs, note: PERIOD_NOTE };
  }

  // The row's View Documents for `date`: the one control of that name
  // carrying the date, held still for a moment. Answers {el} or {why}.
  async function rowHeld(date) {
    const until = Date.now() + ROW_WAIT_MS;
    let held = [];
    let since = Date.now();
    for (;;) {
      if (signedOut()) return { why: SIGN_IN };
      const now = controls().filter((el) => isOpener(el) && dateOf(el) === date);
      if (now.length === held.length && now.every((el, i) => el === held[i])) {
        if (now.length && Date.now() - since >= SETTLE_MS) {
          if (now.length > 1) return { why: "Two rows show this date, so neither was pressed." };
          return { el: now[0] };
        }
      } else {
        held = now;
        since = Date.now();
      }
      if (Date.now() >= until) return { why: "No row on the Document Center shows this date now." };
      await sleep(LOOK_MS);
    }
  }

  // Why the row of `opener` cannot hold this date's document, or "".
  function rowWhy(opener, date) {
    const row = rowOf(opener);
    if (!row || dateOf(opener) !== date) return "Its row no longer shows this date.";
    const cs = controls();
    if (cs.some((c) => c !== opener && isOpener(c) && dateOf(c) === date)) return "Two rows show this date, so neither was pressed.";
    if (cs.some((c) => c !== opener && !row.contains(c) && dateOf(c) === date)) return "Another control shows this date, so which row is this document's is not known.";
    if (all().some((c) => c !== opener && row.contains(c) && isOpener(c))) return "Another row's View Documents sits inside this row, so nothing was pressed.";
    return "";
  }

  // The documents the row of `opener` shows inside itself.
  function revealedIn(opener) {
    const row = rowOf(opener);
    if (!row) return [];
    return all().filter((c) => c !== opener && row.contains(c) && shaped(textOf(c)));
  }

  // The one document the row with this date shows, of the wanted type.
  // Answers {el, name, key}, or {why, key, final} where `final` says waiting
  // longer will not change the answer once it holds still.
  function choose(date, want) {
    const openers = controls().filter((el) => isOpener(el) && dateOf(el) === date);
    if (openers.length !== 1) {
      return { why: openers.length ? "Two rows show this date, so neither was pressed." : "No row on the Document Center shows this date now.", key: `rows:${openers.length}` };
    }
    const opener = openers[0];
    const why = rowWhy(opener, date);
    if (why) return { why, key: why, final: true };
    const docs = revealedIn(opener);
    if (!docs.length) return { why: "Its row showed no document.", key: "none" };
    const key = docs.map(textOf).join("\n");
    const kind = want ? docs.filter((c) => sameType(typeKey(textOf(c)), want)) : docs;
    const fine = kind.filter((c) => isRevealed(textOf(c)) && !screenNames(c).some((n) => nameRefused(n, want)));
    if (!kind.length) return { why: "Its row shows no document of this kind, so nothing was pressed.", key, final: true };
    if (!fine.length) return { why: "What its row shows is not something this presses.", key, final: true };
    if (fine.length > 1) return { why: "Its row shows more than one document of this kind, so none was pressed.", key, final: true };
    const el = fine[0];
    const name = textOf(el);
    if (all().filter((c) => textOf(c) === name).length !== 1) {
      return { why: "Two controls on the page carry its name, so nothing was pressed.", key, final: true };
    }
    return { el, name, key };
  }

  async function clickDoc(doc) {
    const date = (doc && doc.date) || "";
    if (!doc || doc.method !== "newtab" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || doc.id !== `row:${date}`) {
      return no("This is not a document the list gave.");
    }
    if (signedOut()) return no(SIGN_IN);
    if (!onCenter()) return no("The Document Center was not showing.");
    const want = Object.keys(KNOWN_TYPES).find((k) => KNOWN_TYPES[k] === doc.title) || "";
    const found = await rowHeld(date);
    if (found.why) return no(found.why);
    const opener = found.el;
    if (!safeName(nameOf(opener))) return no("Its row's control is not one this presses.");
    const showing = revealedIn(opener);
    if (opener.getAttribute("aria-expanded") === "true" && !showing.length) {
      return no("Its row is open but shows no document. Reload the Document Center, then run it again.");
    }
    if (!showing.length) {
      // Pressed once: pressing it again would fold the row away.
      const why = rowWhy(opener, date);
      if (why) return no(why);
      opener.click();
    }
    // The press can draw the row anew, so the row is found again by its date
    // each time, and its document has to hold still inside it.
    const until = Date.now() + REVEAL_WAIT_MS;
    let last = null;
    let since = Date.now();
    let pick = null;
    for (;;) {
      await sleep(LOOK_MS * 2);
      if (signedOut()) return no(SIGN_IN);
      const got = choose(date, want);
      const same = Boolean(last) && last.key === got.key && last.el === got.el;
      if (!same) since = Date.now();
      last = got;
      if (same && Date.now() - since >= LOOK_MS * 2) {
        if (got.el) { pick = got; break; }
        if (got.final) return no(got.why);
      }
      if (Date.now() >= until) return no(got.why || "Its row showed no document.");
    }
    // Asked once more right before the press.
    const now = choose(date, want);
    if (!now.el || now.el !== pick.el || now.name !== pick.name) {
      return no("Its row changed before its document was pressed, so nothing was pressed.");
    }
    now.el.click();
    return { ok: true };
  }

  async function fetchPdf(doc) {
    let url;
    try { url = new URL((doc && doc.url) || ""); } catch (e) { return { ok: false, why: "not a document link" }; }
    if (url.protocol !== "https:" || url.origin !== location.origin || url.hostname !== HOST || !PDF_HREF.test(url.href)
      || doc.id !== `${url.pathname}${url.search}`) {
      return { ok: false, why: "not a document link" };
    }
    const response = await fetch(url.href, { credentials: "same-origin", redirect: "manual" });
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) {
      return { ok: false, signedOut: true, why: "The site asked for a sign-in." };
    }
    if (response.status !== 200) return { ok: false, why: `The site sent ${response.status}.` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    return globalThis.__sweepPdf.pdfResult(bytes);
  }

  globalThis.__sweep = { readList, fetchPdf, clickDoc };
})();
