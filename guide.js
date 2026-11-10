// The guide card: while the sweep waits on a site for you (a sign-in, a check
// the site asks for, or one thing it needs, such as Shelby County's parcel),
// a small card in that site's tab, bottom right, says what to do. Check now
// asks the sweep to look at the tab again straight away; Skip this site ends
// that site's wait for this run; the × hides the card on this page.
//
// Injected by background.js in the extension's isolated world, then called
// with the text to show. It never reads the page or fills anything in: it
// only adds its own element, in a closed shadow root with its own styles, so
// the page's styles do not reach it and its styles do not reach the page.
(() => {
  if (globalThis.__sweepGuide) return;

  // The card of each site in this page, and the sites whose card you closed.
  const cards = new Map();
  const closed = new Set();

  // The popup's tokens (ui.css), light and dark.
  const STYLE = `
    :host { all: initial; }
    .card {
      --ink: #1d1d1f; --secondary: #6a6a6f; --group: #ffffff;
      --hover: rgb(0 0 0 / .06); --press: rgb(0 0 0 / .12);
      --separator: rgb(60 60 67 / .16); --accent: #0071e3; --accent-press: #0060c2;
      --accent-ink: #0066cc; --orange: #b34700; --radius: 10px;
      box-sizing: border-box; width: 320px; max-width: calc(100vw - 32px);
      padding: 12px 12px 12px 14px; border-radius: var(--radius);
      background: var(--group); color: var(--ink);
      box-shadow: 0 0 0 .5px var(--separator), 0 8px 28px rgb(0 0 0 / .18), 0 1px 3px rgb(0 0 0 / .1);
      font: 13px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased; text-align: left; color-scheme: light;
      animation: rise 200ms cubic-bezier(.2, .7, .3, 1) both;
    }
    @media (prefers-color-scheme: dark) {
      .card {
        --ink: #f5f5f7; --secondary: #a3a3a9; --group: #2c2c2e;
        --hover: rgb(255 255 255 / .1); --press: rgb(255 255 255 / .18);
        --separator: rgb(235 235 245 / .14); --accent-ink: #5aa9ff; --orange: #ffb340;
        box-shadow: 0 0 0 .5px var(--separator), 0 8px 28px rgb(0 0 0 / .5);
        color-scheme: dark;
      }
    }
    @media (prefers-contrast: more) {
      .card { --secondary: #48484a; --separator: rgb(60 60 67 / .5); }
    }
    @media (prefers-contrast: more) and (prefers-color-scheme: dark) {
      .card { --secondary: #d1d1d6; --separator: rgb(235 235 245 / .5); }
    }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } }
    @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
    * { box-sizing: border-box; }
    .head { display: grid; grid-template-columns: 1fr 24px; gap: 0 8px; align-items: start; }
    .label { margin: 0; color: var(--secondary); font-size: 11px; line-height: 14px; font-weight: 600; }
    .site { display: flex; align-items: center; gap: 7px; margin: 3px 0 0; font-size: 13px; line-height: 18px; font-weight: 600; overflow-wrap: anywhere; }
    .site img { flex: none; width: 16px; height: 16px; border-radius: 3px; }
    .close {
      display: grid; place-items: center; width: 24px; height: 24px; margin: -4px -4px 0 0; padding: 0;
      border: 0; border-radius: 6px; background: none; color: var(--secondary); cursor: default;
      transition: background-color 150ms ease-out, color 150ms ease-out;
    }
    .close:hover { background: var(--hover); color: var(--ink); }
    .close:active { background: var(--press); }
    .close svg { width: 12px; height: 12px; display: block; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
    .steps { margin: 8px 0 0; padding: 0; list-style: none; counter-reset: step; }
    .steps li { position: relative; margin: 0; padding: 0 0 0 22px; text-wrap: pretty; }
    .steps li + li { margin-top: 4px; }
    .steps li::before {
      counter-increment: step; content: counter(step); position: absolute; left: 0; top: 1px;
      display: grid; place-items: center; width: 16px; height: 16px; border-radius: 50%;
      background: var(--hover); color: var(--secondary); font-size: 10px; line-height: 1; font-weight: 600;
    }
    .steps.one li { padding: 0; }
    .steps.one li::before { content: none; }
    .actions { display: flex; gap: 8px; margin-top: 12px; }
    button { font: inherit; }
    .primary, .secondary {
      min-height: 28px; padding: 0 12px; border: 0; border-radius: 7px; font-size: 13px; font-weight: 500;
      cursor: default; transition: background-color 150ms ease-out;
    }
    .primary { background: var(--accent); color: #fff; }
    .primary:hover:not(:disabled) { background: var(--accent-press); }
    .primary:disabled { background: var(--press); color: var(--secondary); }
    .secondary { background: var(--hover); color: var(--ink); }
    .secondary:hover { background: var(--press); }
    :focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: 1px; }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  `;

  const make = (doc, tag, props = {}) => Object.assign(doc.createElement(tag), props);

  // Only a press by a person counts: a page's script can make an element
  // look clicked, but not with a trusted event.
  const press = (site, action) => (event) => {
    if (!event.isTrusted) return;
    try { chrome.runtime.sendMessage({ type: "guide", action, site }).catch(() => {}); } catch (e) { /* the extension was reloaded */ }
  };

  function build({ site, name, icon, steps }) {
    const doc = document;
    const host = doc.createElement("statement-sweep-guide");
    // Inline and important, so no page style moves or hides the host.
    host.setAttribute("style", "all: initial !important; position: fixed !important; right: 16px !important; bottom: 16px !important; z-index: 2147483647 !important; display: block !important;");
    const root = host.attachShadow({ mode: "closed" });
    const style = make(doc, "style", { textContent: STYLE });
    const card = make(doc, "div", { className: "card" });
    card.setAttribute("role", "region");
    card.setAttribute("aria-label", `Statement Sweep: ${name}`);

    const head = make(doc, "div", { className: "head" });
    const titles = make(doc, "div");
    titles.append(make(doc, "p", { className: "label", textContent: "Statement Sweep" }));
    const siteLine = make(doc, "p", { className: "site" });
    if (icon) {
      const img = make(doc, "img", { alt: "", width: 16, height: 16, decoding: "async" });
      // A page that does not allow the image gets just the name.
      img.addEventListener("error", () => img.remove());
      img.src = icon;
      siteLine.append(img);
    }
    siteLine.append(make(doc, "span", { textContent: name }));
    titles.append(siteLine);
    const close = make(doc, "button", { className: "close", type: "button", title: "Hide" });
    close.setAttribute("aria-label", "Hide this card on this page");
    close.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';
    close.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      closed.add(site);
      hide(site);
    });
    head.append(titles, close);

    const list = make(doc, "ol", { className: steps.length === 1 ? "steps one" : "steps" });
    for (const step of steps) list.append(make(doc, "li", { textContent: step }));

    const actions = make(doc, "div", { className: "actions" });
    const check = make(doc, "button", { className: "primary", type: "button", textContent: "Check now" });
    const skip = make(doc, "button", { className: "secondary", type: "button", textContent: "Skip this site" });
    const sendCheck = press(site, "check");
    check.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      sendCheck(event);
      // A moment's sign that it was heard; the sweep looks again meanwhile.
      check.disabled = true;
      check.textContent = "Checking…";
      setTimeout(() => { check.disabled = false; check.textContent = "Check now"; }, 1500);
    });
    const sendSkip = press(site, "skip");
    skip.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      sendSkip(event);
      hide(site);
    });
    actions.append(check, skip);

    card.append(head, list, actions);
    root.append(style, card);
    return host;
  }

  // Draws the site's card, or leaves it as it is when it already says the
  // same. Answers "shown" when it was drawn, "kept", or "closed" when you
  // closed it on this page.
  function show(options) {
    const { site } = options;
    const steps = (options.steps || []).map(String).filter(Boolean).slice(0, 3);
    if (!site || !steps.length) return "none";
    if (closed.has(site)) return "closed";
    const key = JSON.stringify([options.name, steps]);
    const have = cards.get(site);
    if (have && have.host.isConnected && have.key === key) return "kept";
    if (have) have.host.remove();
    const host = build({ ...options, steps });
    // On the root element, which a page that replaces its body keeps.
    (document.documentElement || document).append(host);
    cards.set(site, { host, key });
    return "shown";
  }

  // Takes the site's card away. True when there was one to take.
  function hide(site) {
    const have = cards.get(site);
    cards.delete(site);
    if (!have || !have.host.isConnected) return false;
    have.host.remove();
    return true;
  }

  globalThis.__sweepGuide = { show, hide };
})();
