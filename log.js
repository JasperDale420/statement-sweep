// Run logs: what each site did in a sweep and why it stopped, as plain text a
// person can read from disk afterwards, without opening the popup or a tab.
// As PaperPull keeps them: each site's own Logs folder, beside its documents,
// holds one file per run,
//
//   <chosen folder>/<main folder>/<site folder>/Logs/run-YYYYMMDD-HHMMSS.log
//
// and the main folder's Logs folder holds a one-line-per-site summary of the
// same run, under the same name. The site folder is the one the site's PDFs
// are saved in, by the naming settings, without the parts a document's own
// date or title fills in. A line reads
//
//   2026-10-12 16:43:32.244 INFO   chase: Chase: 1 card(s) x 8 year(s)
//
// With no folder chosen, or no permission to write in it, the last
// STORED_LINES lines of each site are kept in chrome.storage.local instead,
// under log:<site id> (and log:runs for the summaries), for Settings' Export
// Logs. Nothing here is ever sent anywhere.
//
// What a line may hold: the engine's and the recipe's own short words, page
// addresses without their query or fragment (a hash route keeps its path),
// and numbers. Every run of 5 or more digits keeps only its last 4, so an
// account or parcel number becomes #####1234. Never page text, cookies or a
// document's contents.
import { getFolder, isGranted, withinChosen, writeFile } from "./folders.js";
import { normalise, pathFor } from "./naming.js";

export const LOGS = "Logs";
export const KEEP_RUNS = 30;
export const STORED_LINES = 2000;
export const FLUSH_MS = 5000;
export const SUMMARY_KEY = "log:runs";
export const STORED_PREFIX = "log:";
// A run's file, or the copy writeFile would make beside one ("run-… (1).log").
export const RUN_FILE = /^run-\d{8}-\d{6}(?: \(\d+\))?\.log$/;
// One site's lines in a run, after which only a last line saying so is added.
const MAX_LINES = 20000;
// One entry, a stack included.
const MAX_TEXT = 4000;

const pad = (n, width = 2) => String(n).padStart(width, "0");
export const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
export const fileStamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
export const runFileName = (d) => `run-${fileStamp(d)}.log`;

// A run of 5 or more digits keeps its last 4.
export const maskDigits = (text) => String(text).replace(/\d{5,}/g, (run) => "#".repeat(run.length - 4) + run.slice(-4));

