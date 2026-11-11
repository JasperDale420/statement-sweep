// The one recipe for every site you added yourself with Add This Site. What
// it looks for is that site's saved pattern (sites.js), data and never code,
// which the engine puts in globalThis.__sweepAddedConfig before each call.
// The picker (picker.js) loads this file too, and learns the pattern from the
// one statement link you pick with the same rules this reads it back with.
//
// It reads and downloads only. It presses or fetches only links that match
// the saved pattern, on the site's own origin: never a button, never a form,
// and never a link whose words say it pays, transfers, signs out or changes
// a setting.
(() => {
  // -- dates --------------------------------------------------------------------
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const MONTH = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
  const monthOf = (word) => MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const iso = (y, m, d) => (y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= lastDay(y, m)
    ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null);
  // Each shape a date is read in, and how its parts make a day. "October 2026"
  // alone means the month's last day, when a statement of that month is dated.
  const SHAPES = [
    [/(?<![\d-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d-])/g, (m) => iso(+m[1], +m[2], +m[3])],
    [/(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4})(?![\d/])/g, (m) => iso(+m[3], +m[1], +m[2])],
    [new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`, "gi"), (m) => iso(+m[3], monthOf(m[1]), +m[2])],
    [new RegExp(`(?<!\\d)(\\d{1,2})\\s+${MONTH}\\.?,?\\s+(\\d{4})(?!\\d)`, "gi"), (m) => iso(+m[3], monthOf(m[2]), +m[1])],
    [new RegExp(`\\b${MONTH}\\.?,?\\s+(\\d{4})(?!\\d)`, "gi"), (m) => iso(+m[2], monthOf(m[1]), lastDay(+m[2], monthOf(m[1])))],
  ];
  // Every date in a text, in order, none inside another.
  function datesIn(text) {
    const found = [];
    for (const [shape, day] of SHAPES) {
      for (const m of String(text || "").matchAll(shape)) {
        const when = day(m);
        if (when) found.push({ at: m.index, end: m.index + m[0].length, when });
      }
    }
    found.sort((a, b) => a.at - b.at || b.end - a.end);
    const kept = [];
    for (const f of found) if (!kept.length || f.at >= kept[kept.length - 1].end) kept.push(f);
    return kept;
  }
  // The date a text gives: its first, or the end of a range ("Oct 1, 2026 to
  // Oct 31, 2026"), the day a statement of that period is dated.
  function dateIn(text) {
    const all = datesIn(text);
    if (!all.length) return null;
    const between = all.length > 1 ? String(text).slice(all[0].end, all[1].at) : "";
    return all.length > 1 && /^\s*(?:-|–|—|to|through|thru)\s*$/i.test(between) ? all[1].when : all[0].when;
  }

  // -- a link's shape -------------------------------------------------------------
  const words = (el) => String((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
  // Words on a link that does something other than open a statement.
  // Whole words where a shorter one sits inside a statement's own words: "close"
  // is refused, "closing date" is not.
  const DANGER = /\bpay\b|payment|transfer|auto-?pay|setting|password|sign\s*(out|off)|log\s*(out|off)|logout|delete|\bclose\b|withdraw|\bbuy\b|\bsell\b|\baccept|\bagree|\bremove|enrol|\bapply\b|submit|confirm|cancel|dispute|unsubscribe|paperless|\bedit\b|\bupdate\b|\b(re)?orders?\b|\brequest|\bsend\b|\bschedul|\brenew|\breplace|\bredeem|\b(de)?activat|\b(un)?lock\b|\b(un)?freeze\b|\bstop\b|\bupgrade/i;
  const labels = (a) => [words(a), a.getAttribute("aria-label") || "", a.getAttribute("title") || "",
    ...[...a.querySelectorAll("img[alt]")].map((img) => img.getAttribute("alt"))].join(" ");
  const danger = (a) => DANGER.test(labels(a));
  // Words that say a link opens a statement, in its words or its address. A
  // pattern saved without the picked link's words (they held a date, or there
  // were none) takes only links that say this or hold a date, so a link of the
  // same shape that does something else is not pressed.
  const STATEMENTISH = /statement|\bstmts?\b|document|\bdocs?\b|pdf|\bview|download|\bbills?\b|billing|invoice|\bfiles?\b|\bopen\b|\btax|1099|\bw-?2\b|notice|letter|receipt/i;
  const MONTH_WORD = new RegExp(`\\b${MONTH}\\b`, "i");
  const saysStatement = (a, t) => STATEMENTISH.test(labels(a)) || MONTH_WORD.test(labels(a)) || Boolean(dateIn(labels(a)))
    || Boolean(t && t.url && STATEMENTISH.test(`${t.url.pathname} ${t.url.search}`));

  // One part of an address with what changes from statement to statement taken
  // out: a long id becomes {id}, and each run of digits {n}.
  function shapePart(part) {
    let s = part;
    try { s = decodeURIComponent(part); } catch (e) { /* kept as it is */ }
    if (/[{}]/.test(s)) return "{id}";
    const turns = (s.match(/[A-Za-z][0-9]|[0-9][A-Za-z]/g) || []).length;
    if ((/^[0-9a-f-]{8,}$/i.test(s) && /\d/.test(s)) || (/^[A-Za-z0-9_-]{12,}$/.test(s) && turns >= 3)) return "{id}";
    return s.replace(/\d+/g, "{n}");
  }
  // The parts that were taken out, for telling two statements apart.
  function partsOf(part) {
    let s = part;
    try { s = decodeURIComponent(part); } catch (e) { /* kept as it is */ }
    const shaped = shapePart(part);
    return shaped === "{id}" ? [s] : s.match(/\d+/g) || [];
  }
  const fragmentShape = (f) => f.split("/").map(shapePart).join("/");
  const pathShape = (pathname) => pathname.split("/").map(shapePart).join("/");

  // What an <a> points at: its shape, the parts that vary, and whether it is
  // on this page's own origin. A link that runs script points at nothing.
  function target(a) {
    const raw = (a.getAttribute("href") || "").trim();
    if (/^javascript:/i.test(raw) || !a.hasAttribute("href")) return null;
    if (raw.startsWith("#")) {
      const f = raw.slice(1);
      return { shape: `#${fragmentShape(f)}`, parts: f.split("/").flatMap(partsOf), own: true, page: true };
    }
    let url;
    try { url = new URL(a.href, location.href); } catch (e) { return null; }
    if (url.origin !== location.origin || url.username || url.password) return { own: false };
    const query = [...url.searchParams];
    const hashed = /^#[/!]/.test(url.hash) ? url.hash.slice(1) : "";
    const shape = pathShape(url.pathname)
      + (query.length ? `?${query.map(([k, v]) => `${shapePart(k)}=${shapePart(v)}`).join("&")}` : "")
      + (hashed ? `#${fragmentShape(hashed)}` : "");
    const parts = [...url.pathname.split("/").flatMap(partsOf), ...query.flatMap(([, v]) => partsOf(v)), ...hashed.split("/").flatMap(partsOf)];
    return { shape, parts, own: true, page: false, url };
  }
  // {n} and {id} are the same wildcard when two shapes are compared.
  const sameShape = (a, b) => a.replace(/\{id\}/g, "{n}") === b.replace(/\{id\}/g, "{n}");

  // A short key from the parts of a link that vary: never the parts themselves.
  function keyOf(parts) {
    let h = 0x811c9dc5;
    for (const ch of parts.join("|")) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
    return h.toString(36);
  }

  // How a statement is saved: fetched when its address is a PDF or a
  // download on this origin, otherwise pressed, and a press that opens a new
  // tab is taken from that tab by the engine.
  function methodOf(a) {
    const t = target(a);
    if (t && !t.page && t.url) {
      const file = a.hasAttribute("download") || /\.pdf$/i.test(t.url.pathname)
        || /(^|[/_.-])(download|pdf|export)s?([/_.-]|$)/i.test(t.url.pathname)
        || /(?:^|&)(?:download|pdf)(?:=|&|$)|=(?:pdf|download)(?:&|$)/i.test(t.url.search.slice(1));
      if (file) return "fetch";
    }
    return a.target === "_blank" ? "newtab" : "click";
  }

  // -- rows -------------------------------------------------------------------
  // Classes that say how a row looks right now, not what it is.
  const PASSING = /^(odd|even|first|last|active|selected|hover|focus|open|closed|expanded|collapsed|new|unread|read|disabled|hidden|visible|show|in)$/i;
  const stableClasses = (el) => [...el.classList].filter((c) => /^[A-Za-z_-][A-Za-z_-]{0,39}$/.test(c) && !PASSING.test(c));

  // The steps from a row down to its link: each a tag and which of that tag it is.
  function pathFrom(row, link) {
    const steps = [];
    for (let el = link; el && el !== row; el = el.parentElement) {
      const same = [...el.parentElement.children].filter((c) => c.tagName === el.tagName);
      steps.unshift([el.tagName.toLowerCase(), same.indexOf(el) + 1]);
    }
    return steps;
  }
  function follow(row, path) {
    let el = row;
    for (const [tag, n] of path) {
      el = [...el.children].filter((c) => c.tagName.toLowerCase() === tag)[n - 1];
      if (!el) return null;
    }
    return el;
  }
  // The row a link sits in: a table row or list item close above it, or else
  // the nearest element, the link or one above, that repeats beside itself
  // with a link in the same place.
  function rowOf(link) {
    for (let el = link, i = 0; el && el !== document.body && i < 8; el = el.parentElement, i += 1) {
      if (el.tagName === "TR" || el.tagName === "LI") return el;
    }
    for (let el = link, i = 0; el && el.parentElement && el !== document.body && i < 8; el = el.parentElement, i += 1) {
      const path = pathFrom(el, link);
      const twins = [...el.parentElement.children].filter((s) => s !== el && s.tagName === el.tagName);
      if (twins.some((s) => { const a = follow(s, path); return a && a.tagName === "A"; })) return el;
    }
    return link;
  }
  const selectorOf = (row) => row.tag + row.classes.map((c) => `.${CSS.escape(c)}`).join("");

  // Not the extension's own card or highlights.
  const ours = (el) => Boolean(el.closest && el.closest("statement-sweep-picker, statement-sweep-guide"));

  function isLike(a, cfg) {
    if (!a || a.tagName !== "A" || ours(a) || danger(a)) return false;
    const t = target(a);
    if (!t || !t.own || !sameShape(t.shape, cfg.href)) return false;
    return cfg.text ? words(a).toLowerCase() === cfg.text.toLowerCase() : saysStatement(a, t);
  }

  // Every link on the page like the one picked, each with its row.
  function likeLinks(cfg) {
    const out = [];
    const taken = new Set();
    let rows;
    try { rows = document.querySelectorAll(selectorOf(cfg.row)); } catch (e) { return out; }
    const selector = selectorOf(cfg.row);
    for (const row of rows) {
      if (ours(row)) continue;
      let link = cfg.path.length ? follow(row, cfg.path) : row;
      // A row whose link has moved, say for a column added, still counts when
      // exactly one of its links is like the one picked, and no row is inside it.
      if (!isLike(link, cfg)) {
        const inside = cfg.path.length && !row.querySelector(selector) ? [...row.querySelectorAll("a[href]")].filter((a) => isLike(a, cfg)) : [];
        link = inside.length === 1 ? inside[0] : null;
      }
      if (link && !taken.has(link)) {
        taken.add(link);
        out.push({ link, row });
      }
    }
    return out;
  }

  // -- where a row's date is ---------------------------------------------------------
  const DATE_HEADS = [/statement\s+date|closing\s+date|period\s+end/i, /date/i, /period|month|issued|posted|closing/i];
  // A table row's column headings, each with the column it starts at.
  function headingsOf(row) {
    if (row.tagName !== "TR") return [];
    const table = row.closest("table");
    if (!table) return [];
    let head = table.tHead && table.tHead.rows.length ? table.tHead.rows[table.tHead.rows.length - 1] : null;
    if (!head) {
      const first = table.rows[0];
      if (first && first !== row && [...first.cells].every((c) => c.tagName === "TH")) head = first;
    }
    if (!head || head === row) return [];
    let col = 0;
    return [...head.cells].map((cell) => { const at = col; col += cell.colSpan || 1; return { at, text: words(cell) }; });
  }
  function cellAt(row, at) {
    let col = 0;
    for (const cell of row.cells || []) {
      if (col === at) return cell;
      col += cell.colSpan || 1;
    }
    return null;
  }
  // The date column of a row's table: the heading saved, or the one at the
  // column saved, or the best named.
  function dateColumn(row, saved) {
    const heads = headingsOf(row);
    if (saved) {
      const named = saved.header && heads.find((h) => h.text.toLowerCase() === saved.header.toLowerCase());
      return named || { at: saved.column, text: saved.header || "" };
    }
    for (const want of DATE_HEADS) {
      const h = heads.find((x) => want.test(x.text));
      if (h) return h;
    }
    return null;
  }
  function dateFor({ link, row }, from, saved) {
    if (from === "column") {
      const col = dateColumn(row, saved);
      const cell = col && cellAt(row, col.at);
      return cell ? dateIn(words(cell)) : null;
    }
    if (from === "link") return dateIn(words(link));
    if (from === "row") return dateIn(words(row));
    return null;
  }

  // Ids that tell the statements apart: the date when it is the only one that
  // day, and otherwise a short key from the parts of its link that vary.
  // Answers clash when two are still the same.
  function docsOf(cfg, found) {
    const items = found.map((f) => {
      const t = target(f.link);
      return { ...f, date: dateFor(f, cfg.date.from, cfg.date.from === "column" ? cfg.date : null), key: keyOf(t ? t.parts : []) };
    });
    const onDay = new Map();
    for (const it of items) if (it.date) onDay.set(it.date, (onDay.get(it.date) || 0) + 1);
    const docs = items.map((it) => ({
      id: it.date ? (onDay.get(it.date) > 1 ? `${it.date}~${it.key}` : it.date) : `h~${it.key}`,
      date: it.date || "",
      title: "Statement",
      method: cfg.method || methodOf(it.link),
      link: it.link,
    }));
    const ids = new Set(docs.map((d) => d.id));
    return { docs, clash: ids.size !== docs.length };
  }
  const newestFirst = (docs) => docs.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // -- learning a pattern from one link (the picker) ------------------------------------------
  const no = (why) => ({ ok: false, why });
  const SOURCES = ["column", "link", "row"];

  // From the one link picked: the pattern, every link like it with its date,
  // and where the dates came from. Nothing of the page's text is kept but the
  // link's words when they hold no digits, and a column's heading.
  function learn(link) {
    if (!link || link.tagName !== "A") return no("That isn't a link. Pick the link you would press to open one statement.");
    const t = target(link);
    if (!t) return no("That link runs the page's own script, so Statement Sweep can't follow it. Pick a link to one statement.");
    if (!t.own) return no(`That link goes to another site. Pick a statement link on ${location.hostname}.`);
    if (danger(link)) return no("That link looks like it does something, such as paying or changing a setting. Pick a link that opens a statement.");
    const text = words(link);
    const keepsText = text && !/\d/.test(text) && text.length <= 40;
    if (!keepsText && !saysStatement(link, t)) return no("That link doesn't say it opens a statement. Pick a link whose words or address say statement, document, PDF, view or download, or give its date.");
    const row = rowOf(link);
    const path = row === link ? [] : pathFrom(row, link);
    const draft = {
      row: { tag: row.tagName.toLowerCase(), classes: [] },
      path,
      href: t.shape,
      text: keepsText ? text : "",
    };
    // The row's classes that every row like it shares, at most two.
    let found = likeLinks(draft);
    const shared = stableClasses(row).filter((c) => found.every((f) => f.row.classList.contains(c))).slice(0, 2);
    if (shared.length) {
      draft.row.classes = shared;
      found = likeLinks(draft);
    }
    if (!found.some((f) => f.link === link)) return no("Statement Sweep couldn't find a pattern in that link. Try another statement link.");
    // Where the dates are: the first place that gives one for at least half.
    const enough = Math.max(1, Math.ceil(found.length / 2));
    let date = { from: "none" };
    for (const from of SOURCES) {
      const col = from === "column" ? dateColumn(row, null) : null;
      if (from === "column" && !col) continue;
      const saved = col ? { column: col.at, header: /\d/.test(col.text) ? "" : col.text.slice(0, 40) } : null;
      const dated = found.filter((f) => dateFor(f, from, saved)).length;
      if (dated >= enough) { date = { from, ...(saved || {}) }; break; }
    }
    draft.date = date;
    draft.method = methodOf(link);
    const { docs, clash } = docsOf(draft, found);
    if (clash) return no("Some of these links look the same and have no date, so Statement Sweep can't tell them apart. Try another statement link.");
    // The list page's own address, its path only. One that holds a long
    // number or an id may name an account, so it is not kept: the site then
    // waits for you to open the page.
    const listShape = pathShape(location.pathname);
    const personal = /\d{5,}/.test(location.pathname) || listShape.includes("{id}");
    Object.assign(draft, { listUrl: personal ? "/" : location.pathname, listPath: listShape, ...(personal ? { listOpen: false } : {}) });
    const dates = docs.map((d) => d.date).filter(Boolean).sort();
    return {
      ok: true,
      config: draft,
      matches: docs.map((d) => ({ el: d.link, date: d.date, picked: d.link === link })),
      range: dates.length ? [dates[0], dates[dates.length - 1]] : null,
    };
  }

  // -- the recipe ---------------------------------------------------------------------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const log = (text) => globalThis.__sweepLog && globalThis.__sweepLog(text);
  const configOf = () => {
    const cfg = globalThis.__sweepAddedConfig;
    return cfg && typeof cfg === "object" && cfg.row && Array.isArray(cfg.path) && typeof cfg.href === "string" ? cfg : null;
  };
  const passwordField = () => Boolean(document.querySelector("input[type='password' i]"));
  const onListPage = (cfg) => (cfg.listPath ? sameShape(pathShape(location.pathname), cfg.listPath) : location.pathname === new URL(cfg.listUrl).pathname);
  const NO_MATCH = "No links like the one you picked were found. The site may have changed its page. Pick a statement link again in Settings.";
  // A list a page is still drawing gets this long to appear.
  const LOOKS = 12;

  async function readList() {
    const cfg = configOf();
    if (!cfg) return { state: "stopped", why: "This site's pattern was not handed to the page.", docs: [] };
    if (location.origin !== cfg.origin) return { state: "no_list" };
    const onList = onListPage(cfg);
    let found = likeLinks(cfg);
    for (let i = 0; !found.length && onList && !passwordField() && i < LOOKS; i += 1) {
      await sleep(500);
      found = likeLinks(cfg);
    }
    if (!found.length) {
      if (passwordField()) return { state: "signed_out" };
      if (!onList) {
        return cfg.listOpen === false
          ? { state: "waiting", why: `Open your statements on ${cfg.name}. Statement Sweep goes on by itself.` }
          : { state: "no_list" };
      }
      log("Added site: no links like the one picked on its list page.");
      return { state: "stopped", noMatch: true, why: NO_MATCH, docs: [] };
    }
    const { docs, clash } = docsOf(cfg, found);
    if (clash) {
      log(`Added site: ${docs.length} like the one picked, but two could not be told apart.`);
      return { state: "stopped", why: "Two statements on the page could not be told apart. Pick a statement link again in Settings.", docs: [] };
    }
    log(`Added site: ${docs.length} like the one picked, ${docs.filter((d) => d.date).length} dated from the ${cfg.date.from}.`);
    return { state: "ok", docs: newestFirst(docs).map(({ link, ...doc }) => doc) };
  }

  // The link of one document, found again by its id among the links like the
  // one picked, and only there.
  function linkOf(doc) {
    const cfg = configOf();
    if (!cfg || location.origin !== cfg.origin || !doc) return null;
    const { docs } = docsOf(cfg, likeLinks(cfg));
    const hit = docs.filter((d) => d.id === doc.id);
    return hit.length === 1 ? hit[0].link : null;
  }

  function clickDoc(doc) {
    const link = linkOf(doc);
    if (!link) return { ok: false, why: "Its link was not on the page." };
    log(`Added site: pressing the link of ${doc.id}.`);
    link.click();
    return { ok: true };
  }

  async function fetchPdf(doc) {
    const link = linkOf(doc);
    const t = link && target(link);
    if (!t || !t.own || t.page || !t.url) return { ok: false, why: "Its link was not on the page." };
    try {
      // Cookies go only to this origin. A link here that redirects to another
      // site is still followed, so a site's own redirects keep working, but it
      // reaches the other site without your cookies there, and what comes back
      // is refused below. Stopping every redirect (redirect: "manual") would
      // also stop the ones a site makes within itself, which are common.
      const response = await fetch(t.url.href, { credentials: "same-origin" });
      if (new URL(response.url || t.url.href).origin !== location.origin) return { ok: false, why: "Its link went to another site." };
      if (!response.ok) return { ok: false, why: "The site did not send it." };
      const bytes = new Uint8Array(await response.arrayBuffer());
      return globalThis.__sweepPdf ? globalThis.__sweepPdf.pdfResult(bytes) : { ok: false, why: "That was not a PDF." };
    } catch (e) {
      return { ok: false, why: "The site could not be reached." };
    }
  }

  globalThis.__sweepAdded = { dateIn, datesIn, shapePart, learn, likeLinks, docsOf, methodOf, rowOf, danger };
  globalThis.__sweep = { readList, clickDoc, fetchPdf };
})();
