"""The TriNet page logic, in a real Chromium, on stand-in pages.

Every id, date and amount here is invented; the shapes follow TriNet's own
answers (token-details and the paycheck list), read once from a signed-in tab.
"""
import base64
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://trinet.hrpassport.com"
PAGE = "/ui-hr-portal-money/"
WHO = "/api-trinet-auth/services/v1.0/authentication/user/token-details"
MONEY = "/api-bs-hr-portal-money/v1/payroll"

COMPANY, EMPLOYEE = "11XX", "00000000001"
WHO_ANSWER = {"uid": "x", "companyid": [COMPANY], "emplid": [EMPLOYEE], "personid": EMPLOYEE}


def key(n):
    return f"{n:032X}"


def check(n, day, off="N"):
    return {"id": key(n), "checkDt": f"{day}T00:00:00", "checkIssueDate": day,
            "checkKey": {"offCycle": off}, "checkNumber": str(n), "grossPay": 1, "netPay": 1}


LIST = {"data": {"checkSummaries": [
    check(3, "2031-02-14"), check(2, "2031-01-31", off="Y"), check(1, "2031-01-31")]}}


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, body="<main>Paychecks</main>", who=WHO_ANSWER, lists=None, pdf=None, who_status=200, list_status=200):
    """Stand in for TriNet. lists maps each 'company/employee' to its answer."""
    lists = lists if lists is not None else {f"{COMPANY}/{EMPLOYEE}": LIST}
    asked = []

    def respond(route):
        url = route.request.url
        path = url[len(BASE):] if url.startswith(BASE) else None
        if path is None:
            route.abort()
        elif path == WHO:
            route.fulfill(status=who_status, content_type="application/json", body=json.dumps(who))
        elif path.startswith(MONEY) and "/paycheck-details-pdf/" in path:
            asked.append(path)
            route.fulfill(**(pdf or dict(status=404, body=b"")))
        elif path.startswith(MONEY) and path.endswith("/paychecks"):
            pair = path[len(MONEY) + 1:-len("/paychecks")]
            if pair in lists:
                route.fulfill(status=list_status, content_type="application/json", body=json.dumps(lists[pair]))
            else:
                route.fulfill(status=404, body=b"")
        else:
            route.fulfill(status=200, content_type="text/html", body=f"<!doctype html><title>TriNet</title>{body}")
    tab.unroute("**/*")
    tab.route("**/*", respond)
    tab.goto(BASE + PAGE)
    tab.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    tab.add_script_tag(content=(ROOT / "providers" / "trinet.page.js").read_text())
    return asked


def read(tab):
    return tab.evaluate("__sweep.readList()")


def doc(n, day, title, at=0):
    return {"id": f"{day}:{key(n)}", "date": day, "title": title, "method": "fetch", "key": key(n), "at": at}


def test_the_list_is_read_newest_first_and_off_cycle_ones_are_named(tab):
    load(tab)
    assert read(tab) == {"state": "ok", "docs": [
        doc(3, "2031-02-14", "Paycheck"),
        doc(2, "2031-01-31", "Off-Cycle Paycheck"),
        doc(1, "2031-01-31", "Paycheck"),
    ]}


def test_two_of_one_kind_on_one_day_are_numbered_so_neither_is_lost(tab):
    load(tab, lists={f"{COMPANY}/{EMPLOYEE}": {"data": {"checkSummaries": [
        check(5, "2031-03-15"), check(4, "2031-03-15")]}}})
    assert [d["title"] for d in read(tab)["docs"]] == ["Paycheck 1", "Paycheck 2"]


def test_the_same_paycheck_twice_is_one_doc(tab):
    load(tab, lists={f"{COMPANY}/{EMPLOYEE}": {"data": {"checkSummaries": [check(1, "2031-01-31")] * 2}}})
    assert len(read(tab)["docs"]) == 1


def test_each_company_in_the_sign_in_is_read_and_its_place_kept(tab):
    who = {**WHO_ANSWER, "companyid": [COMPANY, "22YY"], "emplid": [EMPLOYEE, "00000000002"]}
    load(tab, who=who, lists={
        f"{COMPANY}/{EMPLOYEE}": {"data": {"checkSummaries": [check(1, "2031-01-31")]}},
        "22YY/00000000002": {"data": {"checkSummaries": [check(9, "2029-06-30")]}},
    })
    assert read(tab)["docs"] == [doc(1, "2031-01-31", "Paycheck"), doc(9, "2029-06-30", "Paycheck", at=1)]


def test_an_employee_id_missing_from_the_list_falls_back_to_the_person(tab):
    load(tab, who={**WHO_ANSWER, "emplid": []})
    assert read(tab)["state"] == "ok"


@pytest.mark.parametrize("who", [
    {"uid": "x"},
    {**WHO_ANSWER, "companyid": ["../etc"]},
    {**WHO_ANSWER, "companyid": [COMPANY, "a/b"], "emplid": [EMPLOYEE, EMPLOYEE]},
    {**WHO_ANSWER, "emplid": ["?x=1"], "personid": ""},
])
def test_a_sign_in_without_ids_this_reads_stops_and_asks_no_list(tab, who):
    load(tab, who=who)
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


