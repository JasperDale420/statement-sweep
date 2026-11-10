// Loaded before a site's offers file (amex.offers.js, chase.offers.js), after
// shared.js, in the same isolated world. What every offers recipe shares: how
// a control's name is read, which names may be pressed and which never, how
// an offer's tile is found around its control, and waiting.
//
// The one thing an offers recipe ever presses to change an account is a
// control whose whole accessible name is the site's own add control, such as
// Amex's "Add to Card". Anything that says enrol, activate, apply, buy,
// upgrade, accept or terms is never pressed, whatever else it says.
(() => {
  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const shown = (el) => Boolean(el) && el.isConnected && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const turnedOff = (el) => el.disabled === true || el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

  // Words that are never pressed. Checked on a control's whole name, with
  // the offer's own merchant taken out, so "Buy Buy Baby" is not refused for
  // its name but "Buy now" is.
  const NEVER = /enrol|activat|\bappl(y|ies|ied|ication)\b|\bbuy\b|purchase|check\s*out|upgrade|\baccept|\bagree|\bterms\b|consent|\bpay\b|payment|transfer|redeem|subscribe|sign\s*up|\bjoin\b|\bopen\b|authori[sz]ed\s+user|\bbook\b|\bconfirm\b|\bsubmit\b|\bcontinue\b|\bupgrade\b|\bswitch\b|\bremove\b|\bdelete\b/i;

  // A control's accessible name, close to what a screen reader announces:
  // aria-labelledby, then aria-label, then its text, then an image's alt,
  // then its title.
  function nameOf(el) {
    if (!el) return "";
    const by = tidy(el.getAttribute("aria-labelledby"));
    if (by) {
      const text = tidy(by.split(" ").map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.textContent).join(" "));
      if (text) return text;
    }
    const label = tidy(el.getAttribute("aria-label"));
    if (label) return label;
    if (el.tagName === "INPUT") return tidy(el.value);
    const text = tidy(el.innerText || el.textContent);
    if (text) return text;
    const img = el.querySelector("img[alt]");
    if (img && tidy(img.alt)) return tidy(img.alt);
    return tidy(el.getAttribute("title"));
  }

  const lower = (s) => tidy(s).toLowerCase();

  // True when `name` is wholly one of the site's `exact` add names, or one of
  // them joined to this offer's own merchant ("Add offer, Starbucks", "Add
  // offer for Starbucks", "Add Starbucks offer"), and says nothing it must not.
  function isAddName(name, exact, merchant = "") {
    const n = lower(name);
    if (!n) return false;
    const m = lower(merchant);
    const rest = m ? n.split(m).join(" ") : n;
    if (NEVER.test(rest)) return false;
    const bases = exact.map(lower);
    if (bases.includes(n)) return true;
    if (!m) return false;
    return bases.filter((b) => /^add\b/.test(b)).some((b) => [`${b}, ${m}`, `${b} ${m}`, `${b}: ${m}`, `${b} - ${m}`, `${b} for ${m}`, `${b} from ${m}`].includes(n))
      || n === `add ${m} offer`;
  }

  const CONTROLS = "button, [role='button'], a[href], [role='link'], [role='tab'], [role='menuitem'], [role='option']";
  const controls = (root = document) => Array.from(root.querySelectorAll(CONTROLS)).filter(shown);

  // The one shown control whose whole name passes `test`, or the first of
  // several; never one inside a site's header or footer menus unless asked.
  function controlNamed(test, { root = document, roles = CONTROLS, anywhere = false } = {}) {
    return Array.from(root.querySelectorAll(roles)).find((el) => shown(el)
      && (anywhere || !el.closest("footer, [role='contentinfo']"))
      && test(nameOf(el))) || null;
  }

  // An offer's tile: the largest box around its control that holds no other
  // offer's control.
  function tileOf(control, all) {
    let tile = control;
    while (tile.parentElement && tile.parentElement !== document.body) {
      const parent = tile.parentElement;
      if (all.some((other) => other !== control && parent.contains(other))) break;
      tile = parent;
    }
    return tile;
  }

  // The shown pieces of a tile's text, in order, each run of text a piece of
  // its own, so words in spans side by side are not run together. Words
  // equal to `skip` (its controls' names) are left out.
  function linesOf(tile, skip = []) {
    const leave = new Set(skip.map(lower));
    const lines = [];
    const walker = document.createTreeWalker(tile, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = tidy(node.textContent);
      if (!text || !node.parentElement || !shown(node.parentElement) || node.parentElement.closest("script, style")) continue;
      if (!leave.has(lower(text))) lines.push(text);
    }
    return lines;
  }

  function headingOf(tile) {
    const h = Array.from(tile.querySelectorAll("h1, h2, h3, h4, h5, h6, [role='heading']")).find((el) => shown(el) && tidy(el.innerText));
    if (h) return tidy(h.innerText);
    const img = Array.from(tile.querySelectorAll("img[alt]")).find((i) => tidy(i.alt) && !/logo$/i.test(tidy(i.alt)));
    return img ? tidy(img.alt).replace(/\s+logo$/i, "") : "";
  }

  // "Expires 12/31/2026", "Exp. 1/5/27", "Expires Dec 31, 2026" as YYYY-MM-DD,
  // or "" when no date is said.
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  function expiresOf(text) {
    const t = tidy(text);
    let m = /\bexp(?:ires|\.|iration)?(?:\s+on)?\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/i.exec(t);
    if (m) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return iso(y, Number(m[1]), Number(m[2]));
    }
    m = /\bexp(?:ires|\.|iration)?(?:\s+on)?\s*:?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(t);
    if (m) return iso(Number(m[3]), MONTHS.indexOf(m[1].toLowerCase()) + 1, Number(m[2]));
    return "";
  }
  function iso(y, mo, d) {
    const t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return "";
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  // A short, steady id from an offer's words, for sites that give no id of
  // their own. Only ever kept in this browser.
  function wordsId(...parts) {
    let h = 0x811c9dc5;
    for (const ch of parts.map(lower).join("|")) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  async function waitFor(test, ms, step = 150) {
    const end = Date.now() + ms;
    for (;;) {
      const got = test();
      if (got) return got;
      if (Date.now() >= end) return null;
      await sleep(step);
    }
  }

  const DIALOGS = "[role='dialog'], [role='alertdialog'], dialog[open], [aria-modal='true']";
  const dialogs = () => Array.from(document.querySelectorAll(DIALOGS)).filter(shown);
  // Closes a dialog with its own Close or Cancel, and presses nothing else in it.
  async function closeDialog(dialog) {
    const closer = controlNamed((n) => /^(close|cancel|dismiss|×|x|close dialog|close modal)$/i.test(n), { root: dialog, anywhere: true });
    if (!closer) return false;
    closer.click();
    return Boolean(await waitFor(() => !shown(dialog), 3000));
  }

  globalThis.__offersKit = { tidy, shown, sleep, turnedOff, NEVER, nameOf, isAddName, controls, controlNamed, tileOf, linesOf, headingOf, expiresOf, wordsId, waitFor, dialogs, closeDialog };
})();
