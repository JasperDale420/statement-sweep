"""The Fidelity page logic, in a real Chromium, on stand-in pages."""
import base64
import json
import zlib
from datetime import datetime, timezone
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAGE = "/navigate/ent-documentcenter/statements?poe=fidcom"
HOST = "https://digitalservices.fidelity.com"
HUB = "<h1>Document Access Hub</h1>"
YEAR = datetime.now().year


def eastern_midnight(y, m, d):
    # Fidelity's dates are midnight Eastern, here EDT.
    return int(datetime(y, m, d, 4, tzinfo=timezone.utc).timestamp())


def stmt(i="STMT-1", acct="X12345678", start=(YEAR, 1, 1), end=(YEAR, 1, 31), **extra):
    return {"id": i, "type": "PI Monthly", "acctNum": acct,
            "periodStartDate": eastern_midnight(*start), "periodEndDate": eastern_midnight(*end),
            "formatTypes": {"formatType": {"isPDF": True}}, **extra}


def listing(items):
    return {"statement": {"docDetails": {"docDetail": items}}}


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, path, body, answer=None, download=None):
    """answer(docType, year) -> (status, json) for the list; download -> a route.fulfill dict."""
    posts = []

    def route(r):
        url = r.request.url
        if "/financial-documents/statements" in url and answer:
            body_ = json.loads(r.request.post_data)
            posts.append(dict(body_, headers=r.request.headers))
            status, payload = answer(body_["docType"], int(body_["startDate"][:4]))
            r.fulfill(status=status, content_type="application/json", body=json.dumps(payload))
        elif "/financial-documents/download" in url and download:
            posts.append(json.loads(r.request.post_data))
            r.fulfill(**download)
        else:
            r.fulfill(status=200, content_type="text/html", body=f"<!doctype html><body>{body}</body>")

    tab.unroute("**/*")
    tab.route("**/*", route)
    tab.goto(HOST + path)
    tab.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    tab.add_script_tag(content=(ROOT / "providers" / "fidelity.page.js").read_text())
    return posts


def read(tab):
    return tab.evaluate("__sweep.readList()")


def only_stmt_this_year(items):
    return lambda kind, year: (200, listing(items if kind == "STMT" and year == YEAR else []))


