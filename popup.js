import { PROVIDERS } from "./providers/index.js";

const go = document.getElementById("go");
const list = document.getElementById("list");

async function start(only) {
  chrome.runtime.sendMessage({ type: "sweep", only });
}

async function draw() {
  const { board = {} } = await chrome.storage.session.get("board");
  const { off = [] } = await chrome.storage.local.get("off");
  list.replaceChildren(...PROVIDERS.map((p) => {
    const li = document.createElement("li");
    const s = board[p.id];
    li.dataset.state = s ? s.state : "";
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox"; box.checked = !off.includes(p.id);
    box.addEventListener("change", async () => {
      const { off: now = [] } = await chrome.storage.local.get("off");
      await chrome.storage.local.set({ off: box.checked ? now.filter((x) => x !== p.id) : [...now, p.id] });
    });
    const name = document.createElement("span"); name.textContent = p.name;
    label.append(box, name);
    const one = document.createElement("button");
    one.className = "one"; one.type = "button"; one.textContent = "Run";
    one.setAttribute("aria-label", `Run ${p.name}`);
    one.addEventListener("click", () => start(p.id));
    const say = document.createElement("div");
    say.className = "say"; say.textContent = s ? s.text : "";
    li.append(label, one, say);
    return li;
  }));
  go.disabled = Object.values(board).some((s) => s.state === "working" || s.state === "needs_you");
}
go.addEventListener("click", () => start());
document.getElementById("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
chrome.runtime.onMessage.addListener((m) => { if (m.type === "board") draw(); });
draw();
