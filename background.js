// Runs a sweep: for each provider, find or open its tab, wait for you if you
// are not signed in, read its list, and save what is new. Nothing leaves the
// browser except the requests the provider's own page would make.
import { PROVIDERS } from "./providers/index.js";
import { pathFor } from "./naming.js";
import { makeCapture } from "./capture.js";
import { INBOX, getFolder, isGranted, moveFromInbox, withinChosen, writeFile } from "./folders.js";
import { backfillFor, documentDate, isDue, isTaxDocument, keysFor, localIso, recordOf, siteStatus } from "./cadence.js";
import { amount, cleanUrl, errorText, makeLogs } from "./log.js";
import { OFFERS_WAIT, hasOffers, makeOffers, offersWanted, offersWords } from "./offers.js";
import { addFound, estimateNew, foundKey, foundOf, siteProgress } from "./progress.js";

// The run's logs (log.js): what each site did and why it stopped, written to
// each site's Logs folder as the run goes. `note` adds one line for a site.
const logs = makeLogs();
const note = (provider, text, level = "INFO") => logs.line(provider, level, text);
const providerOf = (id) => PROVIDERS.find((p) => p.id === id);
// Chrome's answer when a tab the sweep held is gone.
const tabGone = (e) => /No tab with id/i.test(String((e && e.message) || e));

const SIGN_IN_WAIT_MS = 5 * 60 * 1000;
// Get New Documents runs every site at once, and you sign in to them one by
// one, when you choose, so each site waits much longer for you.
const SIGN_IN_WAIT_TOGETHER_MS = 30 * 60 * 1000;
const MAX_VIEWS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const human = () => sleep(1500 + Math.random() * 1500);

// One run at a time, of one site or of all of them.
let running = false;
// When this run began, on each of its lines on the board, so the popup adds
// up only this run's sites; whether you pressed Stop; and how far each site
// has got (progress.js), for its bar.
let runAt = 0;
let stopAsked = false;
const progressFor = new Map();
const STOPPED = "You stopped the sync. The rest wait for next time.";
// The tab each site is sweeping in, so its line on the board can say which
// tab to show you.
const tabFor = new Map();

// Every read-modify-write of session storage (the board, the tabs this sweep
// opened) goes through one chain. Sites sweeping at the same time would
// otherwise each read the board, change their own line, and write it back
// over the lines the others changed in between.
let writes = Promise.resolve();
function serially(work) {
  const next = writes.then(work);
  writes = next.catch(() => {});
  return next;
}

// While a run goes, the toolbar button counts the sites waiting for you.
async function badge(board) {
  if (!running) return;
  const waiting = Object.values(board).filter((v) => v.state === "needs_you").length;
  await chrome.action.setBadgeBackgroundColor({ color: "#b34700" }).catch(() => {});
  await chrome.action.setBadgeText({ text: waiting ? String(waiting) : "" }).catch(() => {});
}
const clearBadge = () => chrome.action.setBadgeText({ text: "" }).catch(() => {});

// When no run goes, the toolbar button counts the ticked sites whose next
// document is late by their own history (cadence.js): due, overdue, or tax
// forms in season. Checked about once a day, at browser start, and after a
// run. Nothing is fetched for it; it reads only the dates already kept.
const DUE_CHECK = "due-check";
async function dueBadge() {
  if (running) return;
  const stored = await chrome.storage.local.get(["off", ...PROVIDERS.flatMap((p) => keysFor(p.id))]);
  const off = stored.off || [];
  // What the record's ids say about their dates is kept, once.
  const writes = Object.assign({}, ...PROVIDERS.map((p) => backfillFor(stored, p.id)));
  if (Object.keys(writes).length) await chrome.storage.local.set(writes);
  const today = localIso();
  const due = PROVIDERS.filter((p) => !off.includes(p.id) && isDue(siteStatus(recordOf(stored, p.id), today)));
  if (running) return;
  await chrome.action.setBadgeBackgroundColor({ color: "#0071e3" }).catch(() => {});
  await chrome.action.setBadgeText({ text: due.length ? String(due.length) : "" }).catch(() => {});
  await chrome.action.setTitle({ title: due.length ? `Statement Sweep · ${due.length === 1 ? `${due[0].name} is` : `${due.length} sites are`} due` : "Statement Sweep" }).catch(() => {});
}
const checkDue = () => serially(dueBadge).catch(() => {});
async function scheduleDueCheck() {
  if (!chrome.alarms) return;
  const alarm = await chrome.alarms.get(DUE_CHECK).catch(() => null);
  if (!alarm) await chrome.alarms.create(DUE_CHECK, { delayInMinutes: 1, periodInMinutes: 24 * 60 }).catch(() => {});
}
if (chrome.alarms) chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === DUE_CHECK) checkDue(); });
chrome.runtime.onStartup.addListener(() => { scheduleDueCheck(); checkDue(); });
chrome.runtime.onInstalled.addListener(() => { scheduleDueCheck(); checkDue(); });
scheduleDueCheck();

// Keeps each saved document's date (dates:<site>, {id: "YYYY-MM-DD"}), and
// which are tax forms (tax:<site>), joined with what is stored now, the way
// the seen record is. From the site's own list, or from the id.
// A document saved just now also gets the day it arrived (arrived:<site>),
// from which the site's usual posting delay is learned.
async function remember(provider, docs, fresh = false) {
  const [, dkey, tkey, , akey] = keysFor(provider.id);
  const kept = await chrome.storage.local.get([dkey, tkey, akey]);
  const dates = { ...(kept[dkey] || {}) };
  const tax = new Set(kept[tkey] || []);
  const arrived = { ...(kept[akey] || {}) };
  let changed = false;
  for (const doc of docs) {
    const when = documentDate(doc);
    if (when && dates[doc.id] !== when) { dates[doc.id] = when; changed = true; }
    if (isTaxDocument(doc) && !tax.has(doc.id)) { tax.add(doc.id); changed = true; }
    if (fresh && !arrived[doc.id]) { arrived[doc.id] = localIso(); changed = true; }
  }
  if (changed) await chrome.storage.local.set({ [dkey]: dates, [tkey]: [...tax], [akey]: arrived });
}

// How long each step took, for finding what is slow. Steps and times only,
// never a document's name or anything from an account. Stays in the browser
// and is gone when it closes.
const timing = [];
async function timed(provider, step, work) {
  const started = performance.now();
  try {
    return await work();
  } finally {
    const ms = Math.round(performance.now() - started);
    note(provider, `took ${amount(ms)} ms: ${step}`, "DEBUG");
    timing.push({ p: provider.id, s: step, ms });
    if (timing.length > 3000) timing.shift();
    chrome.storage.session.set({ timing }).catch(() => {});
  }
}

// A line on the board carries its site's tab while that tab is open, for the
// popup's Show button. Written in the order said, through the one chain.
// `offers`, {kind, text}, is the card offers' own line under it: adding,
// capped, stopped, waiting or done. It never changes the site's state, and
// is not logged here, since it can name a card.
async function say(id, state, text, offers) {
  logs.state(providerOf(id), state, text);
  const tabId = tabFor.get(id);
  await serially(async () => {
    const tab = tabId === undefined ? null : await chrome.tabs.get(tabId).catch(() => null);
    const { board = {} } = await chrome.storage.session.get("board");
    const progress = progressFor.get(id);
    board[id] = { state, text, at: Date.now(), run: runAt, ...(tab ? { tab: tab.id } : {}), ...(offers ? { offers } : {}), ...(progress ? { progress } : {}) };
    await chrome.storage.session.set({ board });
    await badge(board);
  });
  chrome.runtime.sendMessage({ type: "board" }).catch(() => {});
}