def test_a_sign_in_page_is_known(tab):
    load(tab, "/prgw/digital/login/full-page", "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_password_box_is_a_sign_in_on_any_address(tab):
    load(tab, PAGE, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


@pytest.mark.parametrize("words", ["Enter the code we sent", "Your session has expired", "Are you a robot?"])
def test_a_security_check_is_known(tab, words):
    load(tab, PAGE, f"<p>{words}</p>")
    assert read(tab) == {"state": "challenge"}


def test_a_check_only_in_the_source_is_not_a_check(tab):
    load(tab, PAGE, HUB + '<script>var s = "enter the code"</script>', answer=only_stmt_this_year([]))
    assert read(tab)["state"] == "ok"


def test_throttling_stops_and_asks_nothing(tab):
    posts = load(tab, PAGE, "<p>Too many requests</p>")
    assert read(tab)["state"] == "stopped" and posts == []


def test_another_fidelity_page_is_not_the_list(tab):
    load(tab, "/navigate/other", HUB)
    assert read(tab) == {"state": "no_list"}


def test_a_list_reads_right_with_the_page_headers(tab):
    posts = load(tab, PAGE, HUB, answer=only_stmt_this_year([stmt()]))
    got = read(tab)
    assert got == {"state": "ok", "docs": [{
        "id": f"STMT-X12345678-{YEAR}-01-31-0", "date": f"{YEAR}-01-31", "title": "Monthly Statement 5678",
        "method": "fetch", "docId": "STMT-1", "docType": "STMT", "acctType": "Brokerage"}]}
    assert posts[0]["headers"]["appid"] == "AP160308"
    assert posts[0]["startDate"] == f"{YEAR}-01-01" and posts[0]["endDate"] == f"{YEAR}-12-31"
    assert posts[0]["annuityAccountLookup"] is True
    # one call per year and kind, back to the hub's oldest year
    assert len(posts) == 2 * (YEAR - 2016 + 1)


def test_a_winter_midnight_and_a_quarter_read_right(tab):
    q = stmt(start=(YEAR, 1, 1), end=(YEAR, 3, 31))
    q["periodEndDate"] = int(datetime(YEAR, 3, 31, 4, tzinfo=timezone.utc).timestamp())
    jan = stmt("STMT-2")
    jan["periodEndDate"] = int(datetime(YEAR, 1, 31, 5, tzinfo=timezone.utc).timestamp())
    load(tab, PAGE, HUB, answer=only_stmt_this_year([jan, q]))
    docs = read(tab)["docs"]
    assert [(d["date"], d["title"]) for d in docs] == [
        (f"{YEAR}-03-31", "Quarterly Statement 5678"), (f"{YEAR}-01-31", "Monthly Statement 5678")]


def test_newest_first_across_kinds_and_two_on_a_day_stay_apart(tab):
    tc1 = stmt("TC-1", end=(YEAR, 2, 2)); tc2 = stmt("TC-2", end=(YEAR, 2, 2))

    def answer(kind, year):
        if year != YEAR:
            return 200, listing([])
        return 200, listing([stmt()] if kind == "STMT" else [tc1, tc2])
    load(tab, PAGE, HUB, answer=answer)
    docs = read(tab)["docs"]
    assert [d["date"] for d in docs] == [f"{YEAR}-02-02", f"{YEAR}-02-02", f"{YEAR}-01-31"]
    assert docs[0]["id"].endswith("-0") and docs[1]["id"].endswith("-1")
    assert docs[0]["docType"] == "TC" and "Trade Confirmation 5678" == docs[0]["title"]


def test_a_document_that_is_not_a_pdf_is_passed_over(tab):
    item = stmt(); item["formatTypes"]["formatType"]["isPDF"] = False
    load(tab, PAGE, HUB, answer=only_stmt_this_year([item]))
    assert read(tab) == {"state": "ok", "docs": []}


def test_the_date_is_not_guessed(tab):
    item = stmt(); item["periodEndDate"] = "Feb 31, 2026"
    load(tab, PAGE, HUB, answer=only_stmt_this_year([stmt("STMT-9"), item]))
    got = read(tab)
    assert got["state"] == "stopped" and len(got["docs"]) == 1


def test_an_id_this_cannot_read_stops(tab):
    load(tab, PAGE, HUB, answer=only_stmt_this_year([stmt("../../x y")]))
    assert read(tab)["state"] == "stopped"


def test_expired_session_on_the_api(tab):
    load(tab, PAGE, HUB, answer=lambda kind, year: (401, {}))
    assert read(tab) == {"state": "signed_out"}


def test_a_server_error_stops_rather_than_read_as_empty(tab):
    load(tab, PAGE, HUB, answer=lambda kind, year: (500, {}))
    assert read(tab)["state"] == "stopped"


def test_a_list_of_the_wrong_shape_stops(tab):
    load(tab, PAGE, HUB, answer=lambda kind, year: (200, {"statement": {"docDetails": {"docDetail": "no"}}}))
    assert read(tab)["state"] == "stopped"


DOC = "{docId: 'STMT-1', docType: 'STMT', acctType: 'Brokerage'}"


def pdf_answer(content, **extra):
    return dict(status=200, content_type="application/json",
                body=json.dumps({"document": {"docDetail": {"content": content, **extra}}}))


def test_an_official_pdf_comes_back_whole_and_the_call_is_right(tab):
    data = b"%PDF-1.7 " + bytes(range(256)) * 400
    posts = load(tab, PAGE, HUB, download=pdf_answer(base64.b64encode(data).decode()))
    got = tab.evaluate(f"__sweep.fetchPdf({DOC})")
    assert got["ok"] and base64.b64decode(got["base64"]) == data and got["size"] == len(data)
    assert posts == [{"id": "STMT-1", "formatType": "PDF", "docType": "STMT", "acctType": "Brokerage"}]


@pytest.mark.parametrize("wbits", [15, -15, 31])
def test_a_deflated_pdf_is_inflated(tab, wbits):
    data = b"%PDF-1.4 " + b"fake " * 50
    packer = zlib.compressobj(wbits=wbits)
    packed = packer.compress(data) + packer.flush()
    load(tab, PAGE, HUB, download=pdf_answer(base64.b64encode(packed).decode(), deflated="Y"))
    got = tab.evaluate(f"__sweep.fetchPdf({DOC})")
    assert got["ok"] and base64.b64decode(got["base64"]) == data


def test_html_labelled_as_a_document_is_not_kept(tab):
    load(tab, PAGE, HUB, download=pdf_answer(base64.b64encode(b"<html>sign in</html>").decode()))
    assert tab.evaluate(f"__sweep.fetchPdf({DOC})")["ok"] is False


def test_an_expired_session_on_download_says_so(tab):
    load(tab, PAGE, HUB, download=dict(status=403, content_type="application/json", body="{}"))
    assert tab.evaluate(f"__sweep.fetchPdf({DOC})")["signedOut"] is True


@pytest.mark.parametrize("doc", ["{docId: 'a b', docType: 'STMT', acctType: 'Brokerage'}",
                                 "{docId: 'x', docType: 'TAX', acctType: 'Brokerage'}",
                                 "{docId: 'x', docType: 'STMT', acctType: '../x'}", "null"])
def test_a_bad_document_is_refused_unasked(tab, doc):
    posts = load(tab, PAGE, HUB, download=pdf_answer(""))
    assert tab.evaluate(f"__sweep.fetchPdf({doc})")["ok"] is False and posts == []
