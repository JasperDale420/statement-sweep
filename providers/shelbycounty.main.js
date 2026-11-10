// Put in Shelby County Trustee's page world by the engine (chrome.scripting,
// world MAIN) before a save, so it never depends on inserting a <script>.
// It only listens: shelbycounty.page.js arms it for one press by sending the
// "statement-sweep-arm" event with a fresh nonce. While armed it keeps the one
// Blob the page makes and records what the page asks to open, opening nothing,
// then hands both back by postMessage and puts everything back as it was.
//
// Derived from PaperPull's apps/shelbycounty/shelbycounty_site.py (AGPL-3.0).
(() => {
  if (window.__statementSweepShelbyMain) return;
  window.__statementSweepShelbyMain = true;

  document.addEventListener("statement-sweep-arm", (event) => {
    const nonce = typeof event.detail === "string" ? event.detail : "";
    if (!/^sweep-[a-z0-9]{6,40}$/.test(nonce)) return;
    const made = [], opened = [];
    const realCreate = URL.createObjectURL, realOpen = window.open;
    URL.createObjectURL = function (b) {
      const u = realCreate.call(URL, b);
      made.push({ blob: b, type: (b && b.type) || "", size: (b && b.size) || 0, url: String(u) });
      return u;
    };
    window.open = function (u) { opened.push(String(u)); return null; };
    const restore = () => {
      URL.createObjectURL = realCreate;
      window.open = realOpen;
      window.removeEventListener("message", onAsk);
    };
    async function onAsk(e) {
      if (e.source !== window || !e.data || e.data.sweepAsk !== nonce) return;
      if (e.data.what === "count") {
        window.postMessage({ sweepAnswer: nonce, what: "count", made: made.length, opened: opened.length }, location.origin);
        return;
      }
      if (e.data.what === "restore") { restore(); return; }
      const out = { sweepAnswer: nonce, what: "take", blobs: made.map((b) => ({ type: b.type, size: b.size, url: b.url })), opened: opened.slice(), bytes: "" };
      try {
        if (made.length === 1) {
          const bytes = new Uint8Array(await made[0].blob.arrayBuffer());
          let bin = "";
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          out.bytes = btoa(bin);
        }
      } catch (err) {
        out.bytes = "";
      } finally {
        restore();
      }
      window.postMessage(out, location.origin);
    }
    window.addEventListener("message", onAsk);
    document.documentElement.setAttribute("data-sweep-armed", nonce);
  });
})();
