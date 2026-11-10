// Two more ways a document can be saved, for sites that do not start a
// download and do not hand the page a PDF it can read itself. background.js
// makes one capture with makeCapture() and calls it from saveOne. Both answer
// as fetchPdf does, {ok: true, base64} or {ok: false, why}, and the PDF is
// then saved through the same naming path as a fetched one.
//
// THE CONTRACT A RECIPE KEEPS
//
// method "newtab": a press that opens the PDF in a new tab, or sends this
// tab to the PDF itself.
//   - clickDoc(doc) presses the document's own control, as for "click", and
//     answers {ok: true}, or {ok: false, why}.
//   - The engine is listening before the press. It takes the one tab this
//     tab opens (webNavigation's sourceTabId is the sweep's tab), or its own move
//     to an address on one of the provider's fileHosts.
//   - That address is then read as follows, and anything else is refused:
//       https on a host in the meta's `fileHosts` (exact hosts, no
//         wildcards): fetched here, in the background, without cookies;
//       https on a host in `match`: fetched by the sweep's tab, as the site's
//         own page would;
//       blob: of an origin in `match`: read by the sweep's tab, which made it.
//   - The bytes must start %PDF-. The new tab is closed. A tab sent to the
//     PDF is sent back to the address it was on before the press.
//   - Nothing opening within the meta's downloadWaitSeconds (45 if unset)
//     after clickDoc answers, or two tabs opening, is a failure like any other.
//
// method "print": a document that is a web page. Chrome prints it with
// Page.printToPDF through chrome.debugger, attached to the sweep's own tab
// (one it opened, never one of yours) only while that one page is printed.
//   - showDoc(doc) brings the document on screen in this tab: by pressing the
//     site's own control, or by location.assign(doc.url) to an address the
//     list read. It answers {ok: true}, or {ok: false, why}. It may be async,
//     and should wait for its own control to be drawn.
//   - printReady(doc) is asked after that, and again after each page load,
//     until it answers {ready: true}. {ready: false, why?} means not yet;
//     {ok: false, why} gives up. It must check that the page is that
//     document's, finished and whole; it may open the page's own folded
//     sections (an "Expand All"), and nothing else.
//   - leaveDoc(doc), if the recipe has one, is asked after the print, saved
//     or not, to take the tab back to the list by the site's own links. A
//     recipe without one is left on the document, for showDoc to move on from.
//   - If you press Cancel on Chrome's "started debugging this browser" bar,
//     the answer carries `stop: true`, and the sweep stops that site.
//   - A recipe may set `printLandscape: true` on a doc.
//
// Made with { inPage, loaded, tabChange, onHost, isOurs, log } from
// background.js, and `waits` (milliseconds) only in tests. `log(provider,
// text, level)` adds a line to the site's run log (log.js); it is given hosts
// only, never a whole address.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Called inside the provider's page (see inPage), so they name only globals.
const clickDoc = (doc) => globalThis.__sweep.clickDoc(doc);
const showDoc = (doc) => (globalThis.__sweep.showDoc ? globalThis.__sweep.showDoc(doc) : { ok: false, why: "This site has no way to show a document." });
const printReady = (doc) => (globalThis.__sweep.printReady ? globalThis.__sweep.printReady(doc) : { ok: false, why: "This site cannot say when a document is ready." });
const leaveDoc = (doc) => (globalThis.__sweep.leaveDoc ? globalThis.__sweep.leaveDoc(doc) : { ok: true, stayed: true });

// Read inside the sweep's own tab: a blob: the page made, or a PDF on the
// site's own host, with the page's own sign-in.
async function readInPage(address) {
  try {
    const response = await fetch(address, { credentials: "include", redirect: "error" });
    if (!response.ok) return { ok: false, why: "The site did not send it." };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") return { ok: false, why: "The site sent something that is not a PDF." };
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { ok: true, base64: btoa(binary) };
  } catch (e) {
    return { ok: false, why: "The document the site opened could not be read." };
  }
}

