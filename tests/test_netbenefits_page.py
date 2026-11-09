"""The NetBenefits page logic, in a real Chromium, on stand-in pages."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WPS = "https://workplaceservices.fidelity.com"
NB = "https://nb.fidelity.com"
STATEMENTS = "/mybenefits/savings2/navigation/dc/OnlineStatement"


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, url, body):
    asked = []

    def route(r):
        asked.append(r.request.url)
        r.fulfill(status=200, content_type="text/html", body=f"<!doctype html><body>{body}</body>")

    tab.unroute("**/*")
    tab.route("**/*", route)
    tab.goto(url)
    tab.add_script_tag(content=(ROOT / "providers" / "netbenefits.page.js").read_text())
    return asked


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_a_sign_in_page_is_known(tab):
    load(tab, NB + "/public/nb/default/login", "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_is_known(tab):
    load(tab, WPS + STATEMENTS, "<p>Verify your identity</p>")
    assert read(tab) == {"state": "challenge"}


def test_throttling_stops(tab):
    load(tab, WPS + STATEMENTS, "<p>Too many requests</p>")
    assert read(tab)["state"] == "stopped"


def test_the_sign_in_site_when_signed_in_is_not_the_list(tab):
    load(tab, NB + "/public/nb/default/home", "<h1>Home</h1>")
    assert read(tab) == {"state": "no_list"}


def test_the_statements_site_stops_and_says_why_and_asks_nothing(tab):
    asked = load(tab, WPS + STATEMENTS, "<h1>Statements</h1><form name=frmRequest></form>")
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == [] and "no address" in got["why"]
    assert asked == [WPS + STATEMENTS]


def test_it_can_save_nothing_so_it_offers_no_way_to(tab):
    load(tab, WPS + STATEMENTS, "<h1>Statements</h1>")
    assert tab.evaluate("Object.keys(__sweep)") == ["readList"]
