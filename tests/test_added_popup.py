"""The popup's Add This Site link (add-site.js), and an added site in the
popup's list, in a real Chromium with the extension's own files and a
stand-in for Chrome's storage, tabs, permissions and scripting. The active
tab is a built-in site's page, a page that is not https, or a page that can
be added. Every site and number is invented."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://x.test/"
TYPES = {".js": "text/javascript", ".html": "text/html", ".css": "text/css"}
CHROME = """
const saved = JSON.parse(sessionStorage.getItem('state') || '{}');
window.__session = {}; window.__local = saved.local || {}; window.__calls = []; window.__closed = false; window.__sent = [];
const area = (name) => ({
  get: async (keys) => { const out = {}; for (const k of [].concat(keys)) if (k in window[name]) out[k] = window[name][k]; return out; },
  set: async (o) => { Object.assign(window[name], o); },
});
// Whether a call came inside the press itself, as Chrome's permission question needs.
window.__pressing = false;
window.addEventListener('click', () => { __pressing = true; }, true);
window.addEventListener('click', () => { __pressing = false; });
window.close = () => { __closed = true; };
Object.defineProperty(window, 'chrome', {value: {
  storage: {session: area('__session'), local: area('__local')},
  runtime: {sendMessage: async (m) => { __sent.push(m); }, openOptionsPage: () => {}, onMessage: {addListener: () => {}}, getURL: (p) => 'chrome-extension://sweep' + p},
  // The tab as it is when the picker is drawn: where it went since the popup opened, if anywhere.
  tabs: {query: async () => [saved.tab], get: async (id) => ({...saved.tab, url: saved.now || saved.tab.url}), update: async () => ({}), },
  windows: {update: async () => ({})},
  permissions: {request: async (o) => { __calls.push(['request', o, __pressing]); return !saved.deny; }},
  scripting: {executeScript: async (o) => { __calls.push(['script', o.target.tabId, o.files || o.args]); return [{result: 'shown'}]; }},
}});
"""
ACME = {"v": 1, "id": "added-acme", "name": "Acme", "origin": "https://bank.example.test", "listUrl": "https://bank.example.test/statements",
        "listPath": "/statements", "match": ["https://bank.example.test/*"], "row": {"tag": "tr", "classes": []}, "path": [["td", 2], ["a", 1]],
        "href": "/files/{id}.pdf", "text": "Download", "date": {"from": "column", "column": 0, "header": "Statement Date"},
        "method": "fetch", "firstSync": "all", "created": "2026-11-10"}


@pytest.fixture(scope="module")
def tab():
    def serve(route):
        path = ROOT / route.request.url[len(BASE):].split("?")[0]
        if path.is_file():
            route.fulfill(status=200, content_type=TYPES.get(path.suffix, "text/plain"), body=path.read_text())
        else:
            route.fulfill(status=200, content_type="text/html", body="<!doctype html><title>x</title>")
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        t.add_init_script(CHROME)
        t.route(BASE + "**", serve)
        yield t
        b.close()


def show(tab, url, local=None, deny=False, now=None):
    tab.goto(BASE)
    tab.evaluate("s => sessionStorage.setItem('state', JSON.stringify(s))", {"tab": {"id": 41, "url": url}, "local": local or {}, "deny": deny, "now": now})
    tab.goto(BASE + "popup.html")
    tab.wait_for_selector("#scroll li")
    # The tab is looked at as the popup opens.
    tab.wait_for_timeout(100)


def add(tab):
    tab.click("#addSite")


def test_the_footer_has_add_this_site_with_a_plus(tab):
    show(tab, "https://bank.example.test/statements")
    assert tab.inner_text("#addSite") == "Add This Site…"
    assert tab.locator("#addSite svg path").get_attribute("d").startswith("M8 3.25v9.5")
    assert tab.is_visible("#addSite")


def test_on_a_built_in_sites_page_it_says_so(tab):
    show(tab, "https://secure.chase.com/web/auth/dashboard#/dashboard/documents")
    add(tab)
    assert tab.inner_text("#addSay") == "Chase is already one of Statement Sweep's sites."
    assert tab.evaluate("__calls") == [] and not tab.evaluate("__closed")


@pytest.mark.parametrize("url", ["http://bank.example.test/statements", "chrome://extensions/", "file:///Users/x/a.pdf", None])
def test_a_page_that_is_not_https_cannot_be_added(tab, url):
    show(tab, url)
    add(tab)
    assert tab.inner_text("#addSay") == "This page can't be added. Only a secure (https) site can be."
    assert tab.evaluate("__calls") == []


def test_on_another_site_it_asks_chrome_inside_the_press_then_draws_the_picker(tab):
    show(tab, "https://bank.example.test/statements?acct=99990001")
    add(tab)
    tab.wait_for_function("__closed")
    assert tab.evaluate("__calls") == [
        ["request", {"origins": ["https://bank.example.test/*"]}, True],
        ["script", 41, ["providers/added.page.js", "picker.js"]],
        ["script", 41, [{"name": ""}]],
    ]


@pytest.mark.parametrize("now", ["https://elsewhere.example.test/statements", "https://bank.example.test.elsewhere.test/", "chrome://newtab/"])
def test_a_tab_that_left_the_site_while_chrome_asked_gets_no_picker(tab, now):
    show(tab, "https://bank.example.test/statements", now=now)
    add(tab)
    tab.wait_for_function("document.getElementById('addSay').textContent !== ''")
    assert tab.inner_text("#addSay") == "This tab is no longer on bank.example.test. Open its statements page and press Add This Site again."
    assert [c[0] for c in tab.evaluate("__calls")] == ["request"] and not tab.evaluate("__closed")


def test_without_chromes_ok_nothing_is_drawn(tab):
    show(tab, "https://bank.example.test/statements", deny=True)
    add(tab)
    tab.wait_for_function("document.getElementById('addSay').textContent !== ''")
    assert tab.inner_text("#addSay") == "Statement Sweep needs your OK to read bank.example.test. Nothing was added."
    assert [c[0] for c in tab.evaluate("__calls")] == ["request"] and not tab.evaluate("__closed")


def test_an_added_site_is_listed_and_adding_it_again_picks_again(tab):
    show(tab, "https://bank.example.test/statements", local={"addedSites": [ACME]})
    names = tab.locator(".name").all_inner_texts()
    assert "Acme" in names
    assert tab.locator("li:has(button[aria-label='Run Acme']) img.favicon").count() == 1
    add(tab)
    tab.wait_for_function("__closed")
    assert tab.evaluate("__calls")[-1] == ["script", 41, [{"name": "Acme"}]]


def test_an_added_site_runs_alone_like_any_other(tab):
    show(tab, "https://bank.example.test/statements", local={"addedSites": [ACME]})
    tab.click("button[aria-label='Run Acme']")
    tab.wait_for_function("__sent.some((m) => m && m.type === 'sweep')")
    assert [m for m in tab.evaluate("__sent") if m and m.get("type") == "sweep"] == [{"type": "sweep", "only": "added-acme"}]
