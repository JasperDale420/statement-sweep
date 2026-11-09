// Runs inside the Shelby County Trustee's public Tax Query pages, on the host
// that shows bills and receipts. Read and save only. It never goes near the
// payment site. Its only presses are a receipt's Print Receipt and the parcel
// page's Print Notice.
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
    try {
      // URLSearchParams has read each + of the base64 as a space.
      return parcelKey(JSON.parse(atob(values[0].replace(/ /g, "+"))).parcel);
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

  function readParcel() {
    const parcel = pageParcel();
    if (!parcel) return stopped("Look up your parcel on this page, then sweep again.");
    const all = rows();
    if (!all.length) return stopped("The parcel's billing history shows no bill.");
    const problem = tableProblem("billing history", all.length);
    const read = billYears(all);
    if (read.why) return stopped(read.why);
    if (problem) return stopped(problem);
    const docs = [];
    if (balanceDue() && noticeButton()) {
      const newest = read.years.slice().sort().reverse()[0];
      docs.push({ id: `notice-${parcel}-${newest}`, date: `${newest}-12-31`, title: "Property Tax Notice", method: "fetch" });
    }
    return stopped("Receipts are on each bill's own page. Open a bill from the billing history, then sweep again.", docs);
  }

  function readBill() {
    const parcel = pageParcel();
    if (!parcel) return stopped("This bill's parcel could not be read.");
    const all = rows();
    if (!footer() && !all.length) {
      return NO_ROWS.test(body().slice(0, 4000)) ? stopped(ONE_BILL) : stopped("The payment history shows neither rows nor words saying it is empty.");
    }
    const problem = tableProblem("payment history", all.length);
    const docs = [];
    const counted = new Map();
    for (const row of all) {
      if (row.cells.length < 3) return stopped("A receipt row has too few cells.", docs);
      if (!row.link || !RECEIPT_LABEL.test(row.label)) return stopped("A receipt row has no Print Receipt link.", docs);
      const iso = mdyToIso(row.cells[2]);
      if (!iso) return stopped("A receipt row's date is not a calendar date.", docs);
      const last = lastFour(row.cells[1]);
      if (!last) return stopped("A receipt row carries no receipt number.", docs);
      const id = `receipt-${parcel}-${iso}-${last}`;
      if (docs.some((d) => d.id === id)) return stopped("Two receipts share a date and a receipt number ending.", docs);
      counted.set(iso, (counted.get(iso) || 0) + 1);
      docs.push({ id, date: iso, title: "Property Tax Receipt", method: "fetch" });
    }
    for (const doc of docs) if (counted.get(doc.date) > 1) doc.title += ` (#${doc.id.split("-").pop()})`;
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return stopped(problem || ONE_BILL, docs);
  }

  function readList() {
    if (location.protocol !== "https:" || location.hostname !== HOST) return { state: "no_list" };
    if (signedOut()) return { state: "signed_out" };
    const lead = body().slice(0, 2500).toLowerCase();
    if (CHECK_WORDS.some((w) => lead.includes(w))) return { state: "challenge" };
    if (SLOW_WORDS.some((w) => lead.includes(w))) return stopped("The Trustee's site says to try again later.");
    const failed = DATA_ERRORS.find((w) => body().slice(0, 3000).toLowerCase().includes(w));
    if (failed) return stopped("The Trustee's page says its data did not load.");
    const path = location.pathname.replace(/\/$/, "");
    if (path === "/Parcel") return readParcel();
    if (path === "/Transaction" && new URLSearchParams(location.search).get("billNumberData")) return readBill();
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
    const script = document.createElement("script");
    script.textContent = hookSource(nonce);
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    const armed = document.documentElement.getAttribute("data-sweep-armed") === nonce;
    document.documentElement.removeAttribute("data-sweep-armed");
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

  function fetchPdf(doc) {
    const id = (doc && doc.id) || "";
    if (location.protocol !== "https:" || location.hostname !== HOST) return { ok: false, why: "This tab is not on the Trustee's lookup." };
    const notice = NOTICE_ID.exec(id);
    if (notice) {
      if (pageParcel() !== notice[1]) return { ok: false, why: "This page shows another parcel." };
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

  globalThis.__sweep = { readList, fetchPdf };
})();
