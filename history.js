// The record of what has already been saved, carried to another copy of
// Statement Sweep, such as the one from the Chrome Web Store, which starts
// with nothing and would otherwise save every document again.
//
// The record is `seen:<site id>` in chrome.storage.local, a list of each
// site's own ids for its documents. A file carries those lists, and, for the
// person to use or not, the folder and file name settings and which sites are
// switched off. Never a chosen folder: Chrome's access to it belongs to this
// copy and cannot be handed to another.
//
// Beside it, optional, each saved document's date (`dates`, {site: {id:
// "YYYY-MM-DD"}}) and which documents are tax forms (`tax`, {site: [id]}),
// from `dates:<site id>` and `tax:<site id>`, so the other copy knows what is
// due (cadence.js) from the first day.
//
// An import only ever adds. Nothing already recorded is removed, so a file
// from an older copy can never make a document be saved twice.
import { PROVIDERS } from "./providers/index.js";
import { checkPattern, normalise } from "./naming.js";
import { dayOf, recordOf } from "./cadence.js";

export const FORMAT = "statement-sweep-history";
export const VERSION = 1;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_IDS = 20000;
const MAX_ID_LENGTH = 1000;
const MAX_PATTERN_LENGTH = 1000;
const KEYS = ["format", "version", "exportedAt", "sites", "naming", "off", "dates", "tax"];
const SEEN = "seen:";
const DATES = "dates:";
const TAX = "tax:";

const known = new Map(PROVIDERS.map((p) => [p.id, p]));
const nameOf = (id) => (known.get(id) || { name: id }).name;
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const local = () => chrome.storage.local;

// Only the patterns, whatever else may have been stored beside them.
function cleanNaming(stored) {
  const n = normalise(stored);
  const providers = {};
  for (const [id, own] of Object.entries(n.providers)) {
    if (!known.has(id) || !isObject(own)) continue;
    const kept = {};
    if (typeof own.folder === "string" && own.folder) kept.folder = own.folder;
    if (typeof own.file === "string" && own.file) kept.file = own.file;
    if (Object.keys(kept).length) providers[id] = kept;
  }
  return { base: n.base, folder: n.folder, file: n.file, providers };
}

// The file's contents, and how many documents and sites it holds.
export async function exportHistory(now = new Date()) {
  const all = await local().get(null);
  const sites = {};
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(SEEN) || !Array.isArray(value)) continue;
    const ids = [...new Set(value.filter((id) => typeof id === "string" && id))];
    if (ids.length) sites[key.slice(SEEN.length)] = ids;
  }
  const file = { format: FORMAT, version: VERSION, exportedAt: now.toISOString(), sites };
  // The dates kept, and those the ids hold, for every site with a record.
  const dates = {}, tax = {};
  for (const provider of PROVIDERS) {
    if (!sites[provider.id] && !all[DATES + provider.id]) continue;
    const record = recordOf(all, provider.id);
    if (Object.keys(record.dates).length) dates[provider.id] = record.dates;
    if (record.tax.length) tax[provider.id] = record.tax;
  }
  if (Object.keys(dates).length) file.dates = dates;
  if (Object.keys(tax).length) file.tax = tax;
  if (all.naming !== undefined) file.naming = cleanNaming(all.naming);
  if (Array.isArray(all.off)) file.off = all.off.filter((id) => typeof id === "string");
  const documents = Object.values(sites).reduce((sum, ids) => sum + ids.length, 0);
  return { file, documents, sites: Object.keys(sites).length };
}

// What is recorded now, for the Settings page.
export async function recordedCounts() {
  const all = await local().get(null);
  let documents = 0, sites = 0;
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(SEEN) && Array.isArray(value) && value.length) {
      documents += value.length;
      sites += 1;
    }
  }
  return { documents, sites };
}

