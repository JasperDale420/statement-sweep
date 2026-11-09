"""The Coinbase page logic, in a real Chromium, on stand-in pages."""
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://accounts.coinbase.com"
PAGE = "/statements"
# The row shape PaperPull's test_statement_rows_in_a_browser.py draws.
BUTTONS = ("<div><button type='button'>HTML</button>"
           "<button type='button' data-testid='statements-pdf-v2' onclick='press(this)'>PDF</button>"
           "<button type='button'>CSV</button></div>")


def statements(*rows, after=""):
    body = "".join(f"<div class='row'>{r}{BUTTONS}</div>" for r in rows)
    return (f"<main><div class='list'>{body}</div>{after}<button type='button'>Generate</button></main>"
            "<script>window.pressed=[];function press(b){pressed.push(b.closest('.row').innerText.slice(0,20))}</script>")


GOOD = ("<span>Last 30 days</span>", "<span>September 2026</span>", "<span>August 2026</span>")
OWNER = {"first_transaction_date": "2026-08-03T00:00:00Z"}


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, body, path=PAGE, host=BASE, owner=OWNER, owner_status=200):
    def respond(route):
        url = route.request.url
        if not url.startswith(host):
            route.abort()
        elif url.endswith("/v2/tax/owner-info"):
            route.fulfill(status=owner_status, content_type="application/json", body=json.dumps(owner))
        else:
            route.fulfill(status=200, content_type="text/html", body=f"<!doctype html><title>Coinbase</title>{body}")
    tab.unroute("**/*")
    tab.route("**/*", respond)
    tab.goto(host + path)
    tab.add_script_tag(content=(ROOT / "providers" / "coinbase.page.js").read_text())


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_months_are_read_newest_first_at_their_last_day_and_the_window_is_skipped(tab):
    load(tab, statements(*GOOD))
    assert read(tab) == {"state": "ok", "docs": [
        {"id": "2026-09", "date": "2026-09-30", "title": "Monthly Statement", "method": "click"},
        {"id": "2026-08", "date": "2026-08-31", "title": "Monthly Statement", "method": "click"},
    ]}


def test_signed_out_on_the_sign_in_address_and_by_password_field(tab):
    load(tab, "", path="/signin")
    assert read(tab) == {"state": "signed_out"}
    load(tab, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_is_a_challenge(tab):
    load(tab, "<main>Enter the code from your authenticator</main>")
    assert read(tab) == {"state": "challenge"}


def test_the_home_page_is_not_the_list(tab):
    load(tab, "<main>Home</main>", path="/home", host="https://www.coinbase.com")
    assert read(tab) == {"state": "no_list"}


def test_a_row_that_does_not_start_with_its_month_stops_and_keeps_the_rest(tab):
    load(tab, statements("<span>Last 30 days</span>", "<span>September 2026</span>",
                         "<span>New</span> <span>August 2026</span>"))
    got = read(tab)
    assert got["state"] == "stopped" and [d["id"] for d in got["docs"]] == ["2026-09"]


def test_a_load_more_that_shows_stops_with_what_was_read(tab):
    load(tab, statements(*GOOD, after="<button data-testid='load-more'>Load more</button>"))
    got = read(tab)
    assert got["state"] == "stopped" and "Load more" in got["why"] and len(got["docs"]) == 2


def test_a_list_short_of_the_first_month_stops(tab):
    load(tab, statements(*GOOD), owner={"first_transaction_date": "2024-02-03"})
    assert read(tab)["state"] == "stopped"


def test_no_first_transaction_stops(tab):
    load(tab, statements(*GOOD), owner={})
    assert read(tab)["state"] == "stopped"


def test_click_presses_only_that_months_pdf_button(tab):
    load(tab, statements(*GOOD))
    assert tab.evaluate("__sweep.clickDoc({id: '2026-08'})") == {"ok": True}
    pressed = tab.evaluate("pressed")
    assert len(pressed) == 1 and pressed[0].startswith("August 2026")


@pytest.mark.parametrize("doc", ["../x", "2026-13", "2020-01"])
def test_a_month_that_cannot_be_bound_presses_nothing(tab, doc):
    load(tab, statements(*GOOD))
    assert tab.evaluate(f"__sweep.clickDoc({{id: '{doc}'}})")["ok"] is False
    assert tab.evaluate("pressed") == []


def test_a_button_that_does_not_read_pdf_stops_and_is_not_pressed(tab):
    load(tab, statements(*GOOD).replace(">PDF<", ">Generate<"))
    assert read(tab)["state"] == "stopped"
    assert tab.evaluate("__sweep.clickDoc({id: '2026-08'})")["ok"] is False
    assert tab.evaluate("pressed") == []
