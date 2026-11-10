"""Settings' Sites You Added (added-settings.js), and the Sites list
(sites-settings.js) with an added site in it, in a real Chromium with the
extension's own modules and a stand-in for Chrome's storage, permissions,
tabs and scripting. The markup is the part of options.html they fill. Every
site, number and count is invented."""
import json
import re
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://x.test/"
PART = re.search(r'  <h2>Sites</h2>.*?<p id="addedStatus" role="status"></p>\n', (ROOT / "options.html").read_text(), re.S).group(0)
STYLE = re.search(r"<style>.*?</style>", (ROOT / "options.html").read_text(), re.S).group(0)
MARKUP = f"""<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="ui.css">{STYLE}<main>
{PART}</main><script src="sites-settings.js" type="module"></script><script src="added-settings.js" type="module"></script>"""
BUILT_IN = [{"id": "sdge", "name": "SDG&E", "match": ["https://myenergycenter.com/*"], "listUrl": "https://myenergycenter.com/x"}]


def config(name, host, **more):
    origin = f"https://{host}"
    return {"v": 1, "id": f"added-{name.lower().replace(' ', '-')}", "name": name, "origin": origin, "listUrl": origin + "/statements",
            "listPath": "/statements", "match": [origin + "/*"], "row": {"tag": "tr", "classes": []}, "path": [["td", 2], ["a", 1]],
            "href": "/files/{id}.pdf", "text": "Download", "date": {"from": "column", "column": 0, "header": "Statement Date"},
            "method": "fetch", "firstSync": "all", "created": "2026-11-10", **more}


ACME = config("Acme", "bank.example.test")
BETA = config("Beta Loans", "loans.example.test", firstSync="new")
CHROME = """
const saved = JSON.parse(sessionStorage.getItem('local') || '{}');
window.__local = saved; window.__changed = []; window.__calls = [];
const changed = (c) => __changed.forEach((f) => f(c, 'local'));
Object.defineProperty(window, 'chrome', { value: {
  storage: {
    local: {
      get: async (keys) => { const out = {}; for (const k of [].concat(keys)) if (k in __local) out[k] = JSON.parse(JSON.stringify(__local[k])); return out; },
      set: async (o) => { Object.assign(__local, JSON.parse(JSON.stringify(o))); const c = {}; for (const k in o) c[k] = { newValue: o[k] }; changed(c); },
      remove: async (keys) => { const c = {}; for (const k of [].concat(keys)) { delete __local[k]; c[k] = {}; } changed(c); },
    },
    onChanged: { addListener: (f) => __changed.push(f) },
  },
  permissions: {
    request: async (o) => { __calls.push(['request', o]); return !window.__deny; },
    remove: async (o) => { __calls.push(['remove', o]); return true; },
  },
  tabs: {
    create: async (o) => { __calls.push(['create', o]); return { id: 77, url: o.url, status: 'loading' }; },
    get: async (id) => ({ id, status: 'complete' }),
  },
  scripting: { executeScript: async (o) => { __calls.push(['script', o.files || (o.args || [])]); return [{ result: 'shown' }]; } },
} });
"""


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


def open_settings(browser, local=None):
    t = browser.new_page()
    t.add_init_script(CHROME)
    index = "export const PROVIDERS = " + json.dumps(BUILT_IN) + ";"

    def serve(route):
        rel = route.request.url[len(BASE):].split("?")[0]
        if rel == "providers/index.js":
            route.fulfill(status=200, content_type="text/javascript", body=index)
        elif rel == "settings.html":
            route.fulfill(status=200, content_type="text/html", body=MARKUP)
        elif (ROOT / rel).is_file():
            route.fulfill(status=200, content_type="text/css" if rel.endswith(".css") else "text/javascript", body=(ROOT / rel).read_text())
        else:
            route.fulfill(status=200, content_type="text/html", body="<!doctype html>")
    t.route(BASE + "**", serve)
    t.goto(BASE)
    t.evaluate("(l) => sessionStorage.setItem('local', JSON.stringify(l))", local or {})
    t.goto(BASE + "settings.html")
    return t


def rows(t):
    return t.locator("#addedList .added-site").evaluate_all(
        "rs => rs.map(r => [r.querySelector('.site-name').textContent, r.querySelector('.site-host').textContent, r.querySelector('.site-state').textContent, r.classList.contains('warn')])")


def test_with_none_added_it_says_how_to_add_one(browser):
    t = open_settings(browser)
    t.wait_for_selector("#addedList .row")
    assert t.inner_text("#addedList") == "None yet. To add one, open its statements page and press Add This Site… at the bottom of Statement Sweep's menu."
    assert t.inner_text("#addedNote") == ("Add This Site works only where each statement is a link you can click. Sites that show "
                                          "statements in a viewer, behind a form or a date picker, need a built-in recipe instead.")
    t.close()


