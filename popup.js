import { PROVIDERS } from "./providers/index.js";

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
};

function glyph(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = GLYPHS[kind];
  return svg;
}

const start = (only) => chrome.runtime.sendMessage({ type: "sweep", only });
const busyIn = (board) => Object.values(board).some((s) => s.state === "working" || s.state === "needs_you");
const count = (rows, pattern) => rows.reduce((sum, r) => sum + Number((pattern.exec(r.text) || [0, 0])[1]), 0);

function say(board, off) {
  const rows = PROVIDERS.filter((p) => board[p.id]).map((p) => ({ name: p.name, ...board[p.id] }));
  const inState = (state) => rows.filter((r) => r.state === state);
  const [needs, working, stopped, done] = ["needs_you", "working", "bad", "ok"].map(inState);
  const fresh = count(done, /^(\d+) new\./) + count(stopped, /^(\d+) saved/);
  if (needs.length) return ["attention", needs.length === 1 ? `${needs[0].name} needs you` : `${needs.length} sites need you`];
  if (working.length) return ["", `Working on ${working[0].name}…`];
  if (stopped.length) return ["stopped", `${fresh} new, ${stopped.length} stopped`];
  if (done.length) return ["", fresh ? `${fresh} new ${fresh === 1 ? "document" : "documents"}` : "Nothing new"];
  const chosen = PROVIDERS.filter((p) => !off.includes(p.id)).length;
  return ["", chosen ? `${chosen} of ${PROVIDERS.length} sites selected` : "No sites selected"];
}

function drawHeader(board, off) {
  const busy = busyIn(board);
  const [kind, text] = say(board, off);
  summary.textContent = text;
  summary.dataset.kind = kind;
  go.textContent = busy ? "Working…" : "Get New Documents";
  go.disabled = busy || PROVIDERS.every((p) => off.includes(p.id));
}

function row(provider, status, off, busy, board) {
  const li = document.createElement("li");
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = !off.includes(provider.id);
  box.dataset.focus = `box:${provider.id}`;
  box.addEventListener("change", async () => {
    const { off: now = [] } = await chrome.storage.local.get("off");
    const next = box.checked ? now.filter((x) => x !== provider.id) : [...now, provider.id];
    await chrome.storage.local.set({ off: next });
    drawHeader(board, next);
  });
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = provider.name;
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
  if (status && status.text) {
    const text = document.createElement("div");
    text.className = "say";
    text.textContent = status.text;
    li.append(text);
  }
  return li;
}

async function draw() {
  const { board = {} } = await chrome.storage.session.get("board");
  const { off = [] } = await chrome.storage.local.get("off");
  const busy = busyIn(board);
  const hasResults = Object.keys(board).length > 0;
  drawHeader(board, off);
  // A redraw must not take the keyboard or the scroll position away from you.
  const kept = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.focus : "";
  const top = scroll.scrollTop;
  scroll.replaceChildren(...SECTIONS.flatMap(([state, title]) => {
    const members = PROVIDERS.filter((p) => (board[p.id] ? board[p.id].state : "") === state);
    if (!members.length) return [];
    const section = document.createElement("section");
    section.dataset.state = state;
    const heading = document.createElement("h2");
    heading.id = `heading-${state || "sites"}`;
    heading.textContent = state === "" && hasResults ? "Not Run Yet" : title;
    const list = document.createElement("ul");
    list.setAttribute("aria-labelledby", heading.id);
    list.append(...members.map((p) => row(p, board[p.id], off, busy, board)));
    section.append(heading, list);
    return [section];
  }));
  scroll.scrollTop = top;
  if (kept) {
    const again = scroll.querySelector(`[data-focus="${CSS.escape(kept)}"]`);
    if (again && !again.disabled) again.focus();
  }
}

go.addEventListener("click", () => start());
document.getElementById("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
chrome.runtime.onMessage.addListener((m) => { if (m.type === "board") draw(); });
draw();
