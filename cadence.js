// What is due: from the dates of the documents a site has already saved, how
// often that site sends one, whether a new one is probably waiting, and
// whether any look missing from the middle. Ported from PaperPull's
// tools/status.py, with its thresholds, so the two never disagree.
//
// The question is not "when did I last run it" but "is there probably
// something new waiting". So the signal is the date of the newest document
// saved, against how often the site issues them, measured from your own
// history (the median gap between documents). Nothing is set per site, and a
// site that moves from monthly to quarterly corrects itself.
//
// Pure functions only. Every one that depends on the day takes `today`, as
// "YYYY-MM-DD" or a Date, so tests can pin it.

export const CURRENT = "current", DUE = "due", OVERDUE = "overdue", UNKNOWN = "unknown", NEVER = "never";
// Due by its schedule, but a sweep looked after its newest document and found
// nothing new, so it waits a few days before being flagged again.
export const CHECKED = "checked";

const DAY_MS = 86400000;
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const FULL_DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
const MONTH_ONLY = /(?<!\d)(\d{4})-(\d{2})(?!\d)(?!-\d)/g;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// -- days ------------------------------------------------------------------------
// A date is a whole day, counted in UTC so no clock change moves it.
export function dayOf(iso) {
  const m = ISO.exec(String(iso || "").trim());
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / DAY_MS;
}
export function isoOf(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}
// Today as the person's own calendar has it.
export function localIso(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function todayDay(today) {
  if (today instanceof Date) return dayOf(localIso(today));
  return dayOf(today == null ? localIso() : today);
}
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// statistics.median: the middle value, or the mean of the middle two.
export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// -- what a document's id says ----------------------------------------------------
// Many sites' ids hold the document's date ("2026-09-30_account_statement",
// "card:2026-10-28", "4821-2026-09-15"), and a month id ("2026-08") stands for
// that month's last day. Only one unambiguous date counts: an id with two
// different dates, or none, says nothing.
export function dateFromId(id) {
  const text = String(id || "");
  const found = new Set();
  for (const m of text.matchAll(FULL_DATE)) {
    if (+m[1] >= 1990 && +m[1] <= 2100 && dayOf(m[0]) !== null) found.add(m[0]);
  }
  if (found.size === 1) return [...found][0];
  if (found.size > 1) return null;
  const months = new Set();
  for (const m of text.matchAll(MONTH_ONLY)) {
    const [y, mo] = [+m[1], +m[2]];
    if (y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12) months.add(`${m[1]}-${m[2]}-${String(lastDayOf(y, mo)).padStart(2, "0")}`);
  }
  return months.size === 1 ? [...months][0] : null;
}

// The day a document is dated, from the site's own list, or from its id.
export function documentDate(doc) {
  if (doc && dayOf(doc.date) !== null) return String(doc.date).trim();
  return dateFromId(doc && doc.id);
}

// The documents of one series: an id with its date taken out. A site's
// monthly statements for one account share it ("card:#"), and its tax forms,
// or a second account's statements, have their own. This stands in for
// PaperPull's account and summary, which a site's list does not always give.
export function seriesOf(id) {
  return String(id || "").replace(FULL_DATE, "#").replace(MONTH_ONLY, "#");
}

// -- tax forms ----------------------------------------------------------------------
// PaperPull's doc_types: a document is a tax document when its title names a
// tax form. Property tax bills and notices are bills, not forms that arrive
// in tax season, so they are left out.
const TAX = /\b(1099|1098|1042|5498|w-?2|tax|transcript|gain\s*loss|realized\s+gains?)\b/i;
const NOT_TAX = /\bproperty\s+tax\b|\btax\s+(bill|notice|receipt|payment)s?\b/i;
export function isTaxText(text) {
  const t = String(text || "").replace(/[_\-:|/.,]+/g, " ").replace(/(\d)([a-z])/gi, "$1 $2");
  return TAX.test(t) && !NOT_TAX.test(t);
}
export function isTaxDocument(doc) {
  return Boolean(doc) && (isTaxText(doc.title) || isTaxText(doc.kind) || isTaxText(doc.id));
}
// The tax year a form is for. One dated in the first half of a year was
// issued for the year before (a 1099 of February 2026 is for 2025); one dated
// later is the year itself (a form dated 2025-12-31).
export function taxYearOf(iso) {
  const m = ISO.exec(String(iso || ""));
  if (!m) return null;
  return +m[2] <= 6 ? +m[1] - 1 : +m[1];
}

// When forms for last year are expected: PaperPull has no tax season of its
// own, so this is January 15 to March 15. Most 1099s and 1098s are mailed by
// January 31, brokerages' consolidated 1099s by mid-February, and corrections
// run into March.
export const TAX_WINDOW = { from: [1, 15], to: [3, 15] };

// { state, year } for a site's tax forms on `today`, or null when the site has
// never had one. state is "due" inside the window with none saved for last
// year, "missing" after the window with none, "have" when last year's are
// saved, "before" in early January.
export function taxSeason(taxDates, today) {
  if (!taxDates || !taxDates.length) return null;
  const now = isoOf(todayDay(today));
  const y = +now.slice(0, 4), year = y - 1;
  if (taxDates.some((d) => taxYearOf(d) === year)) return { state: "have", year };
  const pad = (n) => String(n).padStart(2, "0");
  const from = `${y}-${pad(TAX_WINDOW.from[0])}-${pad(TAX_WINDOW.from[1])}`;
  const to = `${y}-${pad(TAX_WINDOW.to[0])}-${pad(TAX_WINDOW.to[1])}`;
  if (now < from) return { state: "before", year };
  return { state: now <= to ? "due" : "missing", year };
}

// -- how often ----------------------------------------------------------------------
// status.py _gap_median: three dates at least, and two gaps of a sane size.
function gapMedian(days) {
  const uniq = [...new Set(days)].sort((a, b) => a - b);
  if (uniq.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < uniq.length; i += 1) {
    const g = uniq[i] - uniq[i - 1];
    if (g > 0 && g <= 400) gaps.push(g);
  }
  if (gaps.length < 2) return null;
  return median(gaps.slice(-24));
}

// status.py _cadence_days: measured per series and then combined, so several
// accounts each billed monthly do not read as weekly. Pooled only when no
// series has enough history on its own.
export function cadenceDays(bySeries) {
  const per = Object.values(bySeries).map(gapMedian).filter(Boolean);
  if (!per.length) return gapMedian(Object.values(bySeries).flat());
  return median(per);
}

// status.py _fmt_cadence.
export function cadenceName(days) {
  if (!days) return "";
  if (days <= 10) return "weekly";
  if (days <= 20) return "2x month";
  if (days <= 45) return "monthly";
  if (days <= 100) return "quarterly";
  if (days <= 200) return "2x year";
  return "yearly";
}

// -- gaps -------------------------------------------------------------------------
// status.py _tail_cadence_len: a trailing run at a slower, steady rhythm is a
// change of schedule (monthly to quarterly), not a run of holes.
function tailCadenceLen(gaps) {
  let best = 0;
  for (let k = 2; k <= gaps.length; k += 1) {
    const tail = gaps.slice(-k);
    const med = median(tail);
    if (med && tail.every((g) => Math.abs(g - med) <= med * 0.35)) best = k;
    else break;
  }
  return best;
}

// status.py find_gaps: periods that look missing from the MIDDLE of a history.
// A series earns an opinion first: six documents at least, a median interval
// of ten days or more, and 65 percent of its intervals close to that median.
// Then an interval roughly twice the usual one is reported, as possible.
export function findGaps(bySeries) {
  const found = [];
  for (const [series, days] of Object.entries(bySeries)) {
    const uniq = [...new Set(days)].sort((a, b) => a - b);
    if (uniq.length < 6) continue;
    const gaps = uniq.slice(1).map((d, i) => d - uniq[i]);
    const med = median(gaps);
    if (med < 10) continue;
    const regular = gaps.filter((g) => Math.abs(g - med) <= med * 0.35).length / gaps.length;
    if (regular < 0.65) continue;
    const tail = tailCadenceLen(gaps);
    let changedFrom = gaps.length;
    if (tail >= 2 && median(gaps.slice(-tail)) > med * 1.5) changedFrom = gaps.length - tail;
    gaps.forEach((g, i) => {
      if (i >= changedFrom) return;
      if (g >= med * 1.9 && g - med >= 10) {
        found.push({ series, after: isoOf(uniq[i]), before: isoOf(uniq[i + 1]), missing: Math.max(1, Math.round(g / med) - 1), everyDays: med });
      }
    });
  }
  found.sort((a, b) => (a.after < b.after ? -1 : a.after > b.after ? 1 : 0));
  return found;
}

// status.py group_gaps: the same window missing in several series at once is
// one finding (usually a run that failed part way), not several.
export function groupGaps(gaps) {
  const windows = new Map();
  for (const g of gaps) {
    const key = `${g.after}|${g.before}|${g.missing}`;
    if (!windows.has(key)) windows.set(key, { after: g.after, before: g.before, missing: g.missing, everyDays: g.everyDays, count: 0 });
    windows.get(key).count += 1;
  }
  return [...windows.values()].sort((a, b) => (a.after < b.after ? -1 : a.after > b.after ? 1 : 0));
}

// -- one site -----------------------------------------------------------------------
// `ids` are the documents saved (the seen record), `dates` {id: date} and
// `tax` the ids that are tax forms. Returns where the site stands on `today`.
// A gap is known by its window, the two documents either side of it. You can
// say a gap is expected (the popup's Dismiss); that window is then never shown
// or counted again, while a new gap elsewhere still is.
export const gapKey = (g) => `${g.after}|${g.before}`;

// How many days after its own date a site's document usually appears, learned
// from the day each new one was saved (arrived:<site>). Only arrivals within
// one cycle of their date count, so the first sweep's back catalogue, saved
// years late, teaches nothing. Two at least; until then `usual`, the site's
// own typical delay (postsAfterDays in its meta, from when its "statement
// ready" emails arrive), or 0.
export function postingLag(arrived = {}, dates = {}, cadence = null, skip = new Set(), usual = 0) {
  if (!cadence) return 0;
  const lags = [];
  for (const [id, on] of Object.entries(arrived)) {
    if (skip.has(id)) continue;
    const a = dayOf(on), d = dayOf(dates[id]);
    if (a === null || d === null) continue;
    const lag = a - d;
    if (lag >= 0 && lag <= cadence) lags.push(lag);
  }
  if (lags.length >= 2) return Math.round(median(lags.slice(-12)));
  return Number.isInteger(usual) && usual > 0 && usual < cadence ? usual : 0;
}

// After a sweep finds nothing new, how long before the site is flagged again:
// a quarter of its cycle, 3 to 7 days.
export const recheckDays = (cadence) => Math.min(7, Math.max(3, Math.round((cadence || 28) / 4)));

// `postsAfter` is the site's typical posting delay (postingLag's `usual`).
export function siteStatus({ ids = [], dates = {}, tax = [], gapsOk = [], arrived = {}, checked = "" } = {}, today, { postsAfter = 0 } = {}) {
  const now = todayDay(today);
  const taxIds = new Set(tax);
  const all = new Set([...ids, ...Object.keys(dates)]);
  const documents = all.size;
  // Status.py's sane window: a date from before 1990 or after the day after
  // tomorrow came from a page, and is ignored rather than trusted.
  const dated = [];
  for (const id of all) {
    const d = dayOf(dates[id]);
    if (d !== null && d >= dayOf("1990-01-01") && d <= now + 2) dated.push({ id, day: d, tax: taxIds.has(id) });
  }
  // Statements decide the schedule. A site's yearly tax forms have a season
  // of their own (taxSeason), so they never make a monthly site look late or
  // current; a site that only has tax forms is judged by those.
  const statements = dated.filter((d) => !d.tax);
  const judged = statements.length ? statements : dated;
  const bySeries = {};
  for (const d of judged) (bySeries[seriesOf(d.id)] ||= []).push(d.day);
  const newestDay = judged.length ? Math.max(...judged.map((d) => d.day)) : null;
  const cadence = judged.length ? cadenceDays(bySeries) : null;
  const ageDays = newestDay === null ? null : now - newestDay;
  // A site that posts its statements some days after their date is judged
  // from when they usually appear, not from the date printed on them.
  const lagDays = postingLag(arrived, dates, cadence, taxIds, postsAfter);
  const late = ageDays === null ? null : ageDays - lagDays;
  let status;
  if (!documents) status = NEVER;
  else if (newestDay === null || !cadence) status = UNKNOWN;
  else if (late <= cadence * 1.3) status = CURRENT;
  else if (late <= cadence * 2) status = DUE;
  else status = OVERDUE;
  // Looked at since its newest document and nothing was there: wait a little.
  const checkedDay = dayOf(checked);
  const recheck = recheckDays(cadence);
  const nextCheck = checkedDay === null ? null : checkedDay + recheck;
  if ((status === DUE || status === OVERDUE) && checkedDay !== null && newestDay !== null
      && checkedDay >= newestDay && now < nextCheck) status = CHECKED;
  const gapSeries = {};
  for (const d of dated) (gapSeries[seriesOf(d.id)] ||= []).push(d.day);
  const allGaps = groupGaps(findGaps(gapSeries));
  const ok = new Set(gapsOk);
  const gaps = allGaps.filter((g) => !ok.has(gapKey(g)));
  const gapsDismissed = allGaps.length - gaps.length;
  const expectedDay = cadence && newestDay !== null ? newestDay + Math.round(cadence) + lagDays : null;
  // Any tax form at all makes the site one that issues them; only a dated one
  // can say which year is saved.
  const forms = [...taxIds].filter((id) => all.has(id));
  const season = forms.length ? taxSeason(forms.map((id) => dates[id] || ""), isoOf(now)) : null;
  return {
    documents, status, cadenceDays: cadence, cadence: cadenceName(cadence), ageDays,
    newest: newestDay === null ? null : isoOf(newestDay),
    expected: expectedDay === null ? null : isoOf(expectedDay),
    overdueBy: status === OVERDUE && expectedDay !== null ? now - expectedDay : 0,
    lagDays,
    checked: checkedDay === null ? null : isoOf(checkedDay),
    nextCheck: status === CHECKED ? isoOf(nextCheck) : null,
    gaps, gapsDismissed, tax: season,
  };
}

// The order PaperPull's home page lists accounts in, most in need first.
const RANK = { [OVERDUE]: 0, [DUE]: 1, tax: 1, gap: 2, [NEVER]: 3, [UNKNOWN]: 4, [CHECKED]: 5, [CURRENT]: 5 };
// One word for where a site stands, as PaperPull's _account_state: how
// current it is first, then tax forms waiting, then gaps.
export function stateOf(s) {
  if ([OVERDUE, DUE, NEVER].includes(s.status)) return s.status;
  if (s.tax && s.tax.state === "due") return "tax";
  if (s.gaps.length) return "gap";
  return s.status;
}
export const rankOf = (s) => RANK[stateOf(s)] ?? 9;
// Whether Get New Documents runs it: anything that may have something new,
// or that has too little history to say. Up to date sites are left out.
export const needsRun = (s) => stateOf(s) !== CURRENT && stateOf(s) !== CHECKED;
// What the toolbar badge counts: a site whose next document is late.
export const isDue = (s) => s.status === DUE || s.status === OVERDUE || Boolean(s.tax && s.tax.state === "due");

// -- in words ---------------------------------------------------------------------
export function shortDate(iso, today) {
  const m = ISO.exec(String(iso || ""));
  if (!m) return "";
  const year = +m[1], same = year === +isoOf(todayDay(today)).slice(0, 4);
  return `${MONTHS[+m[2] - 1]} ${+m[3]}${same ? "" : `, ${year}`}`;
}
const monthYear = (day) => { const d = isoOf(day); return [MONTHS[+d.slice(5, 7) - 1], d.slice(0, 4)]; };

// The month or months a gap is missing, "Mar 2026" or "Nov 2025–Jan 2026".
export function gapWords(g) {
  const a = dayOf(g.after), b = dayOf(g.before);
  let points;
  if (g.everyDays >= 25 && g.everyDays <= 35) {
    // A monthly series misses the months strictly between its two neighbours.
    points = [];
    const monthIndex = (iso) => +iso.slice(0, 4) * 12 + (+iso.slice(5, 7) - 1);
    for (let i = monthIndex(g.after) + 1; i < monthIndex(g.before); i += 1) {
      points.push(Date.UTC(Math.floor(i / 12), i % 12, 15) / DAY_MS);
    }
    if (!points.length) points = [Math.round((a + b) / 2)];
  } else {
    points = Array.from({ length: g.missing }, (_, k) => Math.round(a + ((b - a) * (k + 1)) / (g.missing + 1)));
  }
  const [fm, fy] = monthYear(points[0]);
  const [lm, ly] = monthYear(points[points.length - 1]);
  if (points.length === 1 || (fm === lm && fy === ly)) return `${fm} ${fy}`;
  return fy === ly ? `${fm}–${lm} ${fy}` : `${fm} ${fy}–${lm} ${ly}`;
}

// The status line under a site's name. `skipped` is true when Get New
// Documents left the site out because it is up to date.
export function statusWords(s, today, { skipped = false } = {}) {
  const parts = [];
  const now = todayDay(today);
  const when = (iso) => shortDate(iso, today);
  switch (s.status) {
    case NEVER: parts.push("Nothing saved yet"); break;
    case UNKNOWN: parts.push(`No schedule yet · ${s.documents} saved${s.newest ? `, newest ${when(s.newest)}` : ""}`); break;
    case CURRENT: {
      const ahead = s.expected && dayOf(s.expected) > now;
      const next = ahead ? `next around ${when(s.expected)}` : "next one expected any day";
      parts.push(`${skipped ? "Not due yet" : "Up to date"} · ${next}`);
      break;
    }
    case CHECKED: parts.push(`Checked ${when(s.checked)} · nothing new yet · next check ${when(s.nextCheck)}`); break;
    case DUE: parts.push(`New one likely · expected around ${when(s.expected)}`); break;
    case OVERDUE: parts.push(`Overdue by ${s.overdueBy} ${s.overdueBy === 1 ? "day" : "days"} · newest ${when(s.newest)}`); break;
    default: break;
  }
  if (s.tax && s.tax.state === "due") parts.push(`Tax forms expected now (${s.tax.year})`);
  if (s.tax && s.tax.state === "missing") parts.push(`${s.tax.year} tax forms not found yet`);
  if (s.gaps.length) {
    const g = s.gaps[0];
    const more = s.gaps.length > 1 ? ` and ${s.gaps.length - 1} more` : "";
    parts.push(`Possible gap: ${gapWords(g)}${g.missing > 1 ? ` (${g.missing} missing)` : ""}${more}`);
  }
  return parts.join(" · ");
}

// A site's standing from what is stored, with its own typical posting delay.
export const standingOf = (stored, provider, today) => siteStatus(recordOf(stored, provider.id), today, { postsAfter: provider.postsAfterDays || 0 });

// -- the stored record --------------------------------------------------------------
// chrome.storage.local keys for one site: the ids saved, their dates, and
// which of them are tax forms.
export const keysFor = (id) => [`seen:${id}`, `dates:${id}`, `tax:${id}`, `gapsOk:${id}`, `arrived:${id}`, `checked:${id}`];

// A site's record as stored, with what its ids say filled in where nothing is
// stored: a date an id holds, and a tax form an id names. Read-only, so it is
// the same however often it runs.
export function recordOf(stored, id) {
  const ids = Array.isArray(stored[`seen:${id}`]) ? stored[`seen:${id}`].filter((x) => typeof x === "string") : [];
  const kept = stored[`dates:${id}`];
  const dates = {};
  if (kept && typeof kept === "object" && !Array.isArray(kept)) {
    for (const [k, v] of Object.entries(kept)) if (dayOf(v) !== null) dates[k] = v;
  }
  for (const x of ids) if (!(x in dates)) { const d = dateFromId(x); if (d) dates[x] = d; }
  const tax = new Set(Array.isArray(stored[`tax:${id}`]) ? stored[`tax:${id}`].filter((x) => typeof x === "string") : []);
  for (const x of ids) if (isTaxText(x)) tax.add(x);
  const gapsOk = Array.isArray(stored[`gapsOk:${id}`]) ? stored[`gapsOk:${id}`].filter((x) => typeof x === "string") : [];
  const arrived = {};
  const kept2 = stored[`arrived:${id}`];
  if (kept2 && typeof kept2 === "object" && !Array.isArray(kept2)) {
    for (const [k, v] of Object.entries(kept2)) if (dayOf(v) !== null) arrived[k] = v;
  }
  const checked = dayOf(stored[`checked:${id}`]) !== null ? stored[`checked:${id}`] : "";
  return { ids, dates, tax: [...tax], gapsOk, arrived, checked };
}

// What recordOf would add to what is stored, for the engine to keep: an empty
// object when nothing is missing, so a second pass writes nothing.
export function backfillFor(stored, id) {
  const { dates, tax } = recordOf(stored, id);
  const kept = stored[`dates:${id}`] && typeof stored[`dates:${id}`] === "object" ? stored[`dates:${id}`] : {};
  const keptTax = Array.isArray(stored[`tax:${id}`]) ? stored[`tax:${id}`] : [];
  const writes = {};
  if (Object.keys(dates).some((k) => kept[k] !== dates[k])) writes[`dates:${id}`] = { ...kept, ...dates };
  if (tax.some((x) => !keptTax.includes(x))) writes[`tax:${id}`] = [...new Set([...keptTax, ...tax])];
  return writes;
}
