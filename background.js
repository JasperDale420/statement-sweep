// Runs a sweep: for each provider, find or open its tab, wait for you if you
// are not signed in, read its list, and save what is new. Nothing leaves the
// browser except the requests the provider's own page would make.
import { PROVIDERS } from "./providers/index.js";

const SIGN_IN_WAIT_MS = 5 * 60 * 1000;
const MAX_VIEWS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const human = () => sleep(1500 + Math.random() * 1500);

let running = false;

// How long each step took, for finding what is slow. Steps and times only,
// never a document's name or anything from an account. Stays in the browser
// and is gone when it closes.
const timing = [];
async function timed(provider, step, work) {
  const started = performance.now();
  try {
    return await work();
  } finally {
    timing.push({ p: provider.id, s: step, ms: Math.round(performance.now() - started) });
    if (timing.length > 3000) timing.shift();
    chrome.storage.session.set({ timing }).catch(() => {});
  }
}

async function say(id, state, text) {
  const { board = {} } = await chrome.storage.session.get("board");
  board[id] = { state, text, at: Date.now() };
  await chrome.storage.session.set({ board });
  chrome.runtime.sendMessage({ type: "board" }).catch(() => {});
}

async function inPage(tabId, provider, func, args = []) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["providers/shared.js", provider.pageFile] });
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result;
}
const readList = (options) => globalThis.__sweep.readList(options);
const fetchPdf = (doc) => globalThis.__sweep.fetchPdf(doc);
const clickDoc = (doc) => globalThis.__sweep.clickDoc(doc);
const nextView = () => globalThis.__sweep.nextView();

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
function mayWalk(ours) {
  // TODO(human): decide whether a tab you already had open may be walked.
  return ours;
}

