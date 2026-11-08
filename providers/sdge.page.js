// Runs inside the provider's own page, where the sign-in already lives.
// Reads and downloads only. It presses nothing and changes nothing.
//
// Derived from PaperPull's apps/sdge/sdge_site.py (AGPL-3.0).
(() => {
  const BILL_PATH = "/portal/BillingHistory/DownloadBillPdf";
  const INVOICE = /^ISU[0-9]{12}$/;
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const text = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();

  // The whole cell must be one real date, or there is no date.
  function statementDate(cell) {
    const m = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+([0-9]{1,2}),\s+([0-9]{4})$/.exec(cell);
    if (!m) return null;
    const month = MONTHS.indexOf(m[1].toLowerCase());
    const year = +m[3], day = +m[2];
    const d = new Date(Date.UTC(year, month, day));
    if (d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
    return d.toISOString().slice(0, 10);
  }

  function signedOut() {
    const url = location.href.toLowerCase();
    return ["/prelogin/", "/accounts/logout", "/account/login", "/login"].some((m) => url.includes(m))
      || Boolean(document.querySelector("input[type='password']"));
  }

  // Each bill row starts with a hidden cell holding its row number, with no
  // header above it. Only that cell is passed over, and only in a row exactly
  // one wider than the header, so a table hiding a real column stops the list
  // rather than file a Due Date as a Statement Date.
  function cellsOf(row, width) {
    const cells = Array.from(row.cells);
    const first = cells[0];
    const numbered = cells.length === width + 1 && first
      && getComputedStyle(first).display === "none" && /^\d+$/.test(text(first));
    return numbered ? cells.slice(1) : cells;
  }

  function readList() {
    if (signedOut()) return { state: "signed_out" };
    const table = document.querySelector("#billHistoryTable");
    if (!table || !table.tHead) return { state: "no_list" };
    const heads = Array.from(table.tHead.rows[0].cells).map(text);
    const column = heads.findIndex((h) => /\bstatement\b/i.test(h) && /\bdate\b/i.test(h));
    if (column < 0 || heads.filter((h) => /\bstatement\b/i.test(h) && /\bdate\b/i.test(h)).length !== 1) {
      return { state: "stopped", why: "The table has no single Statement Date column." };
    }
    const bills = [];
    const seen = new Set();
    for (const row of table.querySelectorAll("tbody tr[invoiceid]")) {
      const id = row.getAttribute("invoiceid") || "";
      if (!INVOICE.test(id)) return { state: "stopped", why: "A bill's number was not one this can read.", bills };
      const cells = cellsOf(row, heads.length);
      if (cells.length !== heads.length || cells.some((c) => c.colSpan !== 1 || c.rowSpan !== 1)) {
        return { state: "stopped", why: "A bill's row does not line up with the table's header.", bills };
      }
      const date = statementDate(text(cells[column]));
      if (!date) return { state: "stopped", why: "A bill's statement date could not be read.", bills };
      if (seen.has(id)) return { state: "stopped", why: "Two rows carry one bill number.", bills };
      seen.add(id);
      bills.push({ id, date });
    }
    return { state: "ok", bills };
  }

  async function fetchPdf(id) {
    if (!INVOICE.test(id)) return { ok: false, why: "not a bill number" };
    const response = await fetch(`${BILL_PATH}?invoiceId=${id}`, { credentials: "same-origin", redirect: "manual" });
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) {
      return { ok: false, signedOut: true, why: "The site asked for a sign-in." };
    }
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!response.ok || type !== "application/pdf") return { ok: false, why: `The site sent ${response.status} ${type}.` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") return { ok: false, why: "That was not a PDF." };
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { ok: true, size: bytes.length, base64: btoa(binary) };
  }

  globalThis.__sweep = { readList, fetchPdf };
})();
