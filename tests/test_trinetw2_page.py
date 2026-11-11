"""The TriNet W-2 page logic (PaperlessEmployee), in a real Chromium, on stand-in pages.

The pages follow the shape of the real Tax Statements, review and order pages,
read once from a signed-in tab. Every id and name here is invented. The tests
that matter most: an order is submitted only when it is a free online
download of the one form asked for, and never otherwise.
"""
import base64
import json
from pathlib import Path
from urllib.parse import parse_qs
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://www.paperlessemployee.com"
PE = "/trinettaxforms/PE"
LIST, SUBMIT = f"{PE}/TaxStatements", f"{PE}/TaxStatements/SubmitOrderV4"
PDF = f"{PE}/Pdf/GetOrderPdf"

K1 = "11111111-2222-4333-8444-555555555555"
K2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
K3 = "99999999-8888-4777-8666-555555555555"


def row(key, form, employer="EXAMPLE EMPLOYER, INC.", cls="currentYear"):
    return (f'<tr class="{cls}"><td><input type="checkbox" name="OrderPostModel.SelectedFormNumbers" value="{key}"></td>'
            f"<td>{form}</td><td>{employer}</td><td></td></tr>")


def list_page(rows=None, online=True):
    rows = rows if rows is not None else [row(K1, "2031 W-2"), row(K2, "2030 W-2", cls="priorYear")]
    radio = '<input type="radio" name="OrderPostModel.SelectedDeliveryMethod" value="Online"><label>DOWNLOAD (PDF)</label>' if online \
        else '<input type="radio" name="OrderPostModel.SelectedDeliveryMethod" value="Postal"><label>MAIL</label>'
    return (f'<!doctype html><title>Tax Statements</title><form action="{LIST}" method="post">'
            '<input type="hidden" name="__RequestVerificationToken" value="list-token">'
            f'<table><thead><tr><th>Select</th><th>Tax Form</th><th>Employer Name</th><th>Download</th></tr></thead><tbody>{"".join(rows)}</tbody></table>'
            f'{radio}<input type="text" name="TotalOrder" value="0.00"><input type="submit" name="action" value="Review &amp; Complete Order"></form>')


def review_page(form="2031 W-2", popup="", paid="", delivery="Your forms will be delivered online", extra=""):
    # Shaped like the real review: a sign-in line with a time, dialogs the
    # page keeps hidden until needed, and "will NOT be emailed" beside the
    # online delivery.
    return ('<!doctype html><title>Confirmation</title>'
            '<p>Account Name: Example Person</p><p>Last login: 11/10/2031 4:05 PM PT Failed login attempts: 0</p>'
            '<h2>Summary Of Your Order</h2>'
            f'<input type="hidden" id="popupToken" value="{popup}">'
            f'<p>{form} EXAMPLE EMPLOYER, INC.</p><p>{delivery}</p><p>Forms will NOT be emailed to you.</p>{extra}'
            '<div class="modal" style="display:none">Session Timeout You will be logged off in 60 seconds.</div>'
            '<script>var fee = "$9.99";</script>'
            f'<form id="frmConfirmation" action="{SUBMIT}" method="post">'
            '<input type="hidden" name="__RequestVerificationToken" value="review-token">'
            '<input type="hidden" name="xsec_responseAuthorize" value="">'
            f'<input type="hidden" name="xsec_paymentAttemptId" value="{paid}">'
            '<input type="button" name="action" value="Submit Order" id="btnSubmitOrder"></form>')


