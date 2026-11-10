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
//       {state: "ok", card, offers: [{id, title, merchant, added, expires?}],
//        onCards?: number already on this card, more?: true when another
//        card may follow, note?}.
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
export const OFFERS_ON = "offersOn";
// A careful pace: at most this many presses a site each sync, the rest left
// for the next sync, and a few seconds, never the same, between presses, as a
// person would. Settings says both (offers-settings.js).
export const MAX_PRESSES = 25;
export const PACE_MS = [1500, 4000];
export const offersKey = (id) => `offers:${id}`;
const MAX_CARDS = 20;
const READ_WAIT_MS = 60000;
const FAILS_IN_A_ROW = 3;
const KEEP = 3000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const paceMs = (random = Math.random) => Math.round(PACE_MS[0] + random() * (PACE_MS[1] - PACE_MS[0]));
const pace = () => sleep(paceMs());

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
    ? `${provider.name} asked you to confirm something.`
    : `${provider.name} signed you out.`);

  // Every card in turn: the offers not yet added and not already in the
  // record are pressed, up to MAX_PRESSES in all, a pause between each two.
  // `progress` says how far. It stops at the first sign-out or check, and
  // never waits for you: that is the statements' part.
  async function run(tabId, provider, { ours, progress = async () => {} }) {
    const sum = { added: 0, already: 0, left: 0, failed: 0, cards: 0, passed: 0, capped: false, why: "", notes: [] };
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
      const todo = offers.filter((o) => !o.added && !known(kept, o.id));
      log(provider, `Card ${read.card || "?"}: ${offers.length} offer(s) read, ${onPage.length} shown as added, ${todo.length} to add.`);
      for (const offer of todo) {
        if (presses >= MAX_PRESSES) { sum.capped = true; return sum; }
        // Never two presses back to back.
        if (presses > 0) await pause();
        if (!(await onSite(tabId, provider))) { sum.why = `The tab left ${provider.name}'s site.`; return sum; }
        await progress(`Adding offers… ${sum.added} added so far.`);
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
        } else if (r.left) {
          sum.left += 1;
          inARow = 0;
          await keep(provider, { left: [offer.id] });
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

// What the popup row says about the offers, after the statements' words.
// `stopped` is true when the offers stopped before they were done. It is only
// ever a note: the site's own line stays what its statements made it.
export function offersWords(sum) {
  const parts = [];
  if (sum.added) parts.push(`Added ${plural(sum.added, "offer")}`);
  if (sum.already) parts.push(`${sum.already} already on your ${sum.already === 1 ? "card" : "cards"}`);
  const none = sum.cards && sum.passed === sum.cards ? "No card of this kind is in this sign-in, so no offers were added." : "No new offers.";
  let text = parts.length ? `${parts.join(" · ")}.` : (sum.why ? "" : none);
  if (sum.left) text += ` ${plural(sum.left, "offer was", "offers were")} left for you, since the site asked for more.`;
  if (sum.failed && !sum.why) text += ` ${plural(sum.failed, "offer")} did not add and ${sum.failed === 1 ? "is" : "are"} tried again next time.`;
  if (sum.capped) text += ` Stopped at ${MAX_PRESSES} offers for this sync. The rest are added next time.`;
  if (sum.why) text += ` Offers stopped: ${sum.why}`;
  for (const note of new Set(sum.notes || [])) text += ` ${note}`;
  return { text: text.trim(), stopped: Boolean(sum.why) };
}
