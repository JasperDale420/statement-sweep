// Runs inside Chase's own page, on Chase Offers, after this site's
// statements are saved, when you turned offers on for it in Settings. Reads
// the offers Chase has drawn for the card on show, and adds one by pressing
// its own add control ("Add offer", or a "+" whose name says so), nothing else.
//
// Chase and Chase Business share one sign-in and one Chase Offers page, so
// each reads only its own cards: `cards` is "personal" or "business", told
// apart by the card's name as chase.page.js does. A card of the other kind is
// passed over, never added to.
//
// Chase may open an offer's own page when its add control is pressed. This
// then presses that page's own Back, or goes back one step in this tab's
// history, which stays on secure.chase.com.
(() => {
  const K = globalThis.__offersKit;
  const LIST_WAIT_MS = 15000;
  const WALK_WAIT_MS = 30000;
  const ADD_WAIT_MS = 10000;
  const BACK_WAIT_MS = 10000;
  const CARD_WAIT_MS = 15000;
  const SWITCHER_WAIT_MS = 5000;
  const MORE_PRESSES = 30;
  const HUB = "/merchantOffers/";
  const ADD = ["Add offer", "Add to card", "Add", "+"];
  const ADDED = /^(added|offer added|added to card|success,? added|success added|activated|offer activated)$/i;
  const ADDED_WORDS = /\b(added|activated)\b/i;
  const TILE = "[data-cy='commerce-tile'], [data-testid='commerce-tile']";
  const LINK = /^(chase offers|see all offers|view all offers|all chase offers)$/i;
  const ALL = /^all( offers)?(\s*\(\d+\))?$/i;
  const MORE = /^(load|show|view|see) more( offers)?$/i;
  const BACK = /^(back|go back|back to offers|back to all offers|back to chase offers)$/i;
  const NONE = /(no (available |eligible |new )?offers|you('ve| have) added all|there are no offers|check back (soon|later))/i;
  const CARD = /^[A-Z0-9][^()]*\(\s*\.{2,}\s*(\d{4})\s*\)$/;
  // As chase.page.js reads them, with Ink cards counted as business.
  const BUSINESS = /\bBUS(INESS)?\b|\bCHK\b|\bINK\b/i;
  const CARDHOLDER = /^[A-Z]\.\s+[A-Z][A-Z'’-]*(\s+[A-Z][A-Z'’-]*)*\s*\(\s*\.{2,}\s*\d{4}\s*\)$/;
  const LOGIN_MARKERS = ["/logon", "/login", "/signin", "/sign-in", "/auth/logon", "/idp", "/mfa", "/verify", "chase.com/web/auth#/logon"];
  const CHECK_MARKERS = ["enter the code we sent", "enter your verification code", "verification code", "one-time", "one time passcode", "security code", "we sent a code", "two-factor", "two-step", "confirm your identity", "verify your identity", "we need to verify", "unusual activity", "are you a robot", "captcha"];
  const ENDED_MARKERS = ["your session has expired", "please log in again", "you've been logged out", "for your security, we signed you out"];
  const RATE_MARKERS = ["too many requests", "rate limit", "try again later", "temporarily unavailable", "http error 429", "unusual traffic"];

  const onChase = () => location.hostname === "secure.chase.com";
  const onHub = () => location.href.includes(HUB);
  const business = (label) => BUSINESS.test(label) || CARDHOLDER.test(label);
  // A card is in scope only when its name can be read: with both kinds in
  // one sign-in, a card of unknown kind could be the other site's.
  const inScope = (label, cards) => !cards || (Boolean(label) && (cards === "business" ? business(label) : !business(label)));

  function signIn() {
    const url = location.href.toLowerCase();
    if (LOGIN_MARKERS.some((m) => url.includes(m)) || document.querySelector("input[type='password']")) return { state: "signed_out" };
    const frame = document.querySelector("iframe[name='logonbox'], iframe#logonbox");
    if (frame && K.shown(frame)) return { state: "signed_out" };
    const hay = `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 1500)}`.toLowerCase();
    if (ENDED_MARKERS.some((m) => hay.includes(m))) return { state: "signed_out" };
    if (CHECK_MARKERS.some((m) => hay.includes(m))) return { state: "challenge" };
    if (RATE_MARKERS.some((m) => hay.includes(m))) return { state: "stopped", why: "Chase asked for a pause. Try again later." };
    return null;
  }

  // The card switcher at the top of Chase Offers: a control whose name is a
  // card, "SAPPHIRE PREFERRED (...1234)", that opens a list of cards.
  const SWITCHERS = "[role='combobox'], button[aria-haspopup], [aria-haspopup='listbox'], select";
  const cardLabel = (s) => {
    const t = K.tidy(s).replace(/\s*,\s*(current selection|selected)\s*$/i, "");
    return CARD.test(t) ? t : "";
  };
  function switcher() {
    return Array.from(document.querySelectorAll(SWITCHERS)).find((el) => K.shown(el) && cardLabel(el.tagName === "SELECT" ? (el.selectedOptions[0] || {}).textContent : K.nameOf(el))) || null;
  }
  function cardOnShow() {
    const box = switcher();
    if (box) return cardLabel(box.tagName === "SELECT" ? (box.selectedOptions[0] || {}).textContent : K.nameOf(box));
    const heading = Array.from(document.querySelectorAll("h1, h2, h3, [role='heading']")).find((h) => K.shown(h) && cardLabel(h.innerText));
    return heading ? cardLabel(heading.innerText) : "";
  }
  const lastFour = (label) => (CARD.exec(label) || [])[1] || "";
  const accountId = () => (/[?&;]accountId=(\d+)/.exec(location.hash || location.href) || [])[1] || "";
  const cardKey = (label) => lastFour(label) || (accountId() ? `a${accountId().slice(-4)}` : "card");

  // Every offer's own control: an add control, or the mark of one added.
  // Inside a commerce tile where Chase draws them, else anywhere in the hub
  // but its header, menus and footer.
  function offerControls() {
    const tiles = Array.from(document.querySelectorAll(TILE)).filter(K.shown);
    const out = [];
    const seen = new Set();
    const consider = (el, tile) => {
      if (seen.has(el)) return;
      seen.add(el);
      const name = K.nameOf(el);
      const merchant = tile ? K.headingOf(tile) || merchantOf(tile, name) : "";
      // A bare "Add" or "+" counts only inside an offer's own tile.
      if (K.isAddName(name, tile ? ADD : ADD.slice(0, 2), merchant)) out.push({ el, name, merchant, added: false });
      else if (ADDED.test(name)) out.push({ el, name, merchant, added: true });
    };
    if (tiles.length) {
      for (const tile of tiles) {
        for (const el of [tile, ...K.controls(tile)]) if (el.matches("button, [role='button'], a[href]")) consider(el, tile);
        // A tile whose add control has been replaced by a mark of being added.
        if (!out.some((c) => tile.contains(c.el))) {
          const mark = Array.from(tile.querySelectorAll("[aria-label], [role='img'], [role='status']")).find((m) => ADDED.test(K.nameOf(m)));
          if (mark) out.push({ el: mark, name: K.nameOf(mark), merchant: K.headingOf(tile) || merchantOf(tile, ""), added: true });
        }
      }
      return out;
    }
    for (const el of K.controls()) {
      if (el.closest("header, footer, nav, [role='navigation'], [role='contentinfo'], [role='dialog']")) continue;
      consider(el, null);
    }
    return out;
  }

  function merchantOf(tile, controlName) {
    const lines = K.linesOf(tile, [controlName]);
    return lines.find((l) => !/[$%]|\bback\b|\bdays?\b|\bleft\b|\bexpires?\b|^\+$/i.test(l)) || "";
  }

  function describe(control, all, card) {
    const tile = control.el.closest(TILE) || K.tileOf(control.el, all);
    const merchant = control.merchant || K.headingOf(tile) || merchantOf(tile, control.name);
    const lines = K.linesOf(tile, [control.name, merchant]);
    const title = lines.find((l) => /[$%]|\bback\b|\bpoints?\b|\bearn\b|\bspend\b/i.test(l)) || lines[0] || "";
    const own = tile.getAttribute("data-offer-id") || tile.getAttribute("data-offerid") || "";
    return { id: `${cardKey(card)}:${own || K.wordsId(merchant, title)}`, tile, merchant, title, expires: K.expiresOf(tile.innerText || "") };
  }

  function offersOnPage(card) {
    const found = offerControls();
    const all = found.map((c) => c.el);
    const ids = new Set();
    const offers = [];
    for (const control of found) {
      const { id, merchant, title, expires } = describe(control, all, card);
      if ((!merchant && !title) || ids.has(id)) continue;
      ids.add(id);
      offers.push({ id, card: cardKey(card), title, merchant, added: control.added, ...(expires ? { expires } : {}) });
    }
    return offers;
  }

  const walk = () => (globalThis.__chaseOffersWalk = globalThis.__chaseOffersWalk || { pressed: new Set(), at: Date.now(), more: 0 });
  function press(el, step) {
    const w = walk();
    if (!el || w.pressed.has(step)) return false;
    w.pressed.add(step);
    el.click();
    return true;
  }

  // Chase's own link to Chase Offers, on secure.chase.com only.
  function hubLink() {
    return Array.from(document.querySelectorAll("a, [role='link'], button")).find((a) => {
      if (!K.shown(a) || !LINK.test(K.nameOf(a))) return false;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#")) return true;
      try {
        const to = new URL(href, location.href);
        return to.protocol === "https:" && to.hostname === "secure.chase.com";
      } catch (e) { return false; }
    }) || null;
  }

  async function readOffers(options = {}) {
    const result = await readPage(options);
    if (result.state !== "walking") delete globalThis.__chaseOffersWalk;
    return result;
  }

  async function readPage({ walk: mayWalk = false, cards = "" } = {}) {
    const held = signIn();
    if (held) return held;
    if (!onChase()) return { state: "no_list" };
    if (!onHub()) {
      if (mayWalk && press(hubLink(), "hub link")) return { state: "walking" };
      return { state: "no_list" };
    }
    const end = Date.now() + LIST_WAIT_MS;
    while (!offerControls().length && !NONE.test(document.body ? document.body.innerText : "")) {
      if (Date.now() >= end) return { state: "stopped", why: "Chase Offers shows no offers and does not say it has none." };
      await K.sleep(250);
      const again = signIn();
      if (again) return again;
    }
    // Every offer, not one category of them.
    const all = K.controlNamed((n) => ALL.test(n), { roles: "button, [role='tab'], [role='button']" });
    if (all && mayWalk && !["true"].includes(all.getAttribute("aria-selected") || all.getAttribute("aria-pressed") || all.getAttribute("aria-current") || "") && press(all, "all offers")) {
      return { state: "walking" };
    }
    const more = K.controlNamed((n) => MORE.test(n));
    if (more && mayWalk && walk().more < MORE_PRESSES) {
      walk().more += 1;
      more.click();
      return { state: "walking" };
    }
    const card = cardOnShow();
    const box = switcher();
    if (box && !card) return { state: "stopped", why: "The card on show could not be read, and other cards may be on this account, so no offer was added." };
    if (cards && !card) return { state: "stopped", why: "The card on show could not be read, so whether it is personal or business is not known, and no offer was added." };
    if (!inScope(card, cards)) return { state: "ok", card: cardKey(card), offers: [], ...(box ? { more: true } : {}), passed: true };
    // Each offer carries its kind, checked again on the card on show before the press.
    const result = { state: "ok", card: cardKey(card), offers: offersOnPage(card).map((o) => (cards ? { ...o, kind: cards } : o)) };
    if (box) result.more = true;
    return result;
  }

  // Back to Chase Offers after an offer's own page, by its own Back, else
  // one step back in this tab, which Chase keeps on its own host.
  async function backToHub() {
    if (onHub() && offerControls().length) return true;
    const back = K.controlNamed((n) => BACK.test(n), { anywhere: true });
    if (back) back.click(); else history.back();
    return Boolean(await K.waitFor(() => onHub() && offerControls().length > 0, BACK_WAIT_MS));
  }

  async function addOne(offer) {
    const held = signIn();
    // A page asking for a pause is not pressed on either.
    if (held) return held.state === "stopped" ? { ok: false, stop: true, why: held.why } : { ok: false, state: held.state };
    if (!onHub()) return { ok: false, why: "Chase Offers is no longer on show." };
    const card = cardOnShow();
    if (cardKey(card) !== offer.card) return { ok: false, why: "Another card is on show." };
    if (offer.kind && !inScope(card, offer.kind)) return { ok: false, stop: true, why: "The card on show is not of this kind, so no offer was added." };
    const found = offerControls();
    const all = found.map((c) => c.el);
    const mine = found.find((c) => describe(c, all, card).id === offer.id);
    if (!mine) return { ok: false, why: "That offer is no longer on the page." };
    if (mine.added) return { ok: true, already: true };
    if (!K.isAddName(K.nameOf(mine.el), ADD, mine.merchant)) return { ok: false, why: "That offer's control is not its add control." };
    if (K.turnedOff(mine.el)) return { ok: false, why: "That offer's add control is turned off." };
    const tile = mine.el.closest(TILE) || K.tileOf(mine.el, all);
    const route = location.href;
    const before = new Set(K.dialogs());
    mine.el.click();
    const settled = await K.waitFor(() => {
      const after = signIn();
      if (after && after.state !== "stopped") return after;
      if (location.href !== route) return { moved: true };
      const opened = K.dialogs().find((d) => !before.has(d));
      if (opened) return { dialog: opened };
      if (!tile.isConnected) return { gone: true };
      if (ADDED.test(K.nameOf(mine.el)) || offerControls().some((c) => c.added && tile.contains(c.el))) return { added: true };
      return null;
    }, ADD_WAIT_MS);
    if (!settled) return { ok: false, why: "Chase did not show the offer as added." };
    if (settled.state) return { ok: false, state: settled.state };
    if (settled.moved) {
      // The offer's own page says whether it was added.
      const said = await K.waitFor(() => ADDED_WORDS.test(document.body ? document.body.innerText : ""), 5000);
      const later = signIn();
      if (later && later.state !== "stopped") return { ok: false, state: later.state };
      if (!(await backToHub())) return { ok: false, stop: true, why: "Chase did not go back to its offers." };
      return said ? { ok: true } : { ok: false, why: "Chase did not show the offer as added." };
    }
    if (settled.dialog) {
      const added = ADDED_WORDS.test(settled.dialog.innerText || "");
      await K.closeDialog(settled.dialog);
      if (added) return { ok: true };
      return { ok: false, left: true, why: "Chase asked for something more for this offer, so it was left for you." };
    }
    return { ok: true };
  }

  // The cards this sync has read, kept on the page between askings.
  const cardsRead = () => (globalThis.__chaseOfferCards = globalThis.__chaseOfferCards || new Set());
  const OPTIONS = "[role='option'], [role='menuitem'], [role='menuitemradio']";

  async function nextCard() {
    const done = cardsRead();
    const card = cardOnShow();
    if (!card) return { why: "The card on show could not be read." };
    done.add(card);
    const finished = () => { delete globalThis.__chaseOfferCards; return { moved: false }; };
    const box = switcher();
    if (!box) return finished();
    const held = offerControls().map((c) => c.el);
    if (box.tagName === "SELECT") {
      const next = Array.from(box.options).find((o) => cardLabel(o.textContent) && !done.has(cardLabel(o.textContent)));
      if (!next) return finished();
      box.value = next.value;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const options = () => Array.from(document.querySelectorAll(OPTIONS)).filter((o) => K.shown(o) && cardLabel(K.nameOf(o)));
      if (!options().length) {
        box.click();
        if (!(await K.waitFor(() => options().length, SWITCHER_WAIT_MS))) return { why: "Chase's card list did not open." };
      }
      const next = options().find((o) => !done.has(cardLabel(K.nameOf(o))));
      if (!next) {
        box.click();
        return finished();
      }
      next.click();
    }
    if (!(await K.waitFor(() => cardOnShow() && !done.has(cardOnShow()), CARD_WAIT_MS))) return { why: "Chase did not change to the card chosen." };
    if (held.length && !(await K.waitFor(() => !held.some(K.shown), CARD_WAIT_MS))) return { why: "Chase did not redraw its offers for the card chosen." };
    return { moved: true };
  }

  globalThis.__offers = { readOffers, addOne, nextCard };
})();
