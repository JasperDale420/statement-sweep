"""The Bilt page logic, in a real Chromium, on stand-in pages shaped like
PaperPull's. Three presses only: View balance summary, View statements, and
one statement's own button, which on the real site opens its PDF in a new tab
(method "newtab"). Every value here is invented."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://www.bilt.com"
CARD = "0a1b2c3d-1111-4222-8333-944455556666"
SCRIPT = """<script>
window.log = [];
function hit(name) { log.push(name); }
function openSummary() { hit('summary'); document.getElementById('summary').hidden = false; }
function openStatements() { hit('statements'); setTimeout(() => { document.getElementById('sheet').hidden = false; }, 300); }
</script>"""

DATES = ["September 06, 2026", "October 06, 2026", "August 06, 2026"]
ISO = ["2026-10-06", "2026-09-06", "2026-08-06"]


def rows(dates, attrs=""):
    return "".join(f'<li><button type="button" onclick="hit(\'stmt:{d}\')" aria-label="Download statement for {d}" {attrs}>{d}</button></li>'
                   for d in dates)


def page(dates=DATES, open_sheet=False, extra_sheet="", opener=None, summary_attrs="", stmt_attrs="", label="Bilt Blue Card", others=""):
    opener = opener if opener is not None else (
        '<div role="button" tabindex="0" onclick="openStatements()">View statements'
        '<button type="button" aria-label="action-right" onclick="event.stopPropagation()"></button></div>')
    return f"""<main id="wallet"><section id="card">
      <div><span>{label}</span> <span>•••• 4821</span> <button type="button" onclick="hit('view')">View</button></div>
      <button type="button" onclick="openSummary()" aria-label="View balance summary" {summary_attrs}><svg width="10" height="10"></svg></button>
      <button type="button" onclick="hit('pay')">Pay card</button>
      <button type="button" onclick="hit('lock')">Lock card</button>
      <p>Recent activity <a href="/wallet/transactions?cardId={CARD}">View all</a></p>
    </section>{others}</main>
    <div id="summary" role="dialog" {'' if open_sheet else 'hidden'}><p>Balance</p>
      <button type="button" onclick="hit('pay2')">Make payment</button>{opener}</div>
    <div id="sheet" role="dialog" {'' if open_sheet else 'hidden'}><h2>Statements</h2><ul>{rows(dates, stmt_attrs)}</ul>{extra_sheet}</div>"""


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, body, path="/wallet"):
    asked = []

    def route(r):
        asked.append(r.request.url)
        if r.request.url.startswith(BASE):
            r.fulfill(status=200, content_type="text/html", body=f"<!doctype html><meta charset=utf-8>{SCRIPT}{body}")
        else:
            r.abort()
    tab.goto("about:blank")
    tab.unroute("**/*")
    tab.route("**/*", route)
    tab.goto(BASE + path)
    tab.add_script_tag(content=(ROOT / "providers" / "bilt.page.js").read_text())
    return asked


def read(tab, walk=False):
    return tab.evaluate("(w) => __sweep.readList({walk: w})", walk)


def click(tab, doc):
    return tab.evaluate("(d) => __sweep.clickDoc(d)", doc)


def pressed(tab):
    return tab.evaluate("window.log")


def doc(iso):
    return {"id": f"statement-{iso}", "date": iso, "title": "Card Statement", "method": "newtab"}


# -- the list -----------------------------------------------------------------

def test_walking_opens_both_sheets_and_lists_newest_first(tab):
    asked = load(tab, page())
    got = read(tab, walk=True)
    assert got == {"state": "ok", "docs": [doc(d) for d in ISO]}
    assert pressed(tab) == ["summary", "statements"]
    assert len(asked) == 1


def test_an_open_sheet_is_read_without_pressing(tab):
    load(tab, page(open_sheet=True))
    got = read(tab, walk=True)
    assert got["state"] == "ok" and [d["id"] for d in got["docs"]] == [f"statement-{d}" for d in ISO]
    assert pressed(tab) == []


def test_without_walking_nothing_is_pressed(tab):
    load(tab, page())
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []
    assert "View balance summary" in got["why"]
    assert pressed(tab) == []


def test_a_summary_already_open_is_not_pressed_again(tab):
    body = page().replace('<div id="summary" role="dialog" hidden>', '<div id="summary" role="dialog">')
    load(tab, body)
    assert read(tab, walk=True)["state"] == "ok"
    assert pressed(tab) == ["statements"]


def test_a_summary_button_with_a_refused_title_is_not_pressed(tab):
    load(tab, page(summary_attrs='title="Pay card"'))
    got = read(tab, walk=True)
    assert got["state"] == "stopped" and pressed(tab) == []


def test_a_turned_off_summary_button_is_not_pressed(tab):
    load(tab, page(summary_attrs="disabled"))
    got = read(tab, walk=True)
    assert got["state"] == "stopped" and "turned off" in got["why"]
    assert pressed(tab) == []


def test_two_view_statements_stop(tab):
    two = ('<div role="button" onclick="openStatements()">View statements</div>'
           '<div role="button" onclick="openStatements()">View statements</div>')
    load(tab, page(opener=two))
    got = read(tab, walk=True)
    assert got["state"] == "stopped" and "not one control" in got["why"]
    assert pressed(tab) == ["summary"]


def test_a_view_statements_with_other_words_is_not_pressed(tab):
    load(tab, page(opener='<div role="button" onclick="openStatements()" title="View statements and pay">View statements</div>'))
    got = read(tab, walk=True)
    assert got["state"] == "stopped" and pressed(tab) == ["summary"]


@pytest.mark.parametrize("path", ["/login", "/auth/start"])
def test_a_sign_in_address_is_signed_out(tab, path):
    load(tab, "<p>Hello</p>", path)
    assert read(tab, walk=True) == {"state": "signed_out"}


def test_a_password_field_is_signed_out(tab):
    load(tab, "<input type=password>")
    assert read(tab, walk=True) == {"state": "signed_out"}


def test_the_sign_in_drawn_on_the_wallet_is_signed_out(tab):
    load(tab, "<nav><button>Sign up / Log in</button></nav><p>Welcome to Bilt. Log in or sign up.</p>")
    assert read(tab, walk=True) == {"state": "signed_out"}


def test_a_sign_in_that_goes_away_is_not_signed_out(tab):
    body = page(open_sheet=True).replace("<main", "<main hidden") + """<p id=s>Complete login to continue.</p>
      <script>setTimeout(() => { document.getElementById('s').remove();
        document.querySelector('main').hidden = false; }, 600);</script>"""
    load(tab, body)
    assert read(tab)["state"] == "ok"


def test_a_security_check_needs_the_person(tab):
    load(tab, "<h1>Enter the code</h1><p>We sent a code to your phone</p>")
    assert read(tab, walk=True) == {"state": "challenge"}


def test_another_page_is_not_the_list_yet(tab):
    load(tab, "<p>hello</p>", "/rewards")
    assert read(tab, walk=True) == {"state": "no_list"}


def test_a_wallet_with_two_cards_stops_and_presses_nothing(tab):
    load(tab, page(others='<div><span>Bilt Card</span> <span>•••• 9999</span></div>'))
    got = read(tab, walk=True)
    assert got["state"] == "stopped" and "one Bilt Card" in got["why"]
    assert pressed(tab) == []


@pytest.mark.parametrize("text", ["October 32, 2026", "Oct 06, 2026", "2026-10-06"])
def test_a_date_that_is_not_one_stops(tab, text):
    bad = f'<button type="button" aria-label="Download statement for {text}">{text}</button>'
    load(tab, page(open_sheet=True, extra_sheet=bad))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


def test_a_label_and_text_that_disagree_stop(tab):
    bad = '<button type="button" aria-label="Download statement for July 06, 2026">July 07, 2026</button>'
    load(tab, page(open_sheet=True, extra_sheet=bad))
    assert read(tab)["docs"] == []


def test_two_statements_of_one_date_stop(tab):
    load(tab, page(dates=DATES + ["October 06, 2026"], open_sheet=True))
    got = read(tab)
    assert got["state"] == "stopped" and "one date" in got["why"]


def test_a_control_for_more_statements_stops(tab):
    load(tab, page(open_sheet=True, extra_sheet="<button>Load more</button>"))
    got = read(tab)
    assert got["docs"] == [] and "only part" in got["why"]


# -- one statement ------------------------------------------------------------

def test_one_statement_is_pressed_from_an_open_sheet(tab):
    load(tab, page(open_sheet=True))
    assert click(tab, doc("2026-09-06")) == {"ok": True}
    assert pressed(tab) == ["stmt:September 06, 2026"]


def test_a_closed_sheet_is_opened_again_before_the_press(tab):
    load(tab, page())
    assert click(tab, doc("2026-08-06")) == {"ok": True}
    assert pressed(tab) == ["summary", "statements", "stmt:August 06, 2026"]


def test_each_statement_in_turn_from_where_the_last_left_the_tab(tab):
    load(tab, page())
    for iso in ISO:
        assert click(tab, doc(iso)) == {"ok": True}
    assert pressed(tab) == ["summary", "statements", "stmt:October 06, 2026",
                            "stmt:September 06, 2026", "stmt:August 06, 2026"]


def test_a_statement_not_on_the_sheet_is_not_pressed(tab):
    load(tab, page(open_sheet=True))
    got = click(tab, doc("2026-07-06"))
    assert got["ok"] is False and "not on the statements sheet" in got["why"]
    assert pressed(tab) == []


@pytest.mark.parametrize("bad", [
    {"id": "statement-2026-09-06", "date": "2026-10-06"},
    {"id": "2026-09-06", "date": "2026-09-06"},
    {"id": "statement-2026-09-06; pay", "date": "2026-09-06"},
    {},
])
def test_a_doc_not_of_this_list_is_refused(tab, bad):
    load(tab, page(open_sheet=True))
    assert click(tab, bad)["ok"] is False
    assert pressed(tab) == []


def test_a_turned_off_statement_is_left_for_the_next_run(tab):
    load(tab, page(open_sheet=True, stmt_attrs='aria-disabled="true"'))
    got = click(tab, doc("2026-10-06"))
    assert got["ok"] is False and "next run" in got["why"]
    assert pressed(tab) == []


def test_a_statement_button_with_a_refused_title_is_not_pressed(tab):
    load(tab, page(open_sheet=True, stmt_attrs='title="Pay now"'))
    assert click(tab, doc("2026-10-06"))["ok"] is False
    assert pressed(tab) == []


def test_a_signed_out_wallet_presses_nothing(tab):
    load(tab, "<nav><button>Sign up / Log in</button></nav><p>Complete login to continue.</p>")
    got = click(tab, doc("2026-10-06"))
    assert got["ok"] is False and "Sign in again" in got["why"]


def test_a_second_card_stops_the_press(tab):
    load(tab, page(open_sheet=True, others='<div><span>Bilt Card</span> <span>•••• 9999</span></div>'))
    got = click(tab, doc("2026-10-06"))
    assert got["ok"] is False and "one Bilt Card" in got["why"]
    assert pressed(tab) == []