// A local date, as the person would write it.
export function fileNameFor(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `Statement Sweep History ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

class Refused extends Error {}
const refuse = (text) => { throw new Refused(text); };

function readNaming(given) {
  const where = "Its folder and file name settings";
  if (!isObject(given)) refuse(`${where} are not in the right form.`);
  for (const key of Object.keys(given)) if (!["base", "folder", "file", "providers"].includes(key)) refuse(`${where} have a part this version does not know: “${key}”.`);
  const checks = [];
  for (const [key, label, isFile] of [["base", "Main folder", false], ["folder", "Folder pattern", false], ["file", "File name pattern", true]]) {
    if (given[key] === undefined) continue;
    if (typeof given[key] !== "string" || given[key].length > MAX_PATTERN_LENGTH) refuse(`${where}: the ${label.toLowerCase()} is not a pattern.`);
    checks.push([label, given[key], isFile]);
  }
  const providers = {};
  if (given.providers !== undefined) {
    if (!isObject(given.providers)) refuse(`${where}: the settings for single sites are not in the right form.`);
    for (const [id, own] of Object.entries(given.providers)) {
      // A site this copy does not have has no use for a pattern.
      if (!known.has(id)) continue;
      if (!isObject(own)) refuse(`${where}: the settings for ${nameOf(id)} are not in the right form.`);
      const kept = {};
      for (const [key, label, isFile] of [["folder", "folder pattern", false], ["file", "file name pattern", true]]) {
        if (own[key] === undefined || own[key] === "") continue;
        if (typeof own[key] !== "string" || own[key].length > MAX_PATTERN_LENGTH) refuse(`${where}: the ${nameOf(id)} ${label} is not a pattern.`);
        checks.push([`${nameOf(id)} ${label}`, own[key], isFile]);
        kept[key] = own[key];
      }
      if (Object.keys(kept).length) providers[id] = kept;
    }
  }
  for (const [label, pattern, isFile] of checks) {
    const problem = checkPattern(pattern, { isFile });
    if (problem) refuse(`${where}: ${label}: ${problem}`);
  }
  return { ...normalise(given), providers };
}

// Reads a history file, strictly. Returns { ok: true, sites, unknown, naming,
// off, exportedAt } or { ok: false, problem } saying in plain words what is wrong.
export function readHistory(text) {
  try {
    if (typeof text !== "string" || text.length > MAX_FILE_BYTES) refuse("This file is too large to be a Statement Sweep history file.");
    let data;
    try { data = JSON.parse(text); } catch (e) { refuse("This is not a Statement Sweep history file. It could not be read."); }
    if (!isObject(data) || data.format !== FORMAT) refuse("This is not a Statement Sweep history file.");
    if (typeof data.version !== "number") refuse("This history file does not say which version it is.");
    if (data.version > VERSION) refuse(`This history file was made by a newer Statement Sweep (version ${data.version}). Update this copy and try again.`);
    if (data.version !== VERSION) refuse(`This history file is version ${data.version}, which this copy cannot read.`);
    for (const key of Object.keys(data)) if (!KEYS.includes(key)) refuse(`This history file has a part this version does not know: “${key}”.`);
    if (data.exportedAt !== undefined && (typeof data.exportedAt !== "string" || Number.isNaN(Date.parse(data.exportedAt)))) refuse("This history file's date is not a date.");
    if (!isObject(data.sites)) refuse("This history file has no list of sites.");
    const sites = {}, unknown = [];
    for (const [id, ids] of Object.entries(data.sites)) {
      // A site this copy does not have is reported, and left out.
      if (!known.has(id)) { unknown.push(id); continue; }
      const name = nameOf(id);
      if (!Array.isArray(ids)) refuse(`${name}: its record is not a list of documents.`);
      if (ids.length > MAX_IDS) refuse(`${name}: its record lists ${ids.length.toLocaleString()} documents, more than the ${MAX_IDS.toLocaleString()} a history file can hold for one site.`);
      if (!ids.every((v) => typeof v === "string" && v && v.length <= MAX_ID_LENGTH)) refuse(`${name}: its record has an entry that is not a document's id.`);
      sites[id] = [...new Set(ids)];
    }
    const dates = {}, tax = {};
    if (data.dates !== undefined && data.dates !== null) {
      if (!isObject(data.dates)) refuse("This history file's document dates are not in the right form.");
      for (const [id, byDoc] of Object.entries(data.dates)) {
        if (!known.has(id)) { if (!unknown.includes(id)) unknown.push(id); continue; }
        const name = nameOf(id);
        if (!isObject(byDoc)) refuse(`${name}: its document dates are not in the right form.`);
        const entries = Object.entries(byDoc);
        if (entries.length > MAX_IDS) refuse(`${name}: its record dates ${entries.length.toLocaleString()} documents, more than the ${MAX_IDS.toLocaleString()} a history file can hold for one site.`);
        for (const [doc, when] of entries) {
          if (!doc || doc.length > MAX_ID_LENGTH) refuse(`${name}: its document dates have an entry that is not a document's id.`);
          if (typeof when !== "string" || dayOf(when) === null) refuse(`${name}: its document dates have one that is not a date (YYYY-MM-DD).`);
        }
        dates[id] = Object.fromEntries(entries);
      }
    }
    if (data.tax !== undefined && data.tax !== null) {
      if (!isObject(data.tax)) refuse("This history file's list of tax forms is not in the right form.");
      for (const [id, ids] of Object.entries(data.tax)) {
        if (!known.has(id)) { if (!unknown.includes(id)) unknown.push(id); continue; }
        const name = nameOf(id);
        if (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every((v) => typeof v === "string" && v && v.length <= MAX_ID_LENGTH)) refuse(`${name}: its list of tax forms is not a list of documents.`);
        tax[id] = [...new Set(ids)];
      }
    }
    let naming = null, off = null;
    if (data.naming !== undefined && data.naming !== null) naming = readNaming(data.naming);
    if (data.off !== undefined && data.off !== null) {
      if (!Array.isArray(data.off) || data.off.length > MAX_IDS || !data.off.every((v) => typeof v === "string")) refuse("This history file's list of switched-off sites is not in the right form.");
      off = [...new Set(data.off.filter((id) => known.has(id)))];
    }
    return { ok: true, sites, unknown, naming, off, dates, tax, exportedAt: data.exportedAt || "" };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, problem: e.message };
    throw e;
  }
}