DONE_PAGE = (f'<!doctype html><title>Order Complete</title><h2>Order Complete</h2><p>2031 W-2</p>'
             f'<a href="{PDF}?download=false" target="_blank">View</a> <a href="{PDF}?download=true" target="_blank">Download</a>')


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, path=LIST, body="<main>Tax Statements</main>", listing=None, review=None, done=DONE_PAGE, pdf=None, landing=None,
         fresh=True):
    """Stand in for PaperlessEmployee. Returns the requests asked, with POST bodies."""
    asked = []
    listing = listing if listing is not None else list_page()
    review = review if review is not None else review_page()

    def respond(route):
        req = route.request
        url = req.url
        if not url.startswith(BASE):
            route.abort()
            return
        p = url[len(BASE):]
        if req.resource_type == "document":
            route.fulfill(status=200, content_type="text/html", body=f"<!doctype html><title>PaperlessEmployee</title>{body}")
            return
        asked.append((req.method, p, parse_qs(req.post_data or "")))
        # The real site answers each POST with a redirect to its next page. A
        # stand-in redirect is not routed (it would reach the real site), so
        # each POST is answered with that next page itself.
        if landing:
            route.fulfill(status=200, content_type="text/html", body=landing)
        elif p == LIST and req.method == "GET":
            route.fulfill(status=200, content_type="text/html", body=listing)
        elif p == LIST and req.method == "POST":
            route.fulfill(status=200, content_type="text/html", body=review)
        elif p == SUBMIT and req.method == "POST":
            route.fulfill(status=200, content_type="text/html", body=done)
        elif p.startswith(PDF):
            route.fulfill(**(pdf or dict(status=404, body=b"")))
        else:
            route.fulfill(status=404, body=b"")
    tab.unroute("**/*")
    tab.route("**/*", respond)
    tab.goto(BASE + path)
    if fresh:
        tab.evaluate("sessionStorage.clear()")
    tab.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    tab.add_script_tag(content=(ROOT / "providers" / "trinetw2.page.js").read_text())
    return asked


def read(tab):
    return tab.evaluate("__sweep.readList()")


def doc(key=K1, year="2031", name="W-2"):
    return {"id": f"{year}:{name}:{key}", "date": f"{year}-12-31", "title": name, "method": "fetch", "key": key}


def fetch(tab, d=None):
    return tab.evaluate(f"__sweep.fetchPdf({json.dumps(d or doc())})")


def submitted(asked):
    return [a for a in asked if a[1] == SUBMIT]


PDF_OK = dict(status=200, content_type="application/octet-stream", body=b"%PDF-1.7 " + bytes(range(256)) * 40)


# -- the list ---------------------------------------------------------------------------

def test_the_list_is_every_form_newest_first_dated_at_its_tax_year_end(tab):
    load(tab)
    assert read(tab) == {"state": "ok", "docs": [doc(K1, "2031"), doc(K2, "2030")]}


def test_reading_the_list_only_reads(tab):
    asked = load(tab)
    read(tab)
    assert [(m, p) for m, p, _ in asked] == [("GET", LIST)]


def test_a_corrected_w2_keeps_its_own_name(tab):
    load(tab, listing=list_page([row(K1, "2031 W-2"), row(K3, "2031 W-2c")]))
    assert [d["title"] for d in read(tab)["docs"]] == ["W-2", "W-2c"]


def test_two_w2s_for_one_year_are_numbered_so_neither_is_lost(tab):
    load(tab, listing=list_page([row(K1, "2031 W-2"), row(K3, "2031 W-2", employer="OTHER EMPLOYER")]))
    assert [d["title"] for d in read(tab)["docs"]] == ["W-2 1", "W-2 2"]


def test_no_forms_yet_is_an_empty_list(tab):
    load(tab, listing=list_page([]))
    assert read(tab) == {"state": "ok", "docs": []}


@pytest.mark.parametrize("bad", [row("../../etc", "2031 W-2"), row(K3, "W-2 for 2031"), row(K3, "1999 W-2")])
def test_a_form_that_cannot_be_read_stops_and_keeps_the_rest(tab, bad):
    load(tab, listing=list_page([row(K1, "2031 W-2"), bad]))
    got = read(tab)
    assert got["state"] == "stopped" and [d["key"] for d in got["docs"]] == [K1]


def test_a_page_of_another_shape_stops(tab):
    load(tab, listing="<!doctype html><p>Something else</p>")
    assert read(tab)["state"] == "stopped"


