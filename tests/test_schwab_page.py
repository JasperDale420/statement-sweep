"""The Schwab page logic, in a real Chromium, on stand-in pages."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOST = "https://client.schwab.com"
PAGE = "/retail/accounts/statements/"


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, url, body, title="Statements &amp; Tax Forms"):
    asked = []

    def route(r):
        asked.append(r.request.url)
        r.fulfill(status=200, content_type="text/html",
                  body=f"<!doctype html><title>{title}</title><body>{body}</body>")

    tab.unroute("**/*")
    tab.route("**/*", route)
    tab.goto(url)
    tab.add_script_tag(content=(ROOT / "providers" / "schwab.page.js").read_text())
    return asked


def read(tab):
    return tab.evaluate("__sweep.readList()")


@pytest.mark.parametrize("url", ["/Areas/Access/Login", "/x?SessionTimeout=true"])
def test_a_sign_in_address_is_known(tab, url):
    load(tab, HOST + url, "<p>Sign in</p>", title="Login")
    assert read(tab) == {"state": "signed_out"}


def test_a_password_box_is_a_sign_in(tab):
    load(tab, HOST + PAGE, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_sign_in_address_in_a_query_is_not_the_statements_page(tab):
    load(tab, HOST + "/other?next=/retail/accounts/statements/", "<p>Hello</p>", title="Summary")
    assert read(tab) == {"state": "no_list"}


@pytest.mark.parametrize("words", ["Enter your verification code", "You've been logged out"])
def test_a_security_check_is_known(tab, words):
    load(tab, HOST + "/app/accounts/summary/", f"<p>{words}</p>", title="Schwab")
    assert read(tab) == {"state": "challenge"}


def test_throttling_stops(tab):
    load(tab, HOST + "/app/accounts/summary/", "<p>Service temporarily unavailable</p>", title="Schwab")
    assert read(tab)["state"] == "stopped"


def test_another_page_is_not_the_list(tab):
    load(tab, HOST + "/app/accounts/summary/", "<p>Accounts</p>", title="Summary")
    assert read(tab) == {"state": "no_list"}


@pytest.mark.parametrize("path", [PAGE, "/app/accounts/statements/"])
def test_the_statements_page_stops_says_why_and_asks_nothing(tab, path):
    asked = load(tab, HOST + path, "<button aria-label='Click to Download PDF'>x</button>")
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == [] and "ausgateway.schwab.com" in got["why"]
    assert asked == [HOST + path]


def test_a_title_drawn_late_is_waited_for(tab):
    load(tab, HOST + PAGE, "<script>setTimeout(() => { document.title = 'Statements'; }, 400)</script>",
         title="Loading")
    assert read(tab)["state"] == "stopped"


def test_it_can_save_nothing_so_it_offers_no_way_to(tab):
    load(tab, HOST + PAGE, "<p>x</p>")
    assert tab.evaluate("Object.keys(__sweep)") == ["readList"]
