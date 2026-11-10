"""The TreasuryDirect page logic, in a real Chromium, on stand-in pages."""
from datetime import date
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "providers" / "treasurydirect.page.js").read_text()
HOST = "https://www.treasurydirect.gov"
UNAVAILABLE = "<html><head><title>TreasuryDirect is unavailable.</title></head><body><h1>TreasuryDirect is unavailable.</h1></body></html>"
OTP = '<html><body><h1>One-time passcode</h1><p>Enter the code we sent</p><input type="text" name="otp"></body></html>'
TODAY = date.today().isoformat()


def addr(handler):
    return f"/RS/RSGatewayRW?UIHandler={handler}&primary=true&processID=111&uiFrom=misc.DisplayWelcome"


def link(handler, label, extra=""):
    return (f'<a {extra} href="/RS/RSGatewayRW?uiFrom=misc.DisplayWelcome&amp;primary=true&amp;processID=111'
            f'&amp;fromTabLink=true&amp;UIHandler={handler}">{label}</a> ')


TABS = (link("misc.DisplayWelcome", "My Account") + link("ch.DisplayCurrentHoldings", "Current Holdings")
        + link("md.DisplayManageDirect", "ManageDirect&reg;") + link("hist.DisplayHistory", "History"))
NO_TAX = "<h4>Manage My Taxes</h4><ul><li>Year 2025 (No taxable transactions)</li></ul>"
HISTORY = link("sechist.DisplaySecurityHistory", "Security History") + link("payhist.DisplayPaymentHistorySummary", "Payment History")


def signed_in(body="", h1="Welcome to your account summary", account="A-123-456-789", tabs=TABS):
    return (f'<html><body>{tabs}<p>Pat Example\'s account: {account}</p><h1>{h1}</h1>{body}'
            '<input type="text" name="iesinglesubmithack"></body></html>')


def site(**over):
    pages = {
        "misc.DisplayWelcome": signed_in(),
        "md.DisplayManageDirect": signed_in(NO_TAX, "ManageDirect&reg;"),
        "ch.DisplayCurrentHoldings": signed_in("<p>Series EE</p>", "Current Holdings"),
        "hist.DisplayHistory": signed_in(HISTORY, "History"),
        "sechist.DisplaySecurityHistory": signed_in("<p>Bought</p>", "History &raquo; Security History"),
        "payhist.DisplayPaymentHistorySummary": signed_in("<p>Paid</p>", "History &raquo; Payment History"),
    }
    pages.update(over)
    return pages


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def inject(tab):
    tab.add_script_tag(content=SOURCE)


def serve(tab, pages, log):
    def respond(route):
        url, req = route.request.url, route.request
        if not url.startswith(HOST):
            return route.abort()
        handler = ""
        if "UIHandler=" in url:
            handler = url.split("UIHandler=")[1].split("&")[0]
        log.append((req.method, handler))
        body = pages.get(handler, pages.get("", "<h1>Not here</h1>"))
        route.fulfill(status=200, content_type="text/html; charset=utf-8", body=f"<!doctype html>{body}")
    tab.unroute("**/*")
    tab.route("**/*", respond)


def load(tab, path, pages, log=None):
    """Opens `path` on stand-in pages ({handler: html}); returns the request log."""
    log = [] if log is None else log
    if isinstance(pages, str):
        pages = {"": pages, path.split("UIHandler=")[1].split("&")[0] if "UIHandler=" in path else "": pages}
    serve(tab, pages, log)
    tab.goto(HOST + path)
    tab.evaluate("sessionStorage.clear()")
    inject(tab)
    log.clear()
    return log


def moved(tab, call, arg=None):
    """Runs `call`, which presses a link, and waits for the page it opens."""
    with tab.expect_navigation():
        got = tab.evaluate(call, arg)
    inject(tab)
    return got


def read(tab, walk=False):
    return tab.evaluate("(w) => __sweep.readList({walk: w})", walk)


