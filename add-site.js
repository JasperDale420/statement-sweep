// Add This Site, the link in the popup's footer. It looks at the tab you are
// on: a built-in site's page has its own recipe, and a page that is not https
// cannot be added. Otherwise it asks Chrome to let the extension read that one
// site, which Chrome allows only straight from your press, then draws the
// picker (picker.js) in the tab and closes the popup.
//
// Kept apart from popup.js, which only lists the sites.
import { ADDED, addedFor, builtInFor } from "./sites.js";

const link = document.getElementById("addSite");
const said = document.getElementById("addSay");
const say = (text) => { said.textContent = text; };

// What the active tab is, looked at as the popup opens, so the press itself
// can go straight to Chrome's question. Chrome gives its address because you
// opened the popup on it (activeTab).
let here = null;
const looked = (async () => {
  if (!chrome.tabs || !chrome.tabs.query) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let url = null;
    try { url = new URL(tab.url); } catch (e) { /* no address to read */ }
    if (!tab || !url || url.protocol !== "https:" || url.username || url.password) { here = { kind: "insecure" }; return; }
    const builtIn = builtInFor(url.href);
    if (builtIn) { here = { kind: "builtin", name: builtIn.name }; return; }
    const { [ADDED]: stored } = await chrome.storage.local.get(ADDED);
    const added = addedFor(stored, url.origin);
    here = { kind: "ok", tabId: tab.id, origin: url.origin, host: url.host, name: added ? added.name : "" };
  } catch (e) {
    here = { kind: "insecure" };
  }
})();

async function draw(tabId, name) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["providers/added.page.js", "picker.js"] });
  await chrome.scripting.executeScript({ target: { tabId }, func: (o) => globalThis.__sweepPicker.start(o), args: [{ name }] });
}

link.addEventListener("click", (event) => {
  event.preventDefault();
  if (!here) {
    say("One moment, then press Add This Site again.");
    looked.then(() => { if (here) say(""); });
    return;
  }
  if (here.kind === "builtin") { say(`${here.name} is already one of Statement Sweep's sites.`); return; }
  if (here.kind !== "ok") { say("This page can't be added. Only a secure (https) site can be."); return; }
  const { tabId, origin, host, name } = here;
  // Asked at once, inside the press: Chrome refuses it later.
  chrome.permissions.request({ origins: [`${origin}/*`] }).then(async (granted) => {
    if (!granted) { say(`Statement Sweep needs your OK to read ${host}. Nothing was added.`); return; }
    try {
      await draw(tabId, name);
      window.close();
    } catch (e) {
      say("Statement Sweep can't draw on this page. Reload it and press Add This Site again.");
    }
  }).catch(() => say("Chrome didn't ask. Press Add This Site again."));
});