# A TriNet employee has no PaperlessEmployee password: its own sign-in page
# is answered no_list, so the engine sends the tab back through TriNet.
def test_paperlessemployee_s_own_sign_in_sends_the_tab_back_through_trinet(tab):
    load(tab, path="/trinettaxforms/PE/Login")
    assert read(tab) == {"state": "no_list"}
    load(tab, body="<input type=password>")
    assert read(tab) == {"state": "no_list"}


def test_a_list_answered_with_a_sign_in_sends_the_tab_back_through_trinet(tab):
    load(tab, landing="<!doctype html><form><input type=password></form>")
    assert read(tab) == {"state": "no_list"}


# -- TriNet's hand-off ----------------------------------------------------------------------

TRINET = "https://trinet.hrpassport.com"
SAML_ERROR = "<p>There was a problem processing your login request.</p><p>SAML Error Code(s): CX0000</p>"


def load_trinet(tab, at, body="<main>TriNet</main>"):
    """Stand in for one of TriNet's own pages."""
    tab.unroute("**/*")
    tab.route("**/*", lambda r: r.fulfill(status=200, content_type="text/html",
                                          body=f"<!doctype html><title>TriNet</title>{body}")
              if r.request.url.startswith(TRINET) else r.abort())
    tab.goto(TRINET + at)
    tab.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    tab.add_script_tag(content=(ROOT / "providers" / "trinetw2.page.js").read_text())


def test_trinet_s_w2_link_is_left_to_hand_the_tab_on(tab):
    load_trinet(tab, "/#/ssowidget/cicplus_w2")
    assert read(tab) == {"state": "walking"}


def test_another_trinet_page_signed_in_is_no_list_so_the_tab_goes_to_the_w2_link(tab):
    load_trinet(tab, "/ui-portal-global/#/app.main.iapp")
    assert read(tab) == {"state": "no_list"}
    load_trinet(tab, "/#/ssowidget/cicplus_w2x")
    assert read(tab) == {"state": "no_list"}


