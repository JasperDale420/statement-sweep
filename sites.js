// Every site Statement Sweep sweeps: the built-in recipes (providers/index.js)
// and the sites you added yourself with Add This Site. An added site is data,
// never code: its saved pattern, kept in chrome.storage.local under
// "addedSites", read by the one built-in recipe providers/added.page.js.
//
// SITES is a live list. Import it as PROVIDERS and call loadSites() before
// reading it, and it holds the added sites too; until then it is the built-in
// ones alone. A service worker cannot wait at the top of a module, so the
// engine loads it at the start of each piece of work.
import { PROVIDERS } from "./providers/index.js";

export const ADDED = "addedSites";
// What the engine keeps for an added site, beside the record every site has:
// how its last sync went ({at, ok, found}), and the documents its first sync
// marked as seen without saving, when you chose "Only new ones from now on".
export const lastKey = (id) => `addedLast:${id}`;
export const primedKey = (id) => `primed:${id}`;
export const ADDED_PAGE = "providers/added.page.js";

export let SITES = PROVIDERS;

const plainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// An added site as the engine, the popup and Settings use a site. `added` is
// its saved pattern, handed to the recipe before each call.
export function siteOf(config) {
  const dated = config.date && config.date.from !== "none";
  return {
    id: config.id,
    name: config.name,
    match: [...config.match],
    listUrl: config.listUrl,
    pageFile: ADDED_PAGE,
    // With no dates on the page, each is named by its link's own short key.
    fileName: dated ? `{date} ${config.name} Statement.pdf` : `${config.name} Statement {id}.pdf`,
    family: config.method === "fetch" ? "fetch" : "click",
    added: config,
  };
}

export const addedSites = (stored) => (Array.isArray(stored) ? stored.filter((c) => cleanConfig(c, c && c.origin)) : []);

export async function loadSites() {
  let stored = [];
  try { stored = (await chrome.storage.local.get(ADDED))[ADDED]; } catch (e) { /* no storage here: the built-in sites alone */ }
  SITES = [...PROVIDERS, ...addedSites(stored).map(siteOf)];
  return SITES;
}

// Whether an address is on one of a site's `match` hosts, where "*." covers
// every host under it, as the engine reads them.
export function onHosts(url, match) {
  let host;
  try { host = new URL(url).hostname; } catch (e) { return false; }
  return match.some((m) => {
    const wanted = new URL(m.replace("*.", "").replace(/\*$/, "")).hostname;
    return m.includes("*.") ? host === wanted || host.endsWith("." + wanted) : host === wanted;
  });
}

// The built-in site an address belongs to, if any. Add This Site is not
// offered there: that site has a recipe of its own.
export const builtInFor = (url) => PROVIDERS.find((p) => onHosts(url, p.match) || (p.fileHosts || []).some((h) => onHosts(url, [`https://${h}/*`]))) || null;

// The added site for an origin, if any, from the stored list.
export const addedFor = (stored, origin) => addedSites(stored).find((c) => c.origin === origin) || null;

// A short id from a name: "added-" and its letters and digits.
export function slugOf(name) {
  const slug = String(name || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");
  return slug || "site";
}

// What a name may be: plain words, short, with nothing a file name or folder cannot hold.
export const cleanName = (name) => String(name || "").replace(/[/\\:*?"<>|\x00-\x1f{}[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40).trim();

const TAG = /^[a-z][a-z0-9-]{0,30}$/;
const CLASS = /^[A-Za-z_-][A-Za-z_-]{0,39}$/;
const TOKENS = /^[^\s<>"'`\\]{0,400}$/;

// A pattern the picker sent, checked field by field, and kept only as the
// fields below. Anything else in it is dropped. Answers null for one that is
// not whole or not for `origin`. Nothing from the page's text is kept but a
// link's words with no digits in them, and a column's heading.
export function cleanConfig(raw, origin, today = "") {
  if (!plainObject(raw) || typeof origin !== "string") return null;
  let url;
  try { url = new URL(origin); } catch (e) { return null; }
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) return null;
  const name = cleanName(raw.name);
  if (!name) return null;
  const id = typeof raw.id === "string" && /^added-[a-z0-9-]{1,40}$/.test(raw.id) ? raw.id : `added-${slugOf(name)}`;
  const listPath = typeof raw.listPath === "string" && raw.listPath.startsWith("/") && TOKENS.test(raw.listPath) ? raw.listPath : null;
  const listOpen = raw.listOpen !== false;
  let listUrl;
  try { listUrl = new URL(String(raw.listUrl || "/"), origin); } catch (e) { return null; }
  if (listUrl.origin !== origin) return null;
  const row = plainObject(raw.row) ? raw.row : null;
  if (!row || !TAG.test(String(row.tag)) || !Array.isArray(row.classes) || row.classes.length > 2 || !row.classes.every((c) => CLASS.test(String(c)))) return null;
  if (!Array.isArray(raw.path) || raw.path.length > 8 || !raw.path.every((s) => Array.isArray(s) && s.length === 2 && TAG.test(String(s[0])) && Number.isInteger(s[1]) && s[1] >= 1 && s[1] <= 200)) return null;
  if (typeof raw.href !== "string" || !TOKENS.test(raw.href) || !/^[/#]|^$/.test(raw.href)) return null;
  const text = typeof raw.text === "string" && !/\d/.test(raw.text) && raw.text.length <= 40 ? raw.text.replace(/\s+/g, " ").trim() : "";
  const d = plainObject(raw.date) ? raw.date : {};
  const from = ["column", "link", "row", "none"].includes(d.from) ? d.from : "none";
  const date = { from };
  if (from === "column") {
    date.column = Number.isInteger(d.column) && d.column >= 0 && d.column < 50 ? d.column : 0;
    date.header = typeof d.header === "string" && !/\d/.test(d.header) ? d.header.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  }
  const method = ["fetch", "click", "newtab"].includes(raw.method) ? raw.method : "click";
  return {
    v: 1,
    id,
    name,
    origin,
    listUrl: origin + listUrl.pathname,
    ...(listPath ? { listPath } : {}),
    ...(listOpen ? {} : { listOpen: false }),
    match: [`${origin}/*`],
    row: { tag: String(row.tag), classes: row.classes.map(String) },
    path: raw.path.map(([t, n]) => [String(t), n]),
    href: raw.href,
    text,
    date,
    method,
    firstSync: raw.firstSync === "new" ? "new" : "all",
    created: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.created || "")) ? raw.created : today,
  };
}

// Adds a site's pattern to the stored list, or puts it in place of the one
// already there for the same origin (Pick Again). Its id is kept then, so its
// record of what was saved stays its own; a new site gets an id no other
// site has. Answers the new list and the site as kept.
export function withSite(stored, config) {
  const list = addedSites(stored);
  const before = list.find((c) => c.origin === config.origin);
  const taken = new Set([...PROVIDERS.map((p) => p.id), ...list.filter((c) => c !== before).map((c) => c.id)]);
  let id = before ? before.id : config.id;
  for (let n = 2; taken.has(id); n += 1) id = `${config.id.slice(0, 40)}-${n}`;
  const site = { ...config, id, created: before ? before.created : config.created };
  return { list: before ? list.map((c) => (c === before ? site : c)) : [...list, site], site };
}

// Share This Site, a later piece, would send a site's pattern to the project
// as an issue for a built-in recipe. What is stored is already only
// structure, so it would send cleanConfig's fields as they are.
