// Runs inside American Express's own page, on its Amex Offers page, after
// this site's statements are saved, when you turned offers on for it in
// Settings. Reads the offers Amex has drawn for the card on show, and adds one
// by pressing its own "Add to Card", nothing else.
//
// Amex holds its session in memory, so this never asks the browser to load
// another page. It presses Amex's own Offers link to get there, once, and
// Amex's own card switcher to move to the next card, the same careful way
// amex.page.js does for statements.
(() => {
  const K = globalThis.__offersKit;
  const LIST_WAIT_MS = 12000;
  const WALK_WAIT_MS = 30000;
  const ADD_WAIT_MS = 10000;
  const CARD_WAIT_MS = 15000;
  const SWITCHER_WAIT_MS = 5000;
  const MORE_PRESSES = 30;
  const ADD = ["Add to Card"];
  const ADDED = /^(added|added to card|offer added)$/i;
  const OFFERS_LINK = /^(amex offers|offers|amex offers & benefits|offers & benefits|offers and benefits|view all offers|see all offers)$/i;
  const AVAILABLE_TAB = /^(available|available offers|eligible|eligible offers)(\s*\(\d+\))?$/i;
  const ADDED_TAB = /^added(?: to card)?\s*\(?\s*(\d+)\s*\)?$/i;
  const MORE = /^(load|show|view|see) more( offers)?$/i;
  const NONE = /(no (available |eligible |new )?offers|you('ve| have) added all|there are no offers|check back (soon|later) for (new )?offers)/i;
  const LOGIN_MARKERS = ["/login", "/logon", "/signin", "/sign-in", "/auth", "myca/logon"];
  const CHECK_URLS = ["/mfa", "/verification", "/challenge"];
  const CHECK_MARKERS = ["enter the code", "verification code", "one-time code", "two-factor", "two-step", "confirm your identity", "verify your identity", "we sent a code", "are you a robot", "captcha", "let's confirm it's you", "unusual activity"];
  const ENDED_MARKERS = ["your session has expired", "log back in"];
  const RATE_MARKERS = ["too many requests", "rate limit", "try again later", "temporarily unavailable", "http error 429", "unusual traffic", "access denied"];
  const byTest = (op, value) => `[data-testid${op}'${value}'], [data-test-id${op}'${value}']`;
  const COMBOBOX = byTest("=", "simple_switcher_combobox");
  const OPTION = byTest("^=", "simple_switcher_product_option_");
  const NUMBER = byTest("=", "simple_switcher_display_number");
  const SELECTED = byTest("=", "simple_switcher_selected_option_display");
  const HOW_TO_GET_THERE = "Open Offers in this tab and sync again.";

  const onAmex = () => location.hostname.endsWith("americanexpress.com");
  const onOffers = () => location.pathname.startsWith("/offers");
  const firstShown = (selector) => Array.from(document.querySelectorAll(selector)).find(K.shown) || null;

  function signIn() {
    const url = location.href.toLowerCase();
    if (CHECK_URLS.some((m) => url.includes(m))) return { state: "challenge" };
    if (LOGIN_MARKERS.some((m) => url.includes(m)) || document.querySelector("input[type='password']")) return { state: "signed_out" };
    const hay = `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 1500)}`.toLowerCase();
    if (ENDED_MARKERS.some((m) => hay.includes(m))) return { state: "signed_out" };
    if (CHECK_MARKERS.some((m) => hay.includes(m))) return { state: "challenge" };
    if (RATE_MARKERS.some((m) => hay.includes(m))) return { state: "stopped", why: "American Express asked for a pause. Try again later." };
    return null;
  }

  const digitsOf = (el) => {
    const n = el && el.querySelector(NUMBER);
    return n ? n.textContent.replace(/\D/g, "") : "";
  };
  function cardOnShow() {
    const box = firstShown(SELECTED) || firstShown(COMBOBOX);
    if (!box) return "";
    const num = Array.from(box.querySelectorAll(NUMBER)).find(K.shown);
    const digits = (num ? num.innerText : "").replace(/\D/g, "");
    return /^\d{4,6}$/.test(digits) ? digits : "";
  }
  const optionDigits = () => new Set(Array.from(document.querySelectorAll(OPTION)).map(digitsOf).filter((d) => /^\d{4,6}$/.test(d)));

  // Every offer's own control on the page: an Add to Card, or the mark of
  // one already added. Header and footer menus are not offers.
  function offerControls() {
    return K.controls().filter((el) => !el.closest("header, footer, nav, [role='contentinfo'], [role='navigation']"))
      .map((el) => ({ el, name: K.nameOf(el) }))
      .filter((c) => K.isAddName(c.name, ADD) || ADDED.test(c.name));
  }

  // One offer, read from the tile around its control.
  function describe({ el, name }, all, card) {
    const tile = K.tileOf(el, all);
    const merchant = K.headingOf(tile);
    const lines = K.linesOf(tile, [name, merchant]).filter((l) => !/^exp/i.test(l));
    const title = lines.find((l) => /[$%]|\bback\b|\bpoints?\b|\bearn\b|\bspend\b|\bget\b|\bcredit\b/i.test(l)) || lines[0] || "";
    const own = tile.getAttribute("data-offer-id") || tile.getAttribute("data-offerid") || "";
    const id = `${card || "card"}:${own || K.wordsId(merchant, title)}`;
    return { id, tile, merchant, title, expires: K.expiresOf(tile.innerText || "") };
  }

  function offersOnPage(card) {
    const found = offerControls();
    const all = found.map((c) => c.el);
    const offers = [];
    const ids = new Set();
    for (const control of found) {
      const { id, merchant, title, expires } = describe(control, all, card);
      if ((!merchant && !title) || ids.has(id)) continue;
      ids.add(id);
      offers.push({ id, card, title, merchant, added: ADDED.test(control.name), ...(expires ? { expires } : {}) });
    }
    return offers;
  }

  // What has been pressed on the way, kept on the page between askings, since
  // this file is run afresh each time. A press is never repeated.
  const walk = () => (globalThis.__amexOffersWalk = globalThis.__amexOffersWalk || { pressed: new Set(), at: Date.now(), more: 0 });
  function press(el, step) {
    const w = walk();
    if (!el || w.pressed.has(step)) return false;
    w.pressed.add(step);
    el.click();
    return true;
  }

  // Amex's own link to its offers, on its own host only.
  // A link with an address must go to /offers on this same host. One
  // without (a menu entry that opens the menu) must say only its name.
  function offersLinks() {
    return Array.from(document.querySelectorAll("a[href], [role='link'], [role='menuitem']")).filter((a) => {
      if (!K.shown(a) || !OFFERS_LINK.test(K.nameOf(a))) return false;
      const href = a.getAttribute("href");
      if (!href) return a.getAttribute("role") === "menuitem";
      try {
        const to = new URL(href, location.href);
        return to.protocol === "https:" && to.hostname === location.hostname && to.pathname.startsWith("/offers");
      } catch (e) { return false; }
    });
  }

  function walkToOffers() {
    const w = walk();
    // A menu ("Offers & Benefits") may open first, then its "Amex Offers":
    // each name is pressed once.
    const step = (a) => `offers link:${K.nameOf(a).toLowerCase()}`;
    const link = offersLinks().find((a) => !w.pressed.has(step(a)));
    if (link && press(link, step(link))) return { state: "walking" };
    if (Date.now() - w.at > WALK_WAIT_MS) return { state: "stopped", why: `Amex's link to its offers did not lead there. ${HOW_TO_GET_THERE}` };
    return { state: "walking" };
  }

  function addedCount() {
    const tab = K.controls().map(K.nameOf).map((n) => ADDED_TAB.exec(n)).find(Boolean);
    return tab ? Number(tab[1]) : null;
  }

  async function readOffers(options = {}) {
    const result = await readPage(options);
    if (result.state !== "walking") delete globalThis.__amexOffersWalk;
    return result;
  }

  async function readPage({ walk: mayWalk = false }) {
    const held = signIn();
    if (held) return held;
    if (!onAmex()) return { state: "no_list" };
    if (!onOffers()) return mayWalk ? walkToOffers() : { state: "no_list" };
    // The Added list is not where offers are added.
    if (/^\/offers\/(enrolled|added)/.test(location.pathname)) {
      const tab = K.controlNamed((n) => AVAILABLE_TAB.test(n), { anywhere: true });
      if (mayWalk && press(tab, "available tab")) return { state: "walking" };
      return { state: "stopped", why: "Amex is showing the offers already added. Open Available offers in this tab and sync again." };
    }
    const end = Date.now() + LIST_WAIT_MS;
    while (!offerControls().length && !NONE.test(document.body ? document.body.innerText : "")) {
      if (Date.now() >= end) return { state: "stopped", why: "The offers page shows no offers and does not say it has none." };
      await K.sleep(250);
      const again = signIn();
      if (again) return again;
    }
    // Amex may draw only some offers until its own More is pressed.
    const more = K.controlNamed((n) => MORE.test(n));
    if (more && mayWalk && walk().more < MORE_PRESSES) {
      walk().more += 1;
      more.click();
      return { state: "walking" };
    }
    const card = cardOnShow();
    const switcher = firstShown(COMBOBOX);
    if (switcher && !card) return { state: "stopped", why: "The card on show could not be read, and other cards may be on this account, so no offer was added." };
    const offers = offersOnPage(card);
    const onCards = addedCount();
    const others = [...optionDigits()].filter((d) => d !== card);
    const result = { state: "ok", card, offers, ...(onCards === null ? {} : { onCards }) };
    // With a switcher, there may be other cards: nextCard finds out.
    if (switcher && (others.length || !optionDigits().size)) result.more = true;
    return result;
  }

  // Presses this one offer's Add to Card, and waits for Amex to show it added.
  async function addOne(offer) {
    const held = signIn();
    // A page asking for a pause is not pressed on either.
    if (held) return held.state === "stopped" ? { ok: false, stop: true, why: held.why } : { ok: false, state: held.state };
    if (!onOffers()) return { ok: false, why: "The offers page is no longer on show." };
    const card = cardOnShow();
    if ((offer.card || "") !== card) return { ok: false, why: "Another card is on show." };
    const found = offerControls();
    const all = found.map((c) => c.el);
    const mine = found.find((c) => describe(c, all, card).id === offer.id);
    if (!mine) return { ok: false, why: "That offer is no longer on the page." };
    if (ADDED.test(mine.name)) return { ok: true, already: true };
    // The whole name, once more, right before the press.
    if (!K.isAddName(K.nameOf(mine.el), ADD)) return { ok: false, why: "That offer's control is not Add to Card." };
    if (K.turnedOff(mine.el)) return { ok: false, why: "That offer's Add to Card is turned off." };
    const tile = K.tileOf(mine.el, all);
    const before = new Set(K.dialogs());
    mine.el.click();
    const settled = await K.waitFor(() => {
      const after = signIn();
      if (after && after.state !== "stopped") return after;
      const opened = K.dialogs().find((d) => !before.has(d));
      if (opened) return { dialog: opened };
      if (!mine.el.isConnected || !tile.isConnected) return { gone: true };
      if (ADDED.test(K.nameOf(mine.el)) || offerControls().some((c) => tile.contains(c.el) && ADDED.test(c.name))) return { added: true };
      return null;
    }, ADD_WAIT_MS);
    if (!settled) return { ok: false, why: "Amex did not show the offer as added." };
    if (settled.state) return { ok: false, state: settled.state };
    if (settled.dialog) {
      // A dialog over an offer that is now added is only Amex saying so.
      const added = tile.isConnected && offerControls().some((c) => tile.contains(c.el) && ADDED.test(c.name));
      await K.closeDialog(settled.dialog);
      if (added) return { ok: true };
      return { ok: false, left: true, why: "Amex asked for something more for this offer, so it was left for you." };
    }
    return { ok: true };
  }

  // The cards whose offers this sync has read, kept on the page between askings.
  const cardsRead = () => (globalThis.__amexOfferCards = globalThis.__amexOfferCards || new Set());

  // The next card in Amex's switcher whose offers have not been read. Every
  // offer of the old card must be gone first, so none is added to the wrong card.
  async function nextCard() {
    const done = cardsRead();
    const card = cardOnShow();
    if (!card) return { why: "The card on show could not be read." };
    done.add(card);
    const finished = () => { delete globalThis.__amexOfferCards; return { moved: false }; };
    const box = firstShown(COMBOBOX);
    if (!box) return finished();
    if (!firstShown(OPTION)) {
      box.click();
      if (!(await K.waitFor(() => firstShown(OPTION), SWITCHER_WAIT_MS))) return { why: "Amex's card switcher did not open." };
    }
    const next = Array.from(document.querySelectorAll(OPTION)).filter(K.shown).find((o) => /^\d{4,6}$/.test(digitsOf(o)) && !done.has(digitsOf(o)));
    if (!next) {
      const open = firstShown(COMBOBOX);
      if (open) open.click();
      return finished();
    }
    const digits = digitsOf(next);
    const held = offerControls().map((c) => c.el);
    next.click();
    if (!(await K.waitFor(() => cardOnShow() === digits, CARD_WAIT_MS))) return { why: "Amex did not change to the card chosen." };
    if (!(await K.waitFor(() => !held.some(K.shown), CARD_WAIT_MS))) return { why: "Amex did not redraw its offers for the card chosen." };
    return { moved: true };
  }

  globalThis.__offers = { readOffers, addOne, nextCard };
})();
