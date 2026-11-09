"""The TreasuryDirect page logic, in a real Chromium, on stand-in pages."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOST = "https://www.treasurydirect.gov"
GATEWAY = "/RS/RSGatewayRW?UIHandler=misc.DisplayWelcome&primary=true&processID=111&uiFrom=misc.DisplayWelcome"
UNAVAILABLE = "<html><head><title>TreasuryDirect is unavailable.</title></head><body><h1>TreasuryDirect is unavailable.</h1></body></html>"
OTP = '<html><body><h1>One-time passcode</h1><p>Enter the code we sent</p><input type="text" name="otp"></body></html>'


def link(handler, label):
    return f'<a href="/RS/RSGatewayRW?uiFrom=misc.DisplayWelcome&amp;primary=true&amp;processID=111&amp;fromTabLink=true&amp;UIHandler={handler}">{label}</a>'


TABS = (link("misc.DisplayWelcome", "My Account") + link("ch.DisplayCurrentHoldings", "Current Holdings")
        + link("md.DisplayManageDirect", "ManageDirect&reg;") + link("hist.DisplayHistory", "History"))


def signed_in(body="", h1="Welcome to your account summary"):
    return f'<html><body>{TABS}<p>Sam Doe\'s account: A-123-456-789</p><h1>{h1}</h1>{body}<input type="text" name="iesinglesubmithack"></body></html>'


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, path, body):
    tab.unroute("**/*")
    tab.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body}"))
    tab.goto(HOST + path)
    tab.add_script_tag(content=(ROOT / "providers" / "treasurydirect.page.js").read_text())


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_the_sign_in_address_is_known(tab):
    load(tab, "/RS/UN-Display.do", "<p>Account number</p>")
    assert read(tab) == {"state": "signed_out"}


def test_an_ended_session_is_known(tab):
    load(tab, GATEWAY, UNAVAILABLE)
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_known(tab):
    load(tab, GATEWAY, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_passcode_page_waits_for_the_person(tab):
    load(tab, GATEWAY, OTP)
    assert read(tab) == {"state": "challenge"}


def test_a_signed_in_page_with_a_retirement_notice_is_not_a_passcode_page(tab):
    load(tab, GATEWAY, signed_in("<p>Your security questions will be retired.</p>"))
    assert read(tab)["state"] == "stopped"


def test_a_signed_in_page_offers_nothing_and_says_why(tab):
    load(tab, GATEWAY, signed_in())
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == [] and "address" in got["why"]


def test_it_never_sends_the_tab_anywhere(tab):
    for path, body in [(GATEWAY, signed_in()), (GATEWAY, "<h1>Something else</h1>"), ("/indiv/help/", "<h1>Help</h1>")]:
        load(tab, path, body)
        assert read(tab)["state"] != "no_list", path


def test_a_page_on_the_address_without_its_tabs_stops(tab):
    load(tab, GATEWAY, "<h1>Something else</h1>")
    assert read(tab)["state"] == "stopped"


def test_a_taxable_year_is_named_for_saving_by_hand(tab):
    taxes = "<h4>Manage My Taxes</h4><ul><li>Year 2024 (No taxable transactions)</li><li><a href=\"/x\">Year 2025</a></li></ul>"
    load(tab, "/RS/RSGatewayRW?UIHandler=md.DisplayManageDirect&processID=111", signed_in(taxes, "ManageDirect&reg;"))
    got = read(tab)
    assert got["state"] == "stopped" and "2025" in got["why"] and "2024" not in got["why"]


def test_no_way_to_save_is_offered(tab):
    load(tab, GATEWAY, signed_in())
    assert tab.evaluate("Object.keys(__sweep)") == ["readList"]
