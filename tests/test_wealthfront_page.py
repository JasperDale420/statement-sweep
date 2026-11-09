"""The Wealthfront page logic, in a real Chromium, on stand-in pages."""
import base64
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOST = "https://www.wealthfront.com"
PAGE = "/documents"
STATEMENT = "/documents/87543673/document/DOCD-AA18"
FORM = "/documents/87543673/2025/FORM_1099_PDF?idx=0"


def dated(date="12/31/2025", title="Monthly Statement for Joint Cash Account (from Wealthfront Brokerage Corp)", href=STATEMENT):
    return f'<tr><td>{date}</td><td>{title}</td><td><a href="{href}">Link</a></td></tr>'


def tax(account="Joint Cash Account", form="Form 1099", year=""):
    return (f'<tr><td>{account}</td><td>{form}{year}</td>'
            '<td><button data-testid="tax-forms-account-view-dialog-trigger">Download</button></td></tr>')


def year_menu(*years):
    return '<select aria-label="tax year">' + "".join(f"<option>Tax Year: {y}</option>" for y in years) + "</select>"


def page_body(rows, menu=year_menu("2025"), older=""):
    return f"{menu}<table><tbody>{rows}</tbody></table>{older}" + """
<script>document.addEventListener('click', e => {
  if (e.target.matches('[data-testid=tax-forms-account-view-dialog-trigger]')) {
    window.__pressed = (window.__pressed || 0) + 1;
    const d = document.createElement('div'); d.setAttribute('role', 'dialog');
    d.innerHTML = window.__links || '<a href="/documents/87543673/2025/FORM_1099_PDF?idx=0">PDF</a>';
    d.insertAdjacentHTML('beforeend', '<button data-testid="dismiss-dialog">Close</button>');
    document.body.append(d);
  }
  if (e.target.matches('[data-testid=dismiss-dialog]')) e.target.closest('[role=dialog]').remove();
});</script>"""


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, path=PAGE, body=page_body(dated()), files=None):
    files = files or {}

    def answer(route):
        wanted = route.request.url.replace(HOST, "")
        if wanted in files:
            route.fulfill(**files[wanted])
        else:
            route.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body}")
    tab.unroute("**/*")
    tab.route("**/*", answer)
    tab.goto(HOST + path)
    tab.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    tab.add_script_tag(content=(ROOT / "providers" / "wealthfront.page.js").read_text())


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_a_statement_row_is_read_with_its_own_date(tab):
    load(tab)
    got = read(tab)
    assert got["state"] == "ok"
    assert got["docs"] == [{
        "id": STATEMENT, "date": "2025-12-31", "title": "Monthly Statement Joint Cash Account",
        "method": "fetch", "url": HOST + STATEMENT,
    }]


def test_a_tax_row_is_filed_at_the_end_of_the_year_the_menu_shows(tab):
    load(tab, body=page_body(tax(), menu=year_menu("2024")))
    doc = read(tab)["docs"][0]
    assert doc["date"] == "2024-12-31" and doc["title"] == "1099 Tax Form Joint Cash Account"


def test_trade_confirmations_are_passed_over(tab):
    load(tab, body=page_body(dated(title="Trade Confirmation for Investing") + dated("11/30/2025", href="/documents/1/document/B")))
    assert [d["date"] for d in read(tab)["docs"]] == ["2025-11-30"]


def test_the_list_is_newest_first_across_both_tables(tab):
    load(tab, body=page_body(dated("03/31/2025", href="/documents/1/document/A") + tax() + dated("11/30/2025", href="/documents/1/document/B")))
    assert [d["date"] for d in read(tab)["docs"]] == ["2025-12-31", "2025-11-30", "2025-03-31"]


