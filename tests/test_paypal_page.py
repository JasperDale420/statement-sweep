"""The PayPal page logic, in a real Chromium, on stand-in pages."""
import base64
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://www.paypal.com"
PAGE = "/myaccount/statements/monthly"


def month(key):
    return {"month": "x", "date": key, "title": "x", "monthNumber": 1, "year": key[:4]}


# The shape of the real answer, with invented months (PaperPull's test_site.py).
ANSWER = {"data": {"statements": [
    {"year": "2031", "details": [month("20310201"), month("20310101")]},
    {"year": "2030", "details": [month("20301201"), month("20301201")]},
]}, "sys": {"pageInfo": {}}}


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, path=PAGE, body="<main>Statements</main>", answer=ANSWER, pdf=None, status=200):
    asked = []

    def respond(route):
        url = route.request.url
        if not url.startswith(BASE):
            route.abort()
        elif "/api/statements/download" in url:
            asked.append(url)
            route.fulfill(**(pdf or dict(status=404, body=b"")))
        elif "/api/statements" in url:
            if isinstance(answer, str):
                route.fulfill(status=status, content_type="text/html", body=answer)
            else:
                route.fulfill(status=status, content_type="application/json", body=json.dumps(answer))
        else:
            route.fulfill(status=200, content_type="text/html", body=f"<!doctype html><title>PayPal</title>{body}")
    tab.unroute("**/*")
    tab.route("**/*", respond)
    tab.goto(BASE + path)
    tab.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    tab.add_script_tag(content=(ROOT / "providers" / "paypal.page.js").read_text())
    return asked


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_the_list_is_read_newest_first_once_each_month_at_its_last_day(tab):
    load(tab)
    assert read(tab) == {"state": "ok", "docs": [
        {"id": "20310201", "date": "2031-02-28", "title": "Monthly Statement", "method": "fetch"},
        {"id": "20310101", "date": "2031-01-31", "title": "Monthly Statement", "method": "fetch"},
        {"id": "20301201", "date": "2030-12-31", "title": "Monthly Statement", "method": "fetch"},
    ]}


def test_signed_out_is_known_by_the_address_and_the_password_field(tab):
    load(tab, path="/signin")
    assert read(tab) == {"state": "signed_out"}
    load(tab, body="<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_is_a_challenge(tab):
    load(tab, body="<p>Enter the code we sent to your phone</p>")
    assert read(tab) == {"state": "challenge"}


@pytest.mark.parametrize("status", [401, 403])
def test_a_list_that_answers_signed_out_is_signed_out(tab, status):
    load(tab, status=status, answer={"data": {}})
    assert read(tab) == {"state": "signed_out"}


def test_a_list_answered_with_a_page_is_signed_out(tab):
    load(tab, answer="<html>sign in</html>")
    assert read(tab) == {"state": "signed_out"}


def test_a_business_account_stops_rather_than_waits(tab):
    load(tab, path="/businessmanage/account/accountAccess")
    got = read(tab)
    assert got["state"] == "stopped" and "business" in got["why"]


def test_another_paypal_page_is_not_the_list(tab):
    load(tab, path="/myaccount/summary")
    assert read(tab) == {"state": "no_list"}


@pytest.mark.parametrize("bad", ["2030-11", "20301301", "20301115", "19990101", 20310201])
def test_a_month_that_cannot_be_read_stops_and_keeps_the_rest(tab, bad):
    answer = {"data": {"statements": [{"year": "2030", "details": [month("20310201"), {"date": bad}]}]}}
    load(tab, answer=answer)
    got = read(tab)
    assert got["state"] == "stopped" and [d["id"] for d in got["docs"]] == ["20310201"]


def test_a_list_of_another_shape_stops(tab):
    load(tab, answer={"data": {"statements": "none"}})
    assert read(tab)["state"] == "stopped"


@pytest.mark.parametrize("doc", [
    "{id: '../../etc', date: '2031-02-28'}",
    "{id: '20310201,20310101', date: '2031-02-28'}",
    "{id: '20310201', date: '2031-02-27'}",
])
def test_a_bad_month_or_a_date_that_disagrees_asks_for_nothing(tab, doc):
    asked = load(tab, pdf=dict(status=200, content_type="application/pdf", body=b"%PDF-1.7"))
    assert tab.evaluate(f"__sweep.fetchPdf({doc})")["ok"] is False
    assert asked == []


def test_an_official_pdf_comes_back_whole_from_its_one_address(tab):
    data = b"%PDF-1.7 " + bytes(range(256)) * 400
    asked = load(tab, pdf=dict(status=200, content_type="application/pdf", body=data))
    got = tab.evaluate("__sweep.fetchPdf({id: '20310201', date: '2031-02-28'})")
    assert got["ok"] and got["size"] == len(data) and base64.b64decode(got["base64"]) == data
    assert asked == [BASE + "/myaccount/statements/api/statements/download?monthList=20310201&reportType=standard"]


def test_html_labelled_as_a_pdf_is_not_kept(tab):
    load(tab, pdf=dict(status=200, content_type="application/pdf", body=b"<html>sign in</html>"))
    assert tab.evaluate("__sweep.fetchPdf({id: '20310201', date: '2031-02-28'})")["ok"] is False


def test_a_download_that_answers_signed_out_says_so(tab):
    load(tab, pdf=dict(status=401, content_type="text/html", body=b""))
    got = tab.evaluate("__sweep.fetchPdf({id: '20310201', date: '2031-02-28'})")
    assert got["ok"] is False and got["signedOut"] is True