// A recipe's own lines for the log (shared.js __sweepLog) come back on its
// answer as `log`, and are written to the site's log here.
async function inPage(tabId, provider, func, args = []) {
  let result;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["providers/shared.js", provider.pageFile] });
    [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  } catch (e) {
    logs.error(provider, `inPage ${func.name || "script"} in tab ${tabId}`, e);
    throw e;
  }
  if (result && Array.isArray(result.log)) for (const text of result.log) note(provider, `page: ${text}`);
  return result;
}
// Run inside the page, so they name only globals. __sweepCarry (shared.js)
// adds the recipe's lines to the answer.
const readList = async (options) => { const r = await globalThis.__sweep.readList(options); return globalThis.__sweepCarry ? globalThis.__sweepCarry(r) : r; };
const fetchPdf = (doc) => globalThis.__sweep.fetchPdf(doc);
const clickDoc = async (doc) => { const r = await globalThis.__sweep.clickDoc(doc); return globalThis.__sweepCarry ? globalThis.__sweepCarry(r) : r; };
const nextView = async () => { const r = await globalThis.__sweep.nextView(); return globalThis.__sweepCarry ? globalThis.__sweepCarry(r) : r; };

// Resolves when the tab next changes, or after `ms`, whichever is first, so
// a page that has moved on is looked at straight away.
function tabChange(tabId, ms) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(changed);
      resolve();
    };
    const changed = (id, info) => { if (id === tabId && (info.status || info.url)) finish(); };
    const timer = setTimeout(finish, ms);
    chrome.tabs.onUpdated.addListener(changed);
  });
}

async function loaded(tabId) {
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await tabChange(tabId, 1000);
  }
  throw new Error("The page did not finish loading.");
}

function onHost(url, provider) {
  let host;
  try { host = new URL(url).hostname; } catch (e) { return false; }
  return provider.match.some((m) => {
    const wanted = new URL(m.replace("*.", "x.").replace(/\*$/, "")).hostname.replace(/^x\./, "");
    return m.includes("*.") ? host === wanted || host.endsWith("." + wanted) : host === wanted;
  });
}

// Whether a recipe may press the site's own links in this tab to reach the
// documents. `ours` is true for a tab this sweep opened, false for one of yours.
const mayWalk = (ours) => ours;

// The guide card (guide.js): while a site waits for you, a card in its tab
// says what to do, from the site's own `guide` steps or these. Its Check now
// cuts the wait's pause short, and its Skip this site ends the wait. Each
// waiting site is kept here, with the one tab its card may speak from.
const GUIDE_SIGN_IN = "Sign in here. Statement Sweep starts by itself once you're in.";
const GUIDE_CHALLENGE = "Finish the check the site is asking for. Statement Sweep goes on by itself.";
const waits = new Map();
function guideSteps(provider, kind, why) {
  const own = provider.guide || {};
  const steps = kind === "challenge" ? own.challenge : kind === "waiting" ? own.waiting : own.signIn;
  if (Array.isArray(steps) && steps.length) return steps.slice(0, 3);
  return [kind === "challenge" ? GUIDE_CHALLENGE : kind === "waiting" ? why || GUIDE_SIGN_IN : GUIDE_SIGN_IN];
}
// The site's favicon as a data address, from the extension's own _favicon
// page, so the card needs no file the site's pages could load. Null without one.
const icons = new Map();
async function iconOf(provider) {
  if (icons.has(provider.id)) return icons.get(provider.id);
  let icon = null;
  try {
    const url = new URL(chrome.runtime.getURL("/_favicon/"));
    url.search = new URLSearchParams({ pageUrl: provider.listUrl, size: "32" }).toString();
    const response = await fetch(url.href);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Chrome sends it as PNG, without saying so.
    const png = bytes.length > 8 && bytes[0] === 0x89 && String.fromCharCode(...bytes.subarray(1, 4)) === "PNG";
    const type = (response.headers.get("content-type") || (png ? "image/png" : "")).split(";")[0];
    if (response.ok && /^image\/[a-z+.-]+$/.test(type)) {
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      icon = `data:${type};base64,${btoa(binary)}`;
    }
  } catch (e) { /* no favicon permission yet, or none kept: the name alone */ }
  icons.set(provider.id, icon);
  return icon;
}
// Draws the card, or keeps the one there. It only adds its own element.
async function showGuide(w, provider, kind, why) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: w.tabId }, files: ["guide.js"] });
    const card = { site: provider.id, name: provider.name, icon: await iconOf(provider), steps: guideSteps(provider, kind, why) };
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId: w.tabId }, func: (o) => globalThis.__sweepGuide.show(o), args: [card] });
    w.card = true;
    w.unseen = false;
    if (result === "shown") note(provider, `Guide card shown in tab ${w.tabId} (${kind}).`);
  } catch (e) {
    // Off the site's hosts the extension may not draw in the tab at all.
    if (!w.unseen) note(provider, `Guide card not drawn in tab ${w.tabId}: ${errorText(e).split("\n")[0]}`, "DEBUG");
    w.unseen = true;
  }
}
async function hideGuide(w, provider, why) {
  if (!w.card) return;
  w.card = false;
  note(provider, `Guide card removed from tab ${w.tabId}: ${why}.`);
  await chrome.scripting.executeScript({ target: { tabId: w.tabId }, func: (site) => Boolean(globalThis.__sweepGuide && globalThis.__sweepGuide.hide(site)), args: [provider.id] })
    .catch(() => {});
}
// A pause in the wait, cut short by Check now or Skip this site.
const nap = (w, work) => (w.now || w.skipped ? Promise.resolve() : Promise.race([work, new Promise((resolve) => { w.wake = resolve; })]));

// The card's buttons. Only the extension's own card, in the very tab the
// site is waiting in, is heard: never the popup, another tab, or a page.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== "guide") return;
  const w = waits.get(message.site);
  const provider = providerOf(message.site);
  const fromCard = sender && sender.id === chrome.runtime.id && sender.tab && w && sender.tab.id === w.tabId && sender.frameId === 0;
  if (!fromCard || !provider || !["check", "skip"].includes(message.action)) {
    if (provider) note(provider, `A guide message (${String(message.action).slice(0, 20)}) was ignored: not from the card in the tab the site waits in.`, "WARN");
    return;
  }
  if (message.action === "check") {
    note(provider, "Check now pressed on the guide card: looking again.");
    w.now = true;
  } else {
    note(provider, "Skip this site pressed on the guide card: its wait ends for this run.");
    w.skipped = true;
  }
  w.wake();
});

