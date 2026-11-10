"""The Card Offers page (offers.html, offers-page.js), in a real Chromium with
the extension's own files, a stand-in site list and a stand-in for Chrome's
storage and messages. Every merchant, offer, card and date is invented."""
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://x.test/"
TYPES = {".js": "text/javascript", ".html": "text/html", ".css": "text/css"}
SITES = [
    {"id": "amex", "name": "American Express", "listUrl": "https://bank.test/amex/statements", "offers": {"file": "providers/amex.offers.js"}},
    {"id": "chase", "name": "Chase", "listUrl": "https://bank.test/chase/docs", "offers": {"file": "providers/chase.offers.js", "url": "https://bank.test/chase/offers", "cards": "personal"}},
    {"id": "chasebusiness", "name": "Chase Business", "listUrl": "https://bank.test/chase/docs", "offers": {"file": "providers/chase.offers.js", "url": "https://bank.test/chase/offers", "cards": "business"}},
    {"id": "sdge", "name": "SDG&E", "listUrl": "https://bank.test/sdge"},
]
INDEX = "export const PROVIDERS = " + json.dumps(SITES) + ";"
CHROME = """
const saved = JSON.parse(sessionStorage.getItem('local') || '{}');
window.__local = saved.local || {}; window.__answer = saved.answer || { ok: true };
window.__changed = []; window.__sent = [];
const changed = (c) => __changed.forEach((f) => f(c, 'local'));
Object.defineProperty(window, 'chrome', { value: {
  storage: { local: {
    get: async (keys) => { const out = {}; for (const k of [].concat(keys)) if (k in __local) out[k] = JSON.parse(JSON.stringify(__local[k])); return out; },
    set: async (o) => { Object.assign(__local, JSON.parse(JSON.stringify(o))); const c = {}; for (const k in o) c[k] = { newValue: o[k] }; changed(c); },
    remove: async (keys) => { const c = {}; for (const k of [].concat(keys)) { delete __local[k]; c[k] = {}; } changed(c); },
  }, onChanged: { addListener: (f) => __changed.push(f) } },
  runtime: { sendMessage: async (m) => { __sent.push(m); return __answer; } },
} });
"""

NOW = "2026-11-10T09:12:00"


def offer(i, status, merchant, title, expires=None, **more):
    return {"id": f"c:{i}", "merchant": merchant, "title": title, "expires": expires, "status": status, **more}


AMEX = {"at": 0, "cards": {
    "11004": {"label": "Invented Gold ·· 1004", "at": 0, "offers": [
        offer(1, "needs_you", "Lakeside Inn", "Earn 5,000 points on a stay", "2026-12-15", why="Amex asked for something more"),
        offer(2, "waiting", "Northside Coffee", "Spend $10, get $3 back", "2026-11-30"),
        offer(3, "waiting", "Corner Market", "Spend $50, get $10 back", "2026-11-14"),
        offer(4, "waiting", "Harbor Air", "20% back on flights", None),
        offer(5, "added", "Pine Street Books", "Spend $30, get $8 back", "2026-12-01", on="2026-11-10"),
        offer(6, "added", "Bright Streaming", "$5 back monthly", "2026-12-31", on="2026-11-03"),
        offer(7, "on_card", "Metro Fuel", "10% back, up to $20", "2026-11-20"),
        offer(8, "waiting", "Gone Shop", "Ended long ago", "2026-01-01"),
    ]},
    "22008": {"label": "Invented Blue ·· 2008", "at": 0, "offers": []},
}}


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


def open_page(browser, local=None, hash="", answer=None):
    t = browser.new_page()
    t.clock.set_fixed_time(NOW)
    t.add_init_script(CHROME)

    def serve(route):
        rel = route.request.url[len(BASE):].split("?")[0].split("#")[0]
        if rel == "providers/index.js":
            route.fulfill(status=200, content_type="text/javascript", body=INDEX)
        elif (ROOT / rel).is_file():
            route.fulfill(status=200, content_type=TYPES.get((ROOT / rel).suffix, "text/plain"), body=(ROOT / rel).read_text())
        else:
            route.fulfill(status=200, content_type="text/html", body="<!doctype html>")
    t.route(BASE + "**", serve)
    t.goto(BASE)
    local = dict(local or {})
    for d in [v for k, v in local.items() if k.startswith("offerDetails:")]:
        d["at"] = t.evaluate("Date.now()")
    t.evaluate("(s) => sessionStorage.setItem('local', JSON.stringify(s))", {"local": local, "answer": answer})
    t.goto(BASE + "offers.html" + hash)
    t.wait_for_selector("[role=tab][aria-selected=true]")
    t.wait_for_function("document.getElementById('siteName').textContent.length > 0")
    return t


def texts(t, sel):
    return [x.strip() for x in t.locator(sel).all_inner_texts()]


