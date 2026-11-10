// The Card Offers page (offers.html): what each site's cards showed on the
// last run, from the record offers.js keeps (offerDetails:<site>), and the
// same per-site switch as Settings (offersOn). Add Offers Now asks the
// background for an offers-only pass. Everything here is read from this
// browser's own storage; nothing is fetched.
import { PROVIDERS } from "./providers/index.js";
import { localIso } from "./cadence.js";
import { ALL, OFFERS_CAP, OFFERS_ON, SOON_DAYS, capChoice, detailsKey, fullOf, hasOffers, liveDetails, offerCounts, offersKey, soonestFirst } from "./offers.js";

const $ = (id) => document.getElementById(id);
const sites = PROVIDERS.filter(hasOffers);
// The card picked on each site, while the page is open.
const pickedCard = new Map();
let site = null;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Chase Business's offers are on Chase's own site, under the same name.
const shortName = (provider) => provider.name.replace(/ Business$/, "");
// The site's own offers page, or for a site without one (Amex), where its
// sign-in starts: its own Offers link is one press from there.
const offersUrl = (provider) => provider.offers.url || provider.listUrl;

const dayOf = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const daysUntil = (iso, today) => Math.round((dayOf(iso) - dayOf(today)) / (24 * 60 * 60 * 1000));
function shortDate(iso, today) {
  const date = dayOf(iso);
  const far = Math.abs(daysUntil(iso, today)) > 300;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(far ? { year: "numeric" } : {}) });
}
const ends = (o, today) => (o.expires ? `Ends ${shortDate(o.expires, today)}` : "");
function whenChecked(ms, today) {
  const at = new Date(ms);
  if (localIso(at) === today) return `today at ${at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  return shortDate(localIso(at), today);
}

function tabs() {
  $("sites").replaceChildren(...sites.map((provider) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "tab");
    b.id = `tab-${provider.id}`;
    b.dataset.site = provider.id;
    b.setAttribute("aria-controls", "site");
    b.textContent = provider.name;
    b.addEventListener("click", () => choose(provider.id, true));
    return b;
  }));
}

// Left and Right move between sites, as a row of tabs does.
$("sites").addEventListener("keydown", (e) => {
  const all = [...$("sites").querySelectorAll("[role=tab]")];
  const at = all.indexOf(document.activeElement);
  if (at < 0) return;
  const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: all.length - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  const next = all[(to + all.length) % all.length];
  choose(next.dataset.site, true);
  next.focus();
});

function choose(id, fromTab = false) {
  if (!sites.some((p) => p.id === id)) id = sites[0].id;
  site = id;
  if (fromTab && location.hash.slice(1) !== id) history.replaceState(null, "", `#${id}`);
  $("now").textContent = "";
  draw();
}

function row(o, { by = "", soon = false, open = null, check = false } = {}) {
  const li = document.createElement("li");
  if (check) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Added");
    svg.innerHTML = '<path d="M3.5 8.5l3 3 6-7"/>';
    li.append(svg);
  }
  const words = document.createElement("div");
  const merchant = document.createElement("div");
  merchant.className = "merchant";
  merchant.textContent = o.merchant || o.title || "An offer";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = [o.merchant ? o.title : "", o.why].filter(Boolean).join(" · ");
  words.append(merchant);
  if (title.textContent) words.append(title);
  li.append(words);
  for (const [text, isSoon] of [[by, false], [o.ends || "", soon]]) {
    if (!text) continue;
    const meta = document.createElement("span");
    meta.className = "meta";
    if (isSoon) meta.dataset.soon = "";
    meta.textContent = text;
    li.append(meta);
  }
  if (open) li.append(open());
  return li;
}

function emptyRow(head, text) {
  const li = row({ merchant: head, title: text });
  li.className = "empty";
  return li;
}

