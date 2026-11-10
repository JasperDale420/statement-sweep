"""The Card Offers part of Settings (offers-settings.js): its switches, the
Each Sync choice, and the record of offers seen with its two-step Forget, in
a real Chromium with the extension's own module, a stand-in site list and a
stand-in for Chrome's storage. The markup is the part options.html gains.
Every offer and count is invented."""
import json
import re
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://x.test/"
# The Card Offers part of options.html, as it is there.
PART = re.search(r'  <h2 id="offersHead">.*?<p id="offersStatus" role="status"></p>\n', (ROOT / "options.html").read_text(), re.S).group(0)
MARKUP = f"""<!doctype html><meta charset="utf-8"><main>
{PART}</main><script src="offers-settings.js" type="module"></script>"""
SITES = [
    {"id": "amex", "name": "American Express", "offers": {"file": "providers/amex.offers.js"}},
    {"id": "chase", "name": "Chase", "offers": {"file": "providers/chase.offers.js", "cards": "personal"}},
    {"id": "chasebusiness", "name": "Chase Business", "offers": {"file": "providers/chase.offers.js", "cards": "business"}},
    {"id": "sdge", "name": "SDG&E"},
]
CHROME = """
const saved = JSON.parse(sessionStorage.getItem('local') || '{}');
window.__local = saved; window.__changed = [];
Object.defineProperty(window, 'chrome', { value: { storage: {
  local: {
    get: async (keys) => { const out = {}; for (const k of [].concat(keys)) if (k in __local) out[k] = __local[k]; return out; },
    set: async (o) => { Object.assign(__local, o); const c = {}; for (const k in o) c[k] = { newValue: o[k] }; __changed.forEach((f) => f(c, 'local')); },
    remove: async (keys) => { const c = {}; for (const k of [].concat(keys)) { delete __local[k]; c[k] = {}; } __changed.forEach((f) => f(c, 'local')); },
  },
  onChanged: { addListener: (f) => __changed.push(f) },
} } });
"""


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


def open_settings(browser, sites=SITES, local=None):
    t = browser.new_page()
    t.add_init_script(CHROME)
    index = "export const PROVIDERS = " + json.dumps(sites) + ";"

    def serve(route):
        rel = route.request.url[len(BASE):].split("?")[0]
        if rel == "providers/index.js":
            route.fulfill(status=200, content_type="text/javascript", body=index)
        elif rel == "settings.html":
            route.fulfill(status=200, content_type="text/html", body=MARKUP)
        elif (ROOT / rel).is_file():
            route.fulfill(status=200, content_type="text/javascript", body=(ROOT / rel).read_text())
        else:
            route.fulfill(status=200, content_type="text/html", body="<!doctype html>")
    t.route(BASE + "**", serve)
    t.goto(BASE)
    t.evaluate("(l) => sessionStorage.setItem('local', JSON.stringify(l))", local or {})
    t.goto(BASE + "settings.html")
    return t


def test_one_switch_per_site_with_offers_all_off_at_first(browser):
    t = open_settings(browser)
    t.wait_for_selector("#offersSites input")
    # Chase and Chase Business share a sign-in, so each says which cards are its.
    assert t.locator("#offersSites label").all_inner_texts() == ["American Express", "Chase · personal cards", "Chase Business · business cards"]
    assert [t.is_checked(f"#offers-{i}") for i in ("amex", "chase", "chasebusiness")] == [False, False, False]
    assert t.locator("#offersSites .offer-site > span").all_inner_texts() == ["Off", "Off", "Off"]
    t.close()


def test_turning_one_on_and_off_is_saved_at_once(browser):
    t = open_settings(browser)
    t.check("#offers-amex")
    t.wait_for_function("(window.__local.offersOn || []).includes('amex')")
    assert t.inner_text("#offersStatus") == "On for American Express. Its offers are added on the next sync."
    t.uncheck("#offers-amex")
    t.wait_for_function("(window.__local.offersOn || []).length === 0")
    assert t.inner_text("#offersStatus") == "Off for American Express."
    t.close()