def test_only_sites_with_offers_are_tabs_and_the_first_is_chosen(browser):
    t = open_page(browser)
    assert texts(t, "[role=tablist] [role=tab]") == ["American Express", "Chase", "Chase Business"]
    assert t.get_attribute("[role=tablist]", "aria-label") == "Site"
    assert t.get_attribute("#tab-amex", "aria-selected") == "true" and t.get_attribute("#tab-chase", "aria-selected") == "false"
    assert t.get_attribute("#tab-amex", "tabindex") == "0" and t.get_attribute("#tab-chase", "tabindex") == "-1"
    assert t.inner_text("#siteName") == "American Express"
    t.close()


def test_the_three_groups_of_a_card(browser):
    t = open_page(browser, {"offersOn": ["amex"], "offerDetails:amex": AMEX})
    assert t.inner_text("#siteStatus") == "Last checked today at 9:12 AM · 2 added · 3 waiting · 1 needs you"
    assert texts(t, "#cards button span:first-child") == ["Invented Gold ·· 1004", "Invented Blue ·· 2008"]
    assert texts(t, "#cards button span + span") == ["3 waiting · 3 added", "0 waiting · 0 added"]
    assert t.get_attribute("#cards button >> nth=0", "aria-pressed") == "true"
    # Needs you, with the site's own reason and a way there.
    assert t.inner_text("#needsHead") == "NEEDS YOU · 1"
    assert texts(t, "#needs .merchant") == ["Lakeside Inn"]
    assert texts(t, "#needs .title") == ["Earn 5,000 points on a stay · Amex asked for something more"]
    link = t.locator("#needs a")
    assert link.inner_text() == "Open on American Express"
    assert link.get_attribute("href") == "https://bank.test/amex/statements" and link.get_attribute("target") == "_blank"
    # Waiting, soonest to end first, an ended offer gone, and what ends soon in orange.
    assert t.inner_text("#waitingHead") == "WAITING TO ADD · 3"
    assert texts(t, "#waiting .merchant") == ["Corner Market", "Northside Coffee", "Harbor Air"]
    assert texts(t, "#waiting .meta") == ["Ends Nov 14", "Ends Nov 30"]
    assert t.locator("#waiting .meta[data-soon]").all_inner_texts() == ["Ends Nov 14"]
    assert t.inner_text("#waitingNote") == "Added on the next sync, up to 25 a site, a few seconds apart. Soonest to expire first."
    # Added: by Statement Sweep with its day, apart from what was on the card already.
    assert t.inner_text("#addedHead") == "ADDED · 3"
    assert texts(t, "#added .merchant") == ["Pine Street Books", "Bright Streaming", "Metro Fuel"]
    assert texts(t, "#added .meta") == ["Added by Statement Sweep, today", "Ends Dec 1", "Added by Statement Sweep, Nov 3", "Ends Dec 31", "Already on the card", "Ends Nov 20"]
    assert t.locator("#added svg[aria-label=Added]").count() == 3
    assert "Gone Shop" not in t.inner_text("body")
    t.close()


def test_a_card_with_nothing_has_its_empty_rows(browser):
    t = open_page(browser, {"offersOn": ["amex"], "offerDetails:amex": AMEX})
    t.click("#cards button >> nth=1")
    t.wait_for_function("document.querySelector('#cards button:nth-child(2)').getAttribute('aria-pressed') === 'true'")
    assert t.is_hidden("#needsPart")
    assert texts(t, "#waiting .merchant") == ["Nothing waiting"] and texts(t, "#waiting .title") == ["Every offer this card shows is on it."]
    assert texts(t, "#added .merchant") == ["None yet"] and texts(t, "#added .title") == ["Offers are added on the next sync."]
    assert t.inner_text("#waitingHead") == "WAITING TO ADD · 0"
    t.close()


def test_a_site_never_run_says_what_to_do(browser):
    t = open_page(browser, hash="#chasebusiness")
    assert t.inner_text("#siteStatus") == "Card offers are off for this site"
    assert t.is_visible("#none") and t.is_hidden("#cards") and t.is_hidden("#waitingPart")
    assert t.inner_text("#noneHead") == "No offers seen yet"
    assert t.inner_text("#noneText") == "Turn on Add when syncing, then sync. The offers this site shows appear here."
    assert t.is_disabled("#addNow")
    t.close()


def test_a_record_from_before_details_were_kept_is_counted(browser):
    t = open_page(browser, {"offersOn": ["chase"], "offers:chase": {"added": ["a", "b", "c"], "seen": [], "left": []}}, hash="#chase")
    assert t.inner_text("#siteStatus") == "On. Offers are added on the next sync."
    assert t.inner_text("#noneText") == "3 offers added before this list was kept. The next sync fills it in."
    t.close()