def test_each_added_site_says_how_its_last_sync_went(browser):
    local = {
        "addedSites": [ACME, BETA],
        "seen:added-acme": ["2026-10-31", "2026-09-30", "2026-08-31"],
        "addedLast:added-acme": {"at": "2026-11-09", "ok": True, "noMatch": False, "found": 3},
        "seen:added-beta-loans": ["2026-10-31", "2026-09-30"], "primed:added-beta-loans": ["2026-09-30"],
    }
    t = open_settings(browser, local)
    t.wait_for_selector("#addedList .added-site")
    assert rows(t) == [
        ["Acme", "bank.example.test", "Worked last sync · 3 saved so far", False],
        # A statement its first sync only marked as seen is not counted as saved.
        ["Beta Loans", "loans.example.test", "Not synced yet · 1 saved so far", False],
    ]
    assert t.locator("#addedList .added-site").first.locator("button").all_inner_texts() == ["Pick Again…", "Remove…"]
    t.close()


def test_a_site_whose_last_sync_found_nothing_turns_orange(browser):
    t = open_settings(browser, {"addedSites": [ACME], "addedLast:added-acme": {"at": "2026-11-09", "ok": False, "noMatch": True, "found": 0}})
    t.wait_for_selector("#addedList .added-site.warn")
    assert t.inner_text("#addedList .site-why") == ("Last sync found no links like the one you picked. The site may have changed "
                                                    "its page. Pick a statement link again to fix it.")
    orange = t.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--orange')")
    assert orange and t.evaluate("getComputedStyle(document.querySelector('.site-why')).color") == t.evaluate(
        "(() => { const p = document.createElement('p'); p.style.color = 'var(--orange)'; document.body.append(p); return getComputedStyle(p).color; })()")
    t.close()


def test_remove_asks_twice_then_forgets_the_site_and_gives_back_access(browser):
    t = open_settings(browser, {"addedSites": [ACME, BETA], "seen:added-acme": ["2026-10-31"]})
    t.wait_for_selector("#addedList .added-site")
    t.click("button[aria-label='Remove Acme']")
    assert t.inner_text("button[aria-label='Remove Acme']") == "Remove (press again)"
    assert "Press Remove again" in t.inner_text("#addedStatus")
    assert [c["name"] for c in t.evaluate("__local.addedSites")] == ["Acme", "Beta Loans"]
    t.click("button[aria-label='Remove Acme']")
    t.wait_for_function("document.querySelectorAll('#addedList .added-site').length === 1")
    assert [c["name"] for c in t.evaluate("__local.addedSites")] == ["Beta Loans"]
    assert t.evaluate("__calls") == [["remove", {"origins": ["https://bank.example.test/*"]}]]
    assert t.inner_text("#addedStatus") == "Acme removed. What it saved stays where it is."
    # Its record of what it saved stays, so adding it again saves nothing twice.
    assert t.evaluate("__local['seen:added-acme']") == ["2026-10-31"]
    t.close()


def test_remove_left_alone_disarms(browser):
    t = open_settings(browser, {"addedSites": [ACME]})
    t.wait_for_selector("#addedList .added-site")
    t.clock.install()
    t.click("button[aria-label='Remove Acme']")
    t.clock.run_for(6000)
    assert t.inner_text("button[aria-label='Remove Acme']") == "Remove…"
    t.click("button[aria-label='Remove Acme']")
    assert len(t.evaluate("__local.addedSites")) == 1
    t.close()


def test_pick_again_opens_the_statements_page_with_the_picker(browser):
    t = open_settings(browser, {"addedSites": [ACME]})
    t.wait_for_selector("#addedList .added-site")
    t.click("button[aria-label='Pick a statement link again for Acme']")
    t.wait_for_function("__calls.length === 4")
    assert t.evaluate("__calls") == [
        ["request", {"origins": ["https://bank.example.test/*"]}],
        ["create", {"url": "https://bank.example.test/statements", "active": True}],
        ["script", ["providers/added.page.js", "picker.js"]],
        ["script", [{"name": "Acme"}]],
    ]
    t.close()


def test_pick_again_without_chromes_ok_opens_nothing(browser):
    t = open_settings(browser, {"addedSites": [ACME]})
    t.wait_for_selector("#addedList .added-site")
    t.evaluate("window.__deny = true")
    t.click("button[aria-label='Pick a statement link again for Acme']")
    t.wait_for_function("document.getElementById('addedStatus').textContent !== ''")
    assert t.inner_text("#addedStatus") == "Statement Sweep needs your OK to read bank.example.test."
    assert [c[0] for c in t.evaluate("__calls")] == ["request"]
    t.close()


def test_an_added_site_can_be_switched_off_like_the_others(browser):
    t = open_settings(browser, {"addedSites": [ACME]})
    t.wait_for_selector("#site-added-acme")
    assert t.locator("#sitesList label").all_inner_texts() == ["Acme", "SDG&E"]
    t.uncheck("#site-added-acme")
    t.wait_for_function("(__local.off || []).includes('added-acme')")
    # Removed, it leaves the list.
    t.evaluate("chrome.storage.local.set({ addedSites: [] })")
    t.wait_for_function("!document.getElementById('site-added-acme')")
    t.close()
