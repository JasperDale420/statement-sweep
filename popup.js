const go = document.getElementById("go");
const status = document.getElementById("status");

async function show() {
  const { status: s } = await chrome.storage.session.get("status");
  if (!s) return;
  status.textContent = s.text;
  status.dataset.state = s.state;
  go.disabled = s.state === "working" || s.state === "needs_you";
}
go.addEventListener("click", async () => {
  go.disabled = true;
  await chrome.storage.session.set({ status: { state: "working", text: "Starting…" } });
  await show();
  chrome.runtime.sendMessage({ type: "sweep" });
});
chrome.runtime.onMessage.addListener((m) => { if (m.type === "status") show(); });
show();
