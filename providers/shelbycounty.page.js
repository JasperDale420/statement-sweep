// Runs inside the Shelby County Trustee's public Tax Query pages, on the host
// that shows bills and receipts. Read and save only. It never goes near the
// payment site. Its only presses are a receipt's Print Receipt and the parcel
// page's Print Notice. In a tab the sweep opened it also goes from the parcel
// page to each of its bills, by the address each bill's own link carries.
//
// The site builds each PDF in the page and opens it, so no address holds one.
// As PaperPull does, one press is watched and the file the page made is kept.
// That needs the page's own world, so a small script is put there for the
// moment of the press, and everything it replaced is put back.
//
// Derived from PaperPull's apps/shelbycounty/shelbycounty_site.py (AGPL-3.0).
(() => {
  const HOST = "apps2.shelbycountytrustee.com";
  const ORIGIN = `https://${HOST}`;
  const LOGIN_MARKERS = ["/login", "/signin", "/sign-in", "/account/login", "/authorize", "payit901"];
  const CHECK_WORDS = ["are you a robot", "captcha", "access denied"];
  const SLOW_WORDS = ["too many requests", "rate limit", "try again later", "temporarily unavailable", "http error 429"];
  const DATA_ERRORS = ["failed to fetch", "data retrieval error", "error retrieving", "something went wrong"];
  const NO_ROWS = /no transactions|no records|no payment/i;
  const FOOTER = /PAGE\s+(\d+)\s+OF\s+(\d+).*?TOTAL\s+RECORDS:\s*(\d+)/i;
  const MDY = /^(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})$/;
  const YEAR = /^(?:19|20)\d{2}$/;
  const RECEIPT_LABEL = /^\s*print\s+receipt\s*$/i;
  const NOTICE_LABEL = /^\s*print\s+notice\b(?:\s+balances?\s+due)?\s*$/i;
  const RECEIPT_ID = /^receipt-([A-Z0-9]+)-(\d{4}-\d{2}-\d{2})-(\d{1,4})$/;
  const NOTICE_ID = /^notice-([A-Z0-9]+)-((?:19|20)\d{2})$/;
  const BILL_LINK = "a[href*='Transaction?billNumberData=']";
  // A bill's page cannot see the parcel's other bills, so it never answers ok.
  const ONE_BILL = "Only this bill's receipts were read. Open each of the parcel's other bills and sweep again.";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const squash = (text) => (text || "").replace(/\s+/g, " ").trim();
  const body = () => (document.body && document.body.innerText) || "";
  const stopped = (why, docs = []) => ({ state: "stopped", why, docs });

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN_MARKERS.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']"));
  }

  const parcelKey = (raw) => (typeof raw === "string" ? raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase() : "");

  // The parcel this page is about, "" when it cannot be read. A bill's page
  // holds it in billNumberData, the bill row as base64 JSON.
  function pageParcel() {
    const params = new URLSearchParams(location.search);
    const path = location.pathname.replace(/\/$/, "");
    const key = path === "/Parcel" ? "parcel" : "billNumberData";
    const values = params.getAll(key);
    if (values.length !== 1) return "";
    if (path === "/Parcel") return parcelKey(values[0]);
    return dataParcel(values[0]);
  }

  function dataParcel(value) {
    try {
      // URLSearchParams has read each + of the base64 as a space.
      return parcelKey(JSON.parse(atob(value.replace(/ /g, "+"))).parcel);
    } catch (e) {
      return "";
    }
  }

  function rows() {
    return Array.from(document.querySelectorAll("table tbody tr")).map((tr) => {
      const link = tr.querySelector("a");
      return {
        el: tr,
        cells: Array.from(tr.querySelectorAll("td")).map((td) => squash(td.innerText)),
        hasBill: Boolean(tr.querySelector(BILL_LINK)),
        link,
        label: link ? squash(link.innerText) : "",
      };
    });
  }

  function footer() {
    const text = body();
    const at = text.search(/PAGE\s+\d+\s+OF\s+\d+/i);
    if (at < 0) return null;
    const m = FOOTER.exec(text.slice(at, at + 200).replace(/\n/g, " "));
    return m ? { page: +m[1], pages: +m[2], total: +m[3] } : null;
  }

  // "" when the whole table is on the page, or why it is not.
  function tableProblem(what, count) {
    const f = footer();
    if (!f) return `The ${what} table shows no PAGE / TOTAL RECORDS line.`;
    if (f.page !== 1) return `The ${what} table is not on its first page.`;
    if (f.pages < 1 || f.total < 0) return `The ${what} table's page count makes no sense.`;
    if (f.pages > 1) return `The ${what} table runs to ${f.pages} pages. Only the first was read, since moving to the next is not a document's own control.`;
    if (count !== f.total) return `The ${what} table shows ${count} rows where it says ${f.total}.`;
    return "";
  }

  // The site shows 10 rows a page and has its own "Rows:" picker up to 50.
  // Set it so the whole table is on one page before reading it, then wait for
  // the table to redraw. Changing how many rows show changes nothing else.
  function rowsPicker() {
    return Array.from(document.querySelectorAll("select")).find((s) => {
      const label = s.parentElement ? squash(s.parentElement.innerText) : "";
      return /^rows:?(\s|$)/i.test(label);
    }) || null;
  }

  async function fullTable() {
    const f = footer();
    if (!f || f.pages <= 1) return;
    const sel = rowsPicker();
    if (!sel) return;
    const sizes = Array.from(sel.options).map((o) => +o.value).filter((n) => Number.isInteger(n) && n > 0);
    if (!sizes.length) return;
    const best = sizes.filter((n) => n >= f.total).sort((a, b) => a - b)[0] || Math.max(...sizes);
    if (+sel.value === best) return;
    log(`Table runs to ${f.pages} pages (${f.total} rows): showing ${best} rows a page.`);
    sel.value = String(best);
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      const g = footer();
      if (g && g.pages === 1) return;
    }
    log("The table did not redraw on one page.");
  }

  const log = (text) => { try { if (typeof globalThis.__sweepLog === "function") globalThis.__sweepLog(text); } catch (e) { /* logging never stops a sweep */ } };

  function mdyToIso(text) {
    const m = MDY.exec((text || "").trim());
    if (!m) return "";
    const month = +m[1], day = +m[2], year = +m[3];
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d.toISOString().slice(0, 10) : "";
  }

  const lastFour = (receipt) => receipt.replace(/\D/g, "").slice(-4);

  function billYears(all) {
    const years = [];
    for (const row of all) {
      if (row.cells.length < 2 || !row.hasBill) return { why: "A billing row has no bill link." };
      const year = row.cells[1].trim();
      if (!YEAR.test(year)) return { why: "A billing row's year is not a year." };
      if (years.includes(year)) return { why: `Two bills are listed for tax year ${year}.` };
      years.push(year);
    }
    return { years };
  }

  function balanceDue() {
    const m = /TOTAL BALANCE\s*\n\s*([^\n]+)/i.exec(body());
    return Boolean(m && /[1-9]/.test(m[1].replace(/[^\d.]/g, "")));
  }

  function noticeButton() {
    const buttons = Array.from(document.querySelectorAll("button")).filter((b) => /^\s*print\s+notice\b/i.test(b.innerText || ""));
    if (buttons.length !== 1 || buttons[0].disabled) return null;
    return NOTICE_LABEL.test(squash(buttons[0].innerText)) ? buttons[0] : null;
  }

  async function readParcel() {
    const parcel = pageParcel();
    if (!parcel) return stopped("Look up your parcel on this page, then sweep again.");
    rememberHere();
    await fullTable();
    const all = rows();
    if (!all.length) return stopped("The parcel's billing history shows no bill.");
    const problem = tableProblem("billing history", all.length);
    const read = billYears(all);
    if (read.why) return stopped(read.why);
    if (problem) return stopped(problem);
    return stopped("Receipts are on each bill's own page. Open a bill from the billing history, then sweep again.", noticeDocs(parcel, read.years));
  }

  function noticeDocs(parcel, years) {
    if (!balanceDue() || !noticeButton()) return [];
    const newest = years.slice().sort().reverse()[0];
    return [{ id: `notice-${parcel}-${newest}`, date: `${newest}-12-31`, title: "Property Tax Notice", method: "fetch" }];
  }

  // A bill's payment history as documents. `why` says what was wrong with it,
  // with the documents read before that; `empty` is a history that says it
  // has no rows; `unread` is one that shows neither rows nor those words.
  async function billRead() {
    const parcel = pageParcel();
    if (!parcel) return { docs: [], why: "This bill's parcel could not be read.", noParcel: true };
    rememberHere();
    await fullTable();
    const all = rows();
    if (!footer() && !all.length) {
      return NO_ROWS.test(body().slice(0, 4000))
        ? { docs: [], why: "", empty: true }
        : { docs: [], why: "The payment history shows neither rows nor words saying it is empty.", unread: true };
    }
    const problem = tableProblem("payment history", all.length);
    const docs = [];
    const counted = new Map();
    for (const row of all) {
      if (row.cells.length < 3) return { docs, why: "A receipt row has too few cells." };
      if (!row.link || !RECEIPT_LABEL.test(row.label)) return { docs, why: "A receipt row has no Print Receipt link." };
      const iso = mdyToIso(row.cells[2]);
      if (!iso) return { docs, why: "A receipt row's date is not a calendar date." };
      const last = lastFour(row.cells[1]);
      if (!last) return { docs, why: "A receipt row carries no receipt number." };
      const id = `receipt-${parcel}-${iso}-${last}`;
      if (docs.some((d) => d.id === id)) return { docs, why: "Two receipts share a date and a receipt number ending." };
      counted.set(iso, (counted.get(iso) || 0) + 1);
      docs.push({ id, date: iso, title: "Property Tax Receipt", method: "fetch" });
    }
    for (const doc of docs) if (counted.get(doc.date) > 1) doc.title += ` (#${doc.id.split("-").pop()})`;
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return { docs, why: problem };
  }

  async function readBill() {
    const r = await billRead();
    if (r.empty) return stopped(ONE_BILL);
    return stopped(r.why || ONE_BILL, r.docs);
  }

  // ---- The walk, only in a tab the sweep opened ----
  // From the parcel page to each of its bills in turn, newest tax year first,
  // as PaperPull does, by the address each bill's own link carries. Where the
  // walk is lives in this tab's sessionStorage, since this file starts afresh
  // on every page. The parcel itself is remembered in this site's
  // localStorage, so a later sweep can open it without being told.
  const WALK_KEY = "statementSweepWalk";
  const SEEN_KEY = "statementSweepSeen";
  const SENT_KEY = "statementSweepSent";
  const PARCEL_KEY = "statementSweepParcel";
  const MAX_BILLS = 60;
  const LOAD_MS = 30000;
  const WALKING = { state: "walking" };
  const PARCEL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 .-]{0,39}$/;

  function stored(store, key) {
    try {
      const raw = globalThis[store].getItem(key);
      return raw === null ? null : JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  function store(where, key, value) {
    try {
      if (value === null) globalThis[where].removeItem(key);
      else globalThis[where].setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function rememberedParcel() {
    const raw = stored("localStorage", PARCEL_KEY);
    return typeof raw === "string" && PARCEL_SHAPE.test(raw) && parcelKey(raw) ? raw : "";
  }

  // Remember the parcel the moment a parcel or bill page shows one, before
  // anything is read, so a stop further on never loses it. The site pads it
  // with spaces ("002010  00005   …"); those are kept trimmed of the tail.
  function rememberHere() {
    const params = new URLSearchParams(location.search);
    let raw = params.get("parcel") || "";
    if (!raw && params.get("billNumberData")) {
      try { raw = String(JSON.parse(atob(params.get("billNumberData").replace(/ /g, "+"))).parcel || ""); } catch (e) { raw = ""; }
    }
    raw = raw.replace(/\s+$/, "");
    if (!PARCEL_SHAPE.test(raw) || !parcelKey(raw)) return;
    if (rememberedParcel() === raw) return;
    if (store("localStorage", PARCEL_KEY, raw)) log("Parcel remembered for the next sweep.");
  }

  // Which page an address is, so one address can be matched to another
  // however its query was written: "P:<parcel>" or "T:<billNumberData>".
  function pageKey(href) {
    let u;
    try { u = new URL(href, location.href); } catch (e) { return ""; }
    if (u.origin !== ORIGIN) return "";
    const path = u.pathname.replace(/\/$/, "");
    if (path === "/Parcel") {
      const values = u.searchParams.getAll("parcel");
      return values.length === 1 && parcelKey(values[0]) ? `P:${parcelKey(values[0])}` : "";
    }
    if (path === "/Transaction") {
      const values = u.searchParams.getAll("billNumberData");
      return values.length === 1 && values[0] ? `T:${values[0].replace(/ /g, "+")}` : "";
    }
    return "";
  }

  // The address of a bill of `parcel` on this site, or "".
  function billUrl(href, parcel) {
    let u;
    try { u = new URL(href, location.href); } catch (e) { return ""; }
    if (u.protocol !== "https:" || u.origin !== ORIGIN || u.username || u.password || u.hash) return "";
    if (u.pathname !== "/Transaction") return "";
    const keys = Array.from(u.searchParams.keys());
    if (keys.length !== 1 || keys[0] !== "billNumberData") return "";
    const value = u.searchParams.get("billNumberData");
    if (!value || dataParcel(value) !== parcel) return "";
    return u.href;
  }

  // How long this tab has shown this page, as far as the sweep has looked.
  function shownFor() {
    const here = pageKey(location.href) || location.href;
    const seen = stored("sessionStorage", SEEN_KEY);
    if (seen && seen.key === here && typeof seen.at === "number") return Date.now() - seen.at;
    store("sessionStorage", SEEN_KEY, { key: here, at: Date.now() });
    return 0;
  }
  const stillLoading = () => document.readyState !== "complete" || shownFor() < LOAD_MS;

  function walkState() {
    const w = stored("sessionStorage", WALK_KEY);
    if (!w || typeof w !== "object" || typeof w.parcel !== "string" || !Array.isArray(w.bills)) return null;
    if (w.bills.length > MAX_BILLS || typeof w.at !== "number" || w.at < -1 || w.at >= w.bills.length) return null;
    if (!w.bills.every((b) => b && billUrl(b.href, w.parcel) === b.href && pageKey(b.href) === b.key)) return null;
    return w;
  }
  const endWalk = () => store("sessionStorage", WALK_KEY, null);

  // The page the walk should be showing now, and the one it left.
  const walkHere = (w) => (w.at < 0 ? w.home : w.bills[w.at].key);

  // A move nextView made that the tab has not finished yet: the page it left
  // is still the one on screen.
  function moving(w, here) {
    if (!w || !w.pending || here !== w.from) return null;
    if (Date.now() - w.since < LOAD_MS) return WALKING;
    endWalk();
    return stopped("The next bill's page did not open.");
  }

  function walkBareParcel() {
    const raw = rememberedParcel();
    // The one thing the person does, once: the sweep waits while they look
    // the parcel up, then remembers it and goes on by itself.
    if (!raw) return { state: "waiting", why: "Look up your parcel in Shelby County Trustee's tab. Statement Sweep remembers it and goes on by itself." };
    const sent = stored("sessionStorage", SENT_KEY);
    if (typeof sent === "number" && Date.now() - sent < LOAD_MS) return WALKING;
    if (typeof sent === "number") return stopped("The parcel this remembered did not open. Look up your parcel on this page, then sweep again.");
    if (!store("sessionStorage", SENT_KEY, Date.now())) return stopped("Look up your parcel on this page, then sweep again.");
    location.assign(`${ORIGIN}/Parcel?parcel=${encodeURIComponent(raw)}`);
    return WALKING;
  }

  async function walkParcel() {
    const here = pageKey(location.href);
    const parcel = pageParcel();
    if (!parcel) return walkBareParcel();
    rememberHere();
    const waiting = moving(walkState(), here);
    if (waiting) return waiting;
    endWalk();
    await fullTable();
    const all = rows();
    log(`Parcel page: ${all.length} bill row(s).`);
    if (!all.length) return stillLoading() ? WALKING : stopped("The parcel's billing history shows no bill.");
    const problem = tableProblem("billing history", all.length);
    const read = billYears(all);
    if (read.why) return stopped(read.why);
    if (problem) return stopped(problem);
    const bills = [];
    for (const [i, row] of all.entries()) {
      const links = Array.from(row.el.querySelectorAll(BILL_LINK));
      const hrefs = new Set(links.map((a) => a.getAttribute("href") || ""));
      if (hrefs.size !== 1) return stopped("A billing row does not have exactly one bill link.");
      const href = billUrl([...hrefs][0], parcel);
      if (!href) return stopped("A billing row's link is not a bill of this parcel on the Trustee's lookup.");
      if (bills.some((b) => b.key === pageKey(href))) return stopped("Two billing rows link to the same bill.");
      bills.push({ href, key: pageKey(href), year: read.years[i] });
    }
    bills.sort((a, b) => (a.year < b.year ? 1 : a.year > b.year ? -1 : 0));
    const note = bills.length > MAX_BILLS ? `The parcel lists ${bills.length} bills. Only the newest ${MAX_BILLS} were read.` : "";
    const w = { parcel, home: here, at: -1, pending: false, from: "", since: 0, bills: bills.slice(0, MAX_BILLS) };
    if (!store("sessionStorage", WALK_KEY, w)) return stopped("This tab cannot keep its place, so the parcel's bills cannot be walked.");
    store("sessionStorage", SENT_KEY, null);
    const docs = noticeDocs(parcel, read.years);
    return note ? { state: "ok", docs, more: true, note } : { state: "ok", docs, more: true };
  }

  async function walkBill() {
    const here = pageKey(location.href);
    const w = walkState();
    if (!w) return readBill();
    const waiting = moving(w, here);
    if (waiting) return waiting;
    const parcel = pageParcel();
    if (parcel !== w.parcel) {
      endWalk();
      return stopped("This bill is for another parcel than the one being walked.");
    }
    const at = w.bills.findIndex((b) => b.key === here);
    if (at < 0 || at !== w.at) {
      endWalk();
      return stopped("This bill is not the one the walk opened.");
    }
    if (w.pending) {
      w.pending = false;
      store("sessionStorage", WALK_KEY, w);
    }
    const r = await billRead();
    log(`Bill ${w.bills[at].year}: ${r.docs.length} receipt(s)${r.why ? `; ${r.why}` : ""}.`);
    if (r.unread && stillLoading()) return WALKING;
    const done = { state: "ok", docs: r.docs, more: true };
    if (r.why) done.note = `The ${w.bills[at].year} bill: ${r.why} Its other receipts were not read.`;
    return done;
  }

  // On to the next bill, by the address its own link carried. Nothing is pressed.
  function nextView() {
    if (location.protocol !== "https:" || location.hostname !== HOST) return { why: "This tab is not on the Trustee's lookup." };
    const w = walkState();
    if (!w) return { why: "No walk of the parcel's bills is under way in this tab." };
    if (w.pending || pageKey(location.href) !== walkHere(w)) {
      endWalk();
      return { why: "This page is not where the walk of the parcel's bills was." };
    }
    const next = w.at + 1;
    if (next >= w.bills.length) {
      endWalk();
      return { moved: false };
    }
    const href = billUrl(w.bills[next].href, w.parcel);
    if (!href) {
      endWalk();
      return { why: "The next bill's address is not a bill of this parcel." };
    }
    Object.assign(w, { at: next, pending: true, from: pageKey(location.href), since: Date.now() });
    if (!store("sessionStorage", WALK_KEY, w)) return { why: "This tab cannot keep its place, so the parcel's bills cannot be walked." };
    location.assign(href);
    return { moved: true };
  }

  function readList(options) {
    const mayWalk = Boolean(options && options.walk);
    if (location.protocol !== "https:" || location.hostname !== HOST) return { state: "no_list" };
    if (signedOut()) return { state: "signed_out" };
    const lead = body().slice(0, 2500).toLowerCase();
    if (CHECK_WORDS.some((w) => lead.includes(w))) return { state: "challenge" };
    if (SLOW_WORDS.some((w) => lead.includes(w))) return stopped("The Trustee's site says to try again later.");
    const failed = DATA_ERRORS.find((w) => body().slice(0, 3000).toLowerCase().includes(w));
    if (failed) return stopped("The Trustee's page says its data did not load.");
    const path = location.pathname.replace(/\/$/, "");
    if (path === "/Parcel") return mayWalk ? walkParcel() : readParcel();
    if (path === "/Transaction" && new URLSearchParams(location.search).get("billNumberData")) return mayWalk ? walkBill() : readBill();
    // The lookup's own search pages: the person is finding their parcel. Keep
    // waiting with them rather than calling it no list.
    if (mayWalk && !rememberedParcel() && /^\/(ParcelsClient|PropertyClient|OwnerClient|Search)$/i.test(path)) {
      return { state: "waiting", why: "Look up your parcel in Shelby County Trustee's tab and open it. Statement Sweep remembers it and goes on by itself." };
    }
    return { state: "no_list" };
  }

  // Put in the page's own world for one press. It keeps every Blob the page
  // makes and records what the page asks to open, opening nothing.
  function hookSource(nonce) {
    return `(() => {
      const nonce = ${JSON.stringify(nonce)};
      const made = [], opened = [];
      const realCreate = URL.createObjectURL, realOpen = window.open;
      URL.createObjectURL = function (b) { const u = realCreate.call(URL, b); made.push({ blob: b, type: (b && b.type) || "", size: (b && b.size) || 0, url: String(u) }); return u; };
      window.open = function (u) { opened.push(String(u)); return null; };
      const restore = () => { URL.createObjectURL = realCreate; window.open = realOpen; window.removeEventListener("message", onAsk); };
      async function onAsk(e) {
        if (e.source !== window || !e.data || e.data.sweepAsk !== nonce) return;
        if (e.data.what === "count") { window.postMessage({ sweepAnswer: nonce, what: "count", made: made.length, opened: opened.length }, location.origin); return; }
        if (e.data.what === "restore") { restore(); return; }
        const out = { sweepAnswer: nonce, what: "take", blobs: made.map((b) => ({ type: b.type, size: b.size, url: b.url })), opened: opened.slice(), bytes: "" };
        try {
          if (made.length === 1) {
            const bytes = new Uint8Array(await made[0].blob.arrayBuffer());
            let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            out.bytes = btoa(bin);
          }
        } catch (err) {
          out.bytes = "";
        } finally {
          restore();
        }
        window.postMessage(out, location.origin);
      }
      window.addEventListener("message", onAsk);
      document.documentElement.setAttribute("data-sweep-armed", nonce);
    })();`;
  }

  function arm(nonce) {
    const root = document.documentElement;
    // First the listener the engine put in the page's world (shelbycounty.main.js):
    // an event's string detail crosses from this world to that one at once.
    document.dispatchEvent(new CustomEvent("statement-sweep-arm", { detail: nonce }));
    let armed = root.getAttribute("data-sweep-armed") === nonce;
    if (!armed) {
      // Without it, the older way: a script put in the page, where its policy allows.
      log("The page-world listener was not there; trying an inserted script.");
      const script = document.createElement("script");
      script.textContent = hookSource(nonce);
      (document.head || root).appendChild(script);
      script.remove();
      armed = root.getAttribute("data-sweep-armed") === nonce;
    }
    root.removeAttribute("data-sweep-armed");
    if (!armed) log("Neither way could watch the press.");
    return armed;
  }

  function ask(nonce, what, ms = 3000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { window.removeEventListener("message", onAnswer); resolve(null); }, ms);
      function onAnswer(e) {
        if (e.source !== window || !e.data || e.data.sweepAnswer !== nonce || e.data.what !== what) return;
        clearTimeout(timer);
        window.removeEventListener("message", onAnswer);
        resolve(e.data);
      }
      window.addEventListener("message", onAnswer);
      window.postMessage({ sweepAsk: nonce, what }, location.origin);
    });
  }

  // Exactly one Blob, of the PDF type, on this site's own origin, asked to
  // open at that same address, starting %PDF-.
  function acceptBlob(result) {
    if (!result) return { why: "The page did not answer." };
    const blobs = result.blobs || [], opened = result.opened || [];
    if (blobs.length !== 1) return { why: "The press did not make exactly one file." };
    if (blobs[0].type !== "application/pdf") return { why: "The file the page made is not a PDF." };
    if (!String(blobs[0].url).startsWith(`blob:${ORIGIN}/`)) return { why: "The file is not on the Trustee's own site." };
    if (opened.length !== 1 || opened[0] !== blobs[0].url) return { why: "The page did not ask to open that file." };
    let bin;
    try { bin = atob(result.bytes || ""); } catch (e) { return { why: "The file could not be read." }; }
    if (bin.slice(0, 5) !== "%PDF-") return { why: "That was not a PDF." };
    return { bin, base64: result.bytes, size: bin.length };
  }

  // The PDF has to be the document that was pressed: its own text names the
  // row's date and receipt number. The site's PDFs are uncompressed.
  function wrongReceipt(bin, dateText, receipt) {
    const digits = receipt.replace(/\D/g, "");
    const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(dateText);
    if (!digits || !m) return "The row cannot be matched to a PDF.";
    if (!new RegExp(`\\b0?${+m[1]}\\s*/\\s*0?${+m[2]}\\s*/\\s*${m[3]}\\b`).test(bin)) return "The PDF does not name the receipt's date.";
    if (!new RegExp(`(?<!\\d)${digits.split("").join("\\s*")}(?!\\d)`).test(bin)) return "The PDF does not name the receipt's number.";
    return "";
  }

  function wrongNotice(bin, year) {
    if (!/notice/i.test(bin)) return "The PDF does not read as a notice.";
    if (!new RegExp(`(?<!\\d)${year}(?!\\d)`).test(bin)) return "The PDF does not name the tax year.";
    return "";
  }

  async function pressAndTake(control, expect) {
    const nonce = `sweep-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    if (!arm(nonce)) return { ok: false, why: "This page does not allow the small script needed to keep the file it builds." };
    control.click();
    let seen = "0|0", still = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const count = await ask(nonce, "count");
      const now = count ? `${count.made}|${count.opened}` : "0|0";
      if (count && count.made && now === seen) {
        still += 1;
        if (still >= 3) break;
      } else {
        still = 0;
      }
      seen = now;
    }
    const accepted = acceptBlob(await ask(nonce, "take", 8000));
    if (accepted.why) return { ok: false, why: accepted.why };
    const wrong = expect(accepted.bin);
    if (wrong) return { ok: false, why: wrong };
    return { ok: true, size: accepted.size, base64: accepted.base64 };
  }

  async function fetchPdf(doc) {
    const id = (doc && doc.id) || "";
    if (location.protocol !== "https:" || location.hostname !== HOST) return { ok: false, why: "This tab is not on the Trustee's lookup." };
    const notice = NOTICE_ID.exec(id);
    if (notice) {
      if (pageParcel() !== notice[1]) return { ok: false, why: "This page shows another parcel." };
      await fullTable();
      const all = rows();
      const read = billYears(all);
      if (read.why || tableProblem("billing history", all.length) || read.years.slice().sort().reverse()[0] !== notice[2]) return { ok: false, why: "The parcel page no longer shows that notice's year as the newest bill." };
      const button = balanceDue() ? noticeButton() : null;
      if (!button) return { ok: false, why: "Print Notice is not there to press." };
      return pressAndTake(button, (bin) => wrongNotice(bin, notice[2]));
    }
    const receipt = RECEIPT_ID.exec(id);
    if (!receipt) return { ok: false, why: "not a document id" };
    if (pageParcel() !== receipt[1]) return { ok: false, why: "This page shows another parcel." };
    const hits = rows().filter((r) => r.cells.length >= 3 && mdyToIso(r.cells[2]) === receipt[2] && lastFour(r.cells[1]) === receipt[3]);
    if (hits.length !== 1) return { ok: false, why: "That receipt is not on the page once." };
    if (!hits[0].link || !RECEIPT_LABEL.test(hits[0].label)) return { ok: false, why: "That receipt has no Print Receipt link." };
    const { cells } = hits[0];
    return pressAndTake(hits[0].link, (bin) => wrongReceipt(bin, cells[2], cells[1]));
  }

  globalThis.__sweep = { readList, fetchPdf, nextView };
})();