// Per site, in the order of the site list: how many of the file's documents
// are new here, and how many are recorded already.
export async function planImport(history) {
  const ids = Object.keys(history.sites);
  const keys = ids.map((id) => SEEN + id);
  const now = keys.length ? await local().get(keys) : {};
  const plan = [];
  for (const provider of PROVIDERS) {
    if (!history.sites[provider.id]) continue;
    const had = Array.isArray(now[SEEN + provider.id]) ? now[SEEN + provider.id] : [];
    const have = new Set(had);
    const fresh = history.sites[provider.id].filter((id) => !have.has(id));
    plan.push({ id: provider.id, name: provider.name, added: fresh.length, already: history.sites[provider.id].length - fresh.length, merged: [...had, ...fresh] });
  }
  return plan;
}

// Adds the file's documents to the record, and only if asked, its settings.
// Read again just before writing, so nothing recorded since is lost.
export async function importHistory(history, { useSettings = false } = {}) {
  const plan = await planImport(history);
  const writes = {};
  for (const site of plan) if (site.added) writes[SEEN + site.id] = site.merged;
  // Dates and tax forms are added where this copy has none; nothing kept here
  // is changed or removed.
  const dated = Object.keys(history.dates || {}), taxed = Object.keys(history.tax || {});
  const now = dated.length || taxed.length ? await local().get([...dated.map((id) => DATES + id), ...taxed.map((id) => TAX + id)]) : {};
  for (const id of dated) {
    const had = isObject(now[DATES + id]) ? now[DATES + id] : {};
    const fresh = Object.entries(history.dates[id]).filter(([doc]) => !(doc in had));
    if (fresh.length) writes[DATES + id] = { ...had, ...Object.fromEntries(fresh) };
  }
  for (const id of taxed) {
    const had = Array.isArray(now[TAX + id]) ? now[TAX + id] : [];
    const fresh = history.tax[id].filter((doc) => !had.includes(doc));
    if (fresh.length) writes[TAX + id] = [...had, ...fresh];
  }
  const naming = Boolean(useSettings && history.naming);
  const off = Boolean(useSettings && history.off);
  if (naming) writes.naming = history.naming;
  if (off) writes.off = history.off;
  if (Object.keys(writes).length) await local().set(writes);
  return {
    sites: plan.map(({ id, name, added, already }) => ({ id, name, added, already })),
    added: plan.reduce((sum, s) => sum + s.added, 0),
    unknown: history.unknown,
    naming,
    off,
  };
}