// Waits and looks again while you sign in. It never touches the sign-in itself.
async function listOnceSignedIn(tabId, provider, ours) {
  const until = Date.now() + SIGN_IN_WAIT_MS;
  let asked = false, sent = false, noList = 0, lastUrl = "", lastRead = 0;
  while (Date.now() < until) {
    const tab = await loaded(tabId);
    // A new address is looked at straight away. The same address, however
    // busy its frames are, at most every two seconds, since some recipes'
    // reads make a request to the provider.
    if (tab.url === lastUrl) await sleep(Math.max(0, lastRead + 2000 - Date.now()));
    lastUrl = tab.url;
    lastRead = Date.now();
    // A sign-in on a host of its own, where this extension has no access and
    // cannot read the page. The address it cannot read is the sign of it.
    if (!tab.url || !onHost(tab.url, provider)) {
      sent = false;
      if (!asked) {
        asked = true;
        await chrome.tabs.update(tabId, { active: true });
        await say(provider.id, "needs_you", `Sign in to ${provider.name} in its tab. This goes on by itself.`);
      }
      await tabChange(tabId, 2000);
      continue;
    }
    let list = null;
    try { list = await inPage(tabId, provider, readList, [{ walk: mayWalk(ours) }]); } catch (e) { /* the page is changing */ }
    if (list && (list.state === "ok" || list.state === "stopped")) return list;
    // Twice in a row, so a bank's redirect chain in the middle of a sign-in
    // is not interrupted by being sent to the list.
    noList = list && list.state === "no_list" ? noList + 1 : 0;
    if (noList >= 2 && !sent && ours) {
      sent = true;
      await chrome.tabs.update(tabId, { url: provider.listUrl });
    }
    if (list && (list.state === "signed_out" || list.state === "challenge")) {
      sent = false;
      if (!asked) {
        asked = true;
        await chrome.tabs.update(tabId, { active: true });
        await say(provider.id, "needs_you", list.state === "challenge"
          ? `${provider.name} is asking you to confirm something. Finish it in its tab.`
          : `Sign in to ${provider.name} in its tab. This goes on by itself.`);
      }
    }
    await tabChange(tabId, 2000);
  }
  return { state: "timed_out" };
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

const folder = (provider) => `Statement Sweep/${provider.name.replace(/[^A-Za-z0-9 ]/g, "")}`;
function fileFor(provider, doc) {
  const name = provider.fileName.replace("{date}", doc.date).replace("{title}", doc.title || "Document")
    .replace("{id}", doc.id).replace(/[/\\:*?"<>|]/g, "-");
  return `${folder(provider)}/${name}`;
}
const saveBase64 = async (base64, filename) => finished(await chrome.downloads.download({
  url: `data:application/pdf;base64,${base64}`, filename, conflictAction: "uniquify", saveAs: false,
}));

// The next download this provider's page starts, named as this document.
// A download from anywhere else, in another tab or from this extension
// itself, is left alone. Returns the wait, and a way to stop waiting, so a
// press that fails leaves nothing armed to catch the next document.
function nextDownload(provider, filename, nameMustMatch) {
  let settle, timer, id = null;
  const promise = new Promise((resolve) => { settle = resolve; });
  const ours = (item) => item.byExtensionId !== chrome.runtime.id
    && [item.referrer, item.finalUrl, item.url].some((u) => u && (onHost(u, provider) || (u.startsWith("blob:") && onHost(u.slice(5), provider))));
  const drop = () => {
    clearTimeout(timer);
    chrome.downloads.onDeterminingFilename.removeListener(naming);
  };
  const refuse = (why) => {
    if (id !== null) {
      chrome.downloads.cancel(id).catch(() => {});
      chrome.downloads.erase({ id }).catch(() => {});
    }
    drop();
    settle({ ok: false, why });
  };
  function naming(item, suggest) {
    if (!ours(item)) { suggest(); return; }
    id = item.id;
    const wrongName = nameMustMatch && !new RegExp(nameMustMatch).test(item.filename || "");
    // Only a PDF counts. A sign-in page saved under a statement's name
    // would otherwise be marked as saved and never fetched again.
    if ((item.mime || "").toLowerCase() !== "application/pdf" || wrongName) {
      suggest();
      refuse(wrongName ? "The site sent a different document." : "The site sent something that is not a PDF.");
      return;
    }
    suggest({ filename, conflictAction: "uniquify" });
    drop();
    finished(id).then((good) => settle({ ok: good }));
  }
  timer = setTimeout(() => refuse("The download did not start in time."), (provider.downloadWaitSeconds || 45) * 1000);
  chrome.downloads.onDeterminingFilename.addListener(naming);
  return { promise, cancel: () => { drop(); settle({ ok: false }); } };
}

async function saveOne(tabId, provider, doc) {
  const filename = fileFor(provider, doc);
  if (doc.method === "fetch") {
    const pdf = await inPage(tabId, provider, fetchPdf, [doc]);
    if (!pdf || !pdf.ok) return { ok: false, why: (pdf && pdf.why) || "The site did not send it." };
    return { ok: await saveBase64(pdf.base64, filename) };
  }
  if (doc.method === "click") {
    const landing = nextDownload(provider, filename, doc.nameMustMatch);
    let pressed;
    try { pressed = await inPage(tabId, provider, clickDoc, [doc]); } catch (e) { landing.cancel(); throw e; }
    if (!pressed || !pressed.ok) {
      landing.cancel();
      return { ok: false, why: (pressed && pressed.why) || "Its download control was not there." };
    }
    return landing.promise;
  }
  return { ok: false, why: "This document has no way to be saved yet." };
}

// A tab of yours is used only if it is already showing the list, and is
// never sent anywhere: it may hold something you are in the middle of.
async function tabToUse(provider) {
  for (const tab of await chrome.tabs.query({ url: provider.match, discarded: false })) {
    try {
      const list = await inPage(tab.id, provider, readList);
      if (list && (list.state === "ok" || list.state === "stopped")) return { tab, ours: false };
    } catch (e) { /* not a page this can read */ }
  }
  return { tab: await chrome.tabs.create({ url: provider.listUrl, active: false }), ours: true };
}

async function sweep(provider) {
  const key = `seen:${provider.id}`;
  const seen = new Set((await chrome.storage.local.get(key))[key] || []);
  const { tab, ours } = await tabToUse(provider);
  const closeOurs = () => (ours ? chrome.tabs.remove(tab.id).catch(() => {}) : null);
  await say(provider.id, "working", "Looking…");

  let count = 0;
  const notes = [];
  // One pass per view of the provider's documents: an account, or a year of
  // one. A recipe with more to show says `more`, and nextView moves it on.
  for (let views = 0; ; views += 1) {
    if (views > MAX_VIEWS) return say(provider.id, "bad", `${count} saved, then it stopped. There were more views than expected.`);
    const list = await timed(provider, "list", () => listOnceSignedIn(tab.id, provider, ours));
    if (list.state === "timed_out") {
      await closeOurs();
      return say(provider.id, "bad", `${count ? `${count} saved. ` : ""}Stopped waiting for you to sign in.`);
    }

    const fresh = (list.docs || []).filter((d) => !seen.has(d.id));
    // Chrome holds a page's second download for a prompt if you have not pressed
    // anything in that tab, and tells nobody. Allowed only while a sweep runs.
    if (fresh.some((d) => d.method === "click")) {
      await Promise.all(provider.match.map((primaryPattern) => chrome.contentSettings.automaticDownloads.set({ primaryPattern, setting: "allow" })));
    }
    for (const [i, doc] of fresh.entries()) {
      await say(provider.id, "working", `Saving ${i + 1} of ${fresh.length}…`);
      const result = await timed(provider, "save", () => saveOne(tab.id, provider, doc));
      if (!result.ok) return say(provider.id, "bad", `${count} saved, then it stopped. ${result.why || ""}`.trim());
      seen.add(doc.id);
      await chrome.storage.local.set({ [key]: [...seen] });
      count += 1;
      await timed(provider, "pause", human);
    }
    if (list.state === "stopped") return say(provider.id, "bad", `${count} saved. The page was not what this expected. ${list.why}`);
    if (list.note) notes.push(list.note);
    if (!list.more) break;

    await say(provider.id, "working", `${count} saved so far. Moving on…`);
    const next = await timed(provider, "next", () => inPage(tab.id, provider, nextView));
    if (!next || next.why) return say(provider.id, "bad", `${count} saved, then it stopped. ${(next && next.why) || ""}`.trim());
    if (next.note) notes.push(next.note);
    if (!next.moved) break;
  }
  await closeOurs();
  // A note is something worth knowing about a sweep that did all it could.
  return say(provider.id, "ok", [count ? `${count} new.` : "Nothing new.", ...new Set(notes)].join(" "));
}

// Chrome stops an idle background worker after about 30 seconds, and waiting
// for a download makes no calls, so a call every 20 seconds keeps a sweep alive.
// A new worker with a sweep still marked as working means the last one died.
(async () => {
  const { board = {} } = await chrome.storage.session.get("board");
  let stale = false;
  for (const v of Object.values(board)) if (v.state === "working" || v.state === "needs_you") { v.state = "bad"; v.text = "That sweep was interrupted. Run it again."; stale = true; }
  if (stale && !running) await chrome.storage.session.set({ board });
})();

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "sweep" || running) return;
  running = true;
  (async () => {
    const { off = [] } = await chrome.storage.local.get("off");
    const chosen = PROVIDERS.filter((p) => (message.only ? p.id === message.only : !off.includes(p.id)));
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
    try {
      for (const provider of chosen) {
        try { await sweep(provider); } catch (e) { await say(provider.id, "bad", `That did not finish. ${e.message}`); }
      }
    } finally {
      clearInterval(keepAlive);
      await chrome.contentSettings.automaticDownloads.clear({}).catch(() => {});
      running = false;
      chrome.runtime.sendMessage({ type: "board" }).catch(() => {});
    }
  })();
});