def listed(tab):
    """The docs as listed from ManageDirect, the way a sweep reads them."""
    load(tab, addr("misc.DisplayWelcome"), site())
    assert moved(tab, "() => __sweep.readList({walk: true})") == {"state": "walking"}
    got = read(tab, True)
    assert got["state"] == "ok"
    return got["docs"]


# Signed out, challenges, and where the tab is.

def test_the_sign_in_address_is_known(tab):
    load(tab, "/RS/UN-Display.do", "<p>Account number</p>")
    assert read(tab) == {"state": "signed_out"}


def test_an_ended_session_is_known(tab):
    load(tab, addr("misc.DisplayWelcome"), UNAVAILABLE)
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_known(tab):
    load(tab, addr("misc.DisplayWelcome"), "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_passcode_page_waits_for_the_person(tab):
    load(tab, addr("misc.DisplayWelcome"), OTP)
    assert read(tab) == {"state": "challenge"}


def test_a_signed_in_page_with_a_retirement_notice_is_not_a_passcode_page(tab):
    load(tab, addr("misc.DisplayWelcome"), signed_in("<p>Your security questions will be retired.</p>"))
    assert read(tab)["state"] == "ready"


def test_it_never_answers_no_list(tab):
    for path, body in [(addr("misc.DisplayWelcome"), signed_in()), (addr("misc.DisplayWelcome"), "<h1>Something else</h1>"),
                       ("/indiv/help/", "<h1>Help</h1>")]:
        for walk in (False, True):
            load(tab, path, body)
            tab.evaluate("document.querySelectorAll('a').forEach(a => a.addEventListener('click', e => e.preventDefault()))")
            assert read(tab, walk)["state"] != "no_list", path


def test_a_page_on_the_address_without_its_tabs_stops(tab):
    load(tab, addr("misc.DisplayWelcome"), "<h1>Something else</h1>")
    assert read(tab)["state"] == "stopped"


def test_a_page_off_the_signed_in_address_stops(tab):
    load(tab, "/indiv/help/", signed_in())
    got = read(tab, True)
    assert got["state"] == "stopped" and got["docs"] == []


# The list.

def test_a_signed_in_tab_of_yours_asks_to_be_carried_on_in_and_is_not_pressed(tab):
    # A second TreasuryDirect tab would end this sign-in, so the recipe answers
    # "ready" and the engine takes this tab over. Nothing is pressed until then.
    log = load(tab, addr("misc.DisplayWelcome"), site())
    got = read(tab, False)
    assert got["state"] == "ready" and "docs" not in got
    tab.wait_for_timeout(300)
    assert log == []


def test_a_walk_presses_managedirect_and_lists_todays_three_pages(tab):
    log = load(tab, addr("misc.DisplayWelcome"), site())
    assert moved(tab, "() => __sweep.readList({walk: true})") == {"state": "walking"}
    assert log == [("GET", "md.DisplayManageDirect")]
    got = read(tab, True)
    assert got["state"] == "ok" and "note" not in got
    account = got["docs"][0]["account"]
    assert len(account) == 12 and "123456789" not in account
    assert got["docs"] == [
        {"id": f"holdings-{TODAY}", "date": TODAY, "title": "Current Holdings", "method": "print", "account": account},
        {"id": f"security-history-{TODAY}", "date": TODAY, "title": "Security History", "method": "print", "account": account},
        {"id": f"payment-history-{TODAY}", "date": TODAY, "title": "Payment History", "method": "print", "account": account},
    ]


def test_a_tab_already_on_managedirect_is_read_without_a_press(tab):
    log = load(tab, addr("md.DisplayManageDirect"), site())
    got = read(tab, False)
    assert got["state"] == "ok" and len(got["docs"]) == 3 and log == []


def test_a_press_in_flight_is_not_made_twice(tab):
    log = load(tab, addr("misc.DisplayWelcome"), site())
    tab.evaluate("document.querySelectorAll('a').forEach(a => a.addEventListener('click', e => e.preventDefault()))")
    tab.evaluate("window.clicks = 0; document.querySelectorAll('a').forEach(a => a.addEventListener('click', () => window.clicks++))")
    assert read(tab, True) == {"state": "walking"}
    assert read(tab, True) == {"state": "walking"}
    assert tab.evaluate("window.clicks") == 1 and log == []


def test_a_taxable_year_is_named_for_saving_by_hand(tab):
    taxes = ("<h4>Manage My Taxes</h4><ul><li>Year 2024 (No taxable transactions)</li>"
             f"<li>{link('tax.DisplayYear', 'Year 2025')}</li></ul>")
    log = load(tab, addr("md.DisplayManageDirect"), site(**{"md.DisplayManageDirect": signed_in(taxes, "ManageDirect&reg;")}))
    got = read(tab)
    assert got["state"] == "ok" and "2025" in got["note"] and "2024" not in got["note"]
    assert [d["id"] for d in got["docs"]] == [f"holdings-{TODAY}", f"security-history-{TODAY}", f"payment-history-{TODAY}"]
    assert log == []


@pytest.mark.parametrize("taxes", [
    "<h4>Something</h4><ul><li>Year 2025 (No taxable transactions)</li></ul>",
    "<h4>Manage My Taxes</h4><p>Nothing</p>",
    "<h4>Manage My Taxes</h4><ul><li>Taxes are hard</li></ul>",
    "<h4>Manage My Taxes</h4><ul><li><a href='/x'>Year 2025</a></li></ul>",
    f"<h4>Manage My Taxes</h4><ul><li>{link('tax.DisplayYear', 'Year 2025')}</li><li>{link('tax.DisplayYear', 'Year 2025')}</li></ul>",
    f"<h4>Manage My Taxes</h4><ul><li>{link('ac.TransferYear', 'Year 2025')}</li></ul>",
])
def test_a_tax_list_that_does_not_read_stops_with_the_pages_still_listed(tab, taxes):
    load(tab, addr("md.DisplayManageDirect"), site(**{"md.DisplayManageDirect": signed_in(taxes, "ManageDirect&reg;")}))
    got = read(tab)
    assert got["state"] == "stopped" and len(got["docs"]) == 3 and got["why"]


def test_a_page_naming_two_accounts_stops(tab):
    body = signed_in("<p>Lee Example's account: B-987-654-321</p>", "ManageDirect&reg;")
    load(tab, addr("md.DisplayManageDirect"), site(**{"md.DisplayManageDirect": body}))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


def test_several_accounts_and_none_named_stops(tab):
    body = (f"<html><body>{TABS}{link('al.DisplayMultiAccount', 'Return To Account Listing')}<h1>ManageDirect&reg;</h1>{NO_TAX}</body></html>")
    load(tab, addr("md.DisplayManageDirect"), site(**{"md.DisplayManageDirect": body}))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == [] and "several" in got["why"]


def test_managedirect_of_another_account_stops(tab):
    load(tab, addr("misc.DisplayWelcome"), site(**{"md.DisplayManageDirect": signed_in(NO_TAX, "ManageDirect&reg;", "B-987-654-321")}))
    moved(tab, "() => __sweep.readList({walk: true})")
    got = read(tab, True)
    assert got["state"] == "stopped" and got["docs"] == []


def test_a_managedirect_press_that_lands_elsewhere_stops(tab):
    load(tab, addr("misc.DisplayWelcome"), site(**{"md.DisplayManageDirect": signed_in("", "Welcome to your account summary")}))
    moved(tab, "() => __sweep.readList({walk: true})")
    got = read(tab, True)
    assert got["state"] == "stopped" and len(got["docs"]) == 3


# Showing, printing and leaving a document, only by the page's own links.

def test_current_holdings_is_shown_by_its_tab_and_ready_there(tab):
    docs = listed(tab)
    log = []
    serve(tab, site(), log)
    assert moved(tab, "(d) => __sweep.showDoc(d)", docs[0]) == {"ok": True}
    assert log == [("GET", "ch.DisplayCurrentHoldings")]
    assert tab.evaluate("(d) => __sweep.printReady(d)", docs[0]) == {"ready": True}


def test_a_history_is_shown_by_history_then_its_own_link(tab):
    docs = listed(tab)
    log = []
    serve(tab, site(), log)
    assert moved(tab, "(d) => __sweep.showDoc(d)", docs[1]) == {"ok": True}
    assert moved(tab, "(d) => __sweep.printReady(d)", docs[1]) == {"ready": False}
    assert tab.evaluate("(d) => __sweep.printReady(d)", docs[1]) == {"ready": True}
    assert log == [("GET", "hist.DisplayHistory"), ("GET", "sechist.DisplaySecurityHistory")]


def test_payment_history_from_the_history_page_is_one_press(tab):
    docs = listed(tab)
    log = load(tab, addr("hist.DisplayHistory"), site())
    assert moved(tab, "(d) => __sweep.showDoc(d)", docs[2]) == {"ok": True}
    assert tab.evaluate("(d) => __sweep.printReady(d)", docs[2]) == {"ready": True}
    assert log == [("GET", "payhist.DisplayPaymentHistorySummary")]


def test_a_document_already_on_screen_is_not_pressed(tab):
    docs = listed(tab)
    log = load(tab, addr("ch.DisplayCurrentHoldings"), site())
    assert tab.evaluate("(d) => __sweep.showDoc(d)", docs[0]) == {"ok": True}
    assert tab.evaluate("(d) => __sweep.printReady(d)", docs[0]) == {"ready": True}
    assert log == []


def test_ready_waits_while_its_press_is_in_flight(tab):
    docs = listed(tab)
    load(tab, addr("md.DisplayManageDirect"), site())
    tab.evaluate("document.querySelectorAll('a').forEach(a => a.addEventListener('click', e => e.preventDefault()))")
    assert tab.evaluate("(d) => __sweep.showDoc(d)", docs[0]) == {"ok": True}
    got = tab.evaluate("(d) => __sweep.printReady(d)", docs[0])
    assert got["ready"] is False


def test_a_page_other_than_the_one_meant_is_not_printed(tab):
    docs = listed(tab)
    load(tab, addr("hist.DisplayHistory"), site())
    got = tab.evaluate("(d) => __sweep.printReady(d)", docs[0])
    assert got["ok"] is False and "other than" in got["why"]


def test_a_history_page_is_not_pressed_on_from_without_its_own_press(tab):
    docs = listed(tab)
    log = load(tab, addr("hist.DisplayHistory"), site())
    got = tab.evaluate("(d) => __sweep.printReady(d)", docs[1])
    assert got["ok"] is False and log == []


def test_another_account_is_not_printed(tab):
    docs = listed(tab)
    other = {**docs[0], "account": "000000000000"}
    log = load(tab, addr("ch.DisplayCurrentHoldings"), site())
    assert tab.evaluate("(d) => __sweep.printReady(d)", other)["ok"] is False
    assert tab.evaluate("(d) => __sweep.showDoc(d)", other)["ok"] is False
    assert log == []


def test_a_signed_out_page_is_not_printed(tab):
    docs = listed(tab)
    load(tab, addr("ch.DisplayCurrentHoldings"), UNAVAILABLE)
    assert tab.evaluate("(d) => __sweep.printReady(d)", docs[0])["ok"] is False
    assert tab.evaluate("(d) => __sweep.showDoc(d)", docs[0])["ok"] is False


@pytest.mark.parametrize("doc", [
    {"id": "holdings-2020-01-02", "date": "2020-01-02", "title": "Current Holdings", "method": "print", "account": ""},
    {"id": f"1099-{TODAY}", "date": TODAY, "method": "print", "account": ""},
    {"id": f"holdings-{TODAY}", "date": "2020-01-02", "method": "print", "account": ""},
    {"id": f"holdings-{TODAY}", "date": TODAY, "method": "click", "account": ""},
])
def test_a_doc_it_did_not_list_today_is_refused(tab, doc):
    log = load(tab, addr("misc.DisplayWelcome"), site())
    assert tab.evaluate("(d) => __sweep.showDoc(d)", doc)["ok"] is False
    assert tab.evaluate("(d) => __sweep.printReady(d)", doc)["ok"] is False
    assert log == []


def test_leaving_presses_my_account(tab):
    docs = listed(tab)
    log = load(tab, addr("ch.DisplayCurrentHoldings"), site())
    with tab.expect_navigation():
        tab.evaluate("(d) => { __sweep.leaveDoc(d); return true; }", docs[0])
    assert log == [("GET", "misc.DisplayWelcome")]
    inject(tab)
    assert tab.evaluate("(d) => __sweep.leaveDoc(d)", docs[0]) == {"ok": True, "stayed": True}


def test_leaving_a_signed_out_page_presses_nothing(tab):
    docs = listed(tab)
    log = load(tab, addr("ch.DisplayCurrentHoldings"), UNAVAILABLE)
    got = tab.evaluate("(d) => __sweep.leaveDoc(d)", docs[0])
    assert got["stayed"] is True and got["ok"] is False and log == []


# Refusals: only the one link meant, shown, on the signed-in pages.

def with_holdings_link(extra="", href=None, twice=False):
    holdings = link("ch.DisplayCurrentHoldings", "Current Holdings", extra)
    if href:
        holdings = f'<a href="{href}">Current Holdings</a> '
    tabs = (link("misc.DisplayWelcome", "My Account") + holdings + (holdings if twice else "")
            + link("md.DisplayManageDirect", "ManageDirect&reg;") + link("hist.DisplayHistory", "History"))
    return signed_in("", "Welcome to your account summary", tabs=tabs)


@pytest.mark.parametrize("page", [
    with_holdings_link(twice=True),
    with_holdings_link(extra='target="_blank"'),
    with_holdings_link(href="https://www.treasurydirect.gov/indiv/help/?UIHandler=ch.DisplayCurrentHoldings"),
    with_holdings_link(href="https://treasurydirect.gov/RS/RSGatewayRW?UIHandler=ch.DisplayCurrentHoldings"),
    with_holdings_link(extra='style="display:none"'),
    with_holdings_link() + '<div style="position:fixed;inset:0;background:white"></div>',
])
def test_a_link_that_is_not_the_one_meant_is_not_pressed(tab, page):
    docs = listed(tab)
    log = load(tab, addr("misc.DisplayWelcome"), site(**{"misc.DisplayWelcome": page}))
    tab.evaluate("window.clicks = 0; document.addEventListener('click', () => window.clicks++, true)")
    got = tab.evaluate("(d) => __sweep.showDoc(d)", docs[0])
    assert got["ok"] is False and got["why"]
    tab.wait_for_timeout(200)
    assert tab.evaluate("window.clicks") == 0 and log == []


def test_it_never_opens_an_address_or_submits_a_form():
    for banned in ("location.assign", "location.replace", "location.href =", "location =", ".submit(", "requestSubmit",
                   "fetch(", "XMLHttpRequest", "window.open", "history.back", "history.go", "location.reload"):
        assert banned not in SOURCE, banned


def test_what_it_offers(tab):
    load(tab, addr("misc.DisplayWelcome"), signed_in())
    assert sorted(tab.evaluate("Object.keys(__sweep)")) == ["leaveDoc", "printReady", "readList", "showDoc"]
