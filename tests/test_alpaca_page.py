"""The Alpaca page logic, in a real Chromium, on stand-in pages."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://app.alpaca.markets"
PAGE = "/account/documents"
LIVE = '<button data-testid="account-switcher-button">Invented Ventures LLC - 7QX40031</button>'
PAPER = '<button data-testid="account-switcher-button">Invented Ventures LLC Paper - PA3QX</button>'


def row(day="2026-09-30", kind="account_statement", last='<p onclick="press(this)">Download</p>'):
    return f"<tr><td>{day}</td><td>{kind}</td><td>{last}</td></tr>"


def page_of(rows, switcher=LIVE, pager=""):
    return (f"{switcher}<table><thead><tr><th>Date</th><th>Document Type</th><th>Download</th></tr></thead>"
            f"<tbody>{rows}</tbody></table>{pager}"
            "<script>window.pressed=[];function press(p){pressed.push(p.closest('tr').cells[0].textContent)}</script>")


GOOD = (row("2026-08-31") + row("2026-09-30") + row("2026-09-30", "crypto_account_statement")
        + row("2026-09-30", "trade_confirmation") + row("2026-09-30", "trade_confirmation_json")
        + row("2026-08-17", "account_application"))


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
            route.fulfill(status=200, content_type="text/html", body=f"<!doctype html><title>Alpaca</title>{body}")
        else:
            route.abort()
    tab.unroute("**/*")
    tab.route("**/*", respond)
    tab.goto(BASE + path)
    tab.add_script_tag(content=(ROOT / "providers" / "alpaca.page.js").read_text())


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_kept_types_are_listed_newest_first_with_the_rest_passed_over(tab):
    load(tab, page_of(GOOD))
    got = read(tab)
    assert got["state"] == "ok"
    assert [(d["id"], d["date"], d["title"], d["method"]) for d in got["docs"]] == [
        ("2026-09-30_account_statement", "2026-09-30", "Brokerage Statement", "click"),
        ("2026-09-30_crypto_account_statement", "2026-09-30", "Crypto Statement", "click"),
        ("2026-09-30_trade_confirmation", "2026-09-30", "Trade Confirmation", "click"),
        ("2026-08-31_account_statement", "2026-08-31", "Brokerage Statement", "click"),
    ]


@pytest.mark.parametrize("path", ["/account/login", "/logout"])
def test_signed_out_by_address(tab, path):
    load(tab, "", path=path)
    assert read(tab) == {"state": "signed_out"}


def test_signed_out_by_password_field(tab):
    load(tab, LIVE + "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_is_a_challenge(tab):
    load(tab, "<p>Enter the code we sent to your phone</p>")
    assert read(tab) == {"state": "challenge"}


@pytest.mark.parametrize("body", [
    page_of(GOOD, switcher=PAPER),
    page_of(GOOD) + "<div>You are on Paper Trading</div>",
])
def test_a_paper_account_stops_and_nothing_is_listed(tab, body):
    load(tab, body)
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == [] and "Paper" in got["why"]


def test_a_paper_account_sent_to_its_dashboard_stops_too(tab):
    load(tab, PAPER, path="/dashboard/overview")
    assert read(tab)["state"] == "stopped"


def test_another_page_is_not_the_list(tab):
    load(tab, LIVE, path="/dashboard/overview")
    assert read(tab) == {"state": "no_list"}


@pytest.mark.parametrize("day", ["2026-02-31", "Sep 30, 2026", ""])
def test_a_date_that_is_not_one_stops(tab, day):
    load(tab, page_of(row(day)))
    assert read(tab)["state"] == "stopped"


def test_a_row_in_another_shape_stops(tab):
    load(tab, page_of(row() + "<tr><td>2026-08-31</td><td>account_statement</td></tr>"))
    got = read(tab)
    assert got["state"] == "stopped" and len(got["docs"]) == 1


def test_a_next_that_is_on_stops_with_what_was_read(tab):
    load(tab, page_of(row(), pager="<button>Previous</button><button>Next</button>"))
    got = read(tab)
    assert got["state"] == "stopped" and "first page" in got["why"] and len(got["docs"]) == 1


def test_a_next_that_is_off_ends_the_list(tab):
    load(tab, page_of(row(), pager="<button disabled>Previous</button><button disabled>Next</button>"))
    assert read(tab)["state"] == "ok"


def test_two_of_one_date_and_kind_are_left_unsaved(tab):
    load(tab, page_of(row() + row() + row("2026-08-31")))
    got = read(tab)
    assert got["state"] == "stopped" and [d["date"] for d in got["docs"]] == ["2026-08-31"]


def test_click_presses_only_its_own_row(tab):
    load(tab, page_of(GOOD))
    assert tab.evaluate("__sweep.clickDoc({id: '2026-08-31_account_statement'})") == {"ok": True}
    assert tab.evaluate("pressed") == ["2026-08-31"]


@pytest.mark.parametrize("doc", ["../x", "2026-08-31_account_application", "2020-01-31_account_statement"])
def test_a_document_that_cannot_be_bound_presses_nothing(tab, doc):
    load(tab, page_of(GOOD))
    assert tab.evaluate(f"__sweep.clickDoc({{id: '{doc}'}})")["ok"] is False
    assert tab.evaluate("pressed") == []


def test_a_control_that_is_not_a_download_is_not_pressed(tab):
    load(tab, page_of(row(last='<p onclick="press(this)" aria-label="Delete">Download</p>')))
    assert tab.evaluate("__sweep.clickDoc({id: '2026-09-30_account_statement'})")["ok"] is False
    assert tab.evaluate("pressed") == []


def test_click_refuses_a_paper_account(tab):
    load(tab, page_of(GOOD, switcher=PAPER))
    assert tab.evaluate("__sweep.clickDoc({id: '2026-08-31_account_statement'})")["ok"] is False
    assert tab.evaluate("pressed") == []