// Waits and looks again while you sign in. It never touches the sign-in itself.
// A single site brings its tab forward for you. With every site at once
// (`together`), no tab takes the front from you: each waits in the background,
// says it needs you, and the popup's Show takes you to it when you choose.
async function listOnceSignedIn(tabId, provider, ours, together) {
  const until = Date.now() + (together ? SIGN_IN_WAIT_TOGETHER_MS : SIGN_IN_WAIT_MS);
  const forward = () => (together ? null : chrome.tabs.update(tabId, { active: true }));
  let asked = false, sent = false, noList = 0, lastUrl = "", lastRead = 0;
  // Each read is logged, and the same answer again only as a count.
  let lastSaid = "", same = 0;
  const heard = (text) => {
    if (text === lastSaid) { same += 1; return; }
    if (same) note(provider, `(the same ${same} more time${same === 1 ? "" : "s"})`);
    lastSaid = text;
    same = 0;
    note(provider, text);
  };
  note(provider, `Reading the list in tab ${tabId} (${ours ? "the sweep's own tab, may walk" : "your tab, never walked"}; waits ${Math.round((until - Date.now()) / 60000)} min for a sign-in).`);
  // This site's wait, for its guide card's buttons (see waits).
  const w = { tabId, now: false, skipped: false, card: false, unseen: false, wake: () => {} };
  waits.set(provider.id, w);
  let left = "the site stopped waiting";
  try {
    while (Date.now() < until) {
      if (w.skipped) {
        if (same) note(provider, `(the same ${same} more time${same === 1 ? "" : "s"})`);
        left = "the site was skipped";
        return { state: "skipped" };
      }
      const tab = await loaded(tabId);
      // A new address is looked at straight away. The same address, however
      // busy its frames are, at most every two seconds, since some recipes'
      // reads make a request to the provider. Check now looks at once.
      if (tab.url === lastUrl) await nap(w, sleep(Math.max(0, lastRead + 2000 - Date.now())));
      w.now = false;
      if (w.skipped) continue;
      // The card goes when the tab moves on, and comes back on the next look
      // if the site is still waiting.
      if (tab.url !== lastUrl) await hideGuide(w, provider, "the tab moved on");
      lastUrl = tab.url;
      lastRead = Date.now();
      // A sign-in on a host of its own, where this extension has no access and
      // cannot read the page. The address it cannot read is the sign of it.
      if (!tab.url || !onHost(tab.url, provider)) {
        heard(`Off the site's hosts, at ${cleanUrl(tab.url) || "no address"}: waiting for a sign-in there.`);
        sent = false;
        if (!asked) {
          asked = true;
          await forward();
          await say(provider.id, "needs_you", `Sign in to ${provider.name} in its tab. This goes on by itself.`);
        }
        await showGuide(w, provider, "signed_out");
        await nap(w, tabChange(tabId, 2000));
        continue;
      }
      let list = null;
      const walk = mayWalk(ours);
      try { list = await inPage(tabId, provider, readList, [{ walk }]); } catch (e) { /* the page is changing; inPage logged it */ }
      heard(list
        ? `readList: ${list.state}, ${(list.docs || []).length} doc(s)${list.more ? ", more" : ""}${list.why ? `, why: ${list.why}` : ""}${list.note ? `, note: ${list.note}` : ""}; walk ${walk}; at ${cleanUrl(tab.url)}`
        : `readList: no answer; walk ${walk}; at ${cleanUrl(tab.url)}`);
      if (list && (list.state === "ok" || list.state === "stopped")) {
        if (same) note(provider, `(the same ${same} more time${same === 1 ? "" : "s"})`);
        left = `the site answered ${list.state}`;
        return list;
      }
      // Twice in a row, so a bank's redirect chain in the middle of a sign-in
      // is not interrupted by being sent to the list.
      noList = list && list.state === "no_list" ? noList + 1 : 0;
      if (noList >= 2 && !sent && ours) {
        sent = true;
        note(provider, `No list twice in a row: sending the tab to ${cleanUrl(provider.listUrl)}.`);
        await chrome.tabs.update(tabId, { url: provider.listUrl });
      }
      // "waiting": the site needs one thing from the person that is not a
      // sign-in (Shelby County's parcel lookup), said in the recipe's words. The
      // tab is then left where the person takes it, never sent back to the list.
      if (list && (list.state === "signed_out" || list.state === "challenge" || list.state === "waiting")) {
        sent = list.state === "waiting";
        if (!asked) {
          asked = true;
          note(provider, `Waiting for you: ${list.state}${together ? ", in the background" : ", tab brought forward"}.`);
          await forward();
          await say(provider.id, "needs_you", list.state === "waiting" ? list.why
            : list.state === "challenge" ? `${provider.name} is asking you to confirm something. Finish it in its tab.`
            : `Sign in to ${provider.name} in its tab. This goes on by itself.`);
        }
        await showGuide(w, provider, list.state, list.why);
      } else if (list) {
        await hideGuide(w, provider, `the site answered ${list.state}`);
      }
      await nap(w, tabChange(tabId, 2000));
    }
    if (same) note(provider, `(the same ${same} more time${same === 1 ? "" : "s"})`);
    note(provider, "Stopped waiting for a sign-in: the wait ran out.", "WARN");
    left = "the wait ran out";
    return { state: "timed_out" };
  } finally {
    if (waits.get(provider.id) === w) waits.delete(provider.id);
    await hideGuide(w, provider, left);
  }
}

