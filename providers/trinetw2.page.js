// Runs inside PaperlessEmployee (CIC Plus), where TriNet keeps W-2s. TriNet's
// own Taxes page sends you here through its sign-in ("You're leaving TriNet");
// this site's list address is that same sign-in link, so the tab lands here
// signed in as you, the way TriNet's own button brings you.
//
// The list is the Tax Statements page: one row per form, each with the id the
// site gives it, read with a GET. Nothing is pressed.
//
// A form is not kept there as a file. The site hands it out as a free order:
// pick the form, pick "Download (PDF)", review, submit, and the order's page
// gives a link that works for ten minutes. fetchPdf does exactly that, with
// the page's own forms posted from inside the page, and only when:
//   * the form is still listed, under the id the list gave it;
//   * delivery is the site's online download, never postal mail;
//   * the review names that one form, every amount on it is $0.00, and the
//     card payment the site can ask for (Authorize.Net) is not set up.
// Anything else stops before the order is submitted. A review left behind
// places nothing.
(() => {
  const HOST = "www.paperlessemployee.com";
  const ROOT = "/trinettaxforms/PE/";
  const LIST = `${ROOT}TaxStatements`;
  const SUBMIT = `${ROOT}TaxStatements/SubmitOrderV4`;
  const PDF = `${ROOT}Pdf/GetOrderPdf`;
  const ONLINE = "Online";
  // The site's id for a form row.
  const KEY = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
  // "2025 W-2", "2024 W-2c": the tax year, then the form's name.
  const FORM = /^(\d{4})\s+([A-Za-z0-9][A-Za-z0-9 -]{0,20})$/;
  const CHALLENGE = ["verification code", "enter the code", "verify your identity", "two-step", "two-factor", "authenticator"];

  const visibleText = () => `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 1500)}`.toLowerCase();
  const signInPath = (path) => !path.startsWith(ROOT) || /log\s*-?(in|on)|sign\s*-?in|sso|timeout/i.test(path);
  const signedOut = () => location.hostname !== HOST || signInPath(location.pathname) || Boolean(document.querySelector("input[type='password']"));
  const read = (html) => new DOMParser().parseFromString(html, "text/html");
  const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();

  // A request from inside the page. An answer that landed off this site's
  // own pages is a sign-in.
  async function ask(path, init = {}) {
    const response = await fetch(path, { credentials: "same-origin", ...init });
    let landed;
    try { landed = new URL(response.url); } catch (e) { landed = null; }
    const out = !landed || landed.hostname !== HOST || signInPath(landed.pathname) || response.status === 401 || response.status === 403;
    return { response, landed, signedOutAnswer: out };
  }
  async function askPage(path, init) {
    const got = await ask(path, init);
    if (got.signedOutAnswer) return { signedOut: true };
    if (!got.response.ok) return { status: got.response.status };
    const page = read(await got.response.text());
    if (page.querySelector("input[type='password']")) return { signedOut: true };
    return { page, path: got.landed.pathname };
  }

  // The Tax Statements form and its rows: { form, rows: [{ key, year, name }] }.
  function listOf(page) {
    const form = [...page.forms].find((f) => (f.getAttribute("action") || "") === LIST);
    if (!form) return null;
    const rows = [];
    let unread = false;
    for (const row of page.querySelectorAll("table tbody tr")) {
      const box = row.querySelector("input[type=checkbox][name='OrderPostModel.SelectedFormNumbers']");
      if (!box) continue;
      const m = FORM.exec(squash(row.cells[1] ? row.cells[1].textContent : ""));
      if (!KEY.test(box.value) || !m || +m[1] < 2000 || +m[1] > 2100) { unread = true; continue; }
      rows.push({ key: box.value, year: m[1], name: m[2].replace(/^w-?2c$/i, "W-2c").replace(/^w-?2$/i, "W-2") });
    }
    return { form, rows, unread };
  }

  async function readList() {
    if (signedOut()) return { state: "signed_out" };
    if (CHALLENGE.some((m) => visibleText().includes(m))) return { state: "challenge" };
    let got;
    try { got = await askPage(LIST); } catch (e) { return { state: "stopped", why: "PaperlessEmployee's Tax Statements did not answer.", docs: [] }; }
    if (got.signedOut) return { state: "signed_out" };
    const list = got.page && listOf(got.page);
    if (!list) return { state: "stopped", why: `PaperlessEmployee's Tax Statements was not the page this reads${got.status ? ` (${got.status})` : ""}.`, docs: [] };

    // Dated the last day of the tax year, so the year is the form's own.
    const docs = [];
    const seen = new Set();
    for (const r of list.rows) {
      if (seen.has(r.key)) continue;
      seen.add(r.key);
      docs.push({ id: `${r.year}:${r.name}:${r.key}`, date: `${r.year}-12-31`, title: r.name, method: "fetch", key: r.key });
    }
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    // Two of one form for one year (two employers) get a number each.
    const count = new Map();
    for (const d of docs) count.set(`${d.date}|${d.title}`, (count.get(`${d.date}|${d.title}`) || 0) + 1);
    const nth = new Map();
    for (const d of docs) {
      const k = `${d.date}|${d.title}`;
      if (count.get(k) > 1) { nth.set(k, (nth.get(k) || 0) + 1); d.title = `${d.title} ${nth.get(k)}`; }
    }
    if (list.unread) return { state: "stopped", why: "A form in PaperlessEmployee's list could not be read.", docs };
    return { state: "ok", docs };
  }

  // Every amount of money in a text, as numbers: "$5.00", "$.50", "USD 5",
  // "US$ 4.95", a full-width "＄5", and a bare "5.00" whose "$" a page may
  // draw with CSS. Anything shaped like money counts, so a fee written in a
  // way not foreseen here is still seen.
  const MONEY = /(?:US\$|\$|＄|USD)\s*(\d[\d,]*(?:\.\d+)?|\.\d+)|(\d[\d,]*\.\d{2})(?!\d)/gi;
  const amounts = (text) => [...String(text).matchAll(MONEY)].map((m) => Number(String(m[1] || m[2]).replace(/,/g, "")));

  // The words a page shows: its text without scripts, styles, templates and
  // what it hides. A parsed page has no layout, so hidden means marked so.
  function shownText(page) {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { out.push(child.nodeValue); continue; }
        if (child.nodeType !== 1) continue;
        const el = child;
        if (/^(script|style|template|noscript|head)$/i.test(el.tagName)) continue;
        if (el.hidden || el.getAttribute("aria-hidden") === "true") continue;
        if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(el.getAttribute("style") || "")) continue;
        out.push(" ");
        walk(el);
        out.push(" ");
      }
    };
    if (page.body) walk(page.body);
    return squash(out.join(""));
  }
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // How often a form's "2025 W-2" stands in a text as itself ("2025 W-2c" is another form).
  const timesNamed = (text, label) => (text.match(new RegExp(`(?<![A-Za-z0-9])${escape(label).replace(/\\-|-/g, "-?")}(?![A-Za-z0-9])`, "gi")) || []).length;

  // Why the review page is not a free online order of this one form, or "".
  // `others` are the other forms the list shows: none of them may be in the
  // order. Every check must pass; none can pass by finding nothing.
  function notFree(page, label, others = []) {
    const form = [...page.forms].find((f) => (f.getAttribute("action") || "") === SUBMIT);
    if (!form) return "The order's review was not the page this reads.";
    const token = page.getElementById("popupToken");
    if (token && token.value) return "PaperlessEmployee asked for a card payment.";
    for (const name of ["xsec_responseAuthorize", "xsec_paymentAttemptId"]) {
      const field = form.elements.namedItem(name);
      if (field && field.value) return "PaperlessEmployee asked for a card payment.";
    }
    // Any field on the page that carries a payment or a sum must be empty or nothing.
    for (const field of page.querySelectorAll("input, select, textarea")) {
      if (/^(__RequestVerificationToken|popupToken|xsec_responseAuthorize|xsec_paymentAttemptId|action)$/.test(field.name || field.id || "")) continue;
      if (!/pay|card|cc|amount|total|price|fee|charge|cost/i.test(`${field.name || ""} ${field.id || ""}`)) continue;
      const value = String(field.value || "").trim();
      if (value && !/^\$?\s*0*(\.0+)?$/.test(value)) return "The order was not free.";
    }
    const text = shownText(page);
    if (amounts(text).some((n) => n !== 0)) return "The order was not free.";
    if (!/delivered online/i.test(text) || /\b(mail(ed)?|postal|ship(ped|ping)?)\b/i.test(text.replace(/will not be e-?mailed|not be emailed/gi, ""))) {
      return "The order was not for an online download.";
    }
    const named = timesNamed(text, label);
    if (!named) return "The order's review did not name this form.";
    // A form the site still holds from an earlier order must not ride along.
    if (others.some((o) => o !== label && timesNamed(text, o))) return "The order's review named another form too.";
    if (others.includes(label) && named > 1) return "The order's review named this form more than once.";
    return "";
  }

  // The order: list, review, submit, then the PDF. Nothing is submitted
  // unless the review is a free online order of this form.
  async function fetchPdf(doc) {
    const key = doc && doc.key;
    const m = /^(\d{4}):([A-Za-z0-9 -]{1,21}):(.+)$/.exec((doc && doc.id) || "");
    if (!KEY.test(key || "") || !m || m[3] !== key || doc.date !== `${m[1]}-12-31`) return { ok: false, why: "not a PaperlessEmployee form" };
    if (signedOut()) return { ok: false, signedOut: true, why: "The PaperlessEmployee tab is not on a signed-in page." };
    const label = `${m[1]} ${m[2]}`;
    try {
      const listed = await askPage(LIST);
      if (listed.signedOut) return { ok: false, signedOut: true, why: "PaperlessEmployee asked for a sign-in." };
      const list = listed.page && listOf(listed.page);
      if (!list) return { ok: false, why: "PaperlessEmployee's Tax Statements was not the page this reads." };
      if (!list.rows.some((r) => r.key === key)) return { ok: false, why: "That form is no longer listed." };
      const online = list.form.querySelector(`input[type=radio][name='OrderPostModel.SelectedDeliveryMethod'][value='${ONLINE}']`);
      if (!online) return { ok: false, why: "PaperlessEmployee did not offer an online download." };
      const token = list.form.elements.namedItem("__RequestVerificationToken");
      if (!token || !token.value) return { ok: false, why: "PaperlessEmployee's form had no token." };

      // 1. Pick the form and the online download; the site answers with its review.
      const pick = new URLSearchParams();
      pick.append("__RequestVerificationToken", token.value);
      pick.append("OrderPostModel.SelectedFormNumbers", key);
      pick.append("OrderPostModel.SelectedDeliveryMethod", ONLINE);
      pick.append("TotalOrder", "0.00");
      pick.append("action", "Review & Complete Order");
      const review = await askPage(LIST, { method: "POST", body: pick });
      if (review.signedOut) return { ok: false, signedOut: true, why: "PaperlessEmployee asked for a sign-in." };
      if (!review.page) return { ok: false, why: `PaperlessEmployee did not review the order${review.status ? ` (${review.status})` : ""}.` };
      const others = list.rows.filter((r) => r.key !== key).map((r) => `${r.year} ${r.name}`);
      const why = notFree(review.page, label, others);
      if (why) return { ok: false, why };

      // 2. Submit the free order, as the page's own Submit Order does when no
      // payment is asked for.
      const submitForm = [...review.page.forms].find((f) => (f.getAttribute("action") || "") === SUBMIT);
      const submitToken = submitForm.elements.namedItem("__RequestVerificationToken");
      if (!submitToken || !submitToken.value) return { ok: false, why: "The order's review had no token." };
      const send = new URLSearchParams();
      send.append("__RequestVerificationToken", submitToken.value);
      send.append("xsec_responseAuthorize", "");
      send.append("xsec_paymentAttemptId", "");
      const done = await askPage(SUBMIT, { method: "POST", body: send });
      if (done.signedOut) return { ok: false, signedOut: true, why: "PaperlessEmployee asked for a sign-in." };
      if (!done.page || !/order complete/i.test(squash(done.page.body ? done.page.body.textContent : ""))) {
        return { ok: false, why: "PaperlessEmployee did not complete the order." };
      }
      // 3. The order's own download link, on this site, while it works.
      const link = [...done.page.querySelectorAll("a[href]")].map((a) => { try { return new URL(a.getAttribute("href"), location.href); } catch (e) { return null; } })
        .find((u) => u && u.hostname === HOST && u.pathname === PDF && u.searchParams.get("download") === "true");
      if (!link) return { ok: false, why: "The order's page had no download link." };
      const got = await ask(link.pathname + link.search);
      if (got.signedOutAnswer) return { ok: false, signedOut: true, why: "PaperlessEmployee asked for a sign-in." };
      if (!got.response.ok) return { ok: false, why: `The site sent ${got.response.status}.` };
      // Kept only if its bytes start %PDF- (shared.js).
      return globalThis.__sweepPdf.pdfResult(new Uint8Array(await got.response.arrayBuffer()));
    } catch (e) {
      return { ok: false, why: "PaperlessEmployee did not answer." };
    }
  }

  globalThis.__sweep = { readList, fetchPdf };
})();
