import { PROVIDERS } from "./providers/index.js";
import { askFor, getFolder } from "./folders.js";
import { gapKey, gapWords, keysFor, localIso, needsRun, rankOf, recordOf, siteStatus, stateOf, statusWords } from "./cadence.js";
import { OFFERS_ON, detailsKey, hasOffers, liveDetails, offerCounts } from "./offers.js";

const go = document.getElementById("go");
const scroll = document.getElementById("scroll");
const summary = document.getElementById("summary");

// Most urgent first, so what needs you is never below the fold.
const SECTIONS = [["needs_you", "Needs You"], ["working", "In Progress"], ["bad", "Stopped"], ["ok", "Done"], ["", "Sites"]];
const GLYPHS = {
  needs_you: '<path d="M8 2.5 14.25 13.25H1.75Z"/><path d="M8 6.5v3.25M8 11.5h.01"/>',
  working: '<path d="M8 1.75a6.25 6.25 0 1 0 6.25 6.25"/>',
  bad: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.75v3.75M8 11h.01"/>',
  ok: '<circle cx="8" cy="8" r="6.25"/><path d="M5.25 8.25 7.25 10.25 10.75 6"/>',
  run: '<path d="M5.5 3.75v8.5l6.75-4.25z"/>',
  tag: '<path d="M2.5 6.5V3.5h3l7 7-3 3-7-7z"/><circle cx="5" cy="6" r=".8"/>',
  need: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.5M8 10.8v.2"/>',
};

function glyph(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = GLYPHS[kind];
  return svg;
}

// Access to a chosen folder can lapse when Chrome restarts, and can only be
// renewed from a press like this one. If it is refused, the sweep says so.
// One site (`only`), or the sites Get New Documents chose (`sites`).
async function start(only, sites) {
  for (const name of ["destination", "inbox"]) {
    try {
      const handle = await getFolder(name);
      if (handle) await askFor(handle);
    } catch (e) { /* the sweep reports a folder it cannot use */ }
  }
  chrome.runtime.sendMessage(only ? { type: "sweep", only } : { type: "sweep", sites });
}
// Brings a site's tab, and its window, to the front. A tab closed meanwhile
// has nothing to show; the engine takes the button away once it hears.
async function showTab(tabId) {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (e) { /* that tab is gone */ }
}
const busyIn = (board) => Object.values(board).some((s) => s.state === "working" || s.state === "needs_you");
const count = (rows, pattern) => rows.reduce((sum, r) => sum + Number((pattern.exec(r.text) || [0, 0])[1]), 0);

// Where each site stands, from the dates of what it has saved (cadence.js).
let standing = {};
// Card offers: the sites they are on for, and what each site's cards showed
// on the last run (offers.js). Only for sites that have offers.
let offersOn = [];
let offerDetails = {};
let today = localIso();

// The sites that need updating, as PaperPull's Get new for all chooses them:
// every site not switched off in Settings that may have something new (due,
// overdue, tax forms in season, a possible gap), that has too little history
// to say, or whose last run stopped. A site that is up to date is left out.
function targetsOf(board, off) {
  return PROVIDERS.filter((p) => !off.includes(p.id)
    && ((board[p.id] && board[p.id].state === "bad") || !standing[p.id] || needsRun(standing[p.id])))
    .map((p) => p.id);
}

// What Get New Documents runs this time: the ticked sites. Each time the popup
// opens they start as the sites that need updating; your ticks then last
// until it closes, and are never saved. Switching a site off is in Settings.
let picked = null;
const pickedOf = (off) => PROVIDERS.filter((p) => picked && picked.has(p.id) && !off.includes(p.id)).map((p) => p.id);

function say(board, off) {
  const rows = PROVIDERS.filter((p) => board[p.id]).map((p) => ({ name: p.name, ...board[p.id] }));
  const inState = (state) => rows.filter((r) => r.state === state);
  const [needs, working, stopped, done] = ["needs_you", "working", "bad", "ok"].map(inState);
  const fresh = count(done, /^(\d+) new\./) + count(stopped, /^(\d+) saved/);
  if (needs.length) return ["attention", needs.length === 1 ? `${needs[0].name} needs you` : `${needs.length} sites need you`];
  if (working.length) return ["", working.length === 1 ? `Working on ${working[0].name}…` : `Working on ${working.length} sites…`];
  if (stopped.length) return ["stopped", `${fresh} new, ${stopped.length} stopped`];
  if (done.length) return ["", fresh ? `${fresh} new ${fresh === 1 ? "document" : "documents"}` : "Nothing new"];
  const swept = PROVIDERS.filter((p) => !off.includes(p.id)).length;
  if (!swept) return ["", "All sites are switched off in Settings"];
  const needIds = targetsOf(board, off);
  const tickedIds = pickedOf(off);
  const need = needIds.length;
  const ticked = tickedIds.length;
  const sites = (n) => `${n} ${n === 1 ? "site" : "sites"}`;
  if (!ticked) return ["", need ? `${sites(need)} need updating, none ticked` : "Everything is up to date"];
  // As it opened: exactly the sites that need updating are ticked.
  const asOpened = ticked === need && tickedIds.every((id) => needIds.includes(id));
  if (asOpened) return ["", swept > need ? `${sites(need)} need updating, ${swept - need} up to date` : `${sites(need)} need updating`];
  return ["", `${sites(ticked)} ticked, ${sites(need)} need updating`];
}

