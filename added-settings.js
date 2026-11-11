// The Sites You Added part of Settings: each site added with Add This Site,
// how its last sync went, and how many it has saved. Pick Again opens its
// statements page with the picker, to pick a statement link afresh. Remove
// asks twice, as Forget Offers does, then forgets the site's pattern and
// gives back the access Chrome gave for it. What it saved stays saved.
import { ADDED, addedSites, lastKey, primedKey } from "./sites.js";

const $ = (id) => document.getElementById(id);
const list = $("addedList");
const status = $("addedStatus");
const REMOVE_ARMED_MS = 5000;
const NO_MATCH = "Last sync found no links like the one you picked. The site may have changed its page. Pick a statement link again to fix it.";

// Resolves once a tab has finished loading, or after 30 seconds.
function loadedTab(tabId) {
  return new Promise((resolve) => {
    const until = Date.now() + 30000;
    const look = async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || tab.status === "complete" || Date.now() > until) resolve(tab);
      else setTimeout(look, 250);
    };
    look();
  });
}

// Opens the site's statements page in a new tab and draws the picker there.
// Chrome's question comes first, straight from your press; for a site still
// allowed it answers at once without asking.
function pickAgain(config) {
  const host = new URL(config.origin).host;
  chrome.permissions.request({ origins: config.match }).then(async (granted) => {
    if (!granted) { status.textContent = `Statement Sweep needs your OK to read ${host}.`; return; }
    const tab = await chrome.tabs.create({ url: config.listUrl, active: true });
    const ready = await loadedTab(tab.id);
    if (!ready) return;
    // Drawn only on the site itself: its page may have sent the tab elsewhere.
    let now = null;
    try { now = new URL(ready.url).origin; } catch (e) { /* no address to read */ }
    if (now !== config.origin) {
      status.textContent = `The picker wasn't drawn: the new tab left ${host}. Open its statements page and press Add This Site in Statement Sweep's menu.`;
      return;
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["providers/added.page.js", "picker.js"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (o) => globalThis.__sweepPicker.start(o), args: [{ name: config.name }] });
    } catch (e) {
      status.textContent = `The picker couldn't be drawn on ${host}. Open its statements page and press Add This Site in Statement Sweep's menu.`;
    }
  }).catch(() => { status.textContent = "Chrome didn't ask. Press Pick Again once more."; });
}

async function remove(config) {
  const { [ADDED]: stored } = await chrome.storage.local.get(ADDED);
  await chrome.storage.local.set({ [ADDED]: addedSites(stored).filter((c) => c.origin !== config.origin) });
  await chrome.permissions.remove({ origins: config.match }).catch(() => false);
  status.textContent = `${config.name} removed. What it saved stays where it is.`;
}

// Its line: how the last sync went, and how many it saved. Statements its
// first sync only marked as seen ("Only new ones from now on") are not counted.
function standing(config, stored) {
  const seen = stored[`seen:${config.id}`] || [];
  const primed = new Set(stored[primedKey(config.id)] || []);
  const saved = seen.filter((id) => !primed.has(id)).length;
  const last = stored[lastKey(config.id)];
  const so = `${saved.toLocaleString()} saved so far`;
  if (!last) return { text: `Not synced yet · ${so}` };
  if (last.noMatch) return { text: so, hint: NO_MATCH };
  if (!last.ok) return { text: `Stopped last sync · ${so}`, kind: "warn", hint: last.why || "" };
  return { text: `Worked last sync · ${so}` };
}

async function draw() {
  const { [ADDED]: raw } = await chrome.storage.local.get(ADDED);
  const sites = addedSites(raw);
  const stored = await chrome.storage.local.get(sites.flatMap((c) => [`seen:${c.id}`, primedKey(c.id), lastKey(c.id)]));
  if (!sites.length) {
    const row = document.createElement("div");
    row.className = "row";
    row.append(Object.assign(document.createElement("p"), { className: "hint empty", textContent: "None yet. To add one, open its statements page and press Add This Site… at the bottom of Statement Sweep's menu." }));
    list.replaceChildren(row);
    return;
  }
  list.replaceChildren(...sites.map((config) => {
    const row = document.createElement("div");
    row.className = "row added-site";
    row.dataset.site = config.id;
    const who = document.createElement("div");
    who.className = "who";
    who.append(Object.assign(document.createElement("span"), { className: "site-name", textContent: config.name }),
      Object.assign(document.createElement("span"), { className: "site-host", textContent: new URL(config.origin).host }));
    const now = standing(config, stored);
    const choice = document.createElement("div");
    choice.className = "choice";
    const state = Object.assign(document.createElement("span"), { className: "site-state", textContent: now.text });
    if (now.kind) state.dataset.kind = now.kind;
    const pick = Object.assign(document.createElement("button"), { className: "secondary", type: "button", textContent: "Pick Again…" });
    pick.setAttribute("aria-label", `Pick a statement link again for ${config.name}`);
    pick.addEventListener("click", () => pickAgain(config));
    const drop = Object.assign(document.createElement("button"), { className: "secondary", type: "button", textContent: "Remove…" });
    drop.setAttribute("aria-label", `Remove ${config.name}`);
    let armed = null;
    drop.addEventListener("click", async () => {
      if (!armed) {
        drop.textContent = "Remove (press again)";
        status.textContent = `Press Remove again to stop syncing ${config.name}. What it saved stays where it is.`;
        armed = setTimeout(() => { armed = null; drop.textContent = "Remove…"; }, REMOVE_ARMED_MS);
        return;
      }
      clearTimeout(armed);
      armed = null;
      await remove(config);
      draw();
    });
    choice.append(state, Object.assign(document.createElement("span"), { className: "pair" }));
    choice.lastChild.append(pick, drop);
    row.append(who, choice);
    if (now.hint) {
      row.classList.add("warn");
      row.append(Object.assign(document.createElement("p"), { className: "hint site-why", textContent: now.hint }));
    }
    return row;
  }));
}

// Kept in step with a site added in another tab, and with a sync.
if (chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.keys(changes).some((k) => k === ADDED || k.startsWith("addedLast:") || k.startsWith("seen:added-"))) draw();
  });
}
draw();
