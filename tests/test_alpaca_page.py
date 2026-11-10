"""The Alpaca page logic, in a real Chromium, on stand-in pages."""
from pathlib import Path
import json
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://app.alpaca.markets"
PAGE = "/account/documents"
LIVE = '<button data-testid="account-switcher-button">Invented Ventures LLC - 7QX40031</button>'
PAPER = '<button data-testid="account-switcher-button">Invented Ventures LLC Paper - PA3QX</button>'


def row(day="2026-09-30", kind="account_statement", last='<p onclick="press(this)">Download</p>'):
    return f"<tr><td>{day}</td><td>{kind}</td><td>{last}</td></tr>"


def page_of(rows, switcher=LIVE, pager=""):
    return (f"{switcher}<table><thead><tr><th>Date</th><th>Document Type</th><th>Download</th></tr></thead>"
            f"<tbody>{rows}</tbody></table>{pager}"
            "<script>window.pressed=[];function press(p){pressed.push(p.closest('tr').cells[0].textContent)}</script>")


GOOD = (row("2026-08-31") + row("2026-09-30") + row("2026-09-30", "crypto_account_statement")
        + row("2026-09-30", "trade_confirmation") + row("2026-09-30", "trade_confirmation_json")
        + row("2026-08-17", "account_application"))


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, body, path=PAGE):
    def respond(route):
        if route.request.url.startswith(BASE):
            route.fulfill(status=200, content_type="text/html", body=f"<!doctype html><title>Alpaca</title>{body}")
        else:
            route.abort()
    tab.unroute("**/*")
    tab.route("**/*", respond)
    tab.goto(BASE + path)
    tab.add_script_tag(content=(ROOT / "providers" / "alpaca.page.js").read_text())


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_kept_types_are_listed_newest_first_with_the_rest_passed_over(tab):
    load(tab, page_of(GOOD))
    got = read(tab)
    assert got["state"] == "ok"
    assert [(d["id"], d["date"], d["title"], d["method"]) for d in got["docs"]] == [
        ("2026-09-30_account_statement", "2026-09-30", "Brokerage Statement", "click"),
        ("2026-09-30_crypto_account_statement", "2026-09-30", "Crypto Statement", "click"),
        ("2026-08-31_account_statement", "2026-08-31", "Brokerage Statement", "click"),
    ]


@pytest.mark.parametrize("path", ["/account/login", "/logout"])
def test_signed_out_by_address(tab, path):
    load(tab, "", path=path)
    assert read(tab) == {"state": "signed_out"}


