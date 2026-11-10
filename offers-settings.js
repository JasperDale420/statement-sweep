// The Card Offers part of Settings: one switch per site that has offers, off
// until you turn it on, how many a sync, and the record of offers seen.
// Saved as soon as it is changed, apart from the folder and name settings'
// Save button, since it changes no file.
import { PROVIDERS } from "./providers/index.js";
import { ALL, CAP_CHOICES, MAX_PRESSES, OFFERS_CAP, OFFERS_ON, PACE_MS, addedSoFar, capChoice, detailsKey, fullOf, hasOffers, liveDetails, offerCounts, offersKey } from "./offers.js";

const $ = (id) => document.getElementById(id);
const sites = PROVIDERS.filter(hasOffers);
const group = $("offersGroup");
const list = $("offersSites");
const status = $("offersStatus");
const seconds = (ms) => String(ms / 1000);
// Chase and Chase Business share a sign-in, so each says which cards are its.
const KIND = { personal: "personal cards", business: "business cards" };

// The pace, from the numbers the engine keeps to, so the two never differ.
const pace = $("offersPace");
if (pace) pace.textContent = `A site's first sync adds every offer it has, which can be hundreds and take a while: about 15 minutes for 300. Later syncs add only new ones. ${seconds(PACE_MS[0])} to ${seconds(PACE_MS[1])} seconds apart, soonest to expire first, and never more than ${MAX_PRESSES} a sync. It stops at once if a site signs you out, asks you to confirm something, or says to slow down.`;

const choiceWords = (n) => (n === ALL ? "Every new offer" : `Up to ${n} offers a site`);
const cap = $("offersCap");
if (cap) {
  cap.replaceChildren(...CAP_CHOICES.map((n) => Object.assign(document.createElement("option"), { value: String(n), textContent: choiceWords(n) })));
  cap.addEventListener("change", async () => {
    const n = Number(cap.value);
    if (!CAP_CHOICES.includes(n)) return;
    await chrome.storage.local.set({ [OFFERS_CAP]: n });
    status.textContent = n === ALL ? "Every new offer is added each sync." : `Up to ${n} offers a site each sync.`;
  });
}

const keys = () => [OFFERS_ON, ...sites.flatMap((p) => [offersKey(p.id), detailsKey(p.id)])];

async function draw() {
  if (!sites.length) {
    for (const el of [group, $("offersHead"), status]) if (el) el.hidden = true;
    return;
  }
  const stored = await chrome.storage.local.get(keys());
  const on = stored[OFFERS_ON] || [];
  if (cap) cap.value = String(await capChoice());
  let added = 0, needs = 0;
  list.replaceChildren(...sites.map((provider) => {
    const row = document.createElement("div");
    row.className = "offer-site";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `offers-${provider.id}`;
    box.checked = on.includes(provider.id);
    const label = document.createElement("label");
    label.htmlFor = box.id;
    label.textContent = provider.name;
    const kind = KIND[(provider.offers || {}).cards];
    if (kind) label.append(" ", Object.assign(document.createElement("span"), { textContent: `· ${kind}` }));
    const count = addedSoFar(stored[offersKey(provider.id)]);
    added += count;
    needs += offerCounts(liveDetails(stored[detailsKey(provider.id)])).needs;
    const said = document.createElement("span");
    // On: how many so far, and whether its first, full sync is still to come.
    const first = fullOf(stored[offersKey(provider.id)]) ? "" : " · first full sync next";
    const words = () => (box.checked ? `${count ? `${count} added so far` : "None added yet"}${first}` : count ? `Off · ${count} added before` : "Off");
    said.textContent = words();
    row.append(box, label, said);
    box.addEventListener("change", async () => {
      const { [OFFERS_ON]: now = [] } = await chrome.storage.local.get(OFFERS_ON);
      const next = box.checked ? [...new Set([...now, provider.id])] : now.filter((id) => id !== provider.id);
      await chrome.storage.local.set({ [OFFERS_ON]: next });
      status.textContent = box.checked
        ? `On for ${provider.name}. Its offers are added on the next sync.`
        : `Off for ${provider.name}.`;
      said.textContent = words();
    });
    return row;
  }));
  $("offersSeen").textContent = `${added} added · ${needs} need${needs === 1 ? "s" : ""} you`;
}

// Forget Offers asks twice, inline: the first press arms it for a few
// seconds, and only a second press then clears the record.
const forget = $("forgetOffers");
const FORGET_ARMED_MS = 5000;
let armed = null;
function disarm() {
  clearTimeout(armed);
  armed = null;
  forget.textContent = "Forget Offers…";
}
if (forget) forget.addEventListener("click", async () => {
  if (!armed) {
    forget.textContent = "Forget Offers (press again)";
    status.textContent = "Press Forget Offers again to clear the list of offers seen.";
    armed = setTimeout(disarm, FORGET_ARMED_MS);
    return;
  }
  disarm();
  await chrome.storage.local.remove(sites.flatMap((p) => [offersKey(p.id), detailsKey(p.id)]));
  status.textContent = "Offers forgotten. Offers already on your cards stay on them.";
  draw();
});

// Kept in step with a sync that adds offers while Settings is open, and with
// the Card Offers page. Not redrawn for a switch you just pressed, so it
// keeps its focus.
if (chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (sites.some((p) => offersKey(p.id) in changes || detailsKey(p.id) in changes) || OFFERS_CAP in changes)) draw();
  });
}
draw();
