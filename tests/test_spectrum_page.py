"""The Spectrum page logic, in a real Chromium, on stand-in pages. The stand-in
is a small one-page app, as Spectrum's is: pressing a row moves the address
in the app, without a page load. Every value here is invented."""
import base64
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://www.spectrum.net"
PAGE = "/billing/statements"
DETAIL = "/billing/bill-details"
ACCOUNT = "90000001"
SIGNED_OUT = "Spectrum signed you out. Sign in and run it again."


def sid(day, kind="DIGITAL", account=ACCOUNT):
    text = f"Account={account}|StatementDate={day}|StatementCode=12|{kind}_DOCUMENT"
    return base64.b64encode(text.encode()).decode().rstrip("=")


def detail(day, transfer=False, next_bill=False):
    return f"{DETAIL}?pdfStatementId={sid(day)}&isNextBill={'true' if next_bill else 'false'}&isAccountTransfer={'true' if transfer else 'false'}"


def row(text, to=None, href="javascript:void(0)", tag=None):
    go = f"go('{to}');" if to else ""
    return (f'<a class="kite-list-item__action" href="{href}" '
            f'onclick="pressed.push(\'row:{tag or text}\');{go}return false">{text}</a>')


def internet_row(day, words, transfer=False, href="javascript:void(0)", lands=None):
    return row(f"Statement {words} $80.00", to=detail(lands or day, transfer), href=href, tag=day)


SEP = internet_row("2026-09-26", "September 26, 2026")
AUG = internet_row("2026-08-26", "August 26, 2026")
JUL = internet_row("2026-07-26", "July 26, 2026")
PRINTABLE = '<button onclick="pressed.push(\'printable:\' + location.search)">View Printable Statement</button>'

MLINK = ('<a role="link" href="javascript:void(0)" onclick="pressed.push(\'mobile-link\');go(\'/billing/mobile-statements\')">'
         'Mobile&nbsp;Account&nbsp;Number:&nbsp;55501</a>')
ILINK = '<a role="link" href="javascript:void(0)">Internet&nbsp;Account&nbsp;Number:&nbsp;55502</a>'
MOBILE_IDS = {"2026-09-13": "m-q1", "2026-08-13": "m-q2"}


def mrow(day, words, href="javascript:void(0)", extra=""):
    to = f"/mobile-billing/statement-history?statementId={MOBILE_IDS.get(day, 'm-x')}&newStatementVersion=2"
    return (f'<a role="link" href="{href}" onclick="pressed.push(\'mrow:{day}\');go(\'{to}\');return false">'
            f'Statement {words}{extra}</a>')


AUG_MROW = mrow("2026-08-13", "August 13, 2026")
MOBILE_LIST = ('<a role="link" href="javascript:void(0)">Statement October 13 Auto Pay: Oct 30 $55.00</a>'
               '<a role="link" href="javascript:void(0)">Your Total So Far $12.00</a>'
               + mrow("2026-09-13", "September 13, 2026", extra=" $55.00") + AUG_MROW
               + '<a role="link" href="javascript:void(0)">Order 4444 Oct 1, 2026</a>')

SECTIONS = ["Account Holder Information", "Previous Balance", "Payments and Credits", "Remaining Balance",
            "Unlimited Lines (2)", "Included Taxes, Fees &amp; Charges"]


def mobile_statement(heading, extra=""):
    buttons = "".join(f'<button id="accord-{i + 1}-button-0" class="kite-accordion-row__button" aria-expanded="false">{s}</button>'
                      for i, s in enumerate(SECTIONS))
    return (f'<div>Statement Details</div><div><h2>{heading}</h2><p>Mobile</p></div>{extra}'
            f'<nav><button aria-expanded="false">Expand Account</button></nav>{buttons}'
            '<button class="kite-button" onclick="expandAll(this)">Expand&nbsp;All</button><button>Print</button>')


APP = r"""
<div id="app"></div>
<script>
window.pressed = [];
const VIEWS = %s;
const MOBILE = %s;
function render() {
  let html = VIEWS[location.pathname];
  if (location.pathname === '/mobile-billing/statement-history') {
    html = MOBILE[new URLSearchParams(location.search).get('statementId')];
  }
  document.getElementById('app').innerHTML = html || '<p>Nothing here</p>';
}
function go(url) { history.pushState({}, '', url); render(); }
function expandAll(b) {
  pressed.push('expand');
  setTimeout(() => {
    for (const s of document.querySelectorAll('.kite-accordion-row__button')) s.setAttribute('aria-expanded', 'true');
    b.textContent = 'Collapse All';
  }, 200);
}
window.addEventListener('popstate', render);
render();
</script>
"""


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def recipe(tab):
    tab.add_script_tag(content=(ROOT / "providers" / "spectrum.page.js").read_text())