def test_the_hash_chooses_the_site_and_choosing_one_sets_it(browser):
    t = open_page(browser, {"offerDetails:chase": {"at": 0, "cards": {"3012": {"label": "Invented Sapphire ·· 3012", "at": 0, "offers": [
        offer(1, "needs_you", "Summit Outfitters", "10% cash back", "2026-11-22", why="Chase asked for more")]}}}}, hash="#chase")
    assert t.get_attribute("#tab-chase", "aria-selected") == "true" and t.inner_text("#siteName") == "Chase"
    # Chase's own offers page.
    assert t.get_attribute("#needs a", "href") == "https://bank.test/chase/offers"
    assert t.inner_text("#needs a") == "Open on Chase"
    t.click("#tab-chasebusiness")
    t.wait_for_function("location.hash === '#chasebusiness'")
    assert t.inner_text("#siteName") == "Chase Business"
    t.evaluate("location.hash = '#amex'")
    t.wait_for_function("document.getElementById('siteName').textContent === 'American Express'")
    # An unknown site is the first one.
    t.evaluate("location.hash = '#nowhere'")
    t.wait_for_function("document.getElementById('tab-amex').getAttribute('aria-selected') === 'true'")
    t.close()


def test_the_sites_are_reached_by_keyboard(browser):
    t = open_page(browser)
    t.focus("#tab-amex")
    t.keyboard.press("ArrowRight")
    t.wait_for_function("document.getElementById('tab-chase').getAttribute('aria-selected') === 'true'")
    assert t.evaluate("document.activeElement.id") == "tab-chase"
    t.keyboard.press("ArrowLeft")
    t.keyboard.press("ArrowLeft")
    t.wait_for_function("document.getElementById('tab-chasebusiness').getAttribute('aria-selected') === 'true'")
    t.keyboard.press("Home")
    t.wait_for_function("document.activeElement.id === 'tab-amex'")
    t.close()


def test_the_switch_is_the_same_one_settings_uses(browser):
    t = open_page(browser, {"offersOn": ["chase"]})
    assert not t.is_checked("#siteOn") and t.is_disabled("#addNow")
    t.check("#siteOn")
    t.wait_for_function("JSON.stringify(window.__local.offersOn) === JSON.stringify(['chase', 'amex'])")
    t.wait_for_function("!document.getElementById('addNow').disabled")
    assert t.inner_text("#siteStatus") == "On. Offers are added on the next sync."
    t.uncheck("#siteOn")
    t.wait_for_function("JSON.stringify(window.__local.offersOn) === JSON.stringify(['chase'])")
    # Turned on elsewhere (Settings), it follows.
    t.evaluate("chrome.storage.local.set({ offersOn: ['chase', 'amex'] })")
    t.wait_for_function("document.getElementById('siteOn').checked")
    t.close()


def test_add_offers_now_asks_the_background_for_that_site_only(browser):
    t = open_page(browser, {"offersOn": ["amex"]})
    t.click("#addNow")
    t.wait_for_function("document.getElementById('now').textContent.length > 0")
    assert t.evaluate("window.__sent") == [{"type": "offersNow", "site": "amex"}]
    assert t.inner_text("#now") == "Adding offers on American Express. The Statement Sweep popup shows how it goes."
    assert t.get_attribute("#now", "role") == "status"
    t.close()


def test_add_offers_now_refused_says_why(browser):
    t = open_page(browser, {"offersOn": ["amex"]}, answer={"ok": False, "why": "A sync is running. Add Offers Now works once it finishes."})
    t.click("#addNow")
    t.wait_for_function("document.getElementById('now').textContent.length > 0")
    assert t.inner_text("#now") == "A sync is running. Add Offers Now works once it finishes."
    assert t.get_attribute("#now", "data-kind") == "no"
    t.close()


def test_the_cap_chosen_is_the_one_said(browser):
    t = open_page(browser, {"offersOn": ["amex"], "offersCap": 10, "offerDetails:amex": AMEX})
    assert t.inner_text("#waitingNote") == "Added on the next sync, up to 10 a site, a few seconds apart. Soonest to expire first."
    t.close()


def test_it_redraws_as_a_sync_adds_offers(browser):
    t = open_page(browser, {"offersOn": ["amex"], "offerDetails:amex": AMEX})
    t.evaluate("""() => { const d = JSON.parse(JSON.stringify(__local['offerDetails:amex']));
      d.cards['11004'].offers.find((o) => o.merchant === 'Corner Market').status = 'added';
      d.cards['11004'].offers.find((o) => o.merchant === 'Corner Market').on = '2026-11-10';
      chrome.storage.local.set({ 'offerDetails:amex': d }); }""")
    t.wait_for_function("document.getElementById('addedHead').textContent === 'Added · 4'")
    assert "Corner Market" not in t.inner_text("#waiting")
    t.close()


def test_the_page_says_what_it_never_does_and_where_the_list_lives(browser):
    t = open_page(browser)
    body = t.inner_text("body")
    assert "never buys, applies or accepts terms" in body
    assert "This list stays in Chrome on this computer. Expired offers drop off by themselves." in body
    assert t.get_attribute("#settingsLink", "href") == "options.html#offersHead"
    t.close()
