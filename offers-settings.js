// The Card Offers part of Settings: one switch per site that has offers, off
// until you turn it on. Saved as soon as it is changed, apart from the
// folder and name settings' Save button, since it changes no file.
import { PROVIDERS } from "./providers/index.js";
import { MAX_PRESSES, OFFERS_ON, PACE_MS, addedSoFar, hasOffers, offersKey } from "./offers.js";

const $ = (id) => document.getElementById(id);
const sites = PROVIDERS.filter(hasOffers);
const group = $("offersGroup");
const list = $("offersSites");
const status = $("offersStatus");
const seconds = (ms) => String(ms / 1000);

// The pace, from the numbers the engine keeps to, so the two never differ.
const pace = $("offersPace");
if (pace) pace.textContent = `At most ${MAX_PRESSES} offers a site each sync, ${seconds(PACE_MS[0])} to ${seconds(PACE_MS[1])} seconds apart. The rest wait for the next sync. It stops at once if the site signs you out or asks you to confirm something.`;

async function draw() {
  if (!sites.length) {
    for (const el of [group, $("offersHead"), status]) if (el) el.hidden = true;
    return;
  }
  const stored = await chrome.storage.local.get([OFFERS_ON, ...sites.map((p) => offersKey(p.id))]);
  const on = stored[OFFERS_ON] || [];
  list.replaceChildren(...sites.map((provider) => {
    const row = document.createElement("div");
    row.className = "check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `offers-${provider.id}`;
    box.checked = on.includes(provider.id);
    const label = document.createElement("label");
    label.htmlFor = box.id;
    label.textContent = provider.name;
    row.append(box, label);
    const added = addedSoFar(stored[offersKey(provider.id)]);
    if (added) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = `${added} ${added === 1 ? "offer" : "offers"} added so far.`;
      row.append(hint);
    }
    box.addEventListener("change", async () => {
      const { [OFFERS_ON]: now = [] } = await chrome.storage.local.get(OFFERS_ON);
      const next = box.checked ? [...new Set([...now, provider.id])] : now.filter((id) => id !== provider.id);
      await chrome.storage.local.set({ [OFFERS_ON]: next });
      status.textContent = box.checked
        ? `On for ${provider.name}. Its offers are added on the next sync.`
        : `Off for ${provider.name}.`;
    });
    return row;
  }));
}

// Kept in step with a sync that adds offers while Settings is open. Not
// redrawn for a switch you just pressed, so it keeps its focus.
if (chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && sites.some((p) => offersKey(p.id) in changes)) draw();
  });
}
draw();