def test_trinet_s_sign_in_is_signed_out(tab):
    load_trinet(tab, "/", body="<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_turned_down_sign_in_is_tried_again_once_then_stops_with_why(tab):
    load(tab, path="/SAML2Portal.aspx", body=SAML_ERROR)
    assert read(tab) == {"state": "no_list"}
    assert read(tab) == {"state": "no_list"}, "reads of one page are one failure"
    load(tab, path="/SAML2Portal.aspx", body=SAML_ERROR, fresh=False)
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == [] and "TriNet" in got["why"]


def test_a_turned_down_sign_in_long_ago_is_tried_again(tab):
    load(tab, path="/SAML2Portal.aspx", body=SAML_ERROR)
    tab.evaluate("sessionStorage.setItem('statementSweepFailedHandOffs', JSON.stringify([performance.timeOrigin - 3600000]))")
    assert read(tab) == {"state": "no_list"}


def test_a_list_read_forgets_an_earlier_turned_down_sign_in(tab):
    load(tab, path="/SAML2Portal.aspx", body=SAML_ERROR)
    read(tab)
    load(tab, fresh=False)
    assert read(tab)["state"] == "ok"
    load(tab, path="/SAML2Portal.aspx", body=SAML_ERROR, fresh=False)
    assert read(tab) == {"state": "no_list"}


# -- the order ------------------------------------------------------------------------

def test_a_free_online_order_of_one_form_brings_back_its_pdf(tab):
    asked = load(tab, pdf=PDF_OK)
    got = fetch(tab)
    assert got["ok"] and base64.b64decode(got["base64"]) == PDF_OK["body"]
    steps = [(m, p) for m, p, _ in asked]
    assert steps == [("GET", LIST), ("POST", LIST), ("POST", SUBMIT), ("GET", f"{PDF}?download=true")]
    pick = asked[1][2]
    assert pick["OrderPostModel.SelectedFormNumbers"] == [K1] and pick["OrderPostModel.SelectedDeliveryMethod"] == ["Online"]
    assert pick["__RequestVerificationToken"] == ["list-token"]
    assert asked[2][2] == {"__RequestVerificationToken": ["review-token"]}


@pytest.mark.parametrize("review, why", [
    (review_page(popup="card-popup"), "card payment"),
    (review_page(paid="attempt-1"), "card payment"),
    (review_page(extra="<p>Order Total: $5.00</p>"), "not free"),
    # A fee however it is written: without a leading digit, as a currency
    # code, with the "$" drawn by CSS, full-width, or in a field.
    (review_page(extra="<p>Processing fee: $.50</p>"), "not free"),
    (review_page(extra="<p>Total: USD 5.00</p>"), "not free"),
    (review_page(extra="<p>Total: <span class='dollar'></span>5.00</p>"), "not free"),
    (review_page(extra="<p>Fee \uff045</p>"), "not free"),
    (review_page(extra="<input type='text' name='OrderTotal' value='4.95'>"), "not free"),
    (review_page(extra="<input type='hidden' name='CardAmount' value='$2'>"), "not free"),
    (review_page(delivery="Your forms will be mailed to you"), "online download"),
    # "delivered online" only in hidden or script text does not count.
    (review_page(delivery="Your forms will be sent", extra="<div hidden>Your forms will be delivered online</div>"), "online download"),
    (review_page(delivery="Your forms will be sent", extra="<script>// delivered online</script>"), "online download"),
    (review_page(delivery="Your forms will be delivered online and a copy mailed by postal service"), "online download"),
    (review_page(form="2030 W-2"), "name this form"),
    # "2031 W-2c" is another form; and a form left from an earlier order rides along.
    (review_page(form="2031 W-2c"), "name this form"),
    (review_page(extra="<p>2030 W-2 EXAMPLE EMPLOYER, INC.</p>"), "another form"),
    ("<!doctype html><p>Something else</p>", "review was not"),
])
def test_an_order_that_is_not_a_free_online_download_of_this_form_is_never_submitted(tab, review, why):
    asked = load(tab, review=review, pdf=PDF_OK)
    got = fetch(tab)
    assert got["ok"] is False and why in got["why"]
    assert submitted(asked) == []


def test_a_list_that_offers_only_mail_places_no_order(tab):
    asked = load(tab, listing=list_page(online=False), pdf=PDF_OK)
    assert fetch(tab)["ok"] is False
    assert [m for m, _, _ in asked] == ["GET"]


def test_a_form_no_longer_listed_places_no_order(tab):
    asked = load(tab, listing=list_page([row(K2, "2030 W-2")]), pdf=PDF_OK)
    got = fetch(tab)
    assert got["ok"] is False and "no longer listed" in got["why"]
    assert [m for m, _, _ in asked] == ["GET"]


@pytest.mark.parametrize("bad", [
    {**doc(), "key": "../x"},
    {**doc(), "date": "2031-06-30"},
    {**doc(), "id": f"2031:W-2:{K2}"},
    {"id": "guard:2026-10-01", "date": "2026-10-01", "title": "Statement", "method": "fetch"},
])
def test_a_document_that_is_not_a_listed_form_asks_for_nothing(tab, bad):
    asked = load(tab, pdf=PDF_OK)
    assert fetch(tab, bad)["ok"] is False
    assert asked == []


def test_an_order_page_without_its_download_link_brings_nothing(tab):
    asked = load(tab, done="<!doctype html><h2>Order Complete</h2><a href='https://elsewhere.example/x.pdf?download=true'>Download</a>", pdf=PDF_OK)
    got = fetch(tab)
    assert got["ok"] is False and "download link" in got["why"]
    assert not any(p.startswith(PDF) for _, p, _ in asked)


def test_html_where_the_pdf_should_be_is_not_kept(tab):
    load(tab, pdf=dict(status=200, content_type="application/pdf", body=b"<html>sign in</html>"))
    assert fetch(tab)["ok"] is False


def test_signed_out_mid_order_says_so(tab):
    load(tab, path="/trinettaxforms/PE/Login")
    got = fetch(tab)
    assert got["ok"] is False and got["signedOut"] is True