// An address without its query or fragment, and without any user name or
// password in it. A hash route (#/… or #!/…) keeps its path, without a query
// of its own. Digits are masked as everywhere else.
export function cleanUrl(address) {
  const text = String(address || "").replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, "$1");
  const cut = text.search(/[?#]/);
  const base = cut < 0 ? text : text.slice(0, cut);
  const hashAt = text.indexOf("#");
  const hash = hashAt < 0 ? "" : text.slice(hashAt);
  const route = /^#!?\//.test(hash) ? hash.split("?")[0] : "";
  return maskDigits(base + route);
}

// Text as it may go in a log: addresses cleaned, digits masked, not too long.
export function cleanText(text) {
  const plain = String(text === undefined ? "" : text)
    .replace(/\b(?:https?|blob|file|chrome-extension):[^\s"'<>()]+/gi, (u) => cleanUrl(u))
    .replace(/\r\n?/g, "\n");
  const masked = maskDigits(plain);
  return masked.length > MAX_TEXT ? `${masked.slice(0, MAX_TEXT)}… (cut)` : masked;
}

// An error's message and where it was thrown: its stack, without the first
// line when that only repeats the message.
export function errorText(error) {
  if (!error) return "unknown error";
  const message = error.message !== undefined ? String(error.message) : String(error);
  const stack = typeof error.stack === "string" ? error.stack.split("\n") : [];
  const frames = stack.filter((line) => /^\s+at /.test(line)).map((line) => line.trim());
  return [message, ...frames].join("\n");
}

export const LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"];

// One entry. A text of several lines (a stack) continues indented.
export function formatLine(date, level, site, text) {
  const [first, ...rest] = cleanText(text).split("\n");
  return [`${stamp(date)} ${String(level).padEnd(5)}  ${site}: ${first}`, ...rest.map((line) => `    ${line}`)].join("\n");
}

// A size or a time with thousands marks, so it is never taken for a long
// number and masked.
export const amount = (n) => Number(n || 0).toLocaleString("en-US");

const NOBODY = { id: "", name: "", fileName: "x.pdf" };
const EMPTY_DOC = { id: "", date: "", title: "" };
const dirOf = (path) => path.split("/").slice(0, -1).join("/");

// The main folder, and the site's folder, inside the chosen one, as the
// naming settings put its PDFs there.
export function mainFolder(naming, chosenName) {
  const plain = { ...normalise(naming), folder: "", providers: {} };
  return dirOf(withinChosen(chosenName, pathFor(plain, NOBODY, EMPTY_DOC)));
}
export function siteFolder(naming, provider, chosenName) {
  const main = mainFolder(naming, chosenName);
  let dir = dirOf(withinChosen(chosenName, pathFor(naming, provider, EMPTY_DOC)));
  // A folder pattern that names nothing for the site would put its log
  // beside the summary, under the same name; it gets a folder of its own.
  if (dir === main) dir = [main, provider.name.replace(/[^A-Za-z0-9 ]/g, "").trim() || provider.id].filter(Boolean).join("/");
  return dir;
}
export const logPath = (folder, started) => [folder, LOGS, runFileName(started)].filter(Boolean).join("/");

// Deletes the oldest run logs past `keep`, only in a folder named Logs, and
// only files named as a run's log.
export async function prune(root, folder, keep = KEEP_RUNS) {
  const parts = [...folder.split("/").filter(Boolean), LOGS];
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part);
  if (dir.name !== LOGS) return [];
  const names = [];
  for await (const [name, handle] of dir.entries()) if (handle.kind === "file" && RUN_FILE.test(name)) names.push(name);
  names.sort();
  const old = names.slice(0, Math.max(0, names.length - keep));
  for (const name of old) await dir.removeEntry(name).catch(() => {});
  return old;
}

// Everything kept in storage, as one text for Export Logs.
export function storedText(stored, nameOf = (id) => id) {
  const keys = Object.keys(stored || {}).filter((k) => k.startsWith(STORED_PREFIX) && Array.isArray(stored[k])).sort((a, b) => {
    if (a === SUMMARY_KEY) return -1;
    if (b === SUMMARY_KEY) return 1;
    return a.localeCompare(b);
  });
  return keys.map((k) => {
    const id = k.slice(STORED_PREFIX.length);
    const head = k === SUMMARY_KEY ? "Runs" : `${nameOf(id)} (${id})`;
    return [`===== ${head} =====`, ...stored[k]].join("\n");
  }).join("\n\n") + (keys.length ? "\n" : "");
}

// The engine's logs. One run at a time, as the engine runs. `deps` are for tests.
export function makeLogs({
  destination = () => getFolder("destination"),
  granted = isGranted,
  write = writeFile,
  local = () => chrome.storage.local,
  naming = async () => (await chrome.storage.local.get("naming")).naming,
  now = () => new Date(),
  flushMs = FLUSH_MS,
  keep = KEEP_RUNS,
} = {}) {
  let run = null;

  // The chosen folder when it can be written now, or null.
  async function writable() {
    const dest = await Promise.resolve().then(destination).catch(() => null);
    if (!dest) return null;
    return (await Promise.resolve(granted(dest)).catch(() => false)) ? dest : null;
  }

  function begin() {
    run = { started: now(), sites: new Map(), lines: [], summaryChain: Promise.resolve(), pruned: false, timer: null };
    return run;
  }

  function recordOf(provider) {
    if (!run) return null;
    let rec = run.sites.get(provider.id);
    if (!rec) {
      rec = {
        provider, lines: [], stored: 0, chain: Promise.resolve(), timer: null, pruned: false, full: false,
        state: "", text: "", saved: 0, failed: 0, started: null, ended: null,
      };
      run.sites.set(provider.id, rec);
    }
    return rec;
  }

  function push(rec, level, text) {
    if (rec.full) return;
    if (rec.lines.length >= MAX_LINES) {
      rec.full = true;
      rec.lines.push(formatLine(now(), "WARN", rec.provider.id, `This run's log is full at ${amount(MAX_LINES)} lines; nothing more is kept.`));
      return;
    }
    rec.lines.push(formatLine(now(), LEVELS.includes(level) ? level : "INFO", rec.provider.id, text));
  }

  function soon(rec) {
    if (rec.timer || !flushMs) return;
    rec.timer = setTimeout(() => {
      rec.timer = null;
      flushSite(rec).catch(() => {});
      flushSummary().catch(() => {});
    }, flushMs);
  }

  function line(provider, level, text) {
    const rec = provider && recordOf(provider);
    if (!rec) return;
    push(rec, level, text);
    soon(rec);
  }

  function error(provider, where, e) {
    line(provider, "ERROR", `${where}: ${errorText(e)}`);
  }

  // A line for the run as a whole, in the summary.
  function runLine(text, level = "INFO") {
    if (!run) return;
    run.lines.push(formatLine(now(), level, "run", text));
  }

  function state(provider, newState, text) {
    const rec = provider && recordOf(provider);
    if (!rec) return;
    rec.state = newState;
    rec.text = text;
    push(rec, newState === "bad" ? "WARN" : "INFO", `board: ${newState}: ${text}`);
    soon(rec);
  }

  function started(provider) {
    const rec = recordOf(provider);
    if (rec && !rec.started) rec.started = now();
  }

  function counted(provider, outcome) {
    const rec = recordOf(provider);
    if (!rec) return;
    if (outcome === "saved") rec.saved += 1;
    else rec.failed += 1;
  }

  async function store(key, lines) {
    if (!lines.length) return;
    const kept = (await local().get(key))[key] || [];
    await local().set({ [key]: [...kept, ...lines].slice(-STORED_LINES) });
  }

  // The whole of a site's log so far, over the last copy; or, without a
  // folder, its lines not stored yet.
  function flushSite(rec) {
    const r = run;
    const next = rec.chain.then(async () => {
      if (!r) return;
      const lines = rec.lines.slice();
      const dest = await writable();
      if (dest) {
        try {
          const folder = siteFolder(await naming(), rec.provider, dest.name);
          await write(dest, logPath(folder, r.started), new Blob([`${lines.join("\n")}\n`], { type: "text/plain" }), { replace: true });
          if (!rec.pruned) {
            rec.pruned = true;
            await prune(dest, folder, keep).catch(() => {});
          }
          return;
        } catch (e) { /* kept in storage below */ }
      }
      await store(`${STORED_PREFIX}${rec.provider.id}`, lines.slice(rec.stored));
      rec.stored = lines.length;
    });
    rec.chain = next.catch(() => {});
    return next;
  }

  const seconds = (rec) => (rec.started ? Math.max(0, ((rec.ended || now()) - rec.started) / 1000) : 0).toFixed(1);

  function summaryLines(r, done) {
    const lines = [...r.lines];
    for (const rec of r.sites.values()) {
      const state = rec.ended ? rec.state || "unknown" : `${rec.state || "waiting"} (still going)`;
      lines.push(formatLine(rec.ended || now(), rec.state === "bad" ? "WARN" : "INFO", rec.provider.id,
        `${state}, ${rec.saved} saved, ${rec.failed} failed, ${seconds(rec)}s, board: ${rec.text || "-"}`));
    }
    if (done) lines.push(formatLine(now(), "INFO", "run", `Run ended after ${((now() - r.started) / 1000).toFixed(1)}s.`));
    return lines;
  }

  // The summary goes over its last copy each time. Without a folder it is
  // stored once, when the run is done.
  function flushSummary(done = false) {
    const r = run;
    if (!r) return Promise.resolve();
    const next = r.summaryChain.then(async () => {
      const lines = summaryLines(r, done);
      const dest = await writable();
      if (dest) {
        try {
          const folder = mainFolder(await naming(), dest.name);
          await write(dest, logPath(folder, r.started), new Blob([`${lines.join("\n")}\n`], { type: "text/plain" }), { replace: true });
          if (!r.pruned) {
            r.pruned = true;
            await prune(dest, folder, keep).catch(() => {});
          }
          return;
        } catch (e) { /* stored below */ }
      }
      if (done) await store(SUMMARY_KEY, lines);
    });
    r.summaryChain = next.catch(() => {});
    return next;
  }

  // A site is done: its log is written now.
  async function ended(provider) {
    const rec = recordOf(provider);
    if (!rec) return;
    rec.ended = now();
    push(rec, "INFO", `Done in ${seconds(rec)}s: ${rec.state || "unknown"}, ${rec.saved} saved, ${rec.failed} failed.`);
    clearTimeout(rec.timer);
    rec.timer = null;
    await flushSite(rec).catch(() => {});
    await flushSummary().catch(() => {});
  }

  // The run is done: every site's log, and the summary, written now.
  async function finish() {
    const r = run;
    if (!r) return;
    for (const rec of r.sites.values()) {
      clearTimeout(rec.timer);
      rec.timer = null;
      if (!rec.ended) rec.ended = now();
      await flushSite(rec).catch(() => {});
    }
    await flushSummary(true).catch(() => {});
    if (run === r) run = null;
  }

  return { begin, line, error, runLine, state, started, counted, ended, finish, current: () => run };
}
