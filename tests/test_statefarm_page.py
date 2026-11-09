"""The State Farm page logic, in a real Chromium, on stand-in pages. Only a
control carrying its own PDF link can be saved here; a View Documents row is
reported. Every date and name is invented."""
import base64
from datetime import date, timedelta
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://edocuments.statefarm.com"
PAGE = "/DocumentCenterUI/"
PRESS = "window.pressed = (window.pressed || 0) + 1"
LINK = "/DocumentCenterProxyV1/document/abc/file.pdf"
OTHER = "/DocumentCenterProxyV1/document/def/file.pdf"
AHEAD = (date.today() + timedelta(days=700)).strftime("%m/%d/%Y")


def row(when, control, more=""):
    return f'<div role="row"><span>{when}</span> {control} <span>{more}</span></div>'


def link(name, href=LINK):
    return f'<a href="{href}" onclick="{PRESS}; return false">{name}</a>'


VIEW = f'<button onclick="{PRESS}">View Documents 1</button>'


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, url, body, pdf=None):
    def route(r):
        if ".pdf" in r.request.url and pdf:
            r.fulfill(**pdf)
        else:
            r.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body}")
    tab.goto("about:blank")
    tab.unroute("**/*")
    tab.route("**/*", route)
    tab.goto(url)
    tab.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    tab.add_script_tag(content=(ROOT / "providers" / "statefarm.page.js").read_text())


def read(tab):
    return tab.evaluate("__sweep.readList()")


def doc():
    return {"id": LINK, "date": "2026-05-08", "title": "Account Statement", "method": "fetch", "url": BASE + LINK}


def test_documents_with_their_own_link_are_read_newest_first(tab):
    load(tab, BASE + PAGE, row("03/14/2026", link("View PDF", OTHER)) + row("05/08/2026", link("Download Statement")))
    got = read(tab)
    assert got["state"] == "ok"
    assert [d["date"] for d in got["docs"]] == ["2026-05-08", "2026-03-14"]
    assert got["docs"][0] == doc()
    assert tab.evaluate("window.pressed") is None


def test_a_view_documents_row_is_reported_and_not_pressed(tab):
    load(tab, BASE + PAGE, row("05/08/2026", link("View PDF")) + row("03/14/2026", VIEW))
    got = read(tab)
    assert got["state"] == "stopped" and "View Documents" in got["why"]
    assert [d["date"] for d in got["docs"]] == ["2026-05-08"]
    assert tab.evaluate("window.pressed") is None


def test_only_view_documents_rows_save_nothing(tab):
    load(tab, BASE + PAGE, row("05/08/2026", VIEW))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


def test_a_day_the_document_stays_online_until_is_not_its_date(tab):
    load(tab, BASE + PAGE, row("05/08/2026", link("View PDF"), more=f"Available until {AHEAD}"))
    assert read(tab)["docs"][0]["date"] == "2026-05-08"


def test_a_tax_form_is_named_as_one(tab):
    load(tab, BASE + PAGE, row("01/24/2026", link("1098 PDF")))
    assert read(tab)["docs"][0]["title"] == "Tax Document"


@pytest.mark.parametrize("path", ["/login", "/auth/x", "/mfa", "/verification", "/challenge"])
def test_a_sign_in_address_is_signed_out(tab, path):
    load(tab, BASE + path, "<p>hello</p>")
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_signed_out(tab):
    load(tab, BASE + PAGE, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_needs_the_person(tab):
    load(tab, BASE + PAGE, "<h1>Let's verify it's you</h1><p>Enter the code</p>")
    assert read(tab) == {"state": "challenge"}


def test_a_document_control_is_not_a_security_check(tab):
    load(tab, BASE + PAGE, row("05/08/2026", link("View PDF")) + "<p>Unusual activity</p>")
    assert read(tab)["state"] == "ok"


def test_another_page_is_not_the_list_yet(tab):
    load(tab, BASE + "/other", "<p>hello</p>")
    assert read(tab) == {"state": "no_list"}


def test_a_row_with_two_dates_stops_rather_than_pick_one(tab):
    load(tab, BASE + PAGE, row("05/08/2026", link("View PDF"), more="03/14/2026"))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


@pytest.mark.parametrize("when", ["02/31/2026", "soon"])
def test_a_date_that_is_not_one_stops(tab, when):
    load(tab, BASE + PAGE, row(when, link("View PDF")))
    assert read(tab)["state"] == "stopped"


def test_a_pay_control_is_not_a_document(tab):
    load(tab, BASE + PAGE, row("05/08/2026", link("View payment PDF")))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


def test_a_link_to_another_host_is_not_a_document(tab):
    load(tab, BASE + PAGE, row("05/08/2026", link("View PDF", "https://evil.example/file.pdf")))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


def test_an_official_pdf_comes_back_whole(tab):
    data = b"%PDF-1.7 " + bytes(range(256)) * 400
    load(tab, BASE + PAGE, row("05/08/2026", link("View PDF")), pdf=dict(status=200, content_type="application/pdf", body=data))
    got = tab.evaluate("(d) => __sweep.fetchPdf(d)", doc())
    assert got["ok"] and base64.b64decode(got["base64"]) == data


def test_html_labelled_as_a_pdf_is_not_kept(tab):
    load(tab, BASE + PAGE, row("05/08/2026", link("View PDF")), pdf=dict(status=200, content_type="application/pdf", body=b"<html>"))
    assert tab.evaluate("(d) => __sweep.fetchPdf(d)", doc())["ok"] is False


@pytest.mark.parametrize("bad", [
    {"id": "x", "url": "https://evil.example/file.pdf"},
    {"id": "/DocumentCenterUI/", "url": BASE + "/DocumentCenterUI/"},
    {"id": "/wrong", "url": BASE + LINK},
    {"id": "x"}])
def test_an_address_this_did_not_read_is_refused(tab, bad):
    load(tab, BASE + PAGE, row("05/08/2026", link("View PDF")))
    assert tab.evaluate("(d) => __sweep.fetchPdf(d)", bad)["ok"] is False
