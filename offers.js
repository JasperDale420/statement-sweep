// Adds a site's card offers to your cards, in the same tab and the same
// signed-in session, right after that site's statements are saved. Off unless
// you turn it on for the site in Settings (offersOn, a list of site ids).
//
// THE CONTRACT A RECIPE KEEPS
//
// A site with offers names its offers file in its meta:
//   "offers": {"file": "providers/<id>.offers.js", "url"?: "...", "cards"?: "personal" | "business"}
// The file is loaded after providers/shared.js and providers/offers-kit.js and
// sets globalThis.__offers:
//   - readOffers({walk, cards}) answers, as readList does:
//       {state: "signed_out"} or {state: "challenge"}: the offers stop there;
//       {state: "no_list"}: not the offers page; the engine then loads `url`
//         once, if the meta gives one on the site's own hosts;
//       {state: "walking"}: it pressed, or waits on, the site's own link;
//       {state: "stopped", why};
//       {state: "ok", card, cardName?, offers: [{id, title, merchant, added,
//        expires?: "YYYY-MM-DD"}], onCards?: number already on this card,
//        more?: true when another card may follow, note?}. `card` is a short
//        id for the card (its last digits); `cardName` what the site calls it.
//   - addOne(offer) presses that one offer's own add control, nothing else,
//     and answers {ok: true}, {ok: false, why}, {ok: false, left: true, why}
//     when the site asked for something more, {ok: false, state} on a
//     sign-out or a check, or {ok: false, stop: true, why}.
//   - nextCard(), optional, moves to the next card with the site's own card
//     switcher: {moved: true}, {moved: false} when every card is done, or {why}.
//
// What is known is kept as offers:<site>, {added: [ids], seen: [ids], left: [ids]}:
// `added` the offers Statement Sweep pressed and saw added, `seen` those the
// site already showed as added, and `left` those it asked more for. An offer
// in any of them is never pressed again. It stays in chrome.storage.local.
//
// What each card showed on the last run is kept beside it, for the Card
// Offers page, as offerDetails:<site>:
//   {at, cards: {<card id>: {label, at, offers: [{id, merchant, title,
//     expires: "YYYY-MM-DD" | null, status, on?, why?}]}}}
// `label` is the card's name and at most its last 4 digits, `status` one of
// waiting, added (by Statement Sweep, on the day `on`), on_card (already on
// it) or needs_you (the site asked for more, in its own words `why`). An offer
// past its end date is dropped. It stays in chrome.storage.local too, and
// never goes into a log: logs say counts and ids only.
import { localIso } from "./cadence.js";

export const OFFERS_ON = "offersOn";
// A careful pace: at most this many presses a site each sync, the rest left
// for the next sync, and a few seconds, never the same, between presses, as a
// person would. Settings says both (offers-settings.js), and lets you choose
// fewer a sync (offersCap), never more.
export const MAX_PRESSES = 25;
export const CAP_CHOICES = [10, 25];
export const OFFERS_CAP = "offersCap";
export const PACE_MS = [1500, 4000];
export const offersKey = (id) => `offers:${id}`;
export const detailsKey = (id) => `offerDetails:${id}`;
// Ends within this many days: drawn in orange, and pressed first anyway.
export const SOON_DAYS = 7;
const MAX_CARDS = 20;
const READ_WAIT_MS = 60000;
const FAILS_IN_A_ROW = 3;
const KEEP = 3000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const paceMs = (random = Math.random) => Math.round(PACE_MS[0] + random() * (PACE_MS[1] - PACE_MS[0]));
const pace = () => sleep(paceMs());

// How many presses a site gets each sync: the one you chose in Settings, or
// the most allowed.
export async function capOf() {
  const { [OFFERS_CAP]: cap } = await chrome.storage.local.get(OFFERS_CAP);
  return CAP_CHOICES.includes(cap) ? Math.min(cap, MAX_PRESSES) : MAX_PRESSES;
}

// Soonest to end first, and an offer that says no end last, each in the
// order the site drew them.
export function soonestFirst(offers) {
  return offers.map((o, i) => [o, i]).sort(([a, i], [b, j]) => {
    const x = a.expires || "9999-99-99", y = b.expires || "9999-99-99";
    return x < y ? -1 : x > y ? 1 : i - j;
  }).map(([o]) => o);
}