function finished(downloadId) {
  return new Promise((resolve) => {
    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state || delta.state.current === "in_progress") return;
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(delta.state.current === "complete");
    };
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

// The names of the downloads this extension starts itself, by their address,
// until Chrome has named them. While a click-method site waits, nameDownload
// listens to Chrome's naming, and Chrome then needs an answer for every
// download, this extension's own too: an empty one throws away the name given
// to chrome.downloads.download, and the document lands as download.pdf.
const ownNames = new Map();
async function saveBase64(base64, filename) {
  const url = `data:application/pdf;base64,${base64}`;
  ownNames.set(url, [...(ownNames.get(url) || []), filename]);
  const forget = () => {
    const left = (ownNames.get(url) || []).slice(1);
    if (left.length) ownNames.set(url, left); else ownNames.delete(url);
  };
  let id;
  try {
    id = await chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
  } catch (e) {
    forget();
    throw e;
  }
  // Named by now, or never asked about (nothing was listening).
  const done = await finished(id);
  if (ownNames.has(url) && (ownNames.get(url) || [])[0] === filename) forget();
  return done;
}

// The next download this provider's page starts, named as this document.
// A download from anywhere else, in another tab or from this extension
// itself, is left alone. Returns the wait, and a way to stop waiting, so a
// press that fails leaves nothing armed to catch the next document.
//
// Chrome gives each download's naming one answer per extension, shared by all
// of its listeners: the first to answer decides, and the rest are ignored. With
// two sites waiting at once, one site's "not mine" would decide the other's
// download. So the extension listens once while anything waits, and asks each
// waiting site in turn whether the download is its own.
const claims = new Set();
function nameDownload(item, suggest) {
  if (item.byExtensionId === chrome.runtime.id) {
    // One of this extension's own: it keeps the name it was started with.
    const names = ownNames.get(item.url);
    if (names && names.length) {
      const [filename, ...left] = names;
      if (left.length) ownNames.set(item.url, left); else ownNames.delete(item.url);
      suggest({ filename, conflictAction: "uniquify" });
      return;
    }
    suggest();
    return;
  }
  for (const claim of claims) if (claim(item, suggest)) return;
  suggest();
}
function arm(claim) {
  claims.add(claim);
  if (claims.size === 1) chrome.downloads.onDeterminingFilename.addListener(nameDownload);
}
function disarm(claim) {
  if (claims.delete(claim) && !claims.size) chrome.downloads.onDeterminingFilename.removeListener(nameDownload);
}

function nextDownload(provider, filename, nameMustMatch, onHeld) {
  let settle, timer, held, id = null;
  const promise = new Promise((resolve) => { settle = resolve; });
  // A download's address is chosen by whoever starts it, so one that says it
  // came from another site is not this provider's, whatever it points at.
  const onProvider = (u) => Boolean(u) && (onHost(u, provider) || (u.startsWith("blob:") && onHost(u.slice(5), provider)));
  const ours = (item) => item.byExtensionId !== chrome.runtime.id
    && (!item.referrer || onHost(item.referrer, provider))
    && [item.referrer, item.finalUrl, item.url].some(onProvider);
  const drop = () => {
    clearTimeout(timer);
    clearTimeout(held);
    if (onHeld) onHeld.stop();
    disarm(claim);
  };
  const refuse = (why) => {
    if (id !== null) {
      chrome.downloads.cancel(id).catch(() => {});
      chrome.downloads.erase({ id }).catch(() => {});
    }
    drop();
    settle({ ok: false, why });
  };
  // True when the download is this site's, and named here.
  function claim(item, suggest) {
    if (!ours(item)) return false;
    id = item.id;
    const wrongName = nameMustMatch && !new RegExp(nameMustMatch).test(item.filename || "");
    // Only a PDF counts. A sign-in page saved under a statement's name
    // would otherwise be marked as saved and never fetched again.
    // A file store (Alpaca's, on Amazon S3) may label a PDF only as a file of
    // bytes; that counts when its own name or address says .pdf.
    const mime = (item.mime || "").toLowerCase();
    const namedPdf = [item.filename, item.finalUrl, item.url].some((u) => /\.pdf$/i.test(String(u || "").split(/[?#]/)[0]));
    // A file the site's own page built (a blob: on its own host) and named .pdf
    // counts too, whatever type it carries: Apple Card's says text/plain. It
    // cannot be a sign-in page sent in place of a statement, and a save to your
    // folder checks its bytes start %PDF- (folders.js moveFromInbox).
    const ownBlob = /^blob:/i.test(item.finalUrl || item.url || "") && onHost(String(item.finalUrl || item.url).slice(5), provider);
    const isPdf = mime === "application/pdf"
      || (["application/octet-stream", "binary/octet-stream", ""].includes(mime) && namedPdf)
      || (ownBlob && namedPdf && ["text/plain", "application/x-download", "application/download"].includes(mime));
    note(provider, `Download ${item.id} is this site's: type ${mime || "none"}${namedPdf ? ", named .pdf" : ""}, from ${cleanUrl(item.finalUrl || item.url)}.`);
    if (!isPdf || wrongName) {
      note(provider, wrongName ? "The download's name did not match the document's, so it was refused." : "The download was not a PDF, so it was refused.", "WARN");
      suggest();
      refuse(wrongName ? "The site sent a different document." : "The site sent something that is not a PDF.");
      return true;
    }
    suggest({ filename, conflictAction: "uniquify" });
    drop();
    finished(id).then((good) => settle({ ok: good, id }));
    return true;
  }
  // A download Chrome may be holding for your answer waits as long as a sign-in.
  const wait = onHeld ? HELD_WAIT_MS : (provider.downloadWaitSeconds || 45) * 1000;
  timer = setTimeout(() => {
    note(provider, `No download started within ${amount(wait / 1000)} s.`, "WARN");
    refuse("The download did not start in time.");
  }, wait);
  if (onHeld) held = setTimeout(() => {
    note(provider, `The download is slow to start after ${amount(HELD_HINT_MS / 1000)} s: Chrome may be holding it behind its multiple-downloads prompt.`, "WARN");
    onHeld.start().catch(() => {});
  }, HELD_HINT_MS);
  arm(claim);
  return { promise, cancel: () => { drop(); settle({ ok: false }); } };
}

// Chrome lets a tab's first download through and holds the next ones behind
// a "download multiple files" prompt, unless you pressed something in the tab
// since. The extension asks Chrome to allow them during a sweep, but some
// versions prompt anyway, and the extension cannot see the prompt. So a later
// download that is slow to start brings its tab forward and says what to press.
const HELD_HINT_MS = 8000;
const FAILS_IN_A_ROW = 3;
const HELD_WAIT_MS = 5 * 60 * 1000;
const downloadsInTab = new Map();

// Sites sweeping at once can each stall on that prompt together. Only the
// first in line is brought forward, so two tabs never snatch the front from
// each other; the next comes forward when the first one's download starts or
// gives up. A hint is in line from when it fires until its wait ends.
const heldLine = [];

function heldHint(tabId, provider) {
  const host = new URL(provider.listUrl).hostname;
  const hint = {};
  hint.front = async () => {
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) await chrome.windows.update(tab.windowId, { drawAttention: true }).catch(() => {});
    // Its download may have started meanwhile; then the sweep has moved on.
    if (heldLine[0] === hint) await say(provider.id, "needs_you", `Chrome may be asking whether ${host} can download multiple files. If so, press Allow in its tab. This goes on by itself.`);
  };
  hint.start = async () => {
    heldLine.push(hint);
    note(provider, heldLine[0] === hint ? `Held-download hint: tab ${tabId} brought forward.` : `Held-download hint: waiting behind ${heldLine[0].name}.`);
    if (heldLine[0] === hint) return hint.front();
    return say(provider.id, "needs_you", `Chrome may be asking whether ${host} can download multiple files. Its tab comes forward after ${heldLine[0].name}'s. This goes on by itself.`);
  };
  hint.name = provider.name;
  hint.stop = () => {
    const at = heldLine.indexOf(hint);
    if (at < 0) return;
    heldLine.splice(at, 1);
    if (at === 0 && heldLine.length) heldLine[0].front().catch(() => {});
  };
  return hint;
}

async function fetchHere(address, provider) {
  let url;
  try { url = new URL(address); } catch (e) { return { ok: false, why: "Its link could not be read." }; }
  if (url.protocol !== "https:" || url.username || url.password || !onHost(url.href, provider)) {
    return { ok: false, why: "Its link is not on one of this site's own hosts." };
  }
  try {
    const response = await fetch(url.href, { credentials: "omit", redirect: "error" });
    if (!response.ok) return { ok: false, why: "The site's file host did not send it." };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") return { ok: false, why: "The site sent something that is not a PDF." };
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { ok: true, base64: btoa(binary) };
  } catch (e) {
    return { ok: false, why: "The site's file host could not be reached." };
  }
}

async function saveOne(tabId, provider, doc) {
  const { naming } = await chrome.storage.local.get("naming");
  const filename = pathFor(naming, provider, doc);
  const destination = await getFolder("destination");
  // A PDF in hand: fetched by the page, opened in a new tab, or printed (capture.js).
  if (doc.method === "fetch" || doc.method === "newtab" || doc.method === "print") {
    let pdf;
    if (doc.method === "newtab") pdf = await capture.newTab(tabId, provider, doc);
    else if (doc.method === "print") pdf = await capture.print(tabId, provider, doc);
    else {
      // A site whose PDF is made in the page needs a listener in the page's own
      // world (its meta's mainFile). Put there by Chrome, not by a <script>, so
      // the page's policy cannot refuse it. It only listens until armed.
      if (provider.mainFile) {
        await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: [provider.mainFile] })
          .catch((e) => note(provider, `The page-world listener could not be put in: ${errorText(e)}`, "WARN"));
      }
      pdf = await inPage(tabId, provider, fetchPdf, [doc]);
    }
    if (!pdf || !pdf.ok) return { ok: false, why: (pdf && pdf.why) || "The site did not send it.", ...(pdf && pdf.stop ? { stop: true } : {}) };
    // A recipe whose document is on a host the page may not read hands over
    // its link instead. It is fetched here only from one of the site's own hosts.
    if (pdf.fetchUrl) {
      note(provider, `The recipe handed over a link; fetching it here from ${cleanUrl(pdf.fetchUrl)}.`);
      pdf = await fetchHere(pdf.fetchUrl, provider);
    }
    if (!pdf.ok) return pdf;
    const size = Math.floor((pdf.base64.length * 3) / 4) - (pdf.base64.endsWith("==") ? 2 : pdf.base64.endsWith("=") ? 1 : 0);
    if (destination) {
      try {
        const bytes = Uint8Array.from(atob(pdf.base64), (c) => c.charCodeAt(0));
        await writeFile(destination, withinChosen(destination.name, filename), new Blob([bytes], { type: "application/pdf" }));
        return { ok: true, bytes: size };
      } catch (e) {
        logs.error(provider, "writing to the chosen folder", e);
        return { ok: await saveBase64(pdf.base64, filename), bytes: size, note: "Some documents were saved in Downloads because your chosen folder could not be written." };
      }
    }
    return { ok: await saveBase64(pdf.base64, filename), bytes: size };
  }
  if (doc.method === "click") {
    // A random name, so a move can only ever pick up this one download.
    const stageName = `${crypto.randomUUID()}.pdf`;
    const onHeld = downloadsInTab.get(tabId) ? heldHint(tabId, provider) : null;
    const landing = nextDownload(provider, destination ? `${INBOX}/${stageName}` : filename, doc.nameMustMatch, onHeld);
    let pressed;
    try { pressed = await inPage(tabId, provider, clickDoc, [doc]); } catch (e) { landing.cancel(); throw e; }
    if (!pressed || !pressed.ok) {
      landing.cancel();
      return { ok: false, why: (pressed && pressed.why) || "Its download control was not there." };
    }
    const landed = await landing.promise;
    if (landed.ok) {
      downloadsInTab.set(tabId, (downloadsInTab.get(tabId) || 0) + 1);
      const [item] = await chrome.downloads.search({ id: landed.id }).catch(() => []);
      if (item) landed.bytes = item.fileSize || item.totalBytes || item.bytesReceived || 0;
    }
    if (!destination || !landed.ok) return landed;
    // The original is removed only once the copy is confirmed whole.
    try {
      await moveFromInbox(await getFolder("inbox"), stageName, destination, withinChosen(destination.name, filename));
    } catch (e) {
      logs.error(provider, "moving a download from the inbox", e);
      return { ok: true, bytes: landed.bytes, note: `Some documents stayed in Downloads, in ${INBOX}, because they could not be moved to your chosen folder.` };
    }
    await chrome.downloads.removeFile(landed.id).catch(() => {});
    await chrome.downloads.erase({ id: landed.id }).catch(() => {});
    return landed;
  }
  return { ok: false, why: "This document has no way to be saved yet." };
}

// A tab of yours is used only if it is already showing the list, and is
// never sent anywhere: it may hold something you are in the middle of.
// The tabs a sweep opened, remembered until they close or Chrome quits. A
// site that stopped leaves its tab open, and the next run reuses it. That tab
// is still the sweep's own, so it may still be walked; a tab you opened never is.
async function ourTabs() {
  return new Set((await chrome.storage.session.get("ourTabs")).ourTabs || []);
}
// Which site each of those tabs was opened for (tabSite, {tab id: site id}).
const tabSites = async () => (await chrome.storage.session.get("tabSite")).tabSite || {};
// New tabs and printing (capture.js). A tab a press opened for a PDF is
// closed by it, and is never taken for a site's own tab.
const capture = makeCapture({
  inPage, loaded, tabChange, onHost,
  isOurs: async (tabId) => (await ourTabs()).has(tabId),
  log: note,
});
// Card offers (offers.js), after a site's statements, only where you turned
// them on in Settings.
const offers = makeOffers({ loaded, tabChange, onHost, log: (provider, text) => note(provider, `offers: ${text}`) });
// Through the one chain, since sites open their tabs at the same time.
const markOurs = (tabId, mine, site) => serially(async () => {
  const tabs = await ourTabs();
  const sites = await tabSites();
  if (mine) tabs.add(tabId); else tabs.delete(tabId);
  if (mine && site) sites[tabId] = site; else delete sites[tabId];
  await chrome.storage.session.set({ ourTabs: [...tabs], tabSite: sites });
});
// A tab that is gone is forgotten everywhere: the sweep's records of it, and capture's.
function forgetTab(tabId) {
  markOurs(tabId, false).catch(() => {});
  downloadsInTab.delete(tabId);
  capture.forget(tabId);
  for (const [id, t] of tabFor) if (t === tabId) tabFor.delete(id);
}
// Chrome swaps a tab for another on some redirects (a prerendered page), and
// the old tab id is gone. What the sweep kept for it moves to the new one.
const replaced = new Map();
if (chrome.tabs.onReplaced) chrome.tabs.onReplaced.addListener((added, removed) => {
  replaced.set(removed, added);
  for (const [id, t] of tabFor) {
    if (t !== removed) continue;
    tabFor.set(id, added);
    note(providerOf(id), `Chrome replaced tab ${removed} with tab ${added}.`);
  }
  if (downloadsInTab.has(removed)) downloadsInTab.set(added, downloadsInTab.get(removed));
  downloadsInTab.delete(removed);
  capture.replace(removed, added);
  serially(async () => {
    const tabs = await ourTabs();
    const sites = await tabSites();
    if (!tabs.has(removed)) return;
    tabs.delete(removed);
    tabs.add(added);
    if (sites[removed]) sites[added] = sites[removed];
    delete sites[removed];
    await chrome.storage.session.set({ ourTabs: [...tabs], tabSite: sites });
  }).catch(() => {});
});
// A closed tab is forgotten everywhere, and its site's line no longer offers to show it.
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [id, t] of tabFor) if (t === tabId) note(providerOf(id), `Tab ${tabId} was closed.`);
  forgetTab(tabId);
  serially(async () => {
    const { board } = await chrome.storage.session.get("board");
    const lines = Object.values(board || {}).filter((v) => v.tab === tabId);
    if (!lines.length) return;
    for (const v of lines) delete v.tab;
    await chrome.storage.session.set({ board });
    chrome.runtime.sendMessage({ type: "board" }).catch(() => {});
  }).catch(() => {});
});