function drawHeader(board, off) {
  const busy = busyIn(board);
  const [kind, text] = say(board, off);
  summary.textContent = text;
  summary.dataset.kind = kind;
  go.textContent = busy ? "Working…" : "Get New Documents";
  go.disabled = busy || !pickedOf(off).length;
}

// The site's own small logo, from Chrome's favicon cache: nothing is bundled
// or fetched from the site. Decoration only, since the name beside it says
// which site it is. A site Chrome has never shown gets Chrome's globe.
function siteIcon(provider) {
  const img = document.createElement("img");
  img.className = "favicon";
  img.alt = "";
  img.setAttribute("aria-hidden", "true");
  img.width = 16;
  img.height = 16;
  img.decoding = "async";
  const url = new URL(chrome.runtime.getURL("/_favicon/"));
  url.search = new URLSearchParams({ pageUrl: provider.listUrl, size: "32" }).toString();
  img.src = url.href;
  // Without the favicon permission yet (before the extension is reloaded), the
  // space is kept and nothing broken is shown.
  img.addEventListener("error", () => { img.style.visibility = "hidden"; });
  return img;
}

function row(provider, status, off, busy, board, skipped) {
  const li = document.createElement("li");
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  const switchedOff = off.includes(provider.id);
  box.checked = !switchedOff && picked.has(provider.id);
  box.disabled = switchedOff;
  if (switchedOff) {
    box.title = "Switched off in Settings";
    li.classList.add("switched-off");
  }
  box.dataset.focus = `box:${provider.id}`;
  box.addEventListener("change", () => {
    if (box.checked) picked.add(provider.id); else picked.delete(provider.id);
    drawHeader(board, off);
  });
  const name = document.createElement("span");
  name.className = "name";
  name.append(siteIcon(provider), provider.name);
  label.append(box, name);
  li.append(label);
  if (status) {
    const mark = glyph(status.state);
    mark.classList.add("state");
    mark.dataset.state = status.state;
    li.append(mark);
  }
  const one = document.createElement("button");
  one.className = "icon one";
  one.type = "button";
  one.title = `Run ${provider.name}`;
  one.setAttribute("aria-label", `Run ${provider.name}`);
  one.dataset.focus = `run:${provider.id}`;
  one.disabled = busy;
  one.append(glyph("run"));
  one.addEventListener("click", () => start(provider.id));
  li.append(one);
  // A site whose tab is open, waiting for you, stopped or still going, can
  // take you to it. Stays pressable while a run goes: that is when it is needed.
  if (status && status.tab != null) {
    li.classList.add("has-show");
    const show = document.createElement("button");
    show.className = "show";
    show.type = "button";
    show.textContent = "Show";
    show.title = `Show ${provider.name}'s tab`;
    show.setAttribute("aria-label", `Show ${provider.name}`);
    show.dataset.focus = `show:${provider.id}`;
    show.addEventListener("click", () => showTab(status.tab));
    li.append(show);
  }
  // Where the site stands by its own history, in words, under its name.
  const standingOf = standing[provider.id];
  if (standingOf) {
    const when = document.createElement("div");
    when.className = "when";
    when.dataset.need = stateOf(standingOf);
    when.textContent = statusWords(standingOf, today, { skipped });
    // A possible gap you know is expected can be dismissed: that window is not
    // shown or counted again. A gap somewhere new still is.
    if (standingOf.gaps.length) {
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "dismiss";
      dismiss.textContent = "Dismiss";
      const words = standingOf.gaps.map(gapWords).join(", ");
      dismiss.setAttribute("aria-label", `Dismiss possible gap for ${provider.name}: ${words}`);
      dismiss.title = "This gap is expected. Stop flagging it.";
      dismiss.dataset.focus = `dismiss:${provider.id}`;
      dismiss.addEventListener("click", async () => {
        const key = `gapsOk:${provider.id}`;
        const { [key]: kept = [] } = await chrome.storage.local.get(key);
        await chrome.storage.local.set({ [key]: [...new Set([...kept, ...standingOf.gaps.map(gapKey)])] });
        await draw();
        // A site ticked only for that gap no longer needs updating: untick it now.
        if (!needsRun(standing[provider.id]) && picked.delete(provider.id)) draw();
      });
      when.append(" ", dismiss);
    }
    li.append(when);
  }
  if (status && status.text) {
    const text = document.createElement("div");
    text.className = "say";
    text.textContent = status.text;
    li.append(text);
  }
  // What the card offers did, on a line of its own, so a stop there is
  // orange while the site's statements stay as they are.
  if (status && status.offers && status.offers.text) {
    const line = document.createElement("div");
    line.className = "offers-line";
    line.dataset.kind = status.offers.kind || "done";
    line.textContent = status.offers.text;
    li.append(line);
  }
  if (hasOffers(provider)) li.append(offersPill(provider));
  return li;
}