// The card as the record names it: its own name, if the recipe read one, and
// at most its last 4 digits, never more.
export function cardLabel(card, name = "") {
  const digits = String(card || "").replace(/\D/g, "").slice(-4);
  let words = String(name || "").replace(/\(?\s*[.·*x-]*\s*\d{3,}\s*\)?/gi, " ").replace(/\d{4,}/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
  // Chase writes its card names in capitals.
  if (words && words === words.toUpperCase()) words = words.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  if (!words) words = "Card";
  return digits ? `${words} ·· ${digits}` : words;
}

const clip = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
const STATUSES = ["waiting", "added", "on_card", "needs_you"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// The details record, read, with what has ended dropped. Anything malformed
// is left out rather than trusted.
export function liveDetails(stored, today = localIso()) {
  const out = { at: 0, cards: {} };
  if (!stored || typeof stored !== "object") return out;
  out.at = Number(stored.at) || 0;
  for (const [key, card] of Object.entries(stored.cards || {})) {
    if (!card || !Array.isArray(card.offers)) continue;
    const offers = card.offers.filter((o) => o && o.id && STATUSES.includes(o.status) && !(ISO.test(o.expires || "") && o.expires < today));
    out.cards[key] = { label: String(card.label || "Card"), at: Number(card.at) || 0, offers };
  }
  return out;
}

// Counts for the popup, the Card Offers page and Settings.
export function offerCounts(details, today = localIso()) {
  const n = { waiting: 0, added: 0, addedToday: 0, onCard: 0, needs: 0, cards: 0 };
  for (const card of Object.values(details.cards || {})) {
    n.cards += 1;
    for (const o of card.offers) {
      if (o.status === "waiting") n.waiting += 1;
      else if (o.status === "needs_you") n.needs += 1;
      else if (o.status === "on_card") n.onCard += 1;
      else if (o.status === "added") { n.added += 1; if (o.on === today) n.addedToday += 1; }
    }
  }
  return n;
}

async function readDetails(provider) {
  const key = detailsKey(provider.id);
  return liveDetails((await chrome.storage.local.get(key))[key]);
}
async function writeDetails(provider, details) {
  await chrome.storage.local.set({ [detailsKey(provider.id)]: liveDetails(details) });
}

// The record's line for one offer, from what the page shows and what is known.
function lineFor(offer, kept, before) {
  const line = { id: String(offer.id), merchant: clip(offer.merchant, 120), title: clip(offer.title, 200), expires: ISO.test(offer.expires || "") ? offer.expires : null, status: "waiting" };
  if (kept.added.has(offer.id)) Object.assign(line, { status: "added" }, before && before.on ? { on: before.on } : {});
  else if (offer.added || kept.seen.has(offer.id)) line.status = "on_card";
  else if (kept.left.has(offer.id)) Object.assign(line, { status: "needs_you", why: (before && before.why) || "The site asked for more before adding it." });
  return line;
}

// Every offer read on a card replaces what that card showed before. Cards not
// read this time keep what they showed last time.
async function noteCard(provider, read, offers, kept) {
  const details = await readDetails(provider);
  const key = String(read.card || "card");
  const before = new Map(((details.cards[key] || {}).offers || []).map((o) => [o.id, o]));
  const at = Date.now();
  details.at = at;
  details.cards[key] = { label: cardLabel(read.card, read.cardName), at, offers: offers.slice(0, 500).map((o) => lineFor(o, kept, before.get(o.id))) };
  await writeDetails(provider, details);
  return details.cards[key].label;
}
async function noteOffer(provider, card, id, change) {
  const details = await readDetails(provider);
  const line = ((details.cards[String(card || "card")] || {}).offers || []).find((o) => o.id === id);
  if (!line) return;
  delete line.on;
  delete line.why;
  Object.assign(line, change);
  await writeDetails(provider, details);
}

export const hasOffers = (provider) => Boolean(provider && provider.offers && provider.offers.file);

export async function offersWanted(provider) {
  if (!hasOffers(provider)) return false;
  const { [OFFERS_ON]: on = [] } = await chrome.storage.local.get(OFFERS_ON);
  return Array.isArray(on) && on.includes(provider.id);
}

// Run in the page, so each is whole on its own.
const readOffers = (options) => globalThis.__offers.readOffers(options);
const addOne = (offer) => globalThis.__offers.addOne(offer);
const nextCard = () => (globalThis.__offers.nextCard ? globalThis.__offers.nextCard() : { moved: false });

async function record(provider) {
  const key = offersKey(provider.id);
  const kept = (await chrome.storage.local.get(key))[key] || {};
  return { added: new Set(kept.added || []), seen: new Set(kept.seen || []), left: new Set(kept.left || []) };
}
const known = (kept, id) => kept.added.has(id) || kept.seen.has(id) || kept.left.has(id);

// Joined with what is stored now, and kept to the newest KEEP of each.
async function keep(provider, { added = [], seen = [], left = [] }) {
  const key = offersKey(provider.id);
  const now = await record(provider);
  for (const id of added) { now.added.delete(id); now.added.add(id); now.left.delete(id); }
  for (const id of seen) if (!now.added.has(id)) { now.seen.delete(id); now.seen.add(id); now.left.delete(id); }
  for (const id of left) { now.left.delete(id); now.left.add(id); }
  const last = (set) => [...set].slice(-KEEP);
  await chrome.storage.local.set({ [key]: { added: last(now.added), seen: last(now.seen), left: last(now.left) } });
}

// How many offers Statement Sweep has added for a site, for Settings.
export const addedSoFar = (kept) => ((kept && kept.added) || []).length;

export function makeOffers({ loaded, tabChange, onHost, pause = pace, log = () => {} }) {
  async function inOffers(tabId, provider, func, args = []) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["providers/shared.js", "providers/offers-kit.js", provider.offers.file] });
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return result;
  }

  const onSite = async (tabId, provider) => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    return Boolean(tab && tab.url && onHost(tab.url, provider));
  };

  // The offers of the card on show, once the page has drawn them. Never
  // waits for a sign-in: that is the statements' part, and a sign-out here
  // stops the offers.
  async function readWhenDrawn(tabId, provider) {
    const { url, cards = "" } = provider.offers;
    const until = Date.now() + READ_WAIT_MS;
    let sent = false, noList = 0;
    while (Date.now() < until) {
      const tab = await loaded(tabId);
      if (!tab.url || !onHost(tab.url, provider)) return { state: "stopped", why: `The tab left ${provider.name}'s site.` };
      let read = null;
      try { read = await inOffers(tabId, provider, readOffers, [{ walk: true, cards }]); } catch (e) { /* the page is changing */ }
      if (read && ["ok", "stopped", "signed_out", "challenge"].includes(read.state)) return read;
      noList = read && read.state === "no_list" ? noList + 1 : 0;
      if (noList >= 2 && !sent && url && onHost(url, provider)) {
        sent = true;
        noList = 0;
        await chrome.tabs.update(tabId, { url });
      } else if (noList >= (sent || !url ? 5 : 2)) {
        return { state: "stopped", why: `${provider.name}'s offers page could not be found.` };
      }
      await tabChange(tabId, 2000);
    }
    return { state: "stopped", why: `${provider.name}'s offers did not finish drawing.` };
  }

  const held = (state, provider) => (state === "challenge"
    ? `${provider.name} asked you to confirm it is you.`
    : `${provider.name} signed you out.`);

  // Every card in turn: the offers not yet added and not already in the
  // record are pressed, soonest to end first, up to `cap` in all (Settings,
  // never above MAX_PRESSES), a pause between each two. `progress` says how
  // far. It stops at the first sign-out or check, and never waits for you:
  // that is the statements' part.
  async function run(tabId, provider, { ours, cap, progress = async () => {} }) {
    const sum = { added: 0, already: 0, left: 0, failed: 0, cards: 0, passed: 0, capped: false, waiting: 0, more: false, why: "", notes: [] };
    const most = Math.min(Number(cap) || (await capOf()), MAX_PRESSES);
    // A tab of yours is never sent anywhere.
    if (!ours) {
      sum.why = "Offers are added only in a tab Statement Sweep opened. Close this site's tab and sync again.";
      return sum;
    }
    let presses = 0, inARow = 0, lastWhy = "";
    for (let cards = 0; cards < MAX_CARDS; cards += 1) {
      const read = await readWhenDrawn(tabId, provider);
      if (read.state === "signed_out" || read.state === "challenge") { sum.why = held(read.state, provider); return sum; }
      if (read.state !== "ok") { sum.why = read.why || "The offers page was not what this expected."; return sum; }
      if (read.note) sum.notes.push(read.note);
      sum.cards += 1;
      // A card of the other kind (Chase's personal and business share a sign-in).
      if (read.passed) { sum.passed += 1; log(provider, `Card ${read.card || "?"}: of the other kind, passed over.`); }
      const offers = Array.isArray(read.offers) ? read.offers : [];
      const kept = await record(provider);
      const onPage = offers.filter((o) => o.added).map((o) => o.id);
      if (onPage.length) await keep(provider, { seen: onPage });
      const inRecord = offers.filter((o) => !o.added && known(kept, o.id));
      sum.already += typeof read.onCards === "number" ? read.onCards
        : onPage.length + inRecord.filter((o) => kept.added.has(o.id) || kept.seen.has(o.id)).length;
      const todo = soonestFirst(offers.filter((o) => !o.added && !known(kept, o.id)));
      const label = await noteCard(provider, read, offers, await record(provider));
      log(provider, `Card ${read.card || "?"}: ${offers.length} offer(s) read, ${onPage.length} shown as added, ${todo.length} to add.`);
      const planned = Math.min(todo.length, Math.max(0, most - presses));
      for (const [i, offer] of todo.entries()) {
        if (presses >= most) {
          sum.capped = true;
          sum.waiting = todo.length - i;
          sum.more = Boolean(read.more);
          return sum;
        }
        // Never two presses back to back.
        if (presses > 0) await pause();
        if (!(await onSite(tabId, provider))) { sum.why = `The tab left ${provider.name}'s site.`; return sum; }
        await progress(`Adding offers · ${i + 1} of ${planned} on ${label}`);
        presses += 1;
        let r;
        try { r = await inOffers(tabId, provider, addOne, [offer]); } catch (e) { r = { ok: false, why: "The page changed while an offer was added." }; }
        r = r || { ok: false, why: "The page did not answer." };
        log(provider, `Offer ${offer.id}: ${r.ok ? (r.already ? "already added" : "added") : `${r.state || (r.left ? "left" : "not added")}${r.why ? `: ${r.why}` : ""}`}.`);
        if (r.state === "signed_out" || r.state === "challenge") { sum.why = held(r.state, provider); return sum; }
        if (r.ok) {
          if (r.already) sum.already += 1; else sum.added += 1;
          inARow = 0;
          await keep(provider, r.already ? { seen: [offer.id] } : { added: [offer.id] });
          await noteOffer(provider, read.card, offer.id, r.already ? { status: "on_card" } : { status: "added", on: localIso() });
        } else if (r.left) {
          sum.left += 1;
          inARow = 0;
          await keep(provider, { left: [offer.id] });
          await noteOffer(provider, read.card, offer.id, { status: "needs_you", why: clip(r.why, 200) || "The site asked for more before adding it." });
        } else {
          sum.failed += 1;
          inARow += 1;
          lastWhy = r.why || lastWhy;
          if (r.stop) { sum.why = lastWhy; return sum; }
          if (inARow >= FAILS_IN_A_ROW) { sum.why = `${inARow} offers in a row would not add. ${lastWhy}`.trim(); return sum; }
        }
      }
      if (!read.more) return sum;
      let next;
      try { next = await inOffers(tabId, provider, nextCard); } catch (e) { next = { why: "The page changed while moving to the next card." }; }
      if (!next || next.why) { sum.why = (next && next.why) || "The next card could not be shown."; return sum; }
      if (!next.moved) return sum;
    }
    sum.notes.push("There were more cards than expected. The rest are added next time.");
    return sum;
  }

  return { run };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What the popup row says about the offers, on a line of its own under the