// A tab showing this site's list, or one it is walking through, is used. A
// recipe also says "stopped" on a page it does not recognise, so a stopped tab
// is used only when a sweep opened it for this same site: Chase Business must
// never take over the tab the personal Chase recipe left open on the same host.
// A tab a sweep opened for another site is not even asked.
async function tabToUse(provider) {
  const opened = await ourTabs();
  const sites = await tabSites();
  for (const tab of await chrome.tabs.query({ url: provider.match, discarded: false })) {
    if (capture.isCaptureTab(tab.id)) { note(provider, `Tab ${tab.id} skipped: a tab a press opened for a PDF.`); continue; }
    const ours = opened.has(tab.id);
    const mine = ours && sites[tab.id] === provider.id;
    if (ours && sites[tab.id] && !mine) { note(provider, `Tab ${tab.id} skipped: the sweep opened it for ${sites[tab.id]}.`); continue; }
    try {
      const list = await inPage(tab.id, provider, readList, [{ walk: false }]);
      const whose = ours ? (mine ? "the sweep's own for this site" : "the sweep's own") : "yours";
      if (list && (list.state === "ok" || list.state === "walking" || (list.state === "stopped" && mine))) {
        note(provider, `Tab adopted: ${tab.id}, ${whose}, at ${cleanUrl(tab.url)}, since it answered ${list.state}.`);
        return { tab, ours };
      }
      // "ready": you are signed in in this tab, and the site cannot be opened
      // a second time without ending that sign-in (TreasuryDirect). The sweep
      // carries on in this tab, by the page's own links, as in one it opened.
      if (list && list.state === "ready") {
        note(provider, `Tab taken over: ${tab.id}, ${whose}, at ${cleanUrl(tab.url)}, since the site is signed in there and a second tab would end that.`);
        await markOurs(tab.id, true, provider.id);
        return { tab, ours: true };
      }
      note(provider, `Tab ${tab.id} (${whose}) not used: it answered ${list ? list.state : "nothing"} at ${cleanUrl(tab.url)}.`);
    } catch (e) { /* not a page this can read; inPage logged it */ }
  }
  const tab = await chrome.tabs.create({ url: provider.listUrl, active: false });
  note(provider, `Tab opened: ${tab.id}, at ${cleanUrl(provider.listUrl)}, since no open tab showed the list.`);
  await markOurs(tab.id, true, provider.id);
  return { tab, ours: true };
}

