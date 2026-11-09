"""The SDG&E page logic, in a real Chromium, on stand-in pages."""
import base64
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HEAD = "<tr><th>Statement Date</th><th>Due Date</th><th>Amount</th></tr>"
INV = "ISU000000000201"


def row(inv=INV, date="Sep 12, 2026", first='<td style="display:none">1</td>', extra=""):
    return f'<tr invoiceid="{inv}">{first}<td>{date}</td><td>Oct 1, 2026</td><td>$1</td>{extra}</tr>'


def table(rows, head=HEAD):
    return f'<table id="billHistoryTable"><thead>{head}</thead><tbody>{rows}</tbody></table>'


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, path, body, bill=None):
    def answer(route):
        url = route.request.url
        if "DownloadBillPdf" in url and bill:
            route.fulfill(**bill)
        else:
            route.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body}")
    tab.unroute("**/*")
    tab.route("**/*", answer)
    tab.goto("https://myenergycenter.com" + path)
    tab.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    tab.add_script_tag(content=(ROOT / "providers" / "sdge.page.js").read_text())


def read(tab):
    return tab.evaluate("__sweep.readList()")


PAGE = "/portal/BillingHistory/index"


def test_rows_with_a_hidden_number_cell_are_read(tab):
    load(tab, PAGE, table(row()))
    assert read(tab) == {"state": "ok", "docs": [{"id": INV, "date": "2026-09-12", "method": "fetch"}]}


def test_rows_with_no_hidden_cell_are_read_too(tab):
    load(tab, PAGE, table(row(first="")))
    assert read(tab)["docs"][0]["date"] == "2026-09-12"


def test_a_hidden_real_column_stops_rather_than_shift_the_date(tab):
    load(tab, PAGE, table(row(first='<td style="display:none">not a number</td>')))
    assert read(tab)["state"] == "stopped"


@pytest.mark.parametrize("date", ["", "Feb 31, 2026", "2026-09-12", "due Sep 12, 2026"])
def test_a_date_that_is_not_one_stops(tab, date):
    load(tab, PAGE, table(row(date=date)))
    assert read(tab)["state"] == "stopped"


def info(line):
    return f'<div id="billHistoryTable_info">{line}</div>'


def accounts(count):
    options = "".join(f'<option value="{i}">Account {i}</option>' for i in range(count))
    return f'<select id="accountList">{options}</select>'


BILL = {"id": INV, "date": "2026-09-12", "method": "fetch"}


def test_a_count_that_agrees_with_the_rows_is_whole(tab):
    load(tab, PAGE, table(row()) + info("Showing 1 to 1 of 1 entries"))
    assert read(tab) == {"state": "ok", "docs": [BILL]}


def test_more_entries_than_rows_drawn_stops_with_the_rows_drawn(tab):
    load(tab, PAGE, table(row()) + info("Showing 1 to 10 of 1,024 entries"))
    got = read(tab)
    assert got["state"] == "stopped" and "1024" in got["why"] and got["docs"] == [BILL]


def test_a_filtered_table_stops(tab):
    load(tab, PAGE, table(row()) + info("Showing 1 to 1 of 1 entries (filtered from 24 total entries)"))
    got = read(tab)
    assert got["state"] == "stopped" and "search" in got["why"] and got["docs"] == [BILL]


def test_a_count_that_cannot_be_read_stops(tab):
    load(tab, PAGE, table(row()) + info("Some other words"))
    assert read(tab)["state"] == "stopped"


@pytest.mark.parametrize("rows", ["", '<tr><td class="dataTables_empty" colspan="3">Loading...</td></tr>',
                                  '<tr><td class="dataTables_empty" colspan="3">No data available in table</td></tr>'])
def test_rows_not_drawn_yet_are_not_a_list_with_nothing_on_it(tab, rows):
    load(tab, PAGE, table(rows) + info("Showing 0 to 0 of 0 entries") + accounts(2))
    assert read(tab) == {"state": "no_list"}


def test_a_second_account_stops_with_the_rows_on_show(tab):
    load(tab, PAGE, accounts(3) + table(row()) + info("Showing 1 to 1 of 1 entries"))
    got = read(tab)
    assert got["state"] == "stopped" and "other 2" in got["why"] and got["docs"] == [BILL]


def test_a_single_account_is_whole(tab):
    load(tab, PAGE, accounts(1) + table(row()))
    assert read(tab) == {"state": "ok", "docs": [BILL]}


def test_a_sign_in_page_is_known(tab):
    load(tab, "/account/login", "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_bad_bill_number_is_refused(tab):
    load(tab, PAGE, table(row()))
    assert tab.evaluate("__sweep.fetchPdf({id: '../../etc'})")["ok"] is False


def test_an_official_pdf_comes_back_whole(tab):
    data = b"%PDF-1.7 " + bytes(range(256)) * 400
    load(tab, PAGE, table(row()), bill=dict(status=200, content_type="application/pdf", body=data))
    got = tab.evaluate(f"__sweep.fetchPdf({{id: '{INV}'}})")
    assert got["ok"] and base64.b64decode(got["base64"]) == data


def test_html_labelled_as_a_bill_is_not_kept(tab):
    load(tab, PAGE, table(row()), bill=dict(status=200, content_type="application/pdf", body=b"<html>sign in</html>"))
    assert tab.evaluate(f"__sweep.fetchPdf({{id: '{INV}'}})")["ok"] is False