export const PRINT_OPTIONS = {
  printBackground: true,
  paperWidth: 8.5,
  paperHeight: 11,
  marginTop: 0.4,
  marginBottom: 0.4,
  marginLeft: 0.4,
  marginRight: 0.4,
  displayHeaderFooter: false,
  preferCSSPageSize: false,
};

// The exact host of an https address on the provider's fileHosts, or "".
export function fileHostOf(address, provider) {
  let url;
  try { url = new URL(address); } catch (e) { return ""; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return "";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return (provider.fileHosts || []).map((h) => String(h).toLowerCase()).includes(host) ? host : "";
}

// Fetched in the background, only from one of the provider's fileHosts.
export async function fetchFile(address, provider) {
  if (!fileHostOf(address, provider)) return { ok: false, why: "The site opened its document on a host this does not fetch from." };
  try {
    const response = await fetch(address, { credentials: "omit", redirect: "error" });
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

const hostOf = (address) => {
  try { return new URL(String(address).replace(/^blob:/, "")).hostname || "no host"; } catch (e) { return "no address yet"; }
};

export function makeCapture({ inPage, loaded, tabChange, onHost, isOurs, log = () => {}, waits = {} }) {
  const URL_WAIT_MS = waits.url ?? 20000;
  const READY_WAIT_MS = waits.ready ?? 60000;
  const SETTLE_MS = waits.settle ?? 500;
  // Tabs opened by a press, never a site's own tab (see tabToUse).
  const opened = new Set();

  const usable = (u) => Boolean(u) && (u.startsWith("https:") || u.startsWith("blob:") || u.startsWith("http:"));

  // Listens for what the press opens. Answers {tab, url}, {here: url} or {why}.
  //
  // Which tab opened a new one is told by webNavigation's sourceTabId. A
  // tab's openerTabId is not enough: for a tab opened from a background tab,
  // as the sweep's tabs are, Chrome names the tab in front as its opener.
  // openerTabId is used only where webNavigation is not available.
  function watchOpened(tabId, provider) {
    let settle, done = false, timer = null, urlTimer = null;
    const promise = new Promise((resolve) => { settle = resolve; });
    const born = new Map(); // new tab id -> its address, once usable
    const nav = chrome.webNavigation && chrome.webNavigation.onCreatedNavigationTarget;
    const finish = (answer) => {
      if (done) return;
      done = true;
      if (answer.why) log(provider, `New tab: ${answer.why}`, "WARN");
      else if (answer.here) log(provider, `The sweep's tab itself went to the document on ${hostOf(answer.here)}.`);
      else if (answer.tab !== undefined) log(provider, `New tab ${answer.tab} reached ${hostOf(answer.url)}.`);
      clearTimeout(timer);
      clearTimeout(urlTimer);
      chrome.tabs.onCreated.removeListener(created);
      chrome.tabs.onUpdated.removeListener(updated);
      if (nav) nav.removeListener(target);
      settle(answer);
    };
    // Where a site has file hosts, its new tab may pass through one of its own
    // pages first (State Farm's app shell, then its document server). Such a
    // tab is taken once it reaches a file host or a blob, and only when the
    // wait runs out does its last address on the site stand.
    const wantsFileHost = Boolean((provider.fileHosts || []).length);
    const arrived = (url) => Boolean(url) && (!wantsFileHost || Boolean(fileHostOf(url, provider)) || url.startsWith("blob:"));
    const look = () => {
      if (born.size > 1) return finish({ why: "The site opened more than one tab, so nothing was taken." });
      for (const [id, url] of born) if (arrived(url)) finish({ tab: id, url });
    };
    const lastChance = () => {
      for (const [id, url] of born) if (url) return finish({ tab: id, url });
      finish({ why: "The tab the site opened did not reach its document." });
    };
    function adopt(id, url) {
      if (done) return;
      if (!born.has(id)) log(provider, `New tab seen: ${id}, opened by tab ${tabId}, at ${usable(url) ? hostOf(url) : "no address yet"}.`);
      opened.add(id);
      if (!born.get(id)) born.set(id, usable(url) ? url : "");
      if (!urlTimer) urlTimer = setTimeout(lastChance, URL_WAIT_MS);
      look();
    }
    function created(tab) {
      if (!nav && tab.openerTabId === tabId) adopt(tab.id, tab.pendingUrl || tab.url || "");
    }
    function target(details) {
      if (details.sourceTabId === tabId) adopt(details.tabId, details.url || "");
    }
    function updated(id, info) {
      if (done || !info.url) return;
      if (born.has(id)) {
        if (usable(info.url)) born.set(id, info.url);
        look();
      } else if (id === tabId && fileHostOf(info.url, provider)) {
        finish({ here: info.url });
      }
    }
    chrome.tabs.onCreated.addListener(created);
    chrome.tabs.onUpdated.addListener(updated);
    if (nav) nav.addListener(target);
    // The wait is counted from when the press is made, since reaching the
    // control can take a recipe a while; a tab opened before then is caught too.
    const wait = waits.open ?? (provider.downloadWaitSeconds || 45) * 1000;
    return {
      promise,
      pressed: () => { if (!done) timer = setTimeout(() => finish({ why: "The site did not open the document in time." }), wait); },
      cancel: () => finish({ why: "" }),
      // Every tab the press opened, closed.
      close: () => Promise.all([...born.keys()].map((id) => chrome.tabs.remove(id).catch(() => {}).finally(() => opened.delete(id)))),
    };
  }

  // Reads what the press opened, by where it is.
  async function take(tabId, provider, url) {
    if (fileHostOf(url, provider)) return fetchFile(url, provider);
    const inner = url.startsWith("blob:") ? url.slice(5) : url;
    let parsed;
    try { parsed = new URL(inner); } catch (e) { return { ok: false, why: "The address the site opened could not be read." }; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !onHost(parsed.href, provider)) {
      return { ok: false, why: "The site opened its document on a host this does not fetch from." };
    }
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: readInPage, args: [url] });
    return result || { ok: false, why: "The document the site opened could not be read." };
  }

  async function newTab(tabId, provider, doc) {
    const before = ((await chrome.tabs.get(tabId).catch(() => null)) || {}).url || "";
    const watch = watchOpened(tabId, provider);
    let pressed;
    try {
      pressed = await inPage(tabId, provider, clickDoc, [doc]);
    } catch (e) {
      watch.cancel();
      await watch.close();
      throw e;
    }
    if (!pressed || !pressed.ok) {
      watch.cancel();
      await watch.close();
      return { ok: false, why: (pressed && pressed.why) || "Its control was not there." };
    }
    watch.pressed();
    const got = await watch.promise;
    try {
      if (got.why) return { ok: false, why: got.why };
      if (got.here) {
        const pdf = await fetchFile(got.here, provider);
        // The tab went to the PDF itself: back to the address it was on. Not
        // back in its history: Chrome skips a page that was left without a
        // person's press, which is how the press left the list.
        await loaded(tabId).catch(() => {});
        if (before && onHost(before, provider)) {
          await chrome.tabs.update(tabId, { url: before }).catch(() => {});
          await tabChange(tabId, 3000);
          await loaded(tabId).catch(() => {});
        }
        return pdf;
      }
      return await take(tabId, provider, got.url);
    } finally {
      await watch.close();
    }
  }

  const canceled = (provider) => `You closed Chrome's debugging bar, so ${provider.name} was stopped. Run it again and leave the bar open until it is done.`;

  // The page in this tab as a PDF, with the debugger attached only meanwhile.
  async function printTab(tabId, provider, doc) {
    const target = { tabId };
    let detached = "";
    const onDetach = (source, reason) => { if (source.tabId === tabId) detached = reason || "detached"; };
    chrome.debugger.onDetach.addListener(onDetach);
    let attached = false;
    try {
      try {
        await chrome.debugger.attach(target, "1.3");
        attached = true;
        log(provider, `Debugger attached to tab ${tabId} to print.`);
      } catch (e) {
        log(provider, `Debugger would not attach to tab ${tabId}: ${(e && e.message) || e}`, "WARN");
        if (/already attached/i.test(String(e && e.message))) return { ok: false, why: `Close DevTools on ${provider.name}'s tab, then run it again.` };
        return { ok: false, why: `Chrome would not let ${provider.name}'s page be printed.` };
      }
      let printed = null;
      try {
        printed = await chrome.debugger.sendCommand(target, "Page.printToPDF", { ...PRINT_OPTIONS, landscape: Boolean(doc.printLandscape) });
      } catch (e) { log(provider, `Page.printToPDF failed: ${(e && e.message) || e}`, "WARN"); }
      if (detached) log(provider, `Debugger detached from tab ${tabId}: ${detached}${detached === "canceled_by_user" ? " (you pressed Cancel on Chrome's bar)" : ""}.`, "WARN");
      if (detached === "canceled_by_user") return { ok: false, stop: true, why: canceled(provider) };
      if (detached === "target_closed") return { ok: false, stop: true, why: `${provider.name}'s tab was closed.` };
      if (detached) return { ok: false, why: "Chrome stopped the print before it finished." };
      const data = printed && printed.data;
      // "JVBERi0" is "%PDF-" in base64.
      if (!data || !data.startsWith("JVBERi0")) return { ok: false, why: "Chrome's print did not make a PDF." };
      return { ok: true, base64: data };
    } finally {
      chrome.debugger.onDetach.removeListener(onDetach);
      if (attached && !detached) {
        await chrome.debugger.detach(target).catch(() => {});
        log(provider, `Debugger detached from tab ${tabId} after the print.`);
      }
    }
  }

  async function print(tabId, provider, doc) {
    if (!(await isOurs(tabId))) {
      return { ok: false, why: `This prints only in a tab it opened itself. Close your own ${provider.name} tab, then run it again.` };
    }
    const shown = await inPage(tabId, provider, showDoc, [doc]);
    if (!shown || !shown.ok) return { ok: false, why: (shown && shown.why) || "Its page could not be opened." };
    try {
      await sleep(SETTLE_MS);
      const until = Date.now() + READY_WAIT_MS;
      let why = "";
      let ready = null;
      while (Date.now() < until) {
        await loaded(tabId).catch(() => {});
        try { ready = await inPage(tabId, provider, printReady, [doc]); } catch (e) { ready = null; /* the page is changing */ }
        if (ready && ready.ready) break;
        if (ready && ready.ok === false) return { ok: false, why: ready.why || "Its page was not the document." };
        if (ready && ready.why) why = ready.why;
        await tabChange(tabId, 1000);
      }
      if (!ready || !ready.ready) return { ok: false, why: why || "Its page did not finish showing." };
      // Asked again just before printing: the sweep's own tab, on the site.
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || !onHost(tab.url, provider)) return { ok: false, why: `The tab left ${provider.name} before it was printed.` };
      if (!(await isOurs(tabId))) return { ok: false, why: "This prints only in a tab it opened itself." };
      return await printTab(tabId, provider, doc);
    } finally {
      try {
        const left = await inPage(tabId, provider, leaveDoc, [doc]);
        if (!(left && left.stayed)) {
          await tabChange(tabId, 1500);
          await loaded(tabId);
        }
      } catch (e) { /* the next press says if the list did not come back */ }
    }
  }

  return {
    newTab, print, isCaptureTab: (id) => opened.has(id),
    // A tab that is gone, or one Chrome swapped for another (onReplaced).
    forget: (id) => { opened.delete(id); },
    replace: (removed, added) => { if (opened.delete(removed)) opened.add(added); },
  };
}