// statements' words: `kind` is done, capped or stopped, for its color.
// `stopped` is true when the offers stopped before they were done. It is only
// ever a note: the site's own line stays what its statements made it.
export function offersWords(sum) {
  const notes = [...new Set(sum.notes || [])];
  const end = (text) => [text, ...notes].filter(Boolean).join(" ").trim();
  if (sum.why) {
    const before = sum.added ? ` ${sum.added} added before that.` : "";
    return { kind: "stopped", text: end(`Offers stopped: ${sum.why}${before}`), stopped: true };
  }
  if (sum.capped) {
    const wait = `${sum.waiting || 0}${sum.more ? " or more" : ""}`;
    return { kind: "capped", text: end(`${plural(sum.added, "offer")} added · ${wait} wait for the next sync`), stopped: false };
  }
  const parts = [];
  if (sum.added) parts.push(`Added ${plural(sum.added, "offer")}`);
  if (sum.already) parts.push(`${sum.already} already on your ${sum.already === 1 ? "card" : "cards"}`);
  const none = sum.cards && sum.passed === sum.cards ? "No card of this kind is in this sign-in, so no offers were added." : "No new offers.";
  let text = parts.length ? `${parts.join(" · ")}.` : none;
  if (sum.left) text += ` ${plural(sum.left, "offer was", "offers were")} left for you, since the site asked for more.`;
  if (sum.failed) text += ` ${plural(sum.failed, "offer")} did not add and ${sum.failed === 1 ? "is" : "are"} tried again next time.`;
  return { kind: "done", text: end(text), stopped: false };
}

// The line a site's offers wait on while a statement there has not saved.
export const OFFERS_WAIT = "Card offers wait until every statement here has saved.";
