"""The Chase page logic, in a real Chromium, on stand-in pages. Every card and
date is invented."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CENTER = "https://secure.chase.com/web/auth/dashboard#/dashboard/documents/myDocs/index"
RESERVE = "SAPPHIRE RESERVE (...1234)"
SOUTHWEST = "SOUTHWEST RAPID REWARDS PLUS (...5678)"
PICKER = '<input id="header-filterstyledselect-0" value="2026">'
ONE_YEAR = PICKER + '<div role="option">2026</div>'


def card(label, open_=True):
    return f'<button aria-expanded="{"true" if open_ else "false"}">{label}</button>'


def row(date, label=RESERVE, kind="Statement", id_=""):
    return f'<a href="#" class="row" id="{id_}">{date} {kind} {label} Saves document</a>'


def center(cards, rows, picker=ONE_YEAR):
    return f"<main>{picker}{cards}<div>{rows}</div></main>" + """<script>
    window.pressed = [];
    document.addEventListener('click', (e) => { const a = e.target.closest('a'); if (a) { e.preventDefault(); pressed.push(a.id); } });
    </script>"""


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, url, body):
    tab.goto("about:blank")
    tab.unroute("**/*")
    tab.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body}"))
    tab.goto(url)
    source = (ROOT / "providers" / "chase.page.js").read_text().replace("DRAW_WAIT_MS = 30000", "DRAW_WAIT_MS = 300")
    tab.add_script_tag(content=source)


def read(tab):
    return tab.evaluate("__sweep.readList()")


DOCS_URL = "https://secure.chase.com/web/auth/dashboard#/dashboard/documents/myDocs/index"


def test_a_sign_in_drawn_in_a_frame_over_the_documents_address_is_known(tab):
    load(tab, DOCS_URL, "<iframe name='logonbox' src='about:blank' style='width:400px;height:400px'></iframe>")
    assert read(tab) == {"state": "signed_out"}


def test_a_hidden_sign_in_frame_is_not_a_sign_in(tab):
    load(tab, DOCS_URL, "<iframe name='logonbox' src='about:blank' style='display:none'></iframe>")
    assert read(tab)["state"] == "stopped"


def test_a_sign_in_address_is_known(tab):
    load(tab, "https://secure.chase.com/web/auth/#/logon/logon/chaseOnline", "<h1>Welcome</h1>")
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_known(tab):
    load(tab, CENTER, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_is_known(tab):
    load(tab, CENTER, "<p>Enter the code we sent to your phone.</p>")
    assert read(tab) == {"state": "challenge"}


def test_a_session_that_ended_is_a_sign_in(tab):
    load(tab, CENTER, "<p>For your security, we signed you out.</p>")
    assert read(tab) == {"state": "signed_out"}


def test_good_rows_come_newest_first_with_their_dates(tab):
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026") + row("Sep 09, 2026") + row("Jul 09, 2026")))
    got = read(tab)
    assert got["state"] == "ok"
    assert [d["date"] for d in got["docs"]] == ["2026-09-09", "2026-08-09", "2026-07-09"]
    assert got["docs"][0] == {"id": f"2026-09-09|Statement|{RESERVE}", "date": "2026-09-09", "title": RESERVE, "method": "click"}


def test_a_card_named_rewards_is_a_card_and_is_read(tab):
    load(tab, CENTER, center(card(SOUTHWEST), row("Aug 09, 2026", SOUTHWEST)))
    assert read(tab)["state"] == "ok"


def test_rows_of_a_closed_card_are_not_read_and_the_list_stops(tab):
    load(tab, CENTER, center(card(RESERVE) + card(SOUTHWEST, False),
                             row("Aug 09, 2026") + row("Aug 15, 2026", SOUTHWEST)))
    got = read(tab)
    assert got["state"] == "stopped" and "other 1" in got["why"]
    assert [d["date"] for d in got["docs"]] == ["2026-08-09"]


def test_a_view_with_no_rows_is_not_called_empty(tab):
    load(tab, CENTER, center(card(RESERVE), ""))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


def test_a_picker_whose_years_are_not_drawn_stops_with_the_rows_on_screen(tab):
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026"), picker=PICKER))
    got = read(tab)
    assert got["state"] == "stopped" and "2026" in got["why"] and "View picker" in got["why"]
    assert [d["date"] for d in got["docs"]] == ["2026-08-09"]


def test_a_picker_offering_older_years_stops_with_the_rows_on_screen(tab):
    picker = PICKER + '<div role="option">2026, current selection</div><div role="option">2025, you\'ve reached the end of the list</div>'
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026"), picker=picker))
    got = read(tab)
    assert got["state"] == "stopped" and "View picker" in got["why"]
    assert [d["date"] for d in got["docs"]] == ["2026-08-09"]


def test_a_year_named_only_in_an_options_label_counts(tab):
    picker = PICKER + '<div role="option" aria-label="2026, current selection"></div><div role="option" aria-label="2025"></div>'
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026"), picker=picker))
    assert read(tab)["state"] == "stopped"


def test_a_picker_offering_only_some_other_year_stops(tab):
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026"), picker=PICKER + '<div role="option">2025</div>'))
    assert read(tab)["state"] == "stopped"


def test_one_year_offered_as_the_current_selection_is_whole(tab):
    picker = PICKER + '<div role="option">2026, current selection</div>'
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026"), picker=picker))
    assert read(tab)["state"] == "ok"


def test_no_card_open_stops(tab):
    load(tab, CENTER, center(card(RESERVE, False), row("Aug 09, 2026")))
    assert read(tab)["state"] == "stopped"


def test_a_date_that_is_not_a_day_stops(tab):
    load(tab, CENTER, center(card(RESERVE), row("Feb 31, 2026")))
    assert read(tab)["state"] == "stopped"


def test_a_year_end_row_is_left_alone(tab):
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026") + row("Dec 31, 2025", kind="Year-End Summary")))
    assert [d["date"] for d in read(tab)["docs"]] == ["2026-08-09"]


@pytest.mark.parametrize("tail", ["&documentType=TAX_DOCUMENTS", "&documentType=YEAR_END_STATEMENTS"])
def test_another_tab_of_the_center_is_not_the_list(tab, tail):
    load(tab, CENTER + tail, center(card(RESERVE), row("Aug 09, 2026")))
    assert read(tab) == {"state": "no_list"}


def test_the_dashboard_is_not_the_list_yet(tab):
    load(tab, "https://secure.chase.com/web/auth/dashboard", "<h1>Accounts</h1>")
    assert read(tab) == {"state": "no_list"}


def test_a_center_that_never_draws_stops(tab):
    load(tab, CENTER, "<h1>Accounts</h1>")
    assert read(tab)["state"] == "stopped"


def test_a_picker_of_something_else_is_not_the_center(tab):
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026"), picker='<input id="x-filterstyledselect" value="All">'))
    assert read(tab)["state"] == "stopped"


def test_the_press_lands_on_its_own_row_only(tab):
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026", id_="a") + row("Sep 09, 2026", id_="b")))
    got = tab.evaluate(f"__sweep.clickDoc({{id: '2026-08-09|Statement|{RESERVE}'}})")
    assert got == {"ok": True}
    assert tab.evaluate("pressed") == ["a"]


def test_a_row_not_on_the_page_is_not_pressed(tab):
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026", id_="a")))
    got = tab.evaluate(f"__sweep.clickDoc({{id: '2031-01-01|Statement|{RESERVE}'}})")
    assert got["ok"] is False and tab.evaluate("pressed") == []


def test_a_row_naming_an_action_is_refused(tab):
    bad = "PAY CARD (...1234)"
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026", bad, id_="a")))
    assert tab.evaluate(f"__sweep.clickDoc({{id: '2026-08-09|Statement|{bad}'}})")["ok"] is False
    assert tab.evaluate("pressed") == []