def test_what_is_on_and_added_so_far_is_shown(browser):
    t = open_settings(browser, local={"offersOn": ["chase"], "offers:chase": {"added": ["a", "b", "c"], "seen": ["d", "e"], "left": ["f"]}})
    t.wait_for_selector("#offersSites input")
    assert t.is_checked("#offers-chase") and not t.is_checked("#offers-amex")
    # Only what Statement Sweep added counts, not what was on the card already.
    assert t.locator("#offersSites .offer-site > span").all_inner_texts() == ["Off", "3 added so far · first full sync next", "Off"]
    t.close()
    # Once a site's first full sync is done, only the count is said.
    t = open_settings(browser, local={"offersOn": ["chase"], "offers:chase": {"added": ["a", "b", "c"], "seen": [], "left": [], "full": "2026-11-10"}})
    t.wait_for_selector("#offersSites input")
    assert t.locator("#offersSites .offer-site > span").all_inner_texts() == ["Off", "3 added so far", "Off"]
    t.close()


def test_the_count_follows_a_sync_while_settings_is_open(browser):
    t = open_settings(browser, local={"offersOn": ["amex"]})
    t.wait_for_selector("#offersSites input")
    assert t.locator("#offersSites .offer-site > span").first.inner_text() == "None added yet · first full sync next"
    t.evaluate("chrome.storage.local.set({'offers:amex': {added: ['x'], seen: [], left: []}})")
    t.wait_for_function("document.getElementById('offersSites').innerText.includes('1 added so far')")
    assert t.is_checked("#offers-amex")
    t.close()


def test_the_pace_and_cap_are_said_from_the_engines_own_numbers(browser):
    t = open_settings(browser)
    t.wait_for_function("document.getElementById('offersPace').textContent.length > 0")
    pace = t.inner_text("#offersPace")
    assert pace.startswith("A site's first sync adds every offer it has")
    assert "Later syncs add only new ones. 1.5 to 4 seconds apart, soonest to expire first, and never more than 500 a sync." in pace
    assert "signs you out, asks you to confirm something, or says to slow down" in t.inner_text("#offersPace")
    t.close()


def test_settings_loads_the_part_and_its_words_are_careful():
    html = (ROOT / "options.html").read_text()
    assert '<script src="offers-settings.js" type="module"></script>' in html
    assert "Off unless you turn it on" in PART and "own add button, nothing else" in PART
    assert "never buys, applies, enrolls or accepts terms" in PART


def test_without_any_site_with_offers_the_part_is_hidden(browser):
    t = open_settings(browser, sites=[SITES[3]])
    t.wait_for_function("document.getElementById('offersGroup').hidden")
    assert t.evaluate("document.getElementById('offersHead').hidden") is True
    t.close()


def test_with_the_real_sites_amex_chase_and_chase_business_each_have_a_switch_all_off(browser):
    metas = [json.loads(m.read_text()) for m in sorted((ROOT / "providers").glob("*.meta.json"))]
    sites = [m for m in metas if m.get("enabled", True)]
    t = open_settings(browser, sites=sites)
    t.wait_for_selector("#offersSites input")
    assert sorted(t.locator("#offersSites label").all_inner_texts()) == sorted(["American Express", "Chase · personal cards", "Chase Business · business cards"])
    assert t.locator("#offersSites input:checked").count() == 0
    kinds = {m["id"]: m["offers"].get("cards") for m in sites if m.get("offers")}
    assert kinds == {"amex": None, "chase": "personal", "chasebusiness": "business"}
    t.close()


def details(*statuses):
    """An invented details record: one card, one offer per status."""
    return {"at": 1, "cards": {"1111": {"label": "Card ·· 1111", "at": 1, "offers": [
        {"id": f"1111:o{i}", "merchant": f"Shop {i}", "title": "Earn 5% back", "expires": None, "status": st} for i, st in enumerate(statuses)]}}}


