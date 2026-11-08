// Runs a sweep: find or open the provider's tab, wait for you to be signed
// in if you are not, read its list, and save what is new. Nothing leaves
// the browser except the requests the provider's own page would make.
import { PROVIDERS } from "./providers/index.js";

const SIGN_IN_WAIT_MS = 5 * 60 * 1000;
const NEWEST = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let running = false;

async function say(status) {
  await chrome.storage.session.set({ status: { ...status, at: Date.now() } });
  chrome.runtime.sendMessage({ type: "status" }).catch(() => {});
}

async function inPage(tabId, provider, func, args = []) {
  await chrome.scripting.executeScript({ target: { tabId }, files: [provider.pageFile] });
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result;
}
const readList = () => globalThis.__sweep.readList();
const fetchPdf = (id) => globalThis.__sweep.fetchPdf(id);

async function loaded(tabId) {
  for (let i = 0; i < 120; i++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await sleep(500);
  }
  throw new Error("The page did not finish loading.");
}

// The list, once it is there. A person signing in moves the tab through the
// provider's own pages, so this waits and looks again, and presses nothing.
async function listOnceSignedIn(tabId, provider) {
  const until = Date.now() + SIGN_IN_WAIT_MS;
  let asked = false;
  while (Date.now() < until) {
    await loaded(tabId);
    let list = null;
    try { list = await inPage(tabId, provider, readList); } catch (e) { /* the page is changing */ }
    if (list && (list.state === "ok" || list.state === "stopped")) return list;
    if (list && list.state === "no_list" && !asked) {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url.includes("BillingHistory")) await chrome.tabs.update(tabId, { url: provider.listUrl });
    }
    if (list && list.state === "signed_out" && !asked) {
      asked = true;
      await chrome.tabs.update(tabId, { active: true });
      await say({ state: "needs_you", text: `Sign in to ${provider.name} in its tab. This goes on by itself once you are in.` });
    }
    await sleep(2000);
  }
  return { state: "timed_out" };
}

function saved(downloadId) {
  return new Promise((resolve) => {
    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "in_progress") return;
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(delta.state.current === "complete");
    };
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

async function sweep(provider) {
  const key = `seen:${provider.id}`;
  const seen = new Set((await chrome.storage.local.get(key))[key] || []);
  const [existing] = await chrome.tabs.query({ url: provider.match });
  const tab = existing || await chrome.tabs.create({ url: provider.listUrl, active: false });
  const opened = !existing;
  await say({ state: "working", text: `Looking at ${provider.name}…` });
  if (existing && !existing.url.includes("BillingHistory")) await chrome.tabs.update(tab.id, { url: provider.listUrl });

  const list = await listOnceSignedIn(tab.id, provider);
  if (list.state === "timed_out") return say({ state: "bad", text: `Stopped waiting for you to sign in to ${provider.name}.` });
  if (list.state === "stopped") return say({ state: "bad", text: `${provider.name}'s page was not what this expected. ${list.why}` });

  const fresh = list.bills.filter((b) => !seen.has(b.id)).slice(0, NEWEST);
  if (!fresh.length) {
    if (opened) await chrome.tabs.remove(tab.id);
    return say({ state: "ok", text: `Nothing new from ${provider.name}.` });
  }

  let count = 0;
  for (const [i, bill] of fresh.entries()) {
    await say({ state: "working", text: `Saving ${i + 1} of ${fresh.length} from ${provider.name}…` });
    const pdf = await inPage(tab.id, provider, fetchPdf, [bill.id]);
    if (!pdf.ok) return say({ state: "bad", text: `${count} saved, then it stopped. ${pdf.why}` });
    const id = await chrome.downloads.download({
      url: `data:application/pdf;base64,${pdf.base64}`,
      filename: `Statement Sweep/${provider.name.replace(/[^A-Za-z0-9 ]/g, "")}/${provider.fileName(bill)}`,
      conflictAction: "uniquify",
      saveAs: false,
    });
    if (!(await saved(id))) return say({ state: "bad", text: `${count} saved, then your browser refused a file.` });
    seen.add(bill.id);
    await chrome.storage.local.set({ [key]: [...seen] });
    count += 1;
    await sleep(1500 + Math.random() * 1500);
  }
  if (opened) await chrome.tabs.remove(tab.id);
  return say({ state: "ok", text: `${count} new from ${provider.name}, in Downloads under Statement Sweep.` });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "sweep" || running) return;
  running = true;
  (async () => {
    try {
      for (const provider of PROVIDERS) await sweep(provider);
    } catch (e) {
      await say({ state: "bad", text: `That did not finish. ${e.message}` });
    } finally {
      running = false;
    }
  })();
});
