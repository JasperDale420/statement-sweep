"""The Card Offers switches in Settings (offers-settings.js), in a real
Chromium with the extension's own module, a stand-in site list and a
stand-in for Chrome's storage. The markup is the part options.html gains."""
import json
import re
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://x.test/"
# The Card Offers part of options.html, as it is there.
PART = re.search(r'  <h2 id="offersHead">.*?<p id="offersStatus" role="status"></p>\n', (ROOT / "options.html").read_text(), re.S).group(0)
MARKUP = f"""<!doctype html><main>
{PART}</main><script src="offers-settings.js" type="module"></script>"""
SITES = [
    {"id": "amex", "name": "American Express", "offers": {"file": "providers/amex.offers.js"}},
    {"id": "chase", "name": "Chase", "offers": {"file": "providers/chase.offers.js", "cards": "personal"}},
    {"id": "sdge", "name": "SDG&E"},
]
CHROME = """
const saved = JSON.parse(sessionStorage.getItem('local') || '{}');
window.__local = saved; window.__changed = [];
Object.defineProperty(window, 'chrome', { value: { storage: {
  local: {
    get: async (keys) => { const out = {}; for (const k of [].concat(keys)) if (k in __local) out[k] = __local[k]; return out; },
    set: async (o) => { Object.assign(__local, o); const c = {}; for (const k in o) c[k] = { newValue: o[k] }; __changed.forEach((f) => f(c, 'local')); },
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
    assert t.locator("#offersSites label").all_inner_texts() == ["American Express", "Chase"]
    assert [t.is_checked(f"#offers-{i}") for i in ("amex", "chase")] == [False, False]
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
    assert "3 offers added so far." in t.inner_text("#offersSites")
    t.close()


def test_the_count_follows_a_sync_while_settings_is_open(browser):
    t = open_settings(browser, local={"offersOn": ["amex"]})
    t.wait_for_selector("#offersSites input")
    assert "added so far" not in t.inner_text("#offersSites")
    t.evaluate("chrome.storage.local.set({'offers:amex': {added: ['x'], seen: [], left: []}})")
    t.wait_for_function("document.getElementById('offersSites').innerText.includes('1 offer added so far.')")
    assert t.is_checked("#offers-amex")
    t.close()


def test_the_pace_and_cap_are_said_from_the_engines_own_numbers(browser):
    t = open_settings(browser)
    t.wait_for_function("document.getElementById('offersPace').textContent.length > 0")
    assert t.inner_text("#offersPace").startswith("At most 25 offers a site each sync, 1.5 to 4 seconds apart. The rest wait for the next sync.")
    assert "signs you out or asks you to confirm" in t.inner_text("#offersPace")
    t.close()


def test_settings_loads_the_part_and_its_words_are_careful():
    html = (ROOT / "options.html").read_text()
    assert '<script src="offers-settings.js" type="module"></script>' in html
    assert "Off unless you turn it on" in PART and "own add control, nothing else" in PART
    assert "personal cards and business cards are kept apart" in PART


def test_without_any_site_with_offers_the_part_is_hidden(browser):
    t = open_settings(browser, sites=[SITES[2]])
    t.wait_for_function("document.getElementById('offersGroup').hidden")
    assert t.evaluate("document.getElementById('offersHead').hidden") is True
    t.close()


def test_with_the_real_sites_amex_chase_and_chase_business_each_have_a_switch_all_off(browser):
    metas = [json.loads(m.read_text()) for m in sorted((ROOT / "providers").glob("*.meta.json"))]
    sites = [m for m in metas if m.get("enabled", True)]
    t = open_settings(browser, sites=sites)
    t.wait_for_selector("#offersSites input")
    assert sorted(t.locator("#offersSites label").all_inner_texts()) == ["American Express", "Chase", "Chase Business"]
    assert t.locator("#offersSites input:checked").count() == 0
    kinds = {m["id"]: m["offers"].get("cards") for m in sites if m.get("offers")}
    assert kinds == {"amex": None, "chase": "personal", "chasebusiness": "business"}
    t.close()