def test_a_sign_in_address_is_known(tab):
    load(tab, path="/login", body="<p>Sign in</p>")
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_known(tab):
    load(tab, body="<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_waits_for_the_person(tab):
    load(tab, body="<p>Enter the code we sent to your phone</p>")
    assert read(tab) == {"state": "challenge"}


def test_a_page_with_rows_is_not_a_challenge_for_its_words(tab):
    load(tab, body=page_body(dated()) + "<p>verification code</p>")
    assert read(tab)["state"] == "ok"


def test_another_page_is_not_the_list(tab):
    load(tab, path="/dashboard", body="<h1>Home</h1>")
    assert read(tab) == {"state": "no_list"}


def test_more_tax_years_stop_with_what_was_read(tab):
    load(tab, body=page_body(tax(), menu=year_menu("2025", "2024")))
    got = read(tab)
    assert got["state"] == "stopped" and "tax year" in got["why"].lower() and len(got["docs"]) == 1


def test_an_older_page_stops_with_what_was_read(tab):
    load(tab, body=page_body(dated(), older="<button>Older</button>"))
    got = read(tab)
    assert got["state"] == "stopped" and len(got["docs"]) == 1


def test_a_turned_off_older_button_means_the_end(tab):
    load(tab, body=page_body(dated(), older="<button disabled>Older</button>"))
    assert read(tab)["state"] == "ok"


@pytest.mark.parametrize("date", ["13/45/2025", "02/30/2025"])
def test_a_date_that_is_not_one_stops(tab, date):
    load(tab, body=page_body(dated(date)))
    assert read(tab)["state"] == "stopped"


def test_a_tax_row_with_no_year_is_never_given_one(tab):
    load(tab, body=page_body(tax(), menu=""))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


@pytest.mark.parametrize("href", ["https://evil.test/documents/1/document/A", "/account/settings", "/documents/1"])
def test_a_link_that_is_not_a_document_address_stops(tab, href):
    load(tab, body=page_body(dated(href=href)))
    assert read(tab)["state"] == "stopped"


def test_a_filter_menu_named_for_documents_is_not_a_row(tab):
    menu = year_menu("2025") + '<div data-testid="document-filter"><select><option>Quarterly Statements</option></select></div>'
    load(tab, body=page_body(dated(), menu=menu))
    assert read(tab)["state"] == "ok"


def test_a_tax_row_with_no_download_is_said_and_the_rest_is_kept(tab):
    bare = "<tr><td>Joint Cash Account</td><td>Form 1099</td></tr>"
    load(tab, body=page_body(bare + dated()))
    got = read(tab)
    assert got["state"] == "stopped" and len(got["docs"]) == 1


def fetch(tab, doc):
    return tab.evaluate(f"__sweep.fetchPdf({json.dumps(doc)})")


def test_a_bad_address_is_refused(tab):
    load(tab)
    assert fetch(tab, {"id": "x", "url": "https://evil.test/documents/1/document/A"})["ok"] is False


def test_an_official_pdf_comes_back_whole(tab):
    data = b"%PDF-1.7 " + bytes(range(256)) * 400
    load(tab, files={STATEMENT: dict(status=200, content_type="application/pdf", body=data)})
    doc = read(tab)["docs"][0]
    got = fetch(tab, doc)
    assert got["ok"] and base64.b64decode(got["base64"]) == data


def test_html_is_not_kept_as_a_pdf(tab):
    load(tab, files={STATEMENT: dict(status=200, content_type="application/pdf", body=b"<html>sign in</html>")})
    assert fetch(tab, read(tab)["docs"][0])["ok"] is False


def test_a_tax_form_is_taken_from_its_dialog_and_the_dialog_closed(tab):
    data = b"%PDF-1.7 a tax form"
    load(tab, body=page_body(tax()), files={FORM: dict(status=200, content_type="application/pdf", body=data)})
    doc = read(tab)["docs"][0]
    got = fetch(tab, doc)
    assert got["ok"] and base64.b64decode(got["base64"]) == data
    assert tab.evaluate("window.__pressed") == 1
    assert tab.evaluate("document.querySelector('[role=dialog]')") is None


def test_a_tax_form_is_refused_when_the_menu_shows_another_year(tab):
    load(tab, body=page_body(tax()))
    doc = read(tab)["docs"][0]
    tab.evaluate("document.querySelector('select').insertAdjacentHTML('beforeend', '<option selected>Tax Year: 2024</option>')")
    assert fetch(tab, doc)["ok"] is False


def test_a_dialog_link_that_is_not_a_document_address_is_refused(tab):
    load(tab, body=page_body(tax()))
    doc = read(tab)["docs"][0]
    tab.evaluate("window.__links = '<a href=\"https://evil.test/x.pdf\">PDF</a>'")
    assert fetch(tab, doc)["ok"] is False