def test_each_sync_adds_every_new_offer_unless_limited_to_10_or_25(browser):
    t = open_settings(browser)
    t.wait_for_selector("#offersSites input")
    assert t.locator("#offersCap option").all_inner_texts() == ["Every new offer", "Up to 10 offers a site", "Up to 25 offers a site"]
    assert t.input_value("#offersCap") == "0"
    assert t.evaluate("document.querySelector('label[for=offersCap]').textContent") == "Each Sync"
    t.select_option("#offersCap", "10")
    t.wait_for_function("window.__local.offersCap === 10")
    assert t.inner_text("#offersStatus") == "Up to 10 offers a site each sync."
    t.close()
    again = open_settings(browser, local={"offersCap": 10})
    again.wait_for_function("document.getElementById('offersCap').value === '10'")
    again.select_option("#offersCap", "0")
    again.wait_for_function("window.__local.offersCap === 0")
    assert again.inner_text("#offersStatus") == "Every new offer is added each sync."
    again.close()


def test_a_cap_that_is_not_a_choice_is_read_as_every_new_offer(browser):
    t = open_settings(browser, local={"offersCap": 400})
    t.wait_for_selector("#offersSites input")
    t.wait_for_function("document.getElementById('offersCap').value === '0'")
    t.close()


def test_offers_seen_counts_what_was_added_and_what_needs_you(browser):
    local = {"offersOn": ["amex"], "offers:amex": {"added": ["a", "b"], "seen": ["c"], "left": ["d"]},
             "offers:chase": {"added": ["e"], "seen": [], "left": []},
             "offerDetails:amex": details("added", "needs_you", "waiting"), "offerDetails:chase": details("needs_you", "needs_you")}
    t = open_settings(browser, local=local)
    t.wait_for_function("document.getElementById('offersSeen').textContent.length > 0")
    assert t.inner_text("#offersSeen") == "3 added · 3 need you"
    assert t.get_attribute("#openOffers", "href") == "offers.html"
    assert t.inner_text("#openOffers") == "Open Card Offers"
    t.close()


def test_forget_asks_twice_inline_and_clears_only_the_offers_record(browser):
    local = {"offersOn": ["amex"], "offersCap": 10, "offers:amex": {"added": ["a"], "seen": [], "left": []},
             "offerDetails:amex": details("added", "needs_you"), "seen:amex": ["s1"]}
    t = open_settings(browser, local=local)
    t.wait_for_function("document.getElementById('offersSeen').textContent === '1 added · 1 needs you'")
    assert t.inner_text("#forgetOffers") == "Forget Offers…"
    t.click("#forgetOffers")
    # The first press only arms it.
    assert t.inner_text("#forgetOffers") == "Forget Offers (press again)"
    assert "offers:amex" in t.evaluate("Object.keys(window.__local)")
    t.click("#forgetOffers")
    t.wait_for_function("!('offerDetails:amex' in window.__local) && !('offers:amex' in window.__local)")
    assert t.inner_text("#forgetOffers") == "Forget Offers…"
    t.wait_for_function("document.getElementById('offersSeen').textContent === '0 added · 0 need you'")
    # Which sites are on, the cap, and the statements record stay.
    assert t.evaluate("[window.__local.offersOn, window.__local.offersCap, window.__local['seen:amex']]") == [["amex"], 10, ["s1"]]
    t.close()


def test_an_armed_forget_lapses_after_a_few_seconds(browser):
    t = open_settings(browser, local={"offers:amex": {"added": ["a"], "seen": [], "left": []}})
    t.wait_for_selector("#offersSites input")
    t.clock.install()
    t.click("#forgetOffers")
    assert t.inner_text("#forgetOffers") == "Forget Offers (press again)"
    t.clock.run_for(5100)
    t.wait_for_function("document.getElementById('forgetOffers').textContent === 'Forget Offers…'")
    t.click("#forgetOffers")
    assert "offers:amex" in t.evaluate("Object.keys(window.__local)")
    t.close()
