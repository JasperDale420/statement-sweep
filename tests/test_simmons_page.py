"""The Simmons Bank page logic, in a real Chromium, on stand-in pages.
Every value is invented, in the shape of PaperPull's fixtures."""
import base64
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://login.simmonsbank.com"
USER = "0a1b2c3d-1111-4222-8333-944455556666"
ACCOUNT = "7e7e7e7e-2222-4333-8444-955566667777"
D1 = "11111111-aaaa-4bbb-8ccc-000000000001"
D2 = "11111111-aaaa-4bbb-8ccc-000000000002"
D3 = "11111111-aaaa-4bbb-8ccc-000000000003"
START = "2023-10-15"
LIST = f"/a/consumer/api/v0/users/{USER}/documents/all"
ACCT = "RE ARM 88129786 (x9786)"
TYPES = {"statement": "Statement", "notice": "Notice", "tax": "Tax"}


def doc(did, kind, title, date):
    return {"documentId": did, "documentType": kind, "documentTitle": title, "description": None,
            "date": date, "documentFilename": "RE-ARM.pdf", "accountIds": [ACCOUNT]}


DOCS = [doc(D2, "notice", "Prime Rate Notice August 2031", "2031-08-20"),
        doc(D1, "statement", "Loan Periodic Statement October 2031", "2031-10-13"),
        doc(D3, "tax", "2030 Tax Reporting January 2031", "2031-01-24")]


def rows(docs, acct=ACCT):
    return [f"{d['documentTitle']} {TYPES[d['documentType']]}, {acct}" for d in docs]


def page_html(texts, asks=True):
    script = """customElements.define('jha-list-item', class extends HTMLElement {
      connectedCallback() { this.attachShadow({mode: 'open'}).innerHTML = '<button>' + this.dataset.t + '</button>'; }});"""
    ask = f"fetch('{LIST}?startDate={START}');" if asks else ""
    items = "".join(f'<jha-list-item role="listitem" data-t="{t}"></jha-list-item>' for t in texts)
    return f"<!doctype html><script>{script}{ask}</script>{items}"


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, path, body, answer=None, settings=None, pdf=None):
    answer = {"documents": DOCS} if answer is None else answer
    settings = {"settings": {"documentStartDate": START}} if settings is None else settings

    def route(r):
        url = r.request.url
        if LIST in url:
            if isinstance(answer, dict) and "status" in answer:
                r.fulfill(**answer)
            else:
                r.fulfill(status=200, content_type="application/json", body=json.dumps(answer))
        elif url.endswith("/documents/settings/institution"):
            r.fulfill(status=200, content_type="application/json", body=json.dumps(settings))
        elif f"/users/{USER}/documents/" in url and pdf:
            r.fulfill(**pdf)
        else:
            r.fulfill(status=200, content_type="text/html", body=body)
    tab.goto("about:blank")
    tab.unroute("**/*")
    tab.route("**/*", route)
    tab.goto(BASE + path)
    tab.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    tab.add_script_tag(content=(ROOT / "providers" / "simmons.page.js").read_text())
    if LIST in body:
        tab.wait_for_function("performance.getEntriesByType('resource').some(e => e.name.includes('documents/all'))")


def read(tab):
    return tab.evaluate("__sweep.readList()")


def fetched(tab, doc_id):
    return tab.evaluate("(id) => __sweep.fetchPdf({id})", doc_id)


GOOD = page_html(rows(DOCS))


def test_the_list_is_read_newest_first_with_the_banks_own_dates(tab):
    load(tab, "/documents", GOOD)
    assert read(tab) == {"state": "ok", "docs": [
        {"id": D1, "date": "2031-10-13", "title": "Loan Periodic Statement October 2031", "method": "fetch"},
        {"id": D2, "date": "2031-08-20", "title": "Prime Rate Notice August 2031", "method": "fetch"},
        {"id": D3, "date": "2031-01-24", "title": "2030 Tax Reporting January 2031", "method": "fetch"}]}


