// Runs inside the provider's own page, where the sign-in already lives.
// Reads and downloads only. It presses nothing and changes nothing.
//
// Derived from PaperPull's apps/sdge/sdge_site.py (AGPL-3.0).
(() => {
  const BILL_PATH = "/portal/BillingHistory/DownloadBillPdf";
  const INVOICE = /^ISU[0-9]{12}$/;
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const text = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();
  // The table plugin's line under the table, "Showing 1 to 10 of 24 entries",
  // and the "(filtered from N total entries)" it adds under a search.
  const INFO_TOTAL = /\bof\s+([\d,]+)\s+entries\b/i;
  const INFO_FILTERED = /\bfiltered\b/i;

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

  // "" when the rows drawn are every bill the table holds, or why they are
  // not. The plugin keeps only the page it shows in the document. A table
  // showing no such line is read as its rows, as PaperPull does.
  function tableProblem(count) {
    const line = document.querySelector("#billHistoryTable_info");
    const info = line ? text(line) : "";
    if (!info) return "";
    if (INFO_FILTERED.test(info)) return "The bill table is filtered by a search. Clear the search and sweep again.";
    const m = INFO_TOTAL.exec(info);
    if (!m) return "The bill table's own count could not be read.";
    const total = +m[1].replace(/,/g, "");
    return total === count ? "" : `The bill table holds ${total} bills and ${count} are drawn. Set it to show them all and sweep again.`;
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
      if (!INVOICE.test(id)) return { state: "stopped", why: "A bill's number was not one this can read.", docs: bills };
      const cells = cellsOf(row, heads.length);
      if (cells.length !== heads.length || cells.some((c) => c.colSpan !== 1 || c.rowSpan !== 1)) {
        return { state: "stopped", why: "A bill's row does not line up with the table's header.", docs: bills };
      }
      const date = statementDate(text(cells[column]));
      if (!date) return { state: "stopped", why: "A bill's statement date could not be read.", docs: bills };
      if (seen.has(id)) return { state: "stopped", why: "Two rows carry one bill number.", docs: bills };
      seen.add(id);
      bills.push({ id, date, method: "fetch" });
    }
    if (!bills.length) return { state: "no_list" };
    const problem = tableProblem(bills.length);
    if (problem) return { state: "stopped", why: problem, docs: bills };
    const accounts = document.querySelector("select#accountList");
    if (accounts && accounts.options.length > 1) {
      return { state: "stopped", why: `Only the account on show was read. Choose each of the other ${accounts.options.length - 1} in SDG&E's account list and sweep again.`, docs: bills };
    }
    return { state: "ok", docs: bills };
  }

  async function fetchPdf(doc) {
    const id = doc && doc.id;
    if (!INVOICE.test(id || "")) return { ok: false, why: "not a bill number" };
    const response = await fetch(`${BILL_PATH}?invoiceId=${id}`, { credentials: "same-origin", redirect: "manual" });
    if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403) {
      return { ok: false, signedOut: true, why: "The site asked for a sign-in." };
    }
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!response.ok || type !== "application/pdf") return { ok: false, why: `The site sent ${response.status} ${type}.` };
    const bytes = new Uint8Array(await response.arrayBuffer());
    return globalThis.__sweepPdf.pdfResult(bytes);
  }

  globalThis.__sweep = { readList, fetchPdf };
})();
