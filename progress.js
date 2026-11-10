// How far a sync has got, for the popup's bars: one for each site, and one
// for the whole sync. Pure, so the tests can call it.
//
// A site's total is not known until its list is read, and a site with several
// lists (accounts, years) only knows them one at a time. Until then the bar
// uses an estimate from the site's own past syncs, and says "about".

import { median } from "./cadence.js";

// How many past syncs' counts are kept for each site.
export const FOUND_KEEP = 6;
export const foundKey = (id) => `found:${id}`;

// The counts kept for a site, oldest first: how many documents each finished
// sync found that were not saved before (saved or not).
export function foundOf(stored, id) {
  const kept = stored[foundKey(id)];
  return Array.isArray(kept) ? kept.filter((n) => Number.isInteger(n) && n >= 0) : [];
}
export const addFound = (found, n) => [...found, n].slice(-FOUND_KEEP);

// The estimate for a site's bar before its list is read: a whole number, or
// null when there is nothing to go on (the bar then moves without a number).
//
// `found` is the counts above, oldest first. `status` is the site's standing
// from cadence.js siteStatus: `status.status` is "due", "overdue", "current",
// "checked", "unknown" or "never", and `status.documents` is how many it has
// saved in all.
export function estimateNew(found, status) {
  // A first sync, or one with no past counts: nothing to go on.
  if (!found.length || !status || !status.documents) return null;
  // A sync that found nothing only says the site was checked early, not how
  // many a site posts, so the size comes from the syncs that found some. The
  // middle one, so a single big catch-up sync does not inflate every bar.
  const some = found.filter((n) => n > 0);
  const size = some.length ? Math.max(1, Math.round(median(some))) : 1;
  // A site whose next document is due likely has a batch that size waiting.
  // One that is up to date, or was just checked, ran because you ticked it,
  // and likely has one at most: a low guess costs nothing, since the bar
  // takes the real count as soon as the list is read.
  return status.status === "due" || status.status === "overdue" || status.status === "unknown" ? size : 1;
}

// A site's progress so far. `done` is how many it has tried (saved or not),
// `listed` how many new ones its lists read so far held, `more` whether a
// list is still to be read, and `estimate` from estimateNew.
export function siteProgress({ done = 0, listed = 0, more = true, estimate = null } = {}) {
  if (!more) return { done, total: Math.max(listed, done), exact: true };
  const total = Math.max(listed, done, estimate ?? 0);
  return { done, total: total || null, exact: false };
}

// The whole sync: every site in this run added up. Exact once every site is.
export function runProgress(rows) {
  let done = 0, total = 0, exact = true, known = 0;
  for (const r of rows) {
    const p = r && r.progress;
    if (!p) continue;
    done += p.done || 0;
    if (p.total != null) { total += p.total; known += 1; }
    if (!p.exact) exact = false;
  }
  return { done, total: known ? total : null, exact };
}

// How full a bar is, 0 to 100, or null for one that moves without a number.
// An estimate never shows a bar as full: the last part waits for the real count.
export function percent(p) {
  if (!p || !p.total) return p && p.exact ? 100 : null;
  const share = Math.min(1, p.done / p.total);
  return Math.round((p.exact ? share : Math.min(share, 0.9)) * 100);
}

// The count beside a bar: "3 of 5", or "0 of about 4" before it is known.
export function countWords(p) {
  if (!p || !p.total) return "";
  return `${p.done} of ${p.exact ? "" : "about "}${p.total}`;
}
