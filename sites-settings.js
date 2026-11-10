// The Sites part of Settings: which sites Statement Sweep sweeps at all. A
// site switched off here is never ticked in the popup, never run by Get New
// Documents and never counted on the toolbar badge. Saved as soon as it is
// changed, apart from the folder and name settings' Save button, since it
// changes no file. The popup's own ticks only choose what to run that time.
import { SITES as PROVIDERS, loadSites } from "./sites.js";

// The sites you added are swept, and switched off, like the rest.
await loadSites();

const $ = (id) => document.getElementById(id);
const list = $("sitesList");
const status = $("sitesStatus");

async function draw() {
  const { off = [] } = await chrome.storage.local.get("off");
  const sorted = [...PROVIDERS].sort((a, b) => a.name.localeCompare(b.name));
  list.replaceChildren(...sorted.map((provider) => {
    const row = document.createElement("div");
    row.className = "check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `site-${provider.id}`;
    box.checked = !off.includes(provider.id);
    const label = document.createElement("label");
    label.htmlFor = box.id;
    label.textContent = provider.name;
    row.append(box, label);
    box.addEventListener("change", async () => {
      const { off: now = [] } = await chrome.storage.local.get("off");
      const next = box.checked ? now.filter((id) => id !== provider.id) : [...new Set([...now, provider.id])];
      await chrome.storage.local.set({ off: next });
      status.textContent = box.checked ? `${provider.name} is swept again.` : `${provider.name} is switched off.`;
    });
    return row;
  }));
}

// Possible gaps dismissed in the popup (gapsOk:<site>), and the way back.
const gapKeys = PROVIDERS.map((p) => `gapsOk:${p.id}`);
async function drawGaps() {
  const stored = await chrome.storage.local.get(gapKeys);
  const n = gapKeys.reduce((sum, k) => sum + (Array.isArray(stored[k]) ? stored[k].length : 0), 0);
  $("gapsCount").textContent = n ? `${n} dismissed` : "None dismissed";
  $("gapsReset").disabled = !n;
}
$("gapsReset").addEventListener("click", async () => {
  await chrome.storage.local.remove(gapKeys);
  status.textContent = "Dismissed gaps are flagged again.";
  drawGaps();
});

// Kept in step with a history import, and with the popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.off) draw();
  if (changes.addedSites) loadSites().then(draw);
  if (Object.keys(changes).some((k) => k.startsWith("gapsOk:"))) drawGaps();
});
draw();
drawGaps();