def load(tab, url, views, mobile=None):
    """Serves the app for every www.spectrum.net address: `views` by path, a
    Mobile statement's page by its statementId."""
    asked = []
    body = "<!doctype html><title>Spectrum</title>" + APP % (json.dumps(views), json.dumps(mobile or {}))

    def route(r):
        asked.append(r.request.url)
        if r.request.url.startswith(BASE + "/"):
            r.fulfill(status=200, content_type="text/html; charset=utf-8", body=body)
        else:
            r.fulfill(status=200, content_type="text/html", body="<!doctype html><p>elsewhere</p>")
    tab.goto("about:blank")
    tab.unroute("**/*")
    tab.route("**/*", route)
    tab.goto(url)
    tab.evaluate("sessionStorage.clear()")
    recipe(tab)
    return asked


def statements(tab, *rows_html, page=PRINTABLE, url=BASE + PAGE):
    return load(tab, url, {PAGE: "".join(rows_html), DETAIL: page})


def read(tab, walk=False):
    return tab.evaluate("(w) => __sweep.readList({walk: w})", walk)


def call(tab, name, doc):
    return tab.evaluate(f"(d) => __sweep.{name}(d)", doc)


def pressed(tab):
    return tab.evaluate("window.pressed")


def doc_of(day, family="current", **more):
    return {"id": f"{family}:{day}", "date": day, "title": "Internet Statement", "method": "newtab", **more}


def mdoc(day):
    return {"id": f"mobile:{day}", "date": day, "title": "Mobile Statement", "method": "print"}


# ---- Internet list -----------------------------------------------------

def test_the_statements_are_listed_newest_first_and_nothing_is_pressed(tab):
    asked = statements(tab, AUG, SEP, '<a class="kite-list-item__action" href="javascript:void(0)">Billing help</a>')
    got = read(tab)
    assert got["state"] == "ok"
    assert got["docs"] == [
        {"id": "current:2026-09-26", "date": "2026-09-26", "title": "Internet Statement", "method": "newtab", "newest": True},
        {"id": "current:2026-08-26", "date": "2026-08-26", "title": "Internet Statement", "method": "newtab"},
    ]
    assert "more" not in got and "only in a tab this opens" in got["note"]
    assert pressed(tab) == []
    assert len(asked) == 1


def test_a_walk_says_there_is_more_and_moves_to_billing(tab):
    statements(tab, SEP)
    got = read(tab, walk=True)
    assert got["more"] is True and "note" not in got
    assert tab.evaluate("__sweep.nextView()") == {"moved": True}
    tab.wait_for_url(BASE + "/billing")
    assert tab.evaluate("JSON.parse(sessionStorage.getItem('__sweepSpectrumWalk')).at") == "mobile"
    recipe(tab)
    assert tab.evaluate("__sweep.nextView()") == {"moved": False}


def test_an_earlier_accounts_row_is_a_prior_statement_by_its_own_address(tab):
    prior = internet_row("2026-02-26", "February 26, 2026", transfer=True, href=detail("2026-02-26", True))
    statements(tab, SEP, prior)
    assert [d["id"] for d in read(tab)["docs"]] == ["current:2026-09-26", "prior:2026-02-26"]


# The month of a move: one statement from each account, both of one date.
FEB_OLD = row("Statement February 26, 2026 $80.00", to=detail("2026-02-26", True), tag="feb-old")
FEB_NEW = row("Statement February 26, 2026 $80.00", to=detail("2026-02-26", False), tag="feb-new")


def test_two_statements_of_one_date_are_one_from_each_account(tab):
    statements(tab, SEP, FEB_OLD, FEB_NEW)
    got = read(tab)
    assert [(d["id"], d.get("twin", False)) for d in got["docs"]] == [
        ("current:2026-09-26", False), ("current:2026-02-26", True), ("prior:2026-02-26", True)]
    assert "share a date" not in got.get("note", "")
    assert got["docs"][0]["newest"] is True


def test_three_statements_of_one_date_are_left_and_said(tab):
    statements(tab, SEP, FEB_OLD, FEB_NEW, FEB_NEW)
    got = read(tab)
    assert [d["id"] for d in got["docs"]] == ["current:2026-09-26"]
    assert "share a date" in got["note"]


