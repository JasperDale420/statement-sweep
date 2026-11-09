"""The Nelnet page logic, in a real Chromium, on stand-in pages."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://nelnet.studentaid.gov"
INBOX = "/documents/inbox-statements"


def row(date="09/27/2026", subject="09/27/2026 Statement", ident="statement-1", label=None, extra=""):
    aria = label if label is not None else f"Download document with subject {subject}"
    return (f'<tr><td>{date}</td><td><a data-cy="document-view-{ident}"><span class="sr-only">Open</span>{subject}</a></td>'
            f'<td><button data-cy="document-download-{ident}" aria-label="{aria}" onclick="press(this)" {extra}>Download</button></td></tr>')


def page_of(rows, pager=""):
    return (f'<main><table><thead><tr><th>Date</th><th>Subject</th><th></th></tr></thead><tbody>{rows}</tbody></table>{pager}</main>'
            "<script>window.pressed=[];function press(b){pressed.push(b.dataset.cy)}</script>")


LAST = ('<button aria-label="Next Page" aria-disabled="true"></button>'
        '<button aria-label="Go to first page" aria-disabled="true"></button>')


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, body, path=INBOX, host=BASE):
    def respond(route):
        if route.request.url.startswith(host):
            route.fulfill(status=200, content_type="text/html", body=f"<!doctype html><title>Nelnet</title>{body}")
        else:
            route.abort()
    tab.unroute("**/*")
    tab.route("**/*", respond)
    tab.goto(host + path)
    tab.add_script_tag(content=(ROOT / "providers" / "nelnet.page.js").read_text())


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_a_list_reads_newest_first_with_its_own_ids_and_names(tab):
    rows = row("08/27/2026", "08/27/2026 Statement", "statement-1") + row("9/27/26", "Annual Repayment Notice", "letter-2")
    load(tab, page_of(rows, LAST))
    assert read(tab) == {"state": "ok", "docs": [
        {"id": "letter-2", "date": "2026-09-27", "title": "Annual Repayment Notice", "method": "click"},
        {"id": "statement-1", "date": "2026-08-27", "title": "Statement", "method": "click"},
    ]}


def test_signed_out_on_the_auth_host_and_by_password_field(tab):
    load(tab, "", path="/", host="https://auth.nelnet.studentaid.gov")
    assert read(tab) == {"state": "signed_out"}
    load(tab, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_is_a_challenge(tab):
    load(tab, "<main>Check your email for a verification code</main>")
    assert read(tab) == {"state": "challenge"}


def test_another_page_is_not_the_list(tab):
    load(tab, "<main>Summary</main>", path="/loans")
    assert read(tab) == {"state": "no_list"}


def test_a_list_with_a_next_page_stops_with_what_was_read(tab):
    load(tab, page_of(row(), '<button aria-label="Next Page" aria-disabled="false"></button>'))
    got = read(tab)
    assert got["state"] == "stopped" and len(got["docs"]) == 1


def test_a_list_not_on_its_first_page_stops(tab):
    load(tab, page_of(row(), '<button aria-label="Next Page" aria-disabled="true"></button>'
                             '<button aria-label="Go to first page" aria-disabled="false"></button>'))
    assert read(tab)["state"] == "stopped"


@pytest.mark.parametrize("date", ["", "13/45/2026", "09/27/2026 and 10/27/2026"])
def test_a_date_that_is_not_one_stops(tab, date):
    load(tab, page_of(row(date=date), LAST))
    assert read(tab)["state"] == "stopped"


def test_a_row_whose_id_is_not_plain_stops(tab):
    load(tab, page_of(row(ident="x.y", label="Download document with subject Notice"), LAST))
    assert read(tab)["state"] == "stopped"


def test_a_row_whose_button_also_pays_stops(tab):
    load(tab, page_of(row(label="Make a payment"), LAST))
    assert read(tab)["state"] == "stopped"


def test_the_guard_reads_the_control_and_not_the_title_of_its_document(tab):
    load(tab, page_of(row(subject="Deferment Approved", ident="letter-9"), LAST))
    assert read(tab)["state"] == "ok"
    assert tab.evaluate("__sweep.clickDoc({id: 'letter-9', date: '2026-09-27'})") == {"ok": True}


def test_click_presses_only_its_own_row(tab):
    load(tab, page_of(row(ident="a-1") + row("08/27/2026", ident="a-2"), LAST))
    assert tab.evaluate("__sweep.clickDoc({id: 'a-2', date: '2026-08-27'})") == {"ok": True}
    assert tab.evaluate("pressed") == ["document-download-a-2"]


@pytest.mark.parametrize("doc", [
    "{id: 'a-9', date: '2026-09-27'}",
    "{id: 'a-1', date: '2026-01-01'}",
    "{id: '\"] x', date: '2026-09-27'}",
])
def test_a_document_that_cannot_be_bound_presses_nothing(tab, doc):
    load(tab, page_of(row(ident="a-1"), LAST))
    assert tab.evaluate(f"__sweep.clickDoc({doc})")["ok"] is False
    assert tab.evaluate("pressed") == []


def test_a_turned_off_button_is_not_pressed(tab):
    load(tab, page_of(row(ident="a-1", extra="disabled"), LAST))
    assert tab.evaluate("__sweep.clickDoc({id: 'a-1', date: '2026-09-27'})")["ok"] is False
    assert tab.evaluate("pressed") == []