// Why these documents cannot go to your chosen folder right now, if so. Asked
// before saving, so nothing lands anywhere you did not expect.
async function folderProblem(docs) {
  const destination = await getFolder("destination");
  if (!destination) return "";
  const allow = "Allow access in Statement Sweep's Settings, then run it again.";
  if (!(await isGranted(destination))) return `Your chosen folder needs permission again. ${allow}`;
  if (docs.some((d) => d.method === "click")) {
    const inbox = await getFolder("inbox");
    if (!inbox || !(await isGranted(inbox))) return `This site saves through Downloads first. ${allow}`;
  }
  return "";
}

// `together` is true when every site runs at once (see listOnceSignedIn).
async function sweep(provider, together = false) {
  const key = `seen:${provider.id}`;
  const seen = new Set((await chrome.storage.local.get(key))[key] || []);
  // A record from before dates were kept gets the dates its ids hold.
  const backfill = backfillFor(await chrome.storage.local.get(keysFor(provider.id)), provider.id);
  if (Object.keys(backfill).length) await chrome.storage.local.set(backfill);
  tabFor.delete(provider.id);
  let { tab, ours } = await tabToUse(provider);
  tabFor.set(provider.id, tab.id);
  // The tab can go mid-run: you close it, or Chrome swaps it for another on
  // a redirect. A swapped tab is followed; a closed one is replaced by a new
  // tab at the list, once per site per run, which waits for a sign-in as before.
  let reopened = false;
  const tabExists = async () => Boolean(await chrome.tabs.get(tab.id).catch(() => null));
  async function recover(where, e) {
    note(provider, `The sweep's tab ${tab.id} is gone (${where})${e ? `: ${errorText(e)}` : "."}`, "WARN");
    const swapped = replaced.get(tab.id);
    const next = swapped === undefined ? null : await chrome.tabs.get(swapped).catch(() => null);
    if (next) {
      note(provider, `Following it to tab ${next.id}, which Chrome put in its place.`);
      if (ours) await markOurs(next.id, true, provider.id);
      tab = next;
      tabFor.set(provider.id, tab.id);
      return true;
    }
    forgetTab(tab.id);
    if (reopened) return false;
    reopened = true;
    tab = await chrome.tabs.create({ url: provider.listUrl, active: false });
    ours = true;
    await markOurs(tab.id, true, provider.id);
    tabFor.set(provider.id, tab.id);
    note(provider, `Tab opened: ${tab.id}, at ${cleanUrl(provider.listUrl)}, in place of the one that closed.`);
    await say(provider.id, "working", "Its tab closed, so it is looking again in a new one…");
    return true;
  }
  const tabClosed = () => `${count ? `${count} saved. ` : ""}${provider.name}'s tab closed during the sweep. Run it again.`;
  // A tab that is closed, or one of yours, which is left as it is, has nothing to show.
  const closeOurs = () => {
    tabFor.delete(provider.id);
    return ours ? chrome.tabs.remove(tab.id).catch(() => {}) : null;
  };

  let count = 0;
  let failed = 0;
  let inARow = 0;
  let lastWhy = "";
  const notes = [];
  // Its bar: an estimate from its past syncs until its lists are read.
  const fkey = foundKey(provider.id);
  const kept = await chrome.storage.local.get([fkey, ...keysFor(provider.id)]);
  const estimate = estimateNew(foundOf(kept, provider.id), siteStatus(recordOf(kept, provider.id), localIso()));
  let listed = 0;
  let more = true;
  const track = () => progressFor.set(provider.id, siteProgress({ done: count + failed, listed, more, estimate }));
  track();
  // Stop pressed: what is saved stays saved, and the sweep's own tab closes.
  const stopped = async () => {
    await closeOurs();
    return say(provider.id, "bad", `${count} saved. ${STOPPED}`);
  };
  await say(provider.id, "working", "Looking…");
  // One pass per view of the provider's documents: an account, or a year of
  // one. A recipe with more to show says `more`, and nextView moves it on.
  views: for (let views = 0; ; views += 1) {
    if (stopAsked) return stopped();
    if (views > MAX_VIEWS) return say(provider.id, "bad", `${count} saved, then it stopped. There were more views than expected.`);
    let list;
    try {
      list = await timed(provider, "list", () => listOnceSignedIn(tab.id, provider, ours, together));
    } catch (e) {
      if (!tabGone(e)) throw e;
      if (await recover("reading the list", e)) continue;
      return say(provider.id, "bad", tabClosed());
    }
    if (list.state === "timed_out") {
      await closeOurs();
      return say(provider.id, "bad", `${count ? `${count} saved. ` : ""}Stopped waiting for you to sign in.`);
    }
    if (list.state === "skipped" && stopAsked) return stopped();
    // Skip this site, on its guide card: the tab is left as it is.
    if (list.state === "skipped") {
      if (!ours) tabFor.delete(provider.id);
      return say(provider.id, "bad", `${count ? `${count} saved. ` : ""}Skipped.`);
    }

    const fresh = (list.docs || []).filter((d) => !seen.has(d.id));
    // What is done already, and what this list holds still to do. Counted
    // this way, a list read again after its tab was replaced is not counted twice.
    listed = count + failed + fresh.length;
    more = Boolean(list.more);
    track();
    // Documents saved before dates were kept get theirs from the list.
    await remember(provider, (list.docs || []).filter((d) => seen.has(d.id)));
    const problem = fresh.length ? await folderProblem(fresh) : "";
    note(provider, `View ${views + 1}: ${(list.docs || []).length} listed, ${fresh.length} not saved before.`);
    if (problem) return say(provider.id, "bad", `${count} saved. ${problem}`);
    // Chrome holds a page's second download for a prompt if you have not pressed
    // anything in that tab, and tells nobody. Some sites (Alpaca) open each
    // document in a new window, which Chrome blocks when no person pressed.
    // Both are allowed for this site only, and only while a sweep runs.
    // A press that opens its PDF in a new tab is allowed that tab the same way.
    if (fresh.some((d) => d.method === "click" || d.method === "newtab")) {
      note(provider, `Allowing automatic downloads and pop-ups for ${provider.match.join(", ")} during the sweep.`);
      await Promise.all(provider.match.flatMap((primaryPattern) => [
        chrome.contentSettings.automaticDownloads.set({ primaryPattern, setting: "allow" }),
        chrome.contentSettings.popups.set({ primaryPattern, setting: "allow" }),
      ]));
    }
    for (const [i, doc] of fresh.entries()) {
      if (stopAsked) return stopped();
      track();
      await say(provider.id, "working", `Saving ${i + 1} of ${fresh.length}…`);
      const result = await timed(provider, "save", () => saveOne(tab.id, provider, doc))
        .catch((e) => {
          logs.error(provider, `saving ${doc.id}`, e);
          return { ok: false, why: `It could not be saved. ${e.message}`, error: e };
        });
      note(provider, `Document ${doc.id} by ${doc.method}: ${result.ok ? "saved" : `not saved: ${result.why || "no reason given"}`}${result.bytes ? `, ${amount(result.bytes)} bytes` : ""}${result.stop ? ", stops the site" : ""}.`, result.ok ? "INFO" : "WARN");
      // The tab went while saving: the list is read again in its new tab.
      if (!result.ok && (result.error ? tabGone(result.error) : !(await tabExists()))) {
        if (await recover(`saving ${doc.id}`, result.error)) continue views;
        return say(provider.id, "bad", tabClosed());
      }
      // One statement that will not save is left for the next run, and the
      // rest are still saved. Several in a row means the site itself has
      // stopped answering, often a sign-out, so going on would only fail more.
      // You closed Chrome's debugging bar: the site stops, as you asked.
      if (!result.ok && result.stop) return say(provider.id, "bad", `${count} saved. ${result.why}`);
      if (!result.ok) {
        failed += 1;
        logs.counted(provider, "failed");
        inARow += 1;
        lastWhy = result.why || lastWhy;
        if (inARow >= FAILS_IN_A_ROW) return say(provider.id, "bad", `${count} saved, then it stopped after ${inARow} in a row would not save. ${lastWhy}`.trim());
        continue;
      }
      inARow = 0;
      seen.add(doc.id);
      // Joined with what is stored now, so a history imported during this
      // sweep is kept rather than written over by the list read at its start.
      for (const id of (await chrome.storage.local.get(key))[key] || []) seen.add(id);
      await chrome.storage.local.set({ [key]: [...seen] });
      await remember(provider, [doc], true);
      count += 1;
      logs.counted(provider, "saved");
      if (result.note) notes.push(result.note);
      await timed(provider, "pause", human);
    }
    if (list.state === "stopped") return say(provider.id, "bad", `${count} saved. The page was not what this expected. ${list.why}`);
    if (list.note) notes.push(list.note);
    if (!list.more) break;

    await say(provider.id, "working", `${count} saved so far. Moving on…`);
    let next;
    try {
      next = await timed(provider, "next", () => inPage(tab.id, provider, nextView));
    } catch (e) {
      if (!tabGone(e)) throw e;
      if (await recover("moving to the next view", e)) continue;
      return say(provider.id, "bad", tabClosed());
    }
    note(provider, `nextView: ${next ? `${next.moved ? "moved" : "did not move"}${next.why ? `, why: ${next.why}` : ""}${next.note ? `, note: ${next.note}` : ""}` : "no answer"}.`);
    if (!next || next.why) return say(provider.id, "bad", `${count} saved, then it stopped. ${(next && next.why) || ""}`.trim());
    if (next.note) notes.push(next.note);
    if (!next.moved) break;
  }
  // Every list is read: the bar is exact, and what this sync found is kept
  // for the next one's estimate.
  more = false;
  track();
  const pastFound = foundOf(await chrome.storage.local.get(fkey), provider.id);
  await chrome.storage.local.set({ [fkey]: addFound(pastFound, count + failed) });
  // Card offers, when you turned them on for this site, in the same tab and
  // sign-in, once every statement it found is saved: a statement that did
  // not save keeps the tab on its list for the next run. What the offers did
  // is only ever a line of its own; it never changes how the site stands.
  const done = [count ? `${count} new.` : "Nothing new.", ...new Set(notes)].join(" ");
  let offered;
  if (!stopAsked && hasOffers(provider) && (await offersWanted(provider))) {
    offered = failed ? { kind: "waiting", text: OFFERS_WAIT } : await offersPass(provider, tab.id, ours, done);
  }
  if (failed) {
    const other = count ? (failed === 1 ? " other" : " others") : "";
    const them = `${failed}${other} did not save and ${failed === 1 ? "is" : "are"}`;
    // A run that saved something is done, with a note; one that saved nothing stopped.
    const [state, head] = count ? ["ok", `${count} new.`] : ["bad", "0 saved."];
    // The sweep's own tab stays open on the documents that did not save.
    if (!ours) tabFor.delete(provider.id);
    return say(provider.id, state, [`${head} ${them} tried again next time. ${lastWhy}`.trim(), ...new Set(notes)].filter(Boolean).join(" "), offered);
  }
  await closeOurs();
  // Looked, and all there was is saved: the popup waits a few days before
  // asking for this site again, even if a new one is due by its schedule.
  await chrome.storage.local.set({ [`checked:${provider.id}`]: localIso() });
  // A note is something worth knowing about a sweep that did all it could.
  return say(provider.id, "ok", done, offered);
}

