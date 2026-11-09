"""The Bilt page logic, in a real Chromium, on stand-in pages shaped like
PaperPull's. A statement cannot be saved from here, so the point is that this
says who is needed, reads the sheet strictly, and presses nothing."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://www.bilt.com"
CARD = "0a1b2c3d-1111-4222-8333-944455556666"
PRESS = "window.pressed = (window.pressed || 0) + 1"


def sheet(dates, extra=""):
    rows = "".join(f'<li><button type="button" onclick="{PRESS}" aria-label="Download statement for {d}">{d}</button></li>' for d in dates)
    return f'<div id="sheet" role="dialog"><h2>Statements</h2><ul>{rows}</ul>{extra}</div>'


def wallet(portal="", label="Bilt Blue Card", four="4821"):
    return f"""<main id="wallet"><section id="card">
      <div><span>{label}</span> <span>•••• {four}</span> <button type="button" onclick="{PRESS}">View</button></div>
      <button type="button" onclick="{PRESS}" aria-label="View balance summary"><svg width="10" height="10"></svg></button>
      <p>Recent activity <a href="/wallet/transactions?cardId={CARD}">View all</a></p>
    </section></main>{portal}"""


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, path, body):
    asked = []

    def route(r):
        asked.append(r.request.url)
        r.fulfill(status=200, content_type="text/html", body=f"<!doctype html><meta charset=utf-8>{body}")
    tab.goto("about:blank")
    tab.unroute("**/*")
    tab.route("**/*", route)
    tab.goto(BASE + path)
    tab.add_script_tag(content=(ROOT / "providers" / "bilt.page.js").read_text())
    return asked


def read(tab):
    return tab.evaluate("__sweep.readList()")


DATES = ["September 06, 2026", "October 06, 2026", "August 06, 2026"]


def test_the_sheets_dates_are_read_and_nothing_is_offered_to_save(tab):
    asked = load(tab, "/wallet", wallet(sheet(DATES)))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []
    assert got["listed"] == ["2026-10-06", "2026-09-06", "2026-08-06"]
    assert "new tab" in got["why"]
    assert tab.evaluate("window.pressed") is None
    assert len(asked) == 1


def test_with_no_sheet_open_nothing_is_pressed_to_open_it(tab):
    load(tab, "/wallet", wallet())
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == [] and got["listed"] == []
    assert tab.evaluate("window.pressed") is None


@pytest.mark.parametrize("path", ["/login", "/auth/start"])
def test_a_sign_in_address_is_signed_out(tab, path):
    load(tab, path, "<p>Hello</p>")
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_signed_out(tab):
    load(tab, "/wallet", "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_the_sign_in_drawn_on_the_wallet_is_signed_out(tab):
    load(tab, "/wallet", "<nav><button>Sign up / Log in</button></nav><p>Welcome to Bilt. Log in or sign up.</p>")
    assert read(tab) == {"state": "signed_out"}


def test_a_sign_in_that_goes_away_is_not_signed_out(tab):
    body = wallet(sheet(DATES)).replace("<main", "<main hidden") + """<p id=s>Complete login to continue.</p>
      <script>setTimeout(() => { document.getElementById('s').remove();
        document.querySelector('main').hidden = false; }, 600);</script>"""
    load(tab, "/wallet", body)
    assert read(tab)["state"] == "stopped"


def test_a_security_check_needs_the_person(tab):
    load(tab, "/wallet", "<h1>Enter the code</h1><p>We sent a code to your phone</p>")
    assert read(tab) == {"state": "challenge"}


def test_another_page_is_not_the_list_yet(tab):
    load(tab, "/rewards", "<p>hello</p>")
    assert read(tab) == {"state": "no_list"}


def test_a_wallet_with_two_cards_stops(tab):
    second = '<div><span>Bilt Card</span> <span>•••• 9999</span></div>'
    load(tab, "/wallet", wallet(second + sheet(DATES)))
    assert "one Bilt Card" in read(tab)["why"]


@pytest.mark.parametrize("text", ["October 32, 2026", "Oct 06, 2026", "2026-10-06"])
def test_a_date_that_is_not_one_stops(tab, text):
    bad = f'<button type="button" aria-label="Download statement for {text}">{text}</button>'
    load(tab, "/wallet", wallet(f"<div>{bad}</div>"))
    got = read(tab)
    assert got["state"] == "stopped" and got["listed"] == []


def test_a_label_and_text_that_disagree_stop(tab):
    bad = '<button type="button" aria-label="Download statement for October 06, 2026">October 07, 2026</button>'
    load(tab, "/wallet", wallet(f"<div>{bad}</div>"))
    assert read(tab)["listed"] == []


def test_a_control_for_more_statements_stops(tab):
    load(tab, "/wallet", wallet(sheet(DATES, extra="<button>Load more</button>")))
    got = read(tab)
    assert got["listed"] == [] and "only part" in got["why"]
