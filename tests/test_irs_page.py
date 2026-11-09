"""The IRS page logic, in a real Chromium, on stand-in pages."""
import base64
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOST = "https://sa.www4.irs.gov"
PAGE = "/ola/tax_records/transcripts"
API = "/ola/api/shared/accounts/taxrecords/1.0/taxpayers/transcripts"
MAIN = '<div id="main" role="main"><h1>Transcripts</h1></div>'
ITEMS = [
    {"transcriptType": "account", "taxPeriod": "202412", "mft": "30", "taxForm": "1040", "availableLanguages": ["en", "es"]},
    {"transcriptType": "return", "taxPeriod": "202412", "mft": "30", "taxForm": "1040", "availableLanguages": ["en"]},
    {"transcriptType": "wageAndIncome", "taxPeriod": "202312", "mft": "00", "taxForm": "All Forms", "availableLanguages": ["en"]},
    {"transcriptType": "recordOfAccount", "taxPeriod": "202212", "mft": "30", "taxForm": "1040 Series", "availableLanguages": ["en"]},
]
JSON_OK = dict(status=200, content_type="application/json", body=json.dumps(ITEMS))
ID = "transcript-account-202412-30"


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, path=PAGE, body=MAIN, answers=None):
    answers = answers or {}

    def answer(route):
        path_only = route.request.url.split("?")[0].replace(HOST, "")
        if path_only in answers:
            route.fulfill(**answers[path_only])
        else:
            route.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body}")
    tab.unroute("**/*")
    tab.route("**/*", answer)
    tab.goto(HOST + path)
    tab.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    tab.add_script_tag(content=(ROOT / "providers" / "irs.page.js").read_text())


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_a_good_list_is_dated_at_each_periods_end_newest_first(tab):
    load(tab, answers={API: JSON_OK})
    got = read(tab)
    assert got["state"] == "ok"
    assert [(d["id"], d["date"], d["title"]) for d in got["docs"]] == [
        ("transcript-account-202412-30", "2024-12-31", "Account Transcript"),
        ("transcript-return-202412-30", "2024-12-31", "Return Transcript"),
        ("transcript-wageAndIncome-202312-00", "2023-12-31", "Wage and Income Transcript"),
        ("transcript-recordOfAccount-202212-30", "2022-12-31", "Record of Account Transcript"),
    ]


def test_two_of_a_type_and_period_are_named_apart_by_their_mft(tab):
    items = [dict(ITEMS[0], mft="30", taxForm="1040"), dict(ITEMS[0], mft="29", taxForm="1040")]
    load(tab, answers={API: dict(status=200, content_type="application/json", body=json.dumps(items))})
    assert [d["title"] for d in read(tab)["docs"]] == ["Account Transcript MFT 30", "Account Transcript MFT 29"]


def test_a_sign_in_address_is_known(tab):
    load(tab, path="/ola/secureaccess/login", body="<p>Sign in</p>")
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_known(tab):
    load(tab, body="<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_waits_for_the_person(tab):
    load(tab, body="<p>Enter the code we sent</p>")
    assert read(tab) == {"state": "challenge"}


def test_another_page_is_not_the_list(tab):
    load(tab, path="/ola/", body=MAIN)
    assert read(tab) == {"state": "no_list"}


def test_the_api_answering_html_is_a_signed_out_session(tab):
    load(tab, answers={API: dict(status=200, content_type="text/html", body="<html>sign in</html>")})
    assert read(tab) == {"state": "signed_out"}


def test_the_api_answering_401_is_a_signed_out_session(tab):
    load(tab, answers={API: dict(status=401, content_type="application/json", body="{}")})
    assert read(tab) == {"state": "signed_out"}


@pytest.mark.parametrize("item", [
    dict(ITEMS[0], transcriptType="somethingNew"),
    dict(ITEMS[0], taxPeriod="2024"),
    dict(ITEMS[0], taxPeriod="202413"),
    dict(ITEMS[0], mft="abc"),
    dict(ITEMS[0], availableLanguages=["es"]),
    dict(ITEMS[0], availableLanguages=None),
])
def test_an_item_of_an_unknown_shape_stops_the_list(tab, item):
    load(tab, answers={API: dict(status=200, content_type="application/json", body=json.dumps([ITEMS[1], item]))})
    got = read(tab)
    assert got["state"] == "stopped" and got["why"]
    assert [d["id"] for d in got["docs"]] == ["transcript-return-202412-30"]


def test_one_transcript_listed_twice_stops(tab):
    load(tab, answers={API: dict(status=200, content_type="application/json", body=json.dumps([ITEMS[0], ITEMS[0]]))})
    assert read(tab)["state"] == "stopped"


def test_an_answer_that_is_not_a_list_stops(tab):
    load(tab, answers={API: dict(status=200, content_type="application/json", body='{"a": 1}')})
    assert read(tab)["state"] == "stopped"


@pytest.mark.parametrize("bad", ["../../etc", "transcript-account-202412-", "transcript-Account-202412-30", "x"])
def test_a_bad_id_is_refused(tab, bad):
    load(tab, answers={API: JSON_OK})
    got = tab.evaluate(f"__sweep.fetchPdf({{id: {json.dumps(bad)}}})")
    assert got["ok"] is False


def transcript_answer(status=200, content_type="application/pdf", body=b"%PDF-1.7 "):
    return {API: JSON_OK, f"{API}/account/202412/30": dict(status=status, content_type=content_type, body=body)}


def test_an_official_pdf_comes_back_whole(tab):
    data = b"%PDF-1.7 " + bytes(range(256)) * 400
    load(tab, answers=transcript_answer(body=data))
    got = tab.evaluate(f"__sweep.fetchPdf({{id: '{ID}'}})")
    assert got["ok"] and base64.b64decode(got["base64"]) == data and got["size"] == len(data)


def test_html_labelled_as_a_pdf_is_not_kept(tab):
    load(tab, answers=transcript_answer(body=b"<html>sign in</html>"))
    assert tab.evaluate(f"__sweep.fetchPdf({{id: '{ID}'}})")["ok"] is False


def test_html_where_a_pdf_was_asked_for_is_a_signed_out_session(tab):
    load(tab, answers=transcript_answer(content_type="text/html", body=b"<html></html>"))
    got = tab.evaluate(f"__sweep.fetchPdf({{id: '{ID}'}})")
    assert got["ok"] is False and got["signedOut"] is True


def test_a_transcript_gone_from_the_list_is_not_asked_for(tab):
    items = [ITEMS[1]]
    answers = transcript_answer()
    answers[API] = dict(status=200, content_type="application/json", body=json.dumps(items))
    load(tab, answers=answers)
    assert tab.evaluate(f"__sweep.fetchPdf({{id: '{ID}'}})")["ok"] is False