// The card offers pass, in a tab already signed in to the site: after a
// site's statements, or alone for Add Offers Now. `text` is the statements'
// line, which stays as it is while the offers line counts up. Answers the
// offers line to keep, {kind, text}.
async function offersPass(provider, tabId, ours, text) {
  const line = (words) => say(provider.id, "working", text, { kind: "adding", text: words });
  await line("Looking at card offers…");
  const sum = await timed(provider, "offers", () => offers.run(tabId, provider, { ours, progress: line })).catch((e) => {
    logs.error(provider, "adding card offers", e);
    return { added: 0, already: 0, why: tabGone(e) ? `${provider.name}'s tab closed.` : "That did not finish." };
  });
  note(provider, `Offers: ${sum.added || 0} added, ${sum.left || 0} left, ${sum.failed || 0} not added${sum.capped ? `, stopped at the cap with ${sum.waiting || 0} waiting` : ""}${sum.why ? `, stopped: ${sum.why}` : ""}.`);
  const { kind, text: words } = offersWords(sum);
  return { kind, text: words };
}

// Add Offers Now, from the Card Offers page: only the offers pass for one
// site, no statements. Its tab is found or opened, and a sign-in waited for,
// as a sweep's is; then the same engine, cap, pace and stops. The site's
// statements line is kept as the last sweep left it.
async function offersOnly(provider) {
  const { board = {} } = await chrome.storage.session.get("board");
  const was = board[provider.id] && ["ok", "bad"].includes(board[provider.id].state) ? board[provider.id] : null;
  const state = was ? was.state : "ok";
  const text = was ? was.text : "";
  try {
    return await offersOnlyIn(provider, state, text);
  } catch (e) {
    logs.error(provider, "adding card offers", e);
    return say(provider.id, state, text, { kind: "stopped", text: "Offers stopped: That did not finish." });
  }
}
async function offersOnlyIn(provider, state, text) {
  const stop = (why) => ({ kind: "stopped", text: `Offers stopped: ${why}` });
  tabFor.delete(provider.id);
  const { tab, ours } = await tabToUse(provider);
  tabFor.set(provider.id, tab.id);
  const closeOurs = () => {
    tabFor.delete(provider.id);
    return ours ? chrome.tabs.remove(tab.id).catch(() => {}) : null;
  };
  await say(provider.id, "working", text, { kind: "adding", text: "Opening card offers…" });
  let list;
  try {
    list = await timed(provider, "list", () => listOnceSignedIn(tab.id, provider, ours, false));
  } catch (e) {
    if (!tabGone(e)) throw e;
    forgetTab(tab.id);
    return say(provider.id, state, text, stop(`${provider.name}'s tab closed.`));
  }
  if (list.state === "timed_out") {
    await closeOurs();
    return say(provider.id, state, text, stop("Statement Sweep stopped waiting for you to sign in."));
  }
  if (list.state === "skipped") {
    if (!ours) tabFor.delete(provider.id);
    return say(provider.id, state, text, stop("Skipped."));
  }
  const offered = await offersPass(provider, tab.id, ours, text);
  await closeOurs();
  return say(provider.id, state, text, offered);
}

// Chrome stops an idle background worker after about 30 seconds, and waiting
// for a download makes no calls, so a call every 20 seconds keeps a sweep alive.
// A new worker with a sweep still marked as working means the last one died.
// A sweep that died leaves its download permission behind, so a worker that
// starts, and every browser start, removes it. A run removes it once, when
// every site in it is done: sites run at the same time, and clearing it after
// one would take it from the others mid-run.
const clearDownloadGrant = () => Promise.all([
  chrome.contentSettings.automaticDownloads.clear({}).catch(() => {}),
  chrome.contentSettings.popups.clear({}).catch(() => {}),
]);
clearDownloadGrant();
chrome.runtime.onStartup.addListener(clearDownloadGrant);
chrome.runtime.onInstalled.addListener(clearDownloadGrant);
// A new worker has no run going, so the badge counts what is due.
checkDue();

