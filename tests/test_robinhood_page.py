"""The Robinhood page logic, in a real Chromium, on stand-in pages."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://robinhood.com"
PAGE = "/account/reports-statements/individual"
TAX = "/account/reports-statements/tax"
JAN = "January 2026 – Individual Investing Account Statement"
FEB = "February 2026 – Individual Investing Account Statement"
SCRIPT = "<script>window.pressed=[];function press(e){pressed.push(e.closest('[data-t]').dataset.t)}</script>"


def link(title):
    return f'<div data-t="{title}"><a download href="#" onclick="press(this);return false">{title}</a></div>'


def button(title, label="Download PDF"):
    return f'<div data-t="{title}"><div>{title}</div><a href="#" onclick="press(this);return false">{label}</a></div>'


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, body, path=PAGE, clear=True):
    def respond(route):
        if route.request.url.startswith(BASE):
            route.fulfill(status=200, content_type="text/html; charset=utf-8",
                          body=f"<!doctype html><title>Robinhood</title>{body}{SCRIPT}")
        else:
            route.abort()
    tab.unroute("**/*")
    tab.route("**/*", respond)
    tab.goto(BASE + path)
    if clear:
        tab.evaluate("sessionStorage.clear()")
    tab.add_script_tag(content=(ROOT / "providers" / "robinhood.page.js").read_text())


def read(tab, walk=False):
    return tab.evaluate("(w) => __sweep.readList({walk: w})", walk)


def test_statements_are_listed_newest_first_dated_by_the_end_of_their_month(tab):
    load(tab, f"<main>{link(JAN)}{link(FEB)}</main>")
    assert read(tab) == {"state": "ok", "docs": [
        {"id": FEB, "date": "2026-02-28", "title": "Account Statement", "method": "newtab"},
        {"id": JAN, "date": "2026-01-31", "title": "Account Statement", "method": "newtab"},
    ]}


def test_a_download_pdf_button_takes_its_title_from_around_it(tab):
    load(tab, f"<main>{button(FEB)}</main>")
    assert read(tab)["docs"][0]["id"] == FEB


def test_a_csv_is_not_listed(tab):
    load(tab, f"<main>{link(FEB)}<button>Download CSV</button></main>")
    got = read(tab)
    assert got["state"] == "ok" and len(got["docs"]) == 1


def test_signed_out_by_address_and_password_field(tab):
    load(tab, "", path="/login")
    assert read(tab) == {"state": "signed_out"}
    load(tab, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_is_a_challenge(tab):
    load(tab, "<main>Confirm your identity. We sent a code.</main>")
    assert read(tab) == {"state": "challenge"}


def test_another_page_is_not_the_list(tab):
    load(tab, "<main>Account</main>", path="/account/settings")
    assert read(tab) == {"state": "no_list"}


def test_a_statement_with_no_date_stops_and_keeps_the_rest(tab):
    load(tab, f"<main>{link(FEB)}{button('Consolidated Form 1099')}</main>")
    got = read(tab)
    assert got["state"] == "stopped" and [d["id"] for d in got["docs"]] == [FEB]


def test_a_month_offered_only_as_html_is_left_out_and_said(tab):
    load(tab, f"<main>{link(FEB)}{button(JAN, 'Download HTML')}</main>")
    got = read(tab)
    assert got["state"] == "ok" and "web page" in got["note"] and [d["id"] for d in got["docs"]] == [FEB]


def test_view_more_stops_with_what_was_read(tab):
    load(tab, f"<main>{link(FEB)}<a href='#'>View More</a></main>")
    got = read(tab)
    assert got["state"] == "stopped" and "View More" in got["why"] and len(got["docs"]) == 1


def test_click_presses_only_its_own_statement(tab):
    load(tab, f"<main>{link(JAN)}{link(FEB)}</main>")
    doc = read(tab)["docs"][1]
    assert tab.evaluate("(d) => __sweep.clickDoc(d)", doc) == {"ok": True}
    assert tab.evaluate("pressed") == [JAN]


def test_a_document_that_cannot_be_bound_presses_nothing(tab):
    load(tab, f"<main>{link(JAN)}</main>")
    for doc in [{"id": "x", "title": "y", "date": "2026-01-31"},
                {"id": FEB, "title": FEB, "date": "2026-02-28"},
                {"id": JAN, "title": JAN, "date": "2026-02-28"}]:
        assert tab.evaluate("(d) => __sweep.clickDoc(d)", doc)["ok"] is False
    assert tab.evaluate("pressed") == []


def test_a_control_that_trips_the_blocklist_stops_and_is_not_pressed(tab):
    load(tab, f"<main>{button(FEB, 'Download PDF to transfer')}</main>")
    assert read(tab)["state"] == "stopped"
    doc = {"id": FEB, "title": FEB, "date": "2026-02-28"}
    assert tab.evaluate("(d) => __sweep.clickDoc(d)", doc)["ok"] is False
    assert tab.evaluate("pressed") == []


def test_each_account_and_tax_form_is_named_by_its_kind(tab):
    crypto = "March 2026 – Robinhood Crypto Account Statement"
    ira = "March 2026 – Consolidated IRA Statement"
    load(tab, f"<main>{link(crypto)}{link(ira)}</main>")
    assert {d["id"]: d["title"] for d in read(tab)["docs"]} == {
        crypto: "Crypto Statement", ira: "Retirement Account Statement"}


def test_a_tax_form_is_dated_by_the_tax_year_the_page_names(tab):
    form, ira = "Robinhood Markets Consolidated Form 1099", "Traditional IRA 5498"
    load(tab, f"<main><h2>Tax year 2025</h2>{button(form)}{button(ira)}</main>", path=TAX)
    assert read(tab) == {"state": "ok", "docs": [
        {"id": f"{form}|2025", "date": "2025-12-31", "title": "Consolidated 1099 Tax Form", "method": "newtab"},
        {"id": f"{ira}|2025", "date": "2025-12-31", "title": "5498 Tax Form", "method": "newtab"},
    ]}
    doc = read(tab)["docs"][1]
    assert tab.evaluate("(d) => __sweep.clickDoc(d)", doc) == {"ok": True}
    assert tab.evaluate("pressed") == [ira]


def test_only_the_chosen_year_tab_names_a_tax_year(tab):
    form = "Robinhood Markets Consolidated Form 1099"
    tabs = ('<div role="tablist"><button role="tab" aria-selected="false">Tax year 2025</button>'
            '<button role="tab" aria-selected="true">Tax year 2024</button></div>')
    load(tab, f"<main>{tabs}{button(form)}</main>", path=TAX)
    assert read(tab)["docs"][0]["date"] == "2024-12-31"


def test_a_tax_form_with_no_year_on_the_page_is_not_guessed(tab):
    load(tab, f"<main><h2>Tax documents</h2>{button('Robinhood Markets Consolidated Form 1099')}</main>", path=TAX)
    got = read(tab)
    assert got["state"] == "stopped" and "tax" in got["why"] and got["docs"] == []


def test_a_retirement_page_showing_one_title_twice_stops(tab):
    ira = "March 2026 – Consolidated IRA Statement"
    load(tab, f"<main>{link(ira)}{link(ira)}</main>", path="/account/reports-statements/retirement")
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


MORE = ("<a href='#' id=more onclick=\"document.querySelector('main').insertAdjacentHTML('beforeend', "
        "'<div data-t=&quot;{t}&quot;><a download href=&quot;#&quot;>{t}</a></div>'); this.remove(); return false\">View More</a>")


def test_a_walk_presses_view_more_until_the_list_is_whole(tab):
    load(tab, f"<main>{link(FEB)}</main>" + MORE.format(t=JAN))
    got = read(tab, walk=True)
    assert got["state"] == "ok" and got["more"] is True
    assert [d["id"] for d in got["docs"]] == [FEB, JAN]
    assert tab.evaluate("pressed") == []


def test_a_walk_goes_through_every_page_in_turn_and_ends(tab):
    load(tab, f"<main>{link(FEB)}</main>")
    assert read(tab, walk=True)["more"] is True
    assert tab.evaluate("__sweep.nextView()") == {"moved": True}
    assert read(tab, walk=True) == {"state": "walking"}
    tab.wait_for_url(BASE + "/account/reports-statements/retirement")
    for nxt in ["/account/reports-statements/crypto", TAX]:
        tab.add_script_tag(content=(ROOT / "providers" / "robinhood.page.js").read_text())
        assert tab.evaluate("__sweep.nextView()") == {"moved": True}
        tab.wait_for_url(BASE + nxt)
    tab.add_script_tag(content=(ROOT / "providers" / "robinhood.page.js").read_text())
    assert tab.evaluate("__sweep.nextView()") == {"moved": False}
    assert tab.evaluate("sessionStorage.length") == 0


def test_a_walk_in_a_tab_left_on_a_later_page_starts_at_the_first(tab):
    load(tab, f"<main>{link(FEB)}</main>", path="/account/reports-statements/crypto")
    assert read(tab, walk=True) == {"state": "walking"}
    tab.wait_for_url(BASE + PAGE)


def test_a_read_in_a_tab_of_yours_forgets_an_old_walk(tab):
    load(tab, f"<main>{link(FEB)}</main>")
    tab.evaluate("sessionStorage.setItem('__sweepRobinhoodWalk', JSON.stringify({at: 2, t: Date.now()}))")
    read(tab)
    assert tab.evaluate("sessionStorage.length") == 0
