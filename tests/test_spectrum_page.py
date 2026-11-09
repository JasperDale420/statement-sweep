"""The Spectrum page logic, in a real Chromium, on stand-in pages. A statement
cannot be saved from here, so the point is that this says who is needed, reads
the rows strictly, and presses nothing."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://www.spectrum.net"
PAGE = "/billing/statements"
PRESS = "window.pressed = (window.pressed || 0) + 1"


def rows(*texts):
    return "".join(f'<a class="kite-list-item__action" href="javascript:void(0)" onclick="{PRESS}">{t}</a>' for t in texts)


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
        r.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body}")
    tab.goto("about:blank")
    tab.unroute("**/*")
    tab.route("**/*", route)
    tab.goto(url)
    tab.add_script_tag(content=(ROOT / "providers" / "spectrum.page.js").read_text())
    return asked


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_the_rows_dates_are_read_and_nothing_is_offered_to_save(tab):
    asked = load(tab, BASE + PAGE, rows("Statement August 26, 2026 $80.00", "Statement September 26, 2026 $80.00", "Billing help"))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []
    assert got["listed"] == ["2026-09-26", "2026-08-26"]
    assert tab.evaluate("window.pressed") is None
    assert len(asked) == 1


@pytest.mark.parametrize("path", ["/login", "/logout", "/signin", "/error/session-expired"])
def test_a_sign_in_address_is_signed_out(tab, path):
    load(tab, BASE + path, "<p>hello</p>")
    assert read(tab) == {"state": "signed_out"}


def test_the_sign_in_host_is_signed_out(tab):
    load(tab, "https://id.spectrum.net/x", "<p>hello</p>")
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_signed_out(tab):
    load(tab, BASE + PAGE, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_the_idle_dialog_is_signed_out(tab):
    load(tab, BASE + PAGE, rows("Statement September 26, 2026") + "<p>Your session is about to expire</p>")
    assert read(tab) == {"state": "signed_out"}


@pytest.mark.parametrize("words", ["Enter the code we sent you", "One-time passcode", "Are you a robot?", "Access Denied"])
def test_a_security_check_needs_the_person(tab, words):
    load(tab, BASE + PAGE, f"<h1>{words}</h1>")
    assert read(tab) == {"state": "challenge"}


def test_the_benign_try_again_message_is_not_a_stop(tab):
    load(tab, BASE + PAGE, rows("Statement September 26, 2026") + "<p>This info is currently not available. Please try again later.</p>")
    assert read(tab)["listed"] == ["2026-09-26"]


def test_a_rate_limit_stops(tab):
    load(tab, BASE + PAGE, "<p>Too many requests</p>")
    assert "try again later" in read(tab)["why"]


def test_another_page_is_not_the_list_yet(tab):
    load(tab, BASE + "/billing", "<p>Billing</p>")
    assert read(tab) == {"state": "no_list"}


@pytest.mark.parametrize("row", ["Statement Sept 26, 2026", "Statement February 31, 2026", "Statement September 26"])
def test_a_row_with_no_date_this_can_read_stops(tab, row):
    load(tab, BASE + PAGE, rows("Statement August 26, 2026", row))
    got = read(tab)
    assert got["state"] == "stopped" and got["listed"] == [] and "no date" in got["why"]
