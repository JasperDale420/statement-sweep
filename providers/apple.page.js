// Runs inside the Apple Store's own pages. Reads the orders and their invoice
// addresses from the data the page embeds, and presses nothing. An invoice has
// no PDF, so each one is printed.
//
// An order's details page, which names its invoice, is on another Apple host
// than the order list. A page may only ask its own host, so from the list this
// reaches the orders on the same host, and otherwise says how to go on: open
// an order's details page and sweep from there, and it reads that order.
//
// The App Store side (reportaproblem.apple.com) is not here: its receipts come
// only as HTML inside a JSON answer, which this kind of recipe cannot print.
//
// Derived from PaperPull's apps/apple/apple_site.py (AGPL-3.0).
(() => {
  const DATA_WAIT_MS = 20000;
  const PAUSE_MS = 2000;
  const MAX_DETAILS = 12;
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const LOGIN_MARKERS = ["/shop/signin", "/signin", "/sign-in", "/auth/signin", "idmsa.apple.com", "appleid.apple.com/sign-in"];
  const CHECK_MARKERS = ["verify you are a human", "verify you are human", "are you a robot", "unusual activity", "access denied"];
  const RATE_MARKERS = ["too many requests", "rate limit", "temporarily blocked", "http error 429"];
  const ORDER = /^W\d{6,15}$/;
  const SECURE_STORE = /^secure\d{1,3}\.store\.apple\.com$/;
  const NAMED_DATE = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(\d{4})(?!\d)/i;
  const ISO_DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/;
  const US_DATE = /(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/;

  const clean = (s) => String(s == null ? "" : s).replace(/[​‎‏﻿]/g, "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN_MARKERS.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']"));
  }

  function check() {
    const hay = `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 3000)}`.toLowerCase();
    if (CHECK_MARKERS.some((m) => hay.includes(m))) return { state: "challenge" };
    if (RATE_MARKERS.some((m) => hay.includes(m))) return { state: "stopped", why: "Apple asked for a pause. Try again later." };
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

  // The list page's data as orders, each with its details address.
  function parseList(init) {
    const root = init.orderList;
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

  // One order's details data: a document, skip for a canceled one, or why not.
  function orderDoc(init, expected) {
    const od = init && init.orderDetail;
    if (!od || typeof od !== "object") return { why: "An order's details page held no order." };
    const header = (od.orderHeader || {}).d || {};
    const number = clean(header.orderNumber);
    if (!ORDER.test(number) || (expected && expected !== number)) return { why: "An order's details page named a different order." };
    const oi = od.orderItems && typeof od.orderItems === "object" ? od.orderItems : {};
    const keys = (oi.c || []).filter((k) => String(k).startsWith("orderItem-"));
    const items = (keys.length ? keys : Object.keys(oi).filter((k) => k.startsWith("orderItem-"))).map((k) => oi[k] || {});
    const invoice = appleUrl(String(header.invoiceUrl || ""));
    if (!invoice || !pathStarts(invoice, "/shop/order/print/invoice/")) {
      const canceled = items.length > 0 && items.every((it) => {
        const t = (it.orderItemStatusTracker || {}).d || {};
        return /^CANCELL?ED$/i.test(clean(t.currentStatus || t.statusDescription));
      });
      return canceled ? { skip: true } : { why: "An order has no invoice and is not canceled." };
    }
    const date = parseDate(header.orderPlacedDate);
    if (!date) return { why: "An order's date could not be read." };
    const details = (items[0] && items[0].orderItemDetails && items[0].orderItemDetails.d) || {};
    const title = clean(details.productName || details.itemShortName).split(" - ")[0].slice(0, 60) || "Store Order";
    return { doc: { id: number, date, title, method: "print", url: invoice.href } };
  }

  async function detailFromFetch(url) {
    const response = await fetch(url, { credentials: "same-origin", redirect: "manual" });
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) return { why: "Apple asked for a sign-in." };
    if (!response.ok) return { why: `Apple answered ${response.status} for an order.` };
    return { init: initData(new DOMParser().parseFromString(await response.text(), "text/html")) };
  }

  async function readList() {
    if (signedOut()) return { state: "signed_out" };
    const here = appleUrl(location.href);
    const onList = pathStarts(here, "/shop/order/list");
    const onDetail = pathStarts(here, "/shop/order/detail/");
    if (!onList && !onDetail) return { state: "no_list" };
    const end = Date.now() + DATA_WAIT_MS;
    let init = initData(document);
    while (!init) {
      const held = check();
      if (held) return held;
      if (Date.now() >= end) return { state: "stopped", why: "The order page held no order data." };
      await sleep(500);
      if (signedOut()) return { state: "signed_out" };
      init = initData(document);
    }
    if (onDetail) {
      const one = orderDoc(init);
      if (one.why) return { state: "stopped", why: one.why };
      return one.skip ? { state: "ok", docs: [] } : { state: "ok", docs: [one.doc] };
    }
    const list = parseList(init);
    if (!list) return { state: "stopped", why: "The order page held no order list." };
    const docs = [];
    const notes = [];
    if (list.more) notes.push("Apple has older orders that this does not read.");
    const reach = list.orders.filter((o) => { const u = appleUrl(o.detail); return u && u.origin === location.origin; });
    const away = list.orders.length - reach.length;
    if (away) notes.push(`${away} of ${list.orders.length} orders have their details on another Apple host. Open an order's details page and sweep from there.`);
    if (reach.length > MAX_DETAILS) notes.push("Only the newest orders were read.");
    for (const [i, order] of reach.slice(0, MAX_DETAILS).entries()) {
      if (i) await sleep(PAUSE_MS);
      const got = await detailFromFetch(order.detail);
      if (got.why) { notes.push(got.why); break; }
      const one = orderDoc(got.init, order.number);
      if (one.why) notes.push(one.why);
      else if (one.doc) docs.push(one.doc);
    }
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (notes.length) return { state: "stopped", why: notes.join(" "), docs };
    return { state: "ok", docs };
  }

  globalThis.__sweep = { readList };
})();