serially(async () => {
  const { board = {} } = await chrome.storage.session.get("board");
  let stale = false;
  for (const v of Object.values(board)) if (v.state === "working" || v.state === "needs_you") { v.state = "bad"; v.text = "That sweep was interrupted. Run it again."; stale = true; }
  if (stale && !running) await chrome.storage.session.set({ board });
}).catch(() => {});

// Sites that share a host take turns. A site's downloads are told apart from
// every other site's by host (nextDownload), and its tab is found by host
// (tabToUse), so two sites on one host at the same time could take each
// other's download or tab: Chase and Chase for Business are both on
// secure.chase.com. A site's hosts are those in its `match` list, where "*."
// covers every host under it. Sites that share a host, directly or through a
// third site, are one group. The groups run at the same time, and the sites in
// a group run one after another, in the list's order.
function hostsOf(provider) {
  return provider.match.map((m) => ({
    host: new URL(m.replace("*.", "x.").replace(/\*$/, "")).hostname.replace(/^x\./, ""),
    wild: m.includes("*."),
  }));
}
const covers = (a, b) => a.host === b.host || (a.wild && b.host.endsWith("." + a.host));
const shareAHost = (p, q) => hostsOf(p).some((a) => hostsOf(q).some((b) => covers(a, b) || covers(b, a)));

function sameHostGroups(providers) {
  const groups = [];
  for (const provider of providers) {
    const linked = groups.filter((g) => g.some((other) => shareAHost(provider, other)));
    const merged = [...linked.flat(), provider];
    for (const g of linked) groups.splice(groups.indexOf(g), 1);
    groups.push(merged.sort((a, b) => providers.indexOf(a) - providers.indexOf(b)));
  }
  return groups;
}

// The summary log says which sites a run took, and why the others were left:
// switched off, or not among those Get New Documents asked for, which are the
// ones whose history says a document may be waiting (popup.js targetsOf).
async function whyChosen(message, off) {
  const stored = await chrome.storage.local.get(PROVIDERS.flatMap((p) => keysFor(p.id)));
  const today = localIso();
  const asked = Array.isArray(message.sites) ? message.sites : null;
  logs.runLine(message.only ? `Run of one site: ${message.only}.` : asked ? `Get New Documents asked for ${asked.length} site(s): ${asked.join(", ") || "none"}.` : "Every ticked site.");
  for (const p of PROVIDERS) {
    if (message.only && p.id !== message.only) continue;
    const s = siteStatus(recordOf(stored, p.id), today);
    const standing = `${s.status}, ${s.documents} saved, newest ${s.newest || "none"}, ${s.cadence || "no cadence"}${s.expected ? `, next expected ${s.expected}` : ""}`;
    const chosen = message.only ? p.id === message.only : !off.includes(p.id) && (!asked || asked.includes(p.id));
    const why = chosen ? "chosen" : off.includes(p.id) ? "left out: switched off" : "left out: Get New Documents did not ask for it (up to date)";
    logs.runLine(`${p.id}: ${why} (${standing}).`);
  }
}

// Add Offers Now. Heard only from this extension's own pages, for a site
// whose offers you turned on, and only when no sync is going: one run at a
// time. The answer says whether it started, and if not, why.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "offersNow") return;
  const answer = (o) => { try { sendResponse(o); } catch (e) { /* the page closed */ } };
  const own = chrome.runtime.getURL ? chrome.runtime.getURL("") : "";
  // Only a page of this extension: a site's tab, where the recipes run, has
  // the site's address, and a message with no address is not trusted either.
  const elsewhere = !sender || sender.id !== chrome.runtime.id || !own || !String(sender.url || "").startsWith(own);
  const provider = providerOf(message.site);
  if (elsewhere || !provider || !hasOffers(provider)) {
    answer({ ok: false, why: "That can only be asked from Card Offers." });
    return;
  }
  if (running) {
    answer({ ok: false, why: "A sync is running. Add Offers Now works once it finishes." });
    return;
  }
  running = true;
  runAt = Date.now();
  stopAsked = false;
  progressFor.clear();
  (async () => {
    if (!(await offersWanted(provider))) {
      running = false;
      answer({ ok: false, why: `Card offers are off for ${provider.name}. Turn on Add When Syncing first.` });
      return;
    }
    answer({ ok: true });
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
    logs.begin();
    try {
      logs.runLine(`Card offers only: ${provider.id}.`);
      logs.started(provider);
      note(provider, `Add Offers Now for ${provider.name} begins: offers only, no statements.`);
      await offersOnly(provider);
      await logs.ended(provider);
    } catch (e) {
      logs.runLine(`The run failed: ${errorText(e)}`, "ERROR");
    } finally {
      clearInterval(keepAlive);
      await logs.finish();
      running = false;
      await serially(clearBadge).catch(() => {});
      await checkDue();
      chrome.runtime.sendMessage({ type: "board" }).catch(() => {});
    }
  })();
  // The answer may come after a storage read.
  return true;
});

// Stop, from the popup: no site starts or saves another document, every wait
// for a sign-in ends, and what was saved stays saved. Card offers already
// being added finish their own short, capped pass. Heard only from this
// extension's own pages, as Add Offers Now is.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== "stop") return;
  const own = chrome.runtime.getURL ? chrome.runtime.getURL("") : "";
  if (!sender || sender.id !== chrome.runtime.id || !own || !String(sender.url || "").startsWith(own)) return;
  if (!running || stopAsked) return;
  stopAsked = true;
  logs.runLine("Stop pressed: no site starts or saves another document.");
  for (const w of waits.values()) {
    w.skipped = true;
    w.wake();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "sweep" || running) return;
  running = true;
  runAt = Date.now();
  stopAsked = false;
  progressFor.clear();
  logs.begin();
  (async () => {
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
    try {
      const { off = [] } = await chrome.storage.local.get("off");
      await whyChosen(message, off).catch((e) => logs.runLine(`Could not say why each site was chosen: ${errorText(e)}`, "WARN"));
      // Get New Documents names the sites that need running (popup.js,
      // targetsOf); a ticked site that is up to date is not among them.
      const asked = Array.isArray(message.sites) ? message.sites : null;
      const chosen = PROVIDERS.filter((p) => (message.only ? p.id === message.only
        : !off.includes(p.id) && (!asked || asked.includes(p.id))));
      // Get New Documents starts every site at once, each in a tab of its own;
      // Run starts the one site, as before.
      const together = !message.only && chosen.length > 1;
      const groups = together ? sameHostGroups(chosen) : chosen.map((p) => [p]);
      for (const group of groups) {
        for (const [i, provider] of group.entries()) {
          if (i) await say(provider.id, "working", `Waiting for ${group[i - 1].name}, which uses the same site.`);
        }
      }
      const runGroup = async (group) => {
        for (const provider of group) {
          if (stopAsked) {
            await say(provider.id, "bad", `Not reached. ${STOPPED}`);
            continue;
          }
          logs.started(provider);
          note(provider, `Sweep of ${provider.name} begins${together ? ", with the other sites at once" : ""}.`);
          try {
            await sweep(provider, together);
          } catch (e) {
            logs.error(provider, "sweep", e);
            await say(provider.id, "bad", `That did not finish. ${e.message}`);
          }
          await logs.ended(provider);
        }
      };
      // Without `together` there is one group of one, so this is the old run.
      await Promise.all(groups.map(runGroup));
    } catch (e) {
      logs.runLine(`The run failed: ${errorText(e)}`, "ERROR");
    } finally {
      await clearDownloadGrant();
      clearInterval(keepAlive);
      await logs.finish();
      running = false;
      await serially(clearBadge).catch(() => {});
      await checkDue();
      chrome.runtime.sendMessage({ type: "board" }).catch(() => {});
    }
  })();
});