def test_the_new_accounts_twin_is_found_on_the_second_press(tab):
    statements(tab, SEP, FEB_OLD, FEB_NEW)
    doc = doc_of("2026-02-26", twin=True)
    assert call(tab, "clickDoc", doc) == {"ok": True}
    got = pressed(tab)
    assert got[:2] == ["row:feb-old", "row:feb-new"]
    assert got[2].startswith("printable:") and "isAccountTransfer=false" in got[2]


def test_the_earlier_accounts_twin_is_found_on_the_first_press(tab):
    statements(tab, SEP, FEB_OLD, FEB_NEW)
    assert call(tab, "clickDoc", doc_of("2026-02-26", "prior", twin=True)) == {"ok": True}
    got = pressed(tab)
    assert got[0] == "row:feb-old" and "isAccountTransfer=true" in got[1]


def test_twins_that_open_alike_save_nothing(tab):
    same = row("Statement February 26, 2026 $80.00", to=detail("2026-02-26", True), tag="feb-b")
    statements(tab, SEP, FEB_OLD, same)
    got = call(tab, "clickDoc", doc_of("2026-02-26", twin=True))
    assert got["ok"] is False and "Neither" in got["why"]
    assert not any(p.startswith("printable:") for p in pressed(tab))


def test_a_twin_whose_pair_is_gone_is_not_pressed(tab):
    statements(tab, SEP, FEB_NEW)
    got = call(tab, "clickDoc", doc_of("2026-02-26", twin=True))
    assert got["ok"] is False and pressed(tab) == []


@pytest.mark.parametrize("bad", [
    row("Statement August 26, 2026 Make a Payment", to=detail("2026-08-26")),
    internet_row("2026-08-26", "August 26, 2026", href="/billing/autopay"),
    internet_row("2026-08-26", "August 26, 2026", href="https://elsewhere.test/statement"),
])
def test_a_row_the_guard_refuses_is_not_listed(tab, bad):
    statements(tab, SEP, bad)
    got = read(tab)
    assert [d["id"] for d in got["docs"]] == ["current:2026-09-26"]
    assert "not pressed" in got["note"]


@pytest.mark.parametrize("path", ["/login", "/logout", "/signin", "/error/session-expired"])
def test_a_sign_in_address_is_signed_out(tab, path):
    load(tab, BASE + path, {path: "<p>hello</p>"})
    assert read(tab) == {"state": "signed_out"}