// A link to the Card Offers page, on this site, saying where its offers stand.
function offersPill(provider) {
  const a = document.createElement("a");
  a.className = "pill";
  a.href = `offers.html#${provider.id}`;
  a.target = "_blank";
  a.dataset.focus = `offers:${provider.id}`;
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  let kind, icon = "tag", words;
  if (!offersOn.includes(provider.id)) {
    [kind, icon, words] = ["off", "", "Turn on card offers…"];
  } else {
    const n = offerCounts(offerDetails[provider.id], today);
    if (n.needs) [kind, icon, words] = ["need", "need", `${plural(n.needs, "offer")} need${n.needs === 1 ? "s" : ""} you`];
    else if (n.addedToday && n.waiting) [kind, words] = ["on", `${plural(n.addedToday, "offer")} added today · ${n.waiting} waiting`];
    else if (n.addedToday) [kind, words] = ["on", `${plural(n.addedToday, "offer")} added today`];
    else if (n.waiting) [kind, words] = ["on", `${plural(n.waiting, "offer")} waiting`];
    else if (n.cards) [kind, words] = ["on", "Card offers all added"];
    else [kind, words] = ["on", "Card offers on"];
  }
  a.dataset.kind = kind;
  a.setAttribute("aria-label", `${words.replace(/…$/, "")}, ${provider.name}. Opens Card Offers.`);
  if (icon) a.append(glyph(icon));
  a.append(words);
  return a;
}

function drawFooter() {
  const sites = PROVIDERS.filter(hasOffers);
  const foot = document.getElementById("offersFoot");
  foot.hidden = !sites.length;
  const on = sites.filter((p) => offersOn.includes(p.id)).length;
  document.getElementById("offersOnCount").textContent = on ? `Card offers on for ${on} ${on === 1 ? "site" : "sites"}` : "Card offers are off";
}

async function draw() {
  const { board = {} } = await chrome.storage.session.get("board");
  const offerSites = PROVIDERS.filter(hasOffers);
  const stored = await chrome.storage.local.get(["off", ...PROVIDERS.flatMap((p) => keysFor(p.id)), OFFERS_ON, ...offerSites.map((p) => detailsKey(p.id))]);
  const off = stored.off || [];
  today = localIso();
  offersOn = Array.isArray(stored[OFFERS_ON]) ? stored[OFFERS_ON] : [];
  offerDetails = Object.fromEntries(offerSites.map((p) => [p.id, liveDetails(stored[detailsKey(p.id)], today)]));
  drawFooter();
  standing = Object.fromEntries(PROVIDERS.map((p) => [p.id, siteStatus(recordOf(stored, p.id), today)]));
  const busy = busyIn(board);
  const hasResults = Object.keys(board).length > 0;
  // First draw after opening: tick the sites that need updating.
  if (!picked) picked = new Set(targetsOf(board, off));
  drawHeader(board, off);
  // Within each run state, what needs you first, as PaperPull's home page
  // lists it: late, then tax forms and gaps, then too little history, then
  // up to date; the longest waiting first, then the site list's own order.
  // A site switched off in Settings goes last: it will not run, whatever its need.
  const order = (p) => [off.includes(p.id) ? 1 : 0, rankOf(standing[p.id]), -(standing[p.id].ageDays || 0), PROVIDERS.indexOf(p)];
  const byNeed = (a, b) => {
    const [x, y] = [order(a), order(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3];
  };
  // A redraw must not take the keyboard or the scroll position away from you.
  const kept = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focus : "";
  const top = scroll.scrollTop;
  scroll.replaceChildren(...SECTIONS.flatMap(([state, title]) => {
    const members = PROVIDERS.filter((p) => (board[p.id] ? board[p.id].state : "") === state).sort(byNeed);
    if (!members.length) return [];
    const section = document.createElement("section");
    section.dataset.state = state;
    const heading = document.createElement("h2");
    heading.id = `heading-${state || "sites"}`;
    heading.textContent = state === "" && hasResults ? "Not Run Yet" : title;
    const list = document.createElement("ul");
    list.setAttribute("aria-labelledby", heading.id);
    // After a run, a ticked site that was left out for being up to date says so.
    const skipped = (p) => hasResults && !board[p.id] && !off.includes(p.id) && !needsRun(standing[p.id]);
    list.append(...members.map((p) => row(p, board[p.id], off, busy, board, skipped(p))));
    section.append(heading, list);
    return [section];
  }));
  scroll.scrollTop = top;
  if (kept) {
    const again = scroll.querySelector(`[data-focus="${CSS.escape(kept)}"]`);
    if (again && !again.disabled) again.focus();
  }
}

go.addEventListener("click", async () => {
  const { board = {} } = await chrome.storage.session.get("board");
  const { off = [] } = await chrome.storage.local.get("off");
  const sites = pickedOf(off);
  if (sites.length) start(undefined, sites);
});
document.getElementById("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
chrome.runtime.onMessage.addListener((m) => { if (m.type === "board") draw(); });
draw();