async function draw() {
  const provider = sites.find((p) => p.id === site);
  const today = localIso();
  const stored = await chrome.storage.local.get([OFFERS_ON, detailsKey(provider.id), offersKey(provider.id)]);
  const cap = await capChoice();
  const full = fullOf(stored[offersKey(provider.id)]);
  const on = (stored[OFFERS_ON] || []).includes(provider.id);
  const details = liveDetails(stored[detailsKey(provider.id)], today);
  const n = offerCounts(details, today);

  for (const b of $("sites").querySelectorAll("[role=tab]")) {
    const selected = b.dataset.site === provider.id;
    b.setAttribute("aria-selected", String(selected));
    b.tabIndex = selected ? 0 : -1;
  }
  $("site").setAttribute("aria-labelledby", `tab-${provider.id}`);
  $("siteName").textContent = provider.name;
  const said = [`${n.added} added`];
  if (n.waiting) said.push(`${n.waiting} waiting`);
  if (n.needs) said.push(`${n.needs} need${n.needs === 1 ? "s" : ""} you`);
  $("siteStatus").textContent = !on ? "Card offers are off for this site"
    : details.at ? `Last checked ${whenChecked(details.at, today)} · ${said.join(" · ")}`
    : "On. Offers are added on the next sync.";
  $("siteOn").checked = on;
  $("addNow").disabled = !on;

  const cards = Object.entries(details.cards);
  $("none").hidden = cards.length > 0;
  for (const id of ["cards", "needsPart", "waitingPart", "addedPart"]) $(id).hidden = !cards.length;
  if (!cards.length) {
    // A record from before details were kept has only ids to count.
    const before = ((stored[offersKey(provider.id)] || {}).added || []).length;
    $("noneText").textContent = before
      ? `${plural(before, "offer")} added before this list was kept. The next sync fills it in.`
      : on ? "They show here after the next sync, or press Add Offers Now."
      : "Turn on Add when syncing, then sync. The offers this site shows appear here.";
    return;
  }
  let key = pickedCard.get(provider.id);
  if (!details.cards[key]) key = cards[0][0];
  pickedCard.set(provider.id, key);
  $("cards").replaceChildren(...cards.map(([id, card]) => {
    const c = offerCounts({ cards: { [id]: card } }, today);
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-pressed", String(id === key));
    b.append(Object.assign(document.createElement("span"), { textContent: card.label }),
      Object.assign(document.createElement("span"), { textContent: `${c.waiting} waiting · ${c.added + c.onCard} added` }));
    b.addEventListener("click", () => { pickedCard.set(provider.id, id); draw(); });
    return b;
  }));

  const card = details.cards[key];
  const withEnds = (o) => ({ ...o, ends: ends(o, today) });
  const needs = soonestFirst(card.offers.filter((o) => o.status === "needs_you")).map(withEnds);
  const waiting = soonestFirst(card.offers.filter((o) => o.status === "waiting")).map(withEnds);
  const added = card.offers.filter((o) => o.status === "added" || o.status === "on_card")
    .sort((a, b) => (a.status === b.status ? (b.on || "").localeCompare(a.on || "") : a.status === "added" ? -1 : 1)).map(withEnds);

  $("needsPart").hidden = !needs.length;
  $("needsHead").textContent = `Needs You · ${needs.length}`;
  const openOn = () => {
    const a = document.createElement("a");
    a.href = offersUrl(provider);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = `Open on ${shortName(provider)}`;
    return a;
  };
  $("needs").replaceChildren(...needs.map((o) => row(o, { open: openOn })));

  $("waitingHead").textContent = `Waiting to Add · ${waiting.length}`;
  $("waiting").replaceChildren(...(waiting.length
    ? waiting.map((o) => row(o, { soon: Boolean(o.expires) && daysUntil(o.expires, today) <= SOON_DAYS }))
    : [emptyRow("Nothing waiting", "Every offer this card shows is on it.")]));
  $("waitingNote").textContent = on
    ? `Added on the next sync${cap === ALL ? (full ? ", every new one" : ", every one, in this site's first full sync") : `, up to ${cap} a site`}, a few seconds apart. Soonest to expire first.`
    : "Turn on Add when syncing to have these added, soonest to expire first.";

  $("addedHead").textContent = `Added · ${added.length}`;
  const by = (o) => (o.status === "on_card" ? "Already on the card"
    : o.on ? `Added by Statement Sweep, ${o.on === today ? "today" : shortDate(o.on, today)}` : "Added by Statement Sweep");
  $("added").replaceChildren(...(added.length
    ? added.map((o) => row(o, { by: by(o), check: true }))
    : [emptyRow("None yet", on ? "Offers are added on the next sync." : "Turn on Add when syncing, then sync.")]));
}

// The same switch as Settings, saved at once.
$("siteOn").addEventListener("change", async () => {
  const box = $("siteOn");
  const { [OFFERS_ON]: now = [] } = await chrome.storage.local.get(OFFERS_ON);
  const next = box.checked ? [...new Set([...now, site])] : now.filter((id) => id !== site);
  await chrome.storage.local.set({ [OFFERS_ON]: next });
  draw();
});

$("addNow").addEventListener("click", async () => {
  const provider = sites.find((p) => p.id === site);
  const say = (text, kind = "") => { $("now").textContent = text; $("now").dataset.kind = kind; };
  $("addNow").disabled = true;
  let answer;
  try { answer = await chrome.runtime.sendMessage({ type: "offersNow", site: provider.id }); } catch (e) { answer = null; }
  if (answer && answer.ok) say(`Adding offers on ${provider.name}. The Statement Sweep popup shows how it goes.`);
  else say((answer && answer.why) || "Statement Sweep did not answer. Try again.", "no");
  $("addNow").disabled = !$("siteOn").checked;
});

// Kept in step with a sync that adds offers, and with Settings.
if (chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !site) return;
    if (OFFERS_ON in changes || detailsKey(site) in changes || offersKey(site) in changes || OFFERS_CAP in changes) draw();
  });
}
window.addEventListener("hashchange", () => choose(location.hash.slice(1)));

if (sites.length) {
  tabs();
  choose(location.hash.slice(1));
} else {
  $("site").hidden = true;
}
