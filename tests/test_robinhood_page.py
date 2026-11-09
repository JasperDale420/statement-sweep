"""The Robinhood page logic, in a real Chromium, on stand-in pages."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://robinhood.com"
PAGE = "/account/reports-statements/individual"
JAN = "January 2026 – Individual Investing Account Statement"
FEB = "February 2026 – Individual Investing Account Statement"
SCRIPT = "<script>window.pressed=[];function press(e){pressed.push(e.closest('[data-t]').dataset.t)}</script>"


def link(title):
    return f'<div data-t="{title}"><a download href="#" onclick="press(this);return false">{title}</a></div>'


def button(title, label="Download PDF"):
    return f'<div data-t="{title}"><div>{title}</div><a href="#" onclick="press(this);return false">{label}</a></div>'


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, body, path=PAGE):
    def respond(route):
        if route.request.url.startswith(BASE):
            route.fulfill(status=200, content_type="text/html; charset=utf-8",
                          body=f"<!doctype html><title>Robinhood</title>{body}{SCRIPT}")
        else:
            route.abort()
    tab.unroute("**/*")
    tab.route("**/*", respond)
    tab.goto(BASE + path)
    tab.add_script_tag(content=(ROOT / "providers" / "robinhood.page.js").read_text())


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_statements_are_listed_newest_first_dated_by_the_end_of_their_month(tab):
    load(tab, f"<main>{link(JAN)}{link(FEB)}</main>")
    assert read(tab) == {"state": "ok", "docs": [
        {"id": FEB, "date": "2026-02-28", "title": FEB, "method": "click"},
        {"id": JAN, "date": "2026-01-31", "title": JAN, "method": "click"},
    ]}


def test_a_download_pdf_button_takes_its_title_from_around_it(tab):
    load(tab, f"<main>{button(FEB)}</main>")
    assert read(tab)["docs"][0]["id"] == FEB


def test_a_csv_is_not_listed(tab):
    load(tab, f"<main>{link(FEB)}<button>Download CSV</button></main>")
    got = read(tab)
    assert got["state"] == "ok" and len(got["docs"]) == 1


def test_signed_out_by_address_and_password_field(tab):
    load(tab, "", path="/login")
    assert read(tab) == {"state": "signed_out"}
    load(tab, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_is_a_challenge(tab):
    load(tab, "<main>Confirm your identity. We sent a code.</main>")
    assert read(tab) == {"state": "challenge"}


def test_another_page_is_not_the_list(tab):
    load(tab, "<main>Account</main>", path="/account/reports-statements/tax")
    assert read(tab) == {"state": "no_list"}


def test_a_statement_with_no_date_stops_and_keeps_the_rest(tab):
    load(tab, f"<main>{link(FEB)}{button('Consolidated Form 1099')}</main>")
    got = read(tab)
    assert got["state"] == "stopped" and [d["id"] for d in got["docs"]] == [FEB]


def test_a_month_offered_only_as_html_is_left_out_and_said(tab):
    load(tab, f"<main>{link(FEB)}{button(JAN, 'Download HTML')}</main>")
    got = read(tab)
    assert got["state"] == "stopped" and "web page" in got["why"] and [d["id"] for d in got["docs"]] == [FEB]


def test_view_more_stops_with_what_was_read(tab):
    load(tab, f"<main>{link(FEB)}<a href='#'>View More</a></main>")
    got = read(tab)
    assert got["state"] == "stopped" and "View More" in got["why"] and len(got["docs"]) == 1


def test_click_presses_only_its_own_statement(tab):
    load(tab, f"<main>{link(JAN)}{link(FEB)}</main>")
    doc = read(tab)["docs"][1]
    assert tab.evaluate("(d) => __sweep.clickDoc(d)", doc) == {"ok": True}
    assert tab.evaluate("pressed") == [JAN]


def test_a_document_that_cannot_be_bound_presses_nothing(tab):
    load(tab, f"<main>{link(JAN)}</main>")
    for doc in [{"id": "x", "title": "y", "date": "2026-01-31"},
                {"id": FEB, "title": FEB, "date": "2026-02-28"},
                {"id": JAN, "title": JAN, "date": "2026-02-28"}]:
        assert tab.evaluate("(d) => __sweep.clickDoc(d)", doc)["ok"] is False
    assert tab.evaluate("pressed") == []


def test_a_control_that_trips_the_blocklist_stops_and_is_not_pressed(tab):
    load(tab, f"<main>{button(FEB, 'Download PDF to transfer')}</main>")
    assert read(tab)["state"] == "stopped"
    doc = {"id": FEB, "title": FEB, "date": "2026-02-28"}
    assert tab.evaluate("(d) => __sweep.clickDoc(d)", doc)["ok"] is False
    assert tab.evaluate("pressed") == []