def test_signed_out_is_known_by_the_password_field(tab):
    load(tab, body="<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_is_a_challenge(tab):
    load(tab, body="<p>Enter the code we sent to your phone</p>")
    assert read(tab) == {"state": "challenge"}


@pytest.mark.parametrize("status", [401, 403])
def test_a_sign_in_question_that_answers_signed_out_is_signed_out(tab, status):
    load(tab, who_status=status)
    assert read(tab) == {"state": "signed_out"}


@pytest.mark.parametrize("status", [401, 403])
def test_a_list_that_answers_signed_out_is_signed_out(tab, status):
    load(tab, list_status=status)
    assert read(tab) == {"state": "signed_out"}


def test_a_list_of_another_shape_stops(tab):
    load(tab, lists={f"{COMPANY}/{EMPLOYEE}": {"data": {"checkSummaries": "none"}}})
    assert read(tab)["state"] == "stopped"


@pytest.mark.parametrize("bad", [
    {"id": "../../etc/passwd", "checkDt": "2031-01-31"},
    {"id": key(7), "checkDt": "2031-02-30", "checkIssueDate": ""},
    {"id": key(7)},
    "not a paycheck",
])
def test_a_paycheck_that_cannot_be_read_stops_and_keeps_the_rest(tab, bad):
    load(tab, lists={f"{COMPANY}/{EMPLOYEE}": {"data": {"checkSummaries": [check(1, "2031-01-31"), bad]}}})
    got = read(tab)
    assert got["state"] == "stopped" and [d["key"] for d in got["docs"]] == [key(1)]


def test_the_issue_date_stands_in_for_a_missing_check_date(tab):
    c = {**check(1, "2031-01-31"), "checkDt": None}
    load(tab, lists={f"{COMPANY}/{EMPLOYEE}": {"data": {"checkSummaries": [c]}}})
    assert read(tab)["docs"][0]["date"] == "2031-01-31"


PDF = dict(status=200, content_type="application/pdf", body=b"%PDF-1.7")


@pytest.mark.parametrize("bad", [
    "{id: '2031-01-31:../x', date: '2031-01-31', key: '../x'}",
    f"{{id: '2031-01-30:{key(1)}', date: '2031-01-31', key: '{key(1)}'}}",
    f"{{id: '2031-01-31:{key(1)}', date: '2031-01-31'}}",
])
def test_a_bad_key_or_an_id_that_disagrees_asks_for_nothing(tab, bad):
    asked = load(tab, pdf=PDF)
    assert tab.evaluate(f"__sweep.fetchPdf({bad})")["ok"] is False
    assert asked == []


def test_an_official_pdf_comes_back_whole_from_its_one_address(tab):
    data = b"%PDF-1.7 " + bytes(range(256)) * 400
    asked = load(tab, pdf=dict(status=200, content_type="application/pdf", body=data))
    got = tab.evaluate(f"__sweep.fetchPdf({json.dumps(doc(1, '2031-01-31', 'Paycheck'))})")
    assert got["ok"] and got["size"] == len(data) and base64.b64decode(got["base64"]) == data
    assert asked == [f"{MONEY}/{COMPANY}/{EMPLOYEE}/paycheck-details-pdf/{key(1)}"]


def test_a_second_company_s_paycheck_is_asked_of_that_company(tab):
    who = {**WHO_ANSWER, "companyid": [COMPANY, "22YY"], "emplid": [EMPLOYEE, "00000000002"]}
    asked = load(tab, who=who, pdf=PDF)
    assert tab.evaluate(f"__sweep.fetchPdf({json.dumps(doc(9, '2029-06-30', 'Paycheck', at=1))})")["ok"]
    assert asked == [f"{MONEY}/22YY/00000000002/paycheck-details-pdf/{key(9)}"]


def test_a_company_no_longer_in_the_sign_in_asks_for_nothing(tab):
    asked = load(tab, pdf=PDF)
    got = tab.evaluate(f"__sweep.fetchPdf({json.dumps(doc(9, '2029-06-30', 'Paycheck', at=3))})")
    assert got["ok"] is False and asked == []


def test_html_labelled_as_a_pdf_is_not_kept(tab):
    load(tab, pdf=dict(status=200, content_type="application/pdf", body=b"<html>sign in</html>"))
    assert tab.evaluate(f"__sweep.fetchPdf({json.dumps(doc(1, '2031-01-31', 'Paycheck'))})")["ok"] is False


def test_a_download_that_answers_signed_out_says_so(tab):
    load(tab, pdf=dict(status=401, content_type="text/html", body=b""))
    got = tab.evaluate(f"__sweep.fetchPdf({json.dumps(doc(1, '2031-01-31', 'Paycheck'))})")
    assert got["ok"] is False and got["signedOut"] is True
