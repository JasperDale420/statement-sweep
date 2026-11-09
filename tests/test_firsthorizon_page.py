"""The First Horizon page logic, in a real Chromium, on stand-in pages.
Every value is invented, shaped as PaperPull's survey saw them."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://digital.firsthorizon.com"
PAGE = "/#accounts/documents"


def card(mdy, date_label=None, button=True, extra=""):
    label = date_label or mdy
    b = (f'<button class="edocs-download-btn" aria-label="Open New Tab to Download PDF for {mdy} statement" '
         f'onclick="(window.pressed = window.pressed || []).push(\'{mdy}\')" {extra}>Download PDF</button>') if button else ""
    return f'<div class="card edocs-item-card" aria-label="Monthly statement for {label}">{b}</div>'


def panel(cards, nick="Everyday", product="Express Checking", mask="4821", expanded="true", region="p1", style=""):
    return (f'<div class="accordion-panel" role="button" aria-expanded="{expanded}" aria-controls="{region}" style="{style}">'
            f'{nick} ({product}) (*{mask}) $12.34</div><div id="{region}">{cards}</div>')


def documents(panels):
    return f'<h1>View Statements</h1><button class="edocs-estatements-tab">STATEMENTS</button>{panels}'


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, body, url=BASE + PAGE):
    tab.goto("about:blank")
    tab.unroute("**/*")
    tab.route("**/*", lambda r: r.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body}"))
    tab.goto(url)
    tab.add_script_tag(content=(ROOT / "providers" / "firsthorizon.page.js").read_text())


def read(tab):
    return tab.evaluate("__sweep.readList()")


def click(tab, doc_id):
    return tab.evaluate("(id) => __sweep.clickDoc({id})", doc_id)


TWO = documents(panel(card("08/15/2026") + card("09/15/2026")) + panel(card("09/20/2026"), mask="7000", region="p2"))


def test_open_panels_are_read_newest_first_with_their_dates(tab):
    load(tab, TWO)
    assert read(tab) == {"state": "ok", "docs": [
        {"id": "7000-2026-09-20", "date": "2026-09-20", "method": "click"},
        {"id": "4821-2026-09-15", "date": "2026-09-15", "method": "click"},
        {"id": "4821-2026-08-15", "date": "2026-08-15", "method": "click"}]}


def test_a_closed_panel_is_not_opened_and_says_so(tab):
    load(tab, documents(panel(card("09/15/2026")) + panel("", mask="7000", expanded="false", region="p2")))
    got = read(tab)
    assert got["state"] == "stopped" and "closed" in got["why"]
    assert [d["date"] for d in got["docs"]] == ["2026-09-15"]
    assert tab.evaluate("window.pressed") is None


@pytest.mark.parametrize("url", [BASE + "/sso/logout", "https://security.firsthorizon.com/"])
def test_a_sign_in_address_is_signed_out(tab, url):
    load(tab, "<p>Sign in</p>", url=url)
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_signed_out(tab):
    load(tab, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_the_session_timeout_warning_is_signed_out(tab):
    load(tab, documents(panel(card("09/15/2026"))) + "<div>Session Timeout Warning</div>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_needs_the_person(tab):
    load(tab, "<h1>Enter the code we sent you</h1>")
    assert read(tab) == {"state": "challenge"}


def test_a_statement_card_is_not_a_security_check(tab):
    load(tab, documents(panel(card("09/15/2026"))) + "<p>Enter the code from your authenticator</p>")
    assert read(tab)["state"] == "ok"


def test_another_route_is_not_the_list_yet(tab):
    load(tab, "<h1>Accounts</h1>", url=BASE + "/#accounts/list")
    assert read(tab) == {"state": "no_list"}


@pytest.mark.parametrize("label", ["13/40/2026", "02/31/2026", "September 15, 2026"])
def test_a_date_that_is_not_one_stops(tab, label):
    load(tab, documents(panel(card("09/15/2026", date_label=label))))
    assert read(tab)["state"] == "stopped"


def test_two_statements_of_one_date_stop(tab):
    load(tab, documents(panel(card("09/15/2026") + card("09/15/2026"))))
    assert read(tab)["state"] == "stopped"


def test_a_card_with_no_download_stops(tab):
    load(tab, documents(panel(card("09/15/2026", button=False))))
    assert read(tab)["state"] == "stopped"


def test_a_panel_the_page_hides_stops(tab):
    load(tab, documents(panel(card("09/15/2026")) + panel("", mask="7000", expanded="false", region="p2", style="display:none")))
    got = read(tab)
    assert got["state"] == "stopped" and "hidden" in got["why"]


def test_the_click_presses_only_that_statements_button(tab):
    load(tab, TWO)
    assert click(tab, "4821-2026-09-15") == {"ok": True}
    assert tab.evaluate("window.pressed") == ["09/15/2026"]


@pytest.mark.parametrize("doc_id", ["../../etc", "4821-2026-09-16", "9999-2026-09-15", ""])
def test_a_statement_not_on_the_page_is_not_pressed(tab, doc_id):
    load(tab, TWO)
    assert click(tab, doc_id)["ok"] is False
    assert tab.evaluate("window.pressed") is None


def test_a_turned_off_button_is_not_pressed(tab):
    load(tab, documents(panel(card("09/15/2026", extra="disabled"))))
    assert click(tab, "4821-2026-09-15")["ok"] is False
    assert tab.evaluate("window.pressed") is None


def test_a_button_labelled_for_another_date_is_not_pressed(tab):
    wrong = card("09/15/2026").replace("for 09/15/2026 statement", "for 08/15/2026 statement")
    load(tab, documents(panel(wrong)))
    assert click(tab, "4821-2026-09-15")["ok"] is False
    assert tab.evaluate("window.pressed") is None
