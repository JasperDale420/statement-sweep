// The picker for Add This Site: a card in the page, bottom right, like the
// guide card, that asks you to click one statement link. That click is caught
// before the page sees it, so nothing opens. From that one link it finds the
// others like it (providers/added.page.js, loaded first), outlines them in
// green, and says how many there are and where their dates come from. Add
// Site sends the pattern, and only the pattern, to the engine to keep.
//
// Injected by the popup's Add This Site, or Settings' Pick Again, in the
// extension's isolated world, then started with __sweepPicker.start(). It
// reads the page only to find the links like the one you picked, and changes
// nothing in it: its card and outlines are its own elements, in a closed
// shadow root with its own styles, laid over the page.
(() => {
  if (globalThis.__sweepPicker) return;

  // The guide card's look (guide.js), with a field, choices and outlines.
  const STYLE = `
    :host { all: initial; }
    .card {
      --ink: #1d1d1f; --secondary: #6a6a6f; --group: #ffffff; --field: #ffffff;
      --hover: rgb(0 0 0 / .06); --press: rgb(0 0 0 / .12);
      --separator: rgb(60 60 67 / .16); --separator-strong: rgb(60 60 67 / .42);
      --accent: #0071e3; --accent-press: #0060c2; --accent-ink: #0066cc;
      --orange: #b34700; --green: #248a3d; --radius: 10px;
      position: fixed; right: 16px; bottom: 16px; pointer-events: auto;
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
        --ink: #f5f5f7; --secondary: #a3a3a9; --group: #2c2c2e; --field: #1c1c1e;
        --hover: rgb(255 255 255 / .1); --press: rgb(255 255 255 / .18);
        --separator: rgb(235 235 245 / .14); --separator-strong: rgb(235 235 245 / .42);
        --accent-ink: #5aa9ff; --orange: #ffb340; --green: #30db5b;
        box-shadow: 0 0 0 .5px var(--separator), 0 8px 28px rgb(0 0 0 / .5);
        color-scheme: dark;
      }
    }
    @media (prefers-contrast: more) {
      .card { --secondary: #48484a; --separator: rgb(60 60 67 / .5); }
    }
    @keyframes rise { from { opacity: 0; transform: translateY(8px); } }
    @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
    * { box-sizing: border-box; }
    .head { display: grid; grid-template-columns: 1fr 24px; gap: 0 8px; align-items: start; }
    .label { margin: 0; color: var(--secondary); font-size: 11px; line-height: 14px; font-weight: 600; }
    .title { margin: 3px 0 0; font-size: 13px; line-height: 18px; font-weight: 600; overflow-wrap: anywhere; }
    .close {
      display: grid; place-items: center; width: 24px; height: 24px; margin: -4px -4px 0 0; padding: 0;
      border: 0; border-radius: 6px; background: none; color: var(--secondary); cursor: default;
    }
    .close:hover { background: var(--hover); color: var(--ink); }
    .close svg { width: 12px; height: 12px; display: block; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
    p { margin: 6px 0 0; text-wrap: pretty; }
    .quiet { color: var(--secondary); font-size: 12px; line-height: 16px; margin-top: 2px; }
    .problem { color: var(--orange); font-weight: 500; }
    .problem:empty { display: none; }
    .field { display: grid; gap: 4px; margin-top: 10px; }
    .field span, legend { font-size: 12px; line-height: 16px; font-weight: 600; color: var(--secondary); }
    input[type=text] {
      width: 100%; min-height: 28px; padding: 3px 8px; border: 1px solid var(--separator-strong); border-radius: 6px;
      background: var(--field); color: var(--ink); font: inherit;
    }
    fieldset { margin: 10px 0 0; padding: 0; border: 0; min-width: 0; }
    legend { padding: 0; margin-bottom: 4px; }
    .choice { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
    .choice input { margin: 0; accent-color: var(--accent); }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
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
    .box {
      position: fixed; pointer-events: none; border-radius: 4px;
      font: 600 11px/14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .box.hover { outline: 2px dashed #0071e3; outline-offset: 2px; background: rgb(0 113 227 / .06); }
    .box.like { outline: 2px solid #248a3d; outline-offset: 2px; background: rgb(36 138 61 / .1); }
    .box.picked { outline-width: 3px; background: rgb(36 138 61 / .18); }
    /* Beside the link, not above it, so a tight table's next row stays readable. */
    .box span {
      position: absolute; left: calc(100% + 8px); top: 50%; transform: translateY(-50%); padding: 1px 6px; border-radius: 4px;
      background: #248a3d; color: #fff; white-space: nowrap;
    }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  `;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const shortDate = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const make = (tag, props = {}) => Object.assign(document.createElement(tag), props);
  const problemLine = () => { const p = make("p", { className: "problem" }); p.setAttribute("role", "alert"); return p; };

  let host = null, root = null, card = null, layer = null, hoverBox = null;
  // "pick" while waiting for your click, "found" once links are found, "added" once kept.
  let mode = null;
  let options = {};
  let found = null;
  let boxes = [];
  let frame = 0;

  // A name for the site from the page's title, or else its host. You can change it.
  const GENERIC = /^(e-?)?(statements?|documents?|accounts?|account\s+\w+|home|dashboard|online\s+banking|sign\s*in|log\s*in|welcome|my\s+\w+|billing|bills?|history|activity|overview|paperless|tax\s+(forms|documents))$/i;
  function nameGuess() {
    const parts = String(document.title || "").split(/\s+[-–—:]\s+|\s*[|·•»]\s*/).map((s) => s.trim())
      .filter((s) => s && !/\d/.test(s) && s.length <= 40 && !GENERIC.test(s));
    if (parts.length) return parts[parts.length - 1];
    const labels = location.hostname.replace(/^www\d*\./, "").split(".");
    const word = labels.find((l, i) => i < labels.length - 1 && !/^(secure|online|my|app|login|accounts?|portal|web|m)$/.test(l)) || labels[0];
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  const fromCard = (event) => Boolean(host) && event.composedPath().includes(host);

  // -- outlines over the page --------------------------------------------------------
  function place(box, el) {
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, display: r.width || r.height ? "block" : "none" });
  }
  function replace() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => { for (const [el, box] of boxes) place(box, el); });
  }
  function clearBoxes() {
    for (const [, box] of boxes) box.remove();
    boxes = [];
  }
  function outline(matches) {
    clearBoxes();
    for (const m of matches) {
      const box = make("div", { className: m.picked ? "box like picked" : "box like" });
      box.append(make("span", { textContent: m.picked ? "You picked this" : "Like it" }));
      box.dataset.kind = m.picked ? "picked" : "like";
      layer.append(box);
      place(box, m.el);
      boxes.push([m.el, box]);
    }
  }

  // -- the page's own events, while the card is up ---------------------------------------
  function hover(event) {
    if (mode !== "pick" || fromCard(event)) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!link) { hoverBox.style.display = "none"; return; }
    place(hoverBox, link);
  }
  // A press on a link, or a button, is kept from the page: nothing opens. A
  // press anywhere else (a year tab, a scroll bar) goes on as usual while you
  // pick. Once links are found, links stay closed until the card goes.
  function intercept(event) {
    if (!mode || mode === "added" || fromCard(event)) return;
    const el = event.target instanceof Element ? event.target : null;
    const link = el && el.closest("a");
    const control = !link && el && mode === "pick" ? el.closest("button, input[type=button], input[type=submit], input[type=image], [role=button], [role=link]") : null;
    if (!link && !control) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (event.type !== "click" || !event.isTrusted || mode !== "pick") return;
    if (link) pick(link);
    else say("That's a button, not a link. Add This Site works only where each statement is a link you can click.");
  }
  function key(event) {
    if (event.key === "Escape" && mode && event.isTrusted) stop();
  }
  const PRESSES = ["click", "auxclick", "mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"];
  function listen(on) {
    const how = on ? "addEventListener" : "removeEventListener";
    for (const type of PRESSES) window[how](type, intercept, true);
    window[how]("mouseover", hover, true);
    window[how]("keydown", key, true);
    window[how]("scroll", replace, true);
    window[how]("resize", replace, true);
  }

  // -- the card ------------------------------------------------------------------------------
  function button(className, text, onPress) {
    const b = make("button", { className, type: "button", textContent: text });
    b.addEventListener("click", (event) => { if (event.isTrusted) onPress(); });
    return b;
  }
  function draw(title, ...rest) {
    const head = make("div", { className: "head" });
    const titles = make("div");
    titles.append(make("p", { className: "label", textContent: "Statement Sweep · Add This Site" }));
    titles.append(make("p", { className: "title", textContent: title }));
    const close = make("button", { className: "close", type: "button", title: "Cancel" });
    close.setAttribute("aria-label", "Cancel adding this site");
    close.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';
    close.addEventListener("click", (event) => { if (event.isTrusted) stop(); });
    head.append(titles, close);
    card.setAttribute("aria-label", `Statement Sweep: ${title}`);
    card.replaceChildren(head, ...rest);
  }
  const problem = () => card.querySelector(".problem");
  function say(text) {
    const p = problem();
    if (p) p.textContent = text;
  }

  function drawPick() {
    mode = "pick";
    found = null;
    clearBoxes();
    const actions = make("div", { className: "actions" });
    actions.append(button("secondary", "Cancel", stop));
    draw("Pick One Statement",
      make("p", { textContent: "Click the link you would press to open one statement. Statement Sweep finds the others like it." }),
      problemLine(),
      actions);
  }

  const SOURCE = {
    column: (d) => `Dates from the ${d.header || "date"} column`,
    link: () => "Dates from each link's text",
    row: () => "Dates from each row's text",
  };
  function drawFound() {
    mode = "found";
    hoverBox.style.display = "none";
    const n = found.matches.length;
    const dated = found.matches.filter((m) => m.date).length;
    const [from, to] = found.range || [];
    const lines = [];
    if (found.range) {
      lines.push(make("p", { className: "range", textContent: from === to ? shortDate(from) : `${shortDate(from)} to ${shortDate(to)}` }));
      lines.push(make("p", { className: "quiet source", textContent: `${SOURCE[found.config.date.from](found.config.date)}${dated < n ? ` · ${dated} of ${n} have one` : ""}` }));
    } else {
      lines.push(make("p", { className: "range", textContent: "No dates found" }));
      lines.push(make("p", { className: "quiet source", textContent: "Each is told apart by its link instead, and saved without a date in its name." }));
    }
    const field = make("label", { className: "field" });
    const name = make("input", { type: "text", value: options.name || nameGuess(), maxLength: 40, spellcheck: false, autocomplete: "off" });
    field.append(make("span", { textContent: "Name" }), name);
    const first = make("fieldset");
    first.append(make("legend", { textContent: "First sync" }));
    for (const [value, words, checked] of [["all", `Save all ${n} here now`, true], ["new", "Only new ones from now on", false]]) {
      const choice = make("label", { className: "choice" });
      choice.append(make("input", { type: "radio", name: "first", value, checked }), make("span", { textContent: words }));
      first.append(choice);
    }
    const actions = make("div", { className: "actions" });
    const add = button("primary", "Add Site", () => keep(name, first, add));
    actions.append(button("secondary", "Pick Again", drawPick), add);
    draw(`${plural(n, "Statement")} Found`, ...lines, field, first, problemLine(), actions);
    outline(found.matches);
  }

  // Sends the pattern to the engine, which checks it and keeps it (sites.js).
  async function keep(name, first, add) {
    const chosen = name.value.replace(/\s+/g, " ").trim();
    if (!chosen) { say("Give it a name."); name.focus(); return; }
    const firstSync = (first.querySelector("input:checked") || {}).value === "new" ? "new" : "all";
    add.disabled = true;
    let answer = null;
    try { answer = await chrome.runtime.sendMessage({ type: "addSite", config: { ...found.config, name: chosen, firstSync } }); } catch (e) { /* the extension was reloaded */ }
    if (!answer || !answer.ok) {
      add.disabled = false;
      say((answer && answer.why) || "Statement Sweep couldn't add it. Please try again.");
      return;
    }
    drawAdded(answer.name || chosen);
  }

  function drawAdded(name) {
    mode = "added";
    const actions = make("div", { className: "actions" });
    // Share This Site, a later piece, goes here beside Done.
    actions.append(button("primary", "Done", stop));
    draw(`${name} Added`, make("p", { textContent: "It syncs with your other sites." }), actions);
    actions.querySelector("button").focus();
  }

  function pick(link) {
    const learned = globalThis.__sweepAdded ? globalThis.__sweepAdded.learn(link) : { ok: false, why: "Statement Sweep couldn't read this page. Please try again." };
    if (!learned.ok) { say(learned.why); return; }
    found = learned;
    drawFound();
  }

  function start(given = {}) {
    stop();
    options = given && typeof given === "object" ? given : {};
    host = document.createElement("statement-sweep-picker");
    // Inline and important, so no page style moves or hides it. It lets every
    // press through to the page but on its card.
    host.setAttribute("style", "all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; display: block !important; pointer-events: none !important;");
    root = host.attachShadow({ mode: "closed" });
    layer = make("div");
    hoverBox = make("div", { className: "box hover" });
    hoverBox.style.display = "none";
    layer.append(hoverBox);
    card = make("div", { className: "card" });
    card.setAttribute("role", "dialog");
    root.append(make("style", { textContent: STYLE }), layer, card);
    (document.documentElement || document).append(host);
    listen(true);
    drawPick();
    return "shown";
  }

  function stop() {
    if (!host) return false;
    listen(false);
    cancelAnimationFrame(frame);
    host.remove();
    host = root = card = layer = hoverBox = null;
    mode = null;
    found = null;
    boxes = [];
    return true;
  }

  globalThis.__sweepPicker = { start, stop };
})();