def test_the_sign_in_host_is_signed_out(tab):
    load(tab, "https://id.spectrum.net/x", {})
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_signed_out(tab):
    statements(tab, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_the_idle_dialog_is_signed_out(tab):
    statements(tab, SEP, "<p>Your session is about to expire</p>")
    assert read(tab) == {"state": "signed_out"}


@pytest.mark.parametrize("words", ["Enter the code we sent you", "One-time passcode", "Are you a robot?", "Access Denied"])
def test_a_security_check_needs_the_person(tab, words):
    statements(tab, f"<h1>{words}</h1>")
    assert read(tab) == {"state": "challenge"}


def test_the_benign_try_again_message_is_not_a_stop(tab):
    statements(tab, SEP, "<p>This info is currently not available. Please try again later.</p>")
    assert [d["id"] for d in read(tab)["docs"]] == ["current:2026-09-26"]


def test_a_rate_limit_stops(tab):
    statements(tab, "<p>Too many requests</p>")
    assert "try again later" in read(tab)["why"]


def test_another_page_is_not_the_list_yet(tab):
    load(tab, BASE + "/billing", {"/billing": MLINK + ILINK})
    assert read(tab) == {"state": "no_list"}
    assert read(tab, walk=True) == {"state": "no_list"}
    assert pressed(tab) == []


@pytest.mark.parametrize("bad", ["Statement Sept 26, 2026", "Statement February 31, 2026", "Statement September 26"])
def test_a_row_with_no_date_this_can_read_stops(tab, bad):
    statements(tab, AUG, row(bad))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == [] and "no date" in got["why"]


# ---- Internet press ------------------------------------------------------

def test_an_older_statement_is_chosen_by_its_row_then_printed_once(tab):
    statements(tab, SEP, AUG)
    assert call(tab, "clickDoc", doc_of("2026-08-26")) == {"ok": True}
    assert tab.url == BASE + detail("2026-08-26")
    assert pressed(tab) == ["row:2026-08-26", "printable:" + detail("2026-08-26")[len(DETAIL):]]


def test_the_next_statement_goes_back_to_statements_in_the_app_first(tab):
    asked = statements(tab, SEP, AUG, JUL)
    assert call(tab, "clickDoc", doc_of("2026-09-26", newest=True)) == {"ok": True}
    assert call(tab, "clickDoc", doc_of("2026-07-26")) == {"ok": True}
    assert [p for p in pressed(tab) if p.startswith("row:")] == ["row:2026-09-26", "row:2026-07-26"]
    assert sum(p.startswith("printable:") for p in pressed(tab)) == 2
    assert tab.url == BASE + detail("2026-07-26")
    assert len(asked) == 1, "no page was loaded between them"


def test_a_row_that_opens_another_statements_page_is_not_printed(tab):
    statements(tab, SEP, internet_row("2026-08-26", "August 26, 2026", lands="2026-09-26"))
    got = call(tab, "clickDoc", doc_of("2026-08-26"))
    assert got["ok"] is False and "not that statement's" in got["why"]
    assert pressed(tab) == ["row:2026-08-26"]


def test_an_earlier_accounts_statement_in_the_current_list_is_printed_by_its_date(tab):
    # Live: Nov 2025–Jan 2026 are in the current list but open under the
    # earlier account number. Same date, so it is this statement.
    statements(tab, SEP, internet_row("2026-02-26", "February 26, 2026", transfer=True))
    got = call(tab, "clickDoc", doc_of("2026-02-26"))
    assert got["ok"] is True
    assert pressed(tab)[0] == "row:2026-02-26"


def test_a_prior_statement_lands_on_its_transfer_page(tab):
    prior = internet_row("2026-02-26", "February 26, 2026", transfer=True, href=detail("2026-02-26", True))
    statements(tab, SEP, prior)
    assert call(tab, "clickDoc", doc_of("2026-02-26", "prior")) == {"ok": True}
    assert call(tab, "clickDoc", doc_of("2026-09-26", "prior"))["ok"] is False


def test_a_page_loaded_by_its_address_is_pressed_only_for_the_newest(tab):
    statements(tab, SEP, AUG, url=BASE + detail("2026-08-26"))
    got = call(tab, "clickDoc", doc_of("2026-08-26"))
    assert got["ok"] is False and "by its address" in got["why"]
    assert pressed(tab) == []
    tab.wait_for_url(BASE + PAGE)

    statements(tab, SEP, AUG, url=BASE + detail("2026-09-26"))
    assert call(tab, "clickDoc", doc_of("2026-09-26", newest=True)) == {"ok": True}
    assert len(pressed(tab)) == 1 and pressed(tab)[0].startswith("printable:")


@pytest.mark.parametrize("page", [PRINTABLE * 2, '<button disabled>View Printable Statement</button>'])
def test_the_printable_control_must_be_one_and_turned_on(tab, page):
    statements(tab, SEP, page=page)
    got = call(tab, "clickDoc", doc_of("2026-09-26", newest=True))
    assert got["ok"] is False
    assert not any(p.startswith("printable:") for p in pressed(tab))


def test_a_missing_row_or_a_doc_this_did_not_list_is_refused(tab):
    statements(tab, SEP)
    assert "no longer" in call(tab, "clickDoc", doc_of("2026-05-26"))["why"]
    assert call(tab, "clickDoc", {"id": "current:2026-09-26", "date": "2026-09-25"})["ok"] is False
    assert call(tab, "clickDoc", mdoc("2026-09-13"))["ok"] is False
    assert pressed(tab) == []


def test_nothing_is_pressed_while_signed_out(tab):
    statements(tab, SEP, "<p>You have been signed out</p>")
    assert call(tab, "clickDoc", doc_of("2026-09-26", newest=True)) == {"ok": False, "why": SIGNED_OUT}
    assert pressed(tab) == []


# ---- Mobile list ---------------------------------------------------------

def mobile_site(tab, path="/billing", billing=MLINK + ILINK, mobile_list=MOBILE_LIST, walk="mobile"):
    load(tab, BASE + path, {"/billing": billing, "/billing/mobile-statements": mobile_list, PAGE: SEP}, mobile={
        "m-q1": mobile_statement("SEPTEMBER 13, 2026"), "m-q2": mobile_statement("AUGUST 13, 2026")})
    if walk:
        tab.evaluate("(at) => sessionStorage.setItem('__sweepSpectrumWalk', JSON.stringify({at, t: Date.now()}))", walk)


def test_the_mobile_walk_presses_the_mobile_link_then_lists_finished_statements(tab):
    mobile_site(tab)
    assert read(tab, walk=True) == {"state": "walking"}
    assert pressed(tab) == ["mobile-link"]
    assert read(tab, walk=True) == {"state": "ok", "docs": [
        {"id": "mobile:2026-09-13", "date": "2026-09-13", "title": "Mobile Statement", "method": "print"},
        {"id": "mobile:2026-08-13", "date": "2026-08-13", "title": "Mobile Statement", "method": "print"},
    ]}
    assert pressed(tab) == ["mobile-link"]


def test_billing_with_no_mobile_account_lists_none(tab):
    mobile_site(tab, billing=ILINK)
    assert read(tab, walk=True) == {"state": "ok", "docs": []}
    assert pressed(tab) == []


@pytest.mark.parametrize("billing", [
    MLINK.replace('href="javascript:void(0)"', 'href="/billing/mobile-statements"'),
    MLINK + MLINK.replace("55501", "55509"),
    '<a role="link" href="javascript:void(0)">Mobile Account Number: see below</a>' + ILINK,
])
def test_a_mobile_link_not_as_seen_is_not_pressed(tab, billing):
    mobile_site(tab, billing=billing)
    assert read(tab, walk=True)["state"] == "stopped"
    assert pressed(tab) == []


@pytest.mark.parametrize("bad", [
    '<a role="link" href="javascript:void(0)">Statement Aug 13, 2026</a>',
    mrow("2026-09-13", "September 13, 2026"),
])
def test_a_mobile_list_not_as_seen_stops(tab, bad):
    mobile_site(tab, path="/billing/mobile-statements", mobile_list=MOBILE_LIST + bad)
    assert read(tab, walk=True)["state"] == "stopped"


def test_mobile_pages_outside_a_walk_are_not_the_list(tab):
    mobile_site(tab, path="/billing/mobile-statements", walk=None)
    assert read(tab, walk=True) == {"state": "no_list"}


# ---- Mobile print --------------------------------------------------------

def test_a_mobile_statement_is_shown_expanded_once_and_left_for_billing(tab):
    mobile_site(tab, path="/billing/mobile-statements", walk=None)
    assert call(tab, "showDoc", mdoc("2026-08-13")) == {"ok": True}
    assert "/mobile-billing/statement-history?statementId=m-q2" in tab.url
    assert call(tab, "printReady", mdoc("2026-08-13")) == {"ready": True}
    assert tab.evaluate("document.querySelectorAll('.kite-accordion-row__button[aria-expanded=true]').length") == 6
    assert call(tab, "printReady", mdoc("2026-08-13")) == {"ready": True}
    assert pressed(tab) == ["mrow:2026-08-13", "expand"]
    assert call(tab, "leaveDoc", mdoc("2026-08-13")) == {"ok": True}
    tab.wait_for_url(BASE + "/billing")
    recipe(tab)
    # From Billing, the next one goes through the Mobile link, as PaperPull does.
    assert call(tab, "showDoc", mdoc("2026-09-13")) == {"ok": True}
    assert pressed(tab) == ["mobile-link", "mrow:2026-09-13"]
    assert call(tab, "printReady", mdoc("2026-09-13")) == {"ready": True}


def test_print_ready_waits_for_its_page_and_refuses_another_dates(tab):
    mobile_site(tab, path="/billing/mobile-statements", walk=None)
    assert call(tab, "printReady", mdoc("2026-08-13"))["ready"] is False
    tab.evaluate("go('/mobile-billing/statement-history?statementId=m-q1')")
    got = call(tab, "printReady", mdoc("2026-08-13"))
    assert got["ok"] is False and "date" in got["why"]
    assert "expand" not in pressed(tab)


def test_a_page_showing_another_date_before_expanding_is_refused(tab):
    load(tab, BASE + "/mobile-billing/statement-history?statementId=m-q2", {}, mobile={
        "m-q2": mobile_statement("AUGUST 13, 2026", extra="<p>JULY 13, 2026</p>")})
    got = call(tab, "printReady", mdoc("2026-08-13"))
    assert got["ok"] is False and "another date" in got["why"]
    assert pressed(tab) == []


def test_a_page_with_too_few_sections_is_not_ready_and_not_pressed(tab):
    page = mobile_statement("AUGUST 13, 2026").replace('id="accord-6-button-0"', 'id="other"')
    load(tab, BASE + "/mobile-billing/statement-history?statementId=m-q2", {}, mobile={"m-q2": page})
    assert call(tab, "printReady", mdoc("2026-08-13"))["ready"] is False
    assert pressed(tab) == []


def test_one_page_for_two_dates_is_refused(tab):
    load(tab, BASE + "/mobile-billing/statement-history?statementId=m-q2", {}, mobile={
        "m-q2": mobile_statement("AUGUST 13, 2026")})
    assert call(tab, "printReady", mdoc("2026-08-13")) == {"ready": True}
    tab.evaluate("document.querySelector('h2').textContent = 'JULY 13, 2026';"
                 "for (const b of document.querySelectorAll('.kite-accordion-row__button')) b.setAttribute('aria-expanded', 'false');"
                 "document.querySelector('.kite-button').textContent = 'Expand All'")
    got = call(tab, "printReady", mdoc("2026-07-13"))
    assert got["ok"] is False and "another date" in got["why"]
    assert pressed(tab) == ["expand"]


def test_a_mobile_row_with_an_address_of_its_own_is_not_pressed(tab):
    bad = mrow("2026-08-13", "August 13, 2026", href="/mobile-billing/statement-history?statementId=m-q2")
    mobile_site(tab, path="/billing/mobile-statements", walk=None, mobile_list=MOBILE_LIST.replace(AUG_MROW, bad))
    got = call(tab, "showDoc", mdoc("2026-08-13"))
    assert got["ok"] is False and "somewhere of its own" in got["why"]
    assert pressed(tab) == []


def test_show_doc_from_elsewhere_goes_back_to_billing(tab):
    statements(tab, SEP)
    got = call(tab, "showDoc", mdoc("2026-08-13"))
    assert got["ok"] is False and "went back to Billing" in got["why"]
    tab.wait_for_url(BASE + "/billing")
    recipe(tab)
    assert call(tab, "showDoc", doc_of("2026-09-26"))["ok"] is False
    assert call(tab, "printReady", doc_of("2026-09-26"))["ok"] is False


def test_print_ready_while_signed_out_gives_up(tab):
    load(tab, BASE + "/mobile-billing/statement-history?statementId=m-q2", {}, mobile={
        "m-q2": mobile_statement("AUGUST 13, 2026") + "<p>Your session has expired</p>"})
    assert call(tab, "printReady", mdoc("2026-08-13")) == {"ok": False, "why": SIGNED_OUT}
    assert pressed(tab) == []


@pytest.mark.parametrize("href", ["unsafe:javascript:void(0);", "javascript:void(0);", ""])
def test_angulars_sanitized_do_nothing_link_counts_as_leading_nowhere(tab, href):
    # Live, every row's href reads "unsafe:javascript:void(0);" (Angular's sanitizer).
    statements(tab, internet_row("2026-09-26", "September 26, 2026", href=href))
    got = read(tab)
    assert [d["date"] for d in got["docs"]] == ["2026-09-26"]


def test_the_newest_rows_payment_due_note_does_not_refuse_it(tab):
    # Live: "Statement October 26, 2026 Payment Due: Nov 12 $80.00".
    newest = row("Statement October 26, 2026 Payment Due: Nov 12 $80.00", to=detail("2026-10-26"), tag="2026-10-26")
    statements(tab, newest, SEP)
    got = read(tab)
    assert [d["date"] for d in got["docs"]] == ["2026-10-26", "2026-09-26"]


@pytest.mark.parametrize("words", ["Statement October 26, 2026 Pay Now $80.00", "Statement October 26, 2026 Payment Due: Nov 12 $80.00 Pay now"])
def test_other_payment_words_still_refuse_a_row(tab, words):
    statements(tab, row(words, to=detail("2026-10-26"), tag="2026-10-26"), SEP)
    assert [d["date"] for d in read(tab)["docs"]] == ["2026-09-26"]


def test_the_newest_statement_opens_as_the_next_bill_and_is_printed(tab):
    # Live: the newest row opens bill-details with isNextBill=true.
    newest = row("Statement October 26, 2026 Payment Due: Nov 12 $80.00", to=detail("2026-10-26", next_bill=True), tag="2026-10-26")
    statements(tab, newest, SEP)
    got = call(tab, "clickDoc", doc_of("2026-10-26"))
    assert got["ok"] is True