def test_signed_out_by_password_field(tab):
    load(tab, LIVE + "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_is_a_challenge(tab):
    load(tab, "<p>Enter the code we sent to your phone</p>")
    assert read(tab) == {"state": "challenge"}


@pytest.mark.parametrize("body", [
    page_of(GOOD, switcher=PAPER),
    page_of(GOOD) + "<div>You are on Paper Trading</div>",
])
def test_a_paper_account_stops_and_nothing_is_listed(tab, body):
    load(tab, body)
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == [] and "Paper" in got["why"]


def test_a_paper_account_sent_to_its_dashboard_stops_too(tab):
    load(tab, PAPER, path="/dashboard/overview")
    assert read(tab)["state"] == "stopped"


# Alpaca's switcher, as seen on the real site (2026-11-09): a Live / Paper
# choice at the top, the side's accounts, then New Paper Account, Account
# Management and Sign Out. Choosing the live account turns the switcher Live.
SWITCH_MENU = """
<button data-testid="account-switcher-button" id="sw">Kronos Paper - PA3BOJ8T7GYS</button>
<div id="menu" hidden>
  <button id="liveSide">Live</button><button id="paperSide">Paper</button>
  <div id="list"></div>
  <button onclick="pressed.push('new')">New Paper Account</button>
  <button onclick="pressed.push('manage')">Account Management</button>
  <button onclick="pressed.push('signout')">Sign Out</button>
</div>
<p>You are on Paper Trading, no real money is being used.</p>
<script>
window.pressed = [];
const LIVE_ACCOUNTS = %s;
sw.onclick = () => { pressed.push('switcher'); menu.hidden = false; };
paperSide.onclick = () => { pressed.push('paper'); list.innerHTML = '<div><p>Kronos</p><p>Paper Account PA3BOJ8T7GYS</p></div>'; };
liveSide.onclick = () => {
  pressed.push('live');
  list.innerHTML = LIVE_ACCOUNTS.map(n => '<div class="card"><p>Kronos</p><p>$49,437.83</p><p>Brokerage Account ' + n + '</p></div>').join('');
  for (const card of list.querySelectorAll('.card')) card.onclick = () => {
    pressed.push('account');
    if (window.staysPaper) return;
    sw.textContent = 'Kronos Live - ' + card.textContent.match(/\\d{6,}/)[0];
    menu.hidden = true;
    document.querySelector('body > p').remove();
  };
};
</script>"""


def switch_page(tab, accounts=("900000001",), stays_paper=False):
    load(tab, SWITCH_MENU % json.dumps(list(accounts)), path="/dashboard/overview")
    tab.evaluate("sessionStorage.clear()")
    if stays_paper:
        tab.evaluate("window.staysPaper = true")


def test_a_sweeps_own_tab_switches_from_paper_to_the_live_account(tab):
    switch_page(tab)
    assert tab.evaluate("__sweep.readList({walk: true})") == {"state": "walking"}
    assert tab.evaluate("pressed") == ["switcher", "live", "account"]
    assert "Live" in tab.inner_text("#sw")


def test_switching_never_presses_the_menus_other_buttons(tab):
    switch_page(tab)
    tab.evaluate("__sweep.readList({walk: true})")
    assert not set(tab.evaluate("pressed")) & {"new", "manage", "signout", "paper"}


def test_without_walking_paper_still_stops_and_nothing_is_pressed(tab):
    switch_page(tab)
    got = tab.evaluate("__sweep.readList({walk: false})")
    assert got["state"] == "stopped" and "Paper" in got["why"]
    assert tab.evaluate("pressed") == []


def test_two_live_accounts_are_left_for_the_person(tab):
    switch_page(tab, accounts=("900000001", "555000111"))
    got = tab.evaluate("__sweep.readList({walk: true})")
    assert got["state"] == "stopped" and "more than one live account" in got["why"]
    assert "account" not in tab.evaluate("pressed")


def test_a_switch_that_does_not_take_stops_and_is_not_tried_again_at_once(tab):
    switch_page(tab, stays_paper=True)
    got = tab.evaluate("__sweep.readList({walk: true})")
    assert got["state"] == "stopped" and "stayed on a Paper account" in got["why"]
    tab.evaluate("pressed.length = 0")
    got = tab.evaluate("__sweep.readList({walk: true})")
    assert got["state"] == "stopped" and tab.evaluate("pressed") == []


def test_another_page_is_not_the_list(tab):
    load(tab, LIVE, path="/dashboard/overview")
    assert read(tab) == {"state": "no_list"}


@pytest.mark.parametrize("day", ["2026-02-31", "Sep 30, 2026", ""])
def test_a_date_that_is_not_one_stops(tab, day):
    load(tab, page_of(row(day)))
    assert read(tab)["state"] == "stopped"


def test_a_row_in_another_shape_stops(tab):
    load(tab, page_of(row() + "<tr><td>2026-08-31</td><td>account_statement</td></tr>"))
    got = read(tab)
    assert got["state"] == "stopped" and len(got["docs"]) == 1


def test_a_next_that_is_on_stops_with_what_was_read(tab):
    load(tab, page_of(row(), pager="<button>Previous</button><button>Next</button>"))
    got = read(tab)
    assert got["state"] == "stopped" and "first page" in got["why"] and len(got["docs"]) == 1


def test_a_next_that_is_off_ends_the_list(tab):
    load(tab, page_of(row(), pager="<button disabled>Previous</button><button disabled>Next</button>"))
    assert read(tab)["state"] == "ok"


def test_two_of_one_date_and_kind_are_left_unsaved(tab):
    load(tab, page_of(row() + row() + row("2026-08-31")))
    got = read(tab)
    assert got["state"] == "stopped" and [d["date"] for d in got["docs"]] == ["2026-08-31"]


def test_click_presses_only_its_own_row(tab):
    load(tab, page_of(GOOD))
    assert tab.evaluate("__sweep.clickDoc({id: '2026-08-31_account_statement'})") == {"ok": True}
    assert tab.evaluate("pressed") == ["2026-08-31"]


@pytest.mark.parametrize("doc", ["../x", "2026-08-31_account_application", "2020-01-31_account_statement"])
def test_a_document_that_cannot_be_bound_presses_nothing(tab, doc):
    load(tab, page_of(GOOD))
    assert tab.evaluate(f"__sweep.clickDoc({{id: '{doc}'}})")["ok"] is False
    assert tab.evaluate("pressed") == []


def test_a_control_that_is_not_a_download_is_not_pressed(tab):
    load(tab, page_of(row(last='<p onclick="press(this)" aria-label="Delete">Download</p>')))
    assert tab.evaluate("__sweep.clickDoc({id: '2026-09-30_account_statement'})")["ok"] is False
    assert tab.evaluate("pressed") == []


def test_click_refuses_a_paper_account(tab):
    load(tab, page_of(GOOD, switcher=PAPER))
    assert tab.evaluate("__sweep.clickDoc({id: '2026-08-31_account_statement'})")["ok"] is False
    assert tab.evaluate("pressed") == []


# A list drawn ten rows a page, as Alpaca draws it, its rows redrawn after
# each Next or Previous. `delay` < 0 redraws at once, for long lists.
def paged(rows, delay=40, endless=False, next_label="Next", switcher=LIVE, start=0):
    data = [list(r) for r in rows]
    return (f"{switcher}<table><thead><tr><th>Date</th><th>Document Type</th><th>Download</th></tr></thead>"
            "<tbody></tbody></table>"
            f"<button id=prev>Previous</button><button id=next>{next_label}</button>"
            "<script>"
            f"window.ALL={data!r};window.page={start};window.turns=[];window.pressed=[];"
            f"const delay={delay}, endless={'true' if endless else 'false'};"
            "const body=document.querySelector('tbody'), prev=document.getElementById('prev'), next=document.getElementById('next');"
            "function press(p){pressed.push(p.closest('tr').cells[0].textContent+' '+p.closest('tr').cells[1].textContent)}"
            "function grow(){while(endless&&ALL.length<(page+1)*10){const n=ALL.length;"
            "const d=new Date(Date.UTC(2026,8,30)-n*86400000).toISOString().slice(0,10);ALL.push([d,'account_statement'])}}"
            "function draw(){grow();body.innerHTML=ALL.slice(page*10,page*10+10).map(([d,k])=>"
            "`<tr><td>${d}</td><td>${k}</td><td><p onclick='press(this)'>Download</p></td></tr>`).join('');"
            "prev.disabled=page===0;next.disabled=!endless&&(page+1)*10>=ALL.length}"
            "function go(step){turns.push(step);page+=step;body.innerHTML='';delay<0?draw():setTimeout(draw,delay)}"
            "prev.onclick=()=>go(-1);next.onclick=()=>go(1);draw();"
            "</script>")


def days(n, kind="account_statement", start=(2026, 9, 30)):
    from datetime import date, timedelta
    first = date(*start)
    return [((first - timedelta(days=i)).isoformat(), kind) for i in range(n)]


def walk_all(tab, limit=50):
    """Read every view, pressing what the engine would, and the views read."""
    views = []
    for _ in range(limit):
        got = tab.evaluate("__sweep.readList({walk: true})")
        views.append(got)
        if not got.get("more"):
            return views
        assert tab.evaluate("__sweep.nextView()") == {"moved": True}
    raise AssertionError("the walk did not end")


TWENTY_THREE = days(20) + [("2026-08-31", "account_statement"), ("2026-07-31", "account_statement"),
                           ("2026-07-31", "trade_confirmation_json")]


def test_walking_counts_every_page_then_reads_each_from_the_last_back_to_the_first(tab):
    load(tab, paged(TWENTY_THREE))
    views = walk_all(tab)
    assert [v["state"] for v in views] == ["ok", "ok", "ok"]
    assert [bool(v.get("more")) for v in views] == [True, True, False]
    assert tab.evaluate("turns") == [1, 1, -1, -1]
    ids = [d["id"] for v in views for d in v["docs"]]
    want = {f"{d}_{k}" for d, k in TWENTY_THREE if k != "trade_confirmation_json"}
    assert len(ids) == len(set(ids)) == 22 and set(ids) == want
    assert views[0]["docs"] == [
        {"id": "2026-08-31_account_statement", "date": "2026-08-31", "title": "Brokerage Statement", "method": "click"},
        {"id": "2026-07-31_account_statement", "date": "2026-07-31", "title": "Brokerage Statement", "method": "click"},
    ]
    assert tab.evaluate("window.__alpacaWalk") is None


def test_a_walked_page_s_documents_are_pressed_on_that_page(tab):
    load(tab, paged(TWENTY_THREE))
    got = tab.evaluate("__sweep.readList({walk: true})")
    assert got["more"] and tab.evaluate("page") == 2
    assert tab.evaluate("__sweep.clickDoc({id: '2026-07-31_account_statement'})") == {"ok": True}
    assert tab.evaluate("__sweep.clickDoc({id: '2026-09-30_account_statement'})")["ok"] is False
    assert tab.evaluate("pressed") == ["2026-07-31 account_statement"]


def test_one_page_walked_is_read_as_before(tab):
    load(tab, paged(days(4)))
    assert tab.evaluate("__sweep.readList({walk: true})") == {"state": "ok", "docs": [
        {"id": f"{d}_{k}", "date": d, "title": "Brokerage Statement", "method": "click"} for d, k in days(4)]}
    assert tab.evaluate("turns") == []


def test_without_walking_the_list_is_left_on_its_first_page(tab):
    load(tab, paged(TWENTY_THREE))
    got = read(tab)
    assert got["state"] == "stopped" and "first page of ten" in got["why"] and len(got["docs"]) == 10
    assert tab.evaluate("turns") == [] and tab.evaluate("page") == 0


def test_a_list_that_never_ends_stops_at_the_cap(tab):
    load(tab, paged([], delay=-1, endless=True))
    got = tab.evaluate("__sweep.readList({walk: true})")
    assert got["state"] == "stopped" and "200 pages" in got["why"] and got["docs"] == []
    assert len(tab.evaluate("turns")) == 199
    assert tab.evaluate("window.__alpacaWalk") is None


def test_two_alike_on_different_pages_are_both_left_and_said_at_the_end(tab):
    rows = days(10) + [("2026-09-30", "account_statement"), ("2026-08-31", "account_statement")]
    load(tab, paged(rows))
    views = walk_all(tab)
    ids = [d["id"] for v in views for d in v["docs"]]
    assert "2026-09-30_account_statement" not in ids and "2026-08-31_account_statement" in ids and len(ids) == 10
    assert views[-1]["state"] == "stopped" and "share one date and kind" in views[-1]["why"]


def test_a_next_that_brings_the_same_rows_stops(tab):
    load(tab, paged(TWENTY_THREE).replace("next.onclick=()=>go(1)", "next.onclick=()=>turns.push(1)"))
    got = tab.evaluate("__sweep.readList({walk: true})")
    assert got["state"] == "stopped" and "did not show other rows" in got["why"]


def test_a_next_with_other_words_on_it_is_not_pressed(tab):
    load(tab, paged(TWENTY_THREE).replace("<button id=next>", "<button id=next aria-label='Next order'>"))
    got = tab.evaluate("__sweep.readList({walk: true})")
    assert got["state"] == "stopped" and tab.evaluate("turns") == []


def test_walking_from_a_later_page_stops_before_pressing(tab):
    load(tab, paged(TWENTY_THREE, start=1))
    got = tab.evaluate("__sweep.readList({walk: true})")
    assert got["state"] == "stopped" and "first page" in got["why"] and tab.evaluate("turns") == []


def test_a_list_changed_between_views_stops(tab):
    load(tab, paged(TWENTY_THREE))
    assert tab.evaluate("__sweep.readList({walk: true})")["more"]
    tab.evaluate("ALL[10]=['2026-10-01','account_statement'];")
    assert "did not go back" in tab.evaluate("__sweep.nextView()")["why"]
    assert tab.evaluate("window.__alpacaWalk") is None
    load(tab, paged(TWENTY_THREE))
    assert tab.evaluate("__sweep.readList({walk: true})")["more"]
    tab.evaluate("document.querySelector('tbody td').textContent='2026-10-02'")
    got = tab.evaluate("__sweep.readList({walk: true})")
    assert got["state"] == "stopped" and "changed" in got["why"]


def test_a_paper_account_mid_walk_presses_nothing_more(tab):
    load(tab, paged(TWENTY_THREE))
    assert tab.evaluate("__sweep.readList({walk: true})")["more"]
    tab.evaluate("document.querySelector('[data-testid=account-switcher-button]').textContent='X Paper - PA1'")
    assert "Paper" in tab.evaluate("__sweep.nextView()")["why"]
    assert tab.evaluate("turns") == [1, 1]