@pytest.mark.parametrize("path", ["/login", "/logout/now", "/signin"])
def test_a_sign_in_address_is_signed_out(tab, path):
    load(tab, path, "<p>Welcome</p>")
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_inside_a_shadow_root_is_signed_out(tab):
    body = """<x-login></x-login><script>customElements.define('x-login', class extends HTMLElement {
      connectedCallback() { this.attachShadow({mode: 'open'}).innerHTML = '<input type=password>'; }});</script>"""
    load(tab, "/documents", body)
    assert read(tab) == {"state": "signed_out"}


@pytest.mark.parametrize("answer", [
    {"status": 401, "body": ""},
    {"status": 403, "body": ""},
    {"status": 200, "content_type": "text/html", "body": "<html>sign in</html>"}])
def test_a_signed_out_answer_to_the_list_is_signed_out(tab, answer):
    load(tab, "/documents", GOOD, answer=answer)
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_needs_the_person(tab):
    load(tab, "/documents", "<h1>Enter the code we sent</h1>")
    assert read(tab) == {"state": "challenge"}


def test_a_page_that_never_asked_for_its_list_is_not_the_list_yet(tab):
    load(tab, "/documents", page_html(rows(DOCS), asks=False))
    assert read(tab) == {"state": "no_list"}


def test_another_page_is_not_the_list_yet(tab):
    load(tab, "/dashboard", "<p>hello</p>")
    assert read(tab) == {"state": "no_list"}


@pytest.mark.parametrize("change", [
    lambda d: d.update(date="2031-02-31"),
    lambda d: d.update(date="10/13/2031"),
    lambda d: d.update(date="2020-01-01"),
    lambda d: d.update(documentId="../../etc"),
    lambda d: d.update(documentType="letter"),
    lambda d: d.update(documentFilename="a.html"),
    lambda d: d.update(accountIds=[ACCOUNT, "other"]),
    lambda d: d.update(cursor="more")])
def test_a_document_this_cannot_trust_stops(tab, change):
    bad = json.loads(json.dumps(DOCS))
    change(bad[0])
    load(tab, "/documents", page_html(rows(DOCS)), answer={"documents": bad})
    assert read(tab)["state"] == "stopped"


def test_a_key_that_may_say_there_is_more_stops(tab):
    load(tab, "/documents", GOOD, answer={"documents": DOCS, "nextCursor": "x"})
    assert read(tab)["state"] == "stopped"


def test_two_accounts_stop(tab):
    two = json.loads(json.dumps(DOCS))
    two[0]["accountIds"] = ["7e7e7e7e-2222-4333-8444-955566668888"]
    load(tab, "/documents", GOOD, answer={"documents": two})
    assert read(tab)["state"] == "stopped"


def test_a_list_asked_from_a_later_day_than_the_banks_stops(tab):
    load(tab, "/documents", GOOD, settings={"settings": {"documentStartDate": "2020-01-01"}})
    assert "first day" in read(tab)["why"]


def test_rows_that_do_not_match_the_answer_stop(tab):
    load(tab, "/documents", page_html(rows(DOCS[:2])))
    assert read(tab)["state"] == "stopped"


def test_a_row_whose_text_cannot_be_read_stops(tab):
    load(tab, "/documents", page_html(rows(DOCS) + ["Something odd (x9786)"]))
    assert read(tab)["state"] == "stopped"


def test_an_official_pdf_comes_back_whole(tab):
    data = b"%PDF-1.7 " + bytes(range(256)) * 400
    load(tab, "/documents", GOOD, pdf=dict(status=200, content_type="application/pdf", body=data))
    got = fetched(tab, D1)
    assert got["ok"] and base64.b64decode(got["base64"]) == data and got["size"] == len(data)


def test_html_labelled_as_a_pdf_is_not_kept(tab):
    load(tab, "/documents", GOOD, pdf=dict(status=200, content_type="application/pdf", body=b"<html>sign in</html>"))
    assert fetched(tab, D1)["ok"] is False


def test_a_refused_pdf_says_signed_out(tab):
    load(tab, "/documents", GOOD, pdf=dict(status=401, body=""))
    assert fetched(tab, D1) == {"ok": False, "signedOut": True, "why": "The site asked for a sign-in."}


def test_a_bad_id_is_refused_before_any_request(tab):
    load(tab, "/documents", GOOD)
    assert fetched(tab, "../../etc")["ok"] is False
