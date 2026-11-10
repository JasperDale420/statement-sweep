"""What the popup shows, in a real Chromium with the extension's own files and
Chrome's own storage stood in for."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://x.test/"
TYPES = {".js": "text/javascript", ".html": "text/html", ".css": "text/css"}
CHROME = """
const saved = JSON.parse(sessionStorage.getItem('state') || '{}');
window.__session = saved.board ? {board: saved.board} : {};
window.__local = saved.off ? {off: saved.off} : {};
window.__sent = []; window.__listeners = [];
const area = (name) => ({
  get: async (keys) => { const out = {}; for (const k of [].concat(keys)) if (k in window[name]) out[k] = window[name][k]; return out; },
  set: async (o) => { Object.assign(window[name], o); },
});
Object.defineProperty(window, 'chrome', {value: {
  storage: {session: area('__session'), local: area('__local')},
  runtime: {sendMessage: (m) => { __sent.push(m); return Promise.resolve(); }, openOptionsPage: () => { __sent.push('options'); },
            onMessage: {addListener: (f) => __listeners.push(f)}},
}});
"""


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


def st(state, text):
    return {"state": state, "text": text, "at": 1}


def show(tab, board=None, off=None):
    tab.goto(BASE)
    tab.evaluate("s => sessionStorage.setItem('state', JSON.stringify(s))", {"board": board or {}, "off": off or []})
    tab.goto(BASE + "popup.html")
    tab.wait_for_selector("#scroll li")


def headings(tab):
    return tab.locator("h2").all_inner_texts()


def names_under(tab, state):
    return tab.locator(f"section[data-state='{state}'] .name").all_inner_texts()


def test_before_any_run_it_says_how_many_sites_are_selected(tab):
    show(tab, off=["amex", "chase"])
    assert tab.inner_text("#summary") == "15 of 17 sites selected"
    assert headings(tab) == ["Sites"] and tab.inner_text("#go") == "Get New Documents" and not tab.is_disabled("#go")


def test_what_needs_you_comes_first_and_is_named_at_the_top(tab):
    show(tab, {"alpaca": st("ok", "Nothing new."), "coinbase": st("working", "Looking…"), "chase": st("needs_you", "Sign in to Chase in its tab. This goes on by itself."), "irs": st("bad", "Stopped waiting for you to sign in.")})
    assert headings(tab) == ["Needs You", "In Progress", "Stopped", "Done", "Not Run Yet"]
    assert names_under(tab, "needs_you") == ["Chase"]
    assert tab.inner_text("#summary") == "Chase needs you"
    assert tab.get_attribute("#summary", "data-kind") == "attention"


def test_several_sites_needing_you_are_counted(tab):
    show(tab, {"amex": st("needs_you", "a"), "chase": st("needs_you", "b")})
    assert tab.inner_text("#summary") == "2 sites need you"


def test_while_working_nothing_can_be_started(tab):
    show(tab, {"coinbase": st("working", "Saving 1 of 2…")})
    assert tab.inner_text("#summary") == "Working on Coinbase…"
    assert tab.is_disabled("#go") and tab.inner_text("#go") == "Working…"
    assert tab.locator(".one:not(:disabled)").count() == 0


def test_finished_results_are_added_up(tab):
    show(tab, {"amex": st("ok", "12 new."), "chase": st("ok", "1 new. A note."), "sdge": st("ok", "Nothing new.")})
    assert tab.inner_text("#summary") == "13 new documents"
    assert not tab.is_disabled("#go")


def test_nothing_new_says_so(tab):
    show(tab, {"amex": st("ok", "Nothing new.")})
    assert tab.inner_text("#summary") == "Nothing new"


def test_a_stop_is_counted_with_what_it_saved(tab):
    show(tab, {"amex": st("bad", "3 saved, then it stopped."), "chase": st("ok", "2 new.")})
    assert tab.inner_text("#summary") == "5 new, 1 stopped"


def test_every_message_is_shown_whole(tab):
    long = "0 saved. The page was not what this expected. " * 4
    show(tab, {"amex": st("bad", long)})
    assert tab.inner_text("section[data-state=bad] .say").strip() == long.strip()


def test_unticking_every_site_leaves_nothing_to_start(tab):
    show(tab)
    for box in tab.locator("input[type=checkbox]").all():
        box.uncheck()
    tab.wait_for_function("document.getElementById('summary').textContent === 'No sites selected'")
    assert tab.is_disabled("#go")


def test_run_asks_for_one_site_and_get_new_for_all(tab):
    show(tab)
    tab.click("button[aria-label='Run Chase']")
    tab.click("#go")
    sent = tab.evaluate("__sent")
    assert sent[0] == {"type": "sweep", "only": "chase"}
    assert sent[1]["type"] == "sweep" and sent[1].get("only") is None


def test_settings_opens_the_settings_page(tab):
    show(tab)
    tab.click("#settings")
    assert tab.evaluate("__sent") == ["options"]


def test_a_redraw_keeps_the_keyboards_place(tab):
    show(tab, {"amex": st("ok", "1 new.")})
    tab.focus("button[aria-label='Run Chase']")
    tab.evaluate("__session.board.alpaca = {state: 'ok', text: '2 new.', at: 1}; __listeners.forEach(f => f({type: 'board'}))")
    tab.wait_for_function("document.querySelector('section[data-state=ok] li .name').textContent === 'Alpaca'")
    assert tab.evaluate("document.activeElement.getAttribute('aria-label')") == "Run Chase"


def test_status_is_announced_and_lists_are_named_by_their_heading(tab):
    show(tab, {"chase": st("needs_you", "a")})
    assert tab.get_attribute("#summary", "role") == "status"
    assert tab.locator("section[data-state=needs_you] ul").get_attribute("aria-labelledby") == "heading-needs_you"
