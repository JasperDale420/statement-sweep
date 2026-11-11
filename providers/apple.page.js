// Runs inside the Apple Store's own pages. Reads the orders and their invoice
// addresses from the data the pages embed, and presses nothing. An invoice is
// a web page, not a PDF, so each one is printed.
//
// The order list names each order's details page, which is on another Apple
// host (secureN.store.apple.com), and only that page names the date and the
// invoice. So the sweep's own tab walks them as a person would: from the list
// to one order's details page, back to the list, to the next, and so on. The
// list says which orders this walk has been to in this tab's session storage
// on the list's host, since the details pages cannot see it.
//
// An invoice is printed where Apple draws it: showDoc goes to the invoice's
// own address, which the order's details page named and which is checked to
// be an invoice page on Apple's store, and printReady waits for it to show
// that order's number and stop changing. The invoice's own Print and Close
// buttons are hidden first (a display change in this page, nothing pressed),
// as PaperPull does.
//
// Apple says when older orders exist past the list, and this, like PaperPull,
// does not page the list: it says so. The App Store side
// (reportaproblem.apple.com) is not here: its receipts come only as HTML
// inside a JSON answer, with no page of their own to print.
//
// Derived from PaperPull's apps/apple/apple_site.py (AGPL-3.0).
(() => {
  const DATA_WAIT_MS = 20000;
  const PAUSE_MS = 2000;
  const STEADY_MS = 800;
  const MAX_ORDERS = 100;
  const WALK_AGE_MS = 15 * 60 * 1000;
  const WALK_KEY = "statementSweep.apple.walk";
  const LIST_URL = "https://www.apple.com/shop/order/list";
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const LOGIN_MARKERS = ["/shop/signin", "/signin", "/sign-in", "/auth/signin", "idmsa.apple.com", "appleid.apple.com/sign-in"];
  const CHECK_MARKERS = ["verify you are a human", "verify you are human", "are you a robot", "unusual activity", "access denied"];
  const RATE_MARKERS = ["too many requests", "rate limit", "temporarily blocked", "http error 429"];
  const ORDER = /^W\d{6,15}$/;
  const SECURE_STORE = /^secure\d{1,3}\.store\.apple\.com$/;
  const NAMED_DATE = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(\d{4})(?!\d)/i;
  const ISO_DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/;
  const US_DATE = /(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/;
  const SIGN_IN = "Apple asked for a sign-in. Sign in, then run it again.";
  const OWN_TAB = "Apple's orders are read one by one in the sweep's own tab.";

  const clean = (s) => String(s == null ? "" : s).replace(/[​‎‏﻿]/g, "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A short line for the run log (shared.js), never the page's own text.
  const trace = (text) => { if (globalThis.__sweepLog) globalThis.__sweepLog(text); };

  function day(year, month, date) {
    const d = new Date(Date.UTC(year, month, date));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== date) return null;
    return d.toISOString().slice(0, 10);
  }

  function parseDate(text) {
    const s = String(text || "");
    let m = NAMED_DATE.exec(s);
    if (m) return day(+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()), +m[2]);
    m = ISO_DATE.exec(s);
    if (m) return day(+m[1], +m[2] - 1, +m[3]);
    m = US_DATE.exec(s);
    if (m) return day(+m[3], +m[1] - 1, +m[2]);
    return null;
  }

  // An https address on one of Apple's store hosts, exactly, or null.
  function appleUrl(text) {
    try {
      const u = new URL(text);
      const host = u.hostname.toLowerCase();
      const ok = host === "www.apple.com" || host === "store.apple.com" || SECURE_STORE.test(host);
      return u.protocol === "https:" && !u.port && !u.username && !u.password && ok ? u : null;
    } catch (e) {
      return null;
    }
  }
  const pathStarts = (url, prefix) => Boolean(url) && url.pathname.startsWith(prefix);
  const here = () => appleUrl(location.href);
  const onList = () => pathStarts(here(), "/shop/order/list");
  const onDetail = () => pathStarts(here(), "/shop/order/detail/");

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN_MARKERS.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']"));
  }

  function check() {
    const hay = `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 3000)}`.toLowerCase();
    if (CHECK_MARKERS.some((m) => hay.includes(m))) return { state: "challenge" };
    if (RATE_MARKERS.some((m) => hay.includes(m))) return { state: "stopped", why: "Apple asked for a pause. Try again later.", docs: [] };
    return null;
  }

  function initData(doc) {
    const node = doc.getElementById("init_data");
    if (!node) return null;
    try {
      const data = JSON.parse(node.textContent || "");
      return data && typeof data === "object" && !Array.isArray(data) ? data : null;
    } catch (e) {
      return null;
    }
  }

  // The page's data, once it is there. {init} or an answer to give instead.
  async function pageData() {
    const end = Date.now() + DATA_WAIT_MS;
    let init = initData(document);
    while (!init) {
      const held = check();
      if (held) return { answer: held };
      if (Date.now() >= end) return { answer: { state: "stopped", why: "Apple's order page held no order data.", docs: [] } };
      await sleep(500);
      if (signedOut()) return { answer: { state: "signed_out" } };
      init = initData(document);
    }
    return { init };
  }

  // The list page's data as orders, each with its details address, or null.
  function parseList(init) {
    const root = init && init.orderList;
    if (!root || typeof root !== "object") return null;
    const orders = [];
    const seen = new Set();
    for (const key of root.c || []) {
      const node = root[key];
      if (!node || typeof node !== "object") continue;
      let number = clean((node.d || {}).webOrderNumber);
      if (!ORDER.test(number)) {
        const m = /^order-(W\d{6,15})$/.exec(String(key));
        number = m ? m[1] : "";
      }
      if (!number || seen.has(number)) continue;
      seen.add(number);
      let detail = "";
      for (const itemKey of node.c || []) {
        const item = (node[itemKey] && node[itemKey].d) || null;
        const url = item && appleUrl(item.orderDetailUrl || "");
        if (!detail && pathStarts(url, "/shop/order/detail/")) detail = url.href;
      }
      orders.push({ number, detail });
    }
    return { orders, more: Boolean((root.d || {}).moreOrdersAvailable) };
  }

  // One order's details data: {doc}, {skip} for a canceled one, {later} for
  // one Apple has not invoiced yet, or {why} it cannot be read.
  function orderDoc(init) {
    const od = init && init.orderDetail;
    if (!od || typeof od !== "object") return { why: "An order's details page held no order." };
    const header = (od.orderHeader || {}).d || {};
    const number = clean(header.orderNumber);
    if (!ORDER.test(number)) return { why: "An order's details page named no order number." };
    const oi = od.orderItems && typeof od.orderItems === "object" ? od.orderItems : {};
    const keys = (oi.c || []).filter((k) => String(k).startsWith("orderItem-"));
    const items = (keys.length ? keys : Object.keys(oi).filter((k) => k.startsWith("orderItem-"))).map((k) => oi[k] || {});
    const written = clean(header.invoiceUrl);
    if (!written) {
      const canceled = items.length > 0 && items.every((it) => {
        const t = (it.orderItemStatusTracker || {}).d || {};
        return /^CANCELL?ED$/i.test(clean(t.currentStatus || t.statusDescription));
      });
      // Apple invoices an order once it ships or is ready for pickup.
      return canceled ? { skip: true } : { later: true };
    }
    const invoice = appleUrl(written);
    if (!invoice || !pathStarts(invoice, "/shop/order/print/invoice/")) return { why: "An order's invoice was not on Apple's store." };
    const date = parseDate(header.orderPlacedDate);
    if (!date) return { why: "An order's date could not be read." };
    const details = (items[0] && items[0].orderItemDetails && items[0].orderItemDetails.d) || {};
    const title = clean(details.productName || details.itemShortName).split(" - ")[0].slice(0, 60) || "Store Order";
    return { doc: { id: number, date, title, method: "print", url: invoice.href } };
  }

  // Which orders this walk has been to, kept on the list's host.
  function loadWalk() {
    try {
      const w = JSON.parse(sessionStorage.getItem(WALK_KEY) || "null");
      return w && Array.isArray(w.visited) && typeof w.t === "number" && Date.now() - w.t < WALK_AGE_MS ? w : null;
    } catch (e) { return null; }
  }
  const saveWalk = (w) => { try { sessionStorage.setItem(WALK_KEY, JSON.stringify(w)); } catch (e) { /* not kept */ } };
  const dropWalk = () => { try { sessionStorage.removeItem(WALK_KEY); } catch (e) { /* not there */ } };

  // Leaves this page a moment later, so the answer reaches the sweep first.
  function leaveFor(url, after = 0) {
    globalThis.__appleLeaving = true;
    setTimeout(() => location.assign(url), 100 + after);
  }

  function listNotes(list) {
    const notes = [];
    const missing = list.orders.filter((o) => !o.detail).length;
    if (missing) notes.push(`${missing} Apple order(s) named no details page. They are tried again next time.`);
    if (list.orders.length > MAX_ORDERS) notes.push(`Only the newest ${MAX_ORDERS} Apple orders were read.`);
    if (list.more) notes.push("Apple has older orders that this does not read yet.");
    return notes;
  }

  // The orders this walk has still to visit, newest first.
  function pending(list, walk) {
    const visited = new Set((walk && walk.visited) || []);
    return list.orders.slice(0, MAX_ORDERS).filter((o) => o.detail && !visited.has(o.number));
  }

  async function readList({ walk: mayWalk = false } = {}) {
    if (signedOut()) return { state: "signed_out" };
    if (!onList() && !onDetail()) return { state: "no_list" };
    // A tab of yours, or the sweep's first look at a tab it kept, ends any
    // walk an earlier run left behind. Only the sweep's own tab can print.
    if (!mayWalk) {
      if (onList()) dropWalk();
      return { state: "stopped", why: OWN_TAB, docs: [] };
    }
    if (globalThis.__appleLeaving) return { state: "walking" };
    const got = await pageData();
    if (got.answer) return got.answer;

    if (onDetail()) {
      const one = orderDoc(got.init);
      trace(`Order details on ${location.hostname}: ${one.why ? `stopped: ${one.why}` : one.later ? "not invoiced yet" : one.doc ? "an invoice to print" : "nothing to save"}.`);
      if (one.why) return { state: "stopped", why: one.why, docs: [] };
      if (one.later) return { state: "ok", docs: [], more: true, note: "Apple has not invoiced an order yet. It is looked at again next time." };
      return { state: "ok", docs: one.doc ? [one.doc] : [], more: true };
    }

    const list = parseList(got.init);
    if (!list) return { state: "stopped", why: "Apple's order page held no order list.", docs: [] };
    const notes = listNotes(list);
    const left = pending(list, loadWalk());
    trace(`Order list on ${location.hostname}: ${list.orders.length} order(s), ${left.length} left to visit this walk${list.more ? ", older ones not read" : ""}.`);
    const answer = { state: "ok", docs: [], ...(notes.length ? { note: notes.join(" ") } : {}) };
    if (left.length) return { ...answer, more: true };
    dropWalk();
    return answer;
  }

  // From the list, the next order's details page; from anywhere else on
  // Apple's store, back to the list, which then says whether more are left.
  function nextView() {
    if (signedOut()) return { why: SIGN_IN };
    if (!onList()) {
      leaveFor(LIST_URL);
      return { moved: true };
    }
    const list = parseList(initData(document));
    if (!list) return { why: "Apple's order page held no order list." };
    const walk = loadWalk() || { visited: [] };
    const [next] = pending(list, walk);
    if (!next) { dropWalk(); trace(`End of the walk: ${walk.visited.length} order(s) visited.`); return { moved: false }; }
    // Its place in the walk, never its number, which is the order's own.
    trace(`Next: the details of order ${walk.visited.length + 1} of this walk.`);
    saveWalk({ visited: [...walk.visited, next.number], t: Date.now() });
    // One details page at a time, the way a person reads them.
    leaveFor(next.detail, PAUSE_MS);
    return { moved: true };
  }

  // A doc this listed, as its invoice address, or null.
  function invoiceOf(doc) {
    if (!doc || !ORDER.test(String(doc.id || "")) || doc.method !== "print") return null;
    const url = appleUrl(String(doc.url || ""));
    return pathStarts(url, "/shop/order/print/invoice/") ? url : null;
  }

  function showDoc(doc) {
    const want = invoiceOf(doc);
    if (!want) return { ok: false, why: "This is not an Apple invoice this listed." };
    if (signedOut()) return { ok: false, why: SIGN_IN };
    // On the order's own details page, the invoice must still be the one it names.
    if (onDetail()) {
      const one = orderDoc(initData(document));
      if (one.doc && one.doc.id === doc.id && one.doc.url !== want.href) return { ok: false, why: "The order's invoice address has changed. Run it again." };
    }
    leaveFor(want.href);
    return { ok: true };
  }

  // The invoice's own Print and Close buttons, hidden so the PDF does not
  // show them. Neither is pressed.
  function hidePrintControls() {
    for (const el of document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']")) {
      const t = clean(el.innerText || el.value || el.getAttribute("aria-label") || "");
      if (/^(print|close)$/i.test(t)) el.style.setProperty("display", "none", "important");
    }
  }

  async function printReady(doc) {
    const want = invoiceOf(doc);
    if (!want) return { ok: false, why: "This is not an Apple invoice this listed." };
    if (signedOut()) return { ok: false, why: SIGN_IN };
    const held = check();
    if (held && held.state === "challenge") return { ok: false, why: "Apple is asking you to confirm something. Finish it in its tab, then run it again." };
    if (held) return { ok: false, why: held.why };
    const at = here();
    if (!at || at.host !== want.host || at.pathname !== want.pathname) return { ready: false, why: "Apple's invoice page did not open." };
    if (document.readyState !== "complete") return { ready: false, why: "Apple's invoice is still loading." };
    // The invoice is drawn by the page's own script: it is done when it shows
    // this order's number and stops changing.
    const text = () => (document.body ? document.body.innerText : "");
    const before = text();
    if (!before.includes(doc.id)) return { ready: false, why: "Apple's invoice did not show its order number." };
    await sleep(STEADY_MS);
    if (text() !== before || location.pathname !== want.pathname) return { ready: false, why: "Apple's invoice is still drawing." };
    hidePrintControls();
    return { ready: true };
  }

  globalThis.__sweep = { readList, nextView, showDoc, printReady };
})();
