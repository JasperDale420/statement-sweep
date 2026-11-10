"""The Coinbase page logic, in a real Chromium, on stand-in pages."""
import base64
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://accounts.coinbase.com"
PAGE = "/statements"
# The row shape PaperPull's test_statement_rows_in_a_browser.py draws.
BUTTONS = ("<div><button type='button'>HTML</button>"
           "<button type='button' data-testid='statements-pdf-v2' onclick='press(this)'>PDF</button>"
           "<button type='button'>CSV</button></div>")


def statements(*rows, after=""):
    body = "".join(f"<div class='row'>{r}{BUTTONS}</div>" for r in rows)
    return (f"<main><div class='list'>{body}</div>{after}<button type='button'>Generate</button></main>"
            "<script>window.pressed=[];function press(b){pressed.push(b.closest('.row').innerText.slice(0,20))}</script>")


asked = []
GOOD = ("<span>Last 30 days</span>", "<span>September 2026</span>", "<span>August 2026</span>")
OWNER = {"first_transaction_date": "2026-08-03T00:00:00Z"}


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


TAX_HOST = "https://tax-center-forms-production.s3.amazonaws.com"
NO_TAX = {"forms": {}, "reports": []}


CARD_HOST = "https://statements.cardless.com"
fetched = []


def load(tab, body, path=PAGE, host=BASE, owner=OWNER, owner_status=200, tax=NO_TAX, reachable=True,
         pages=None, keep=False):
    """`pages` gives a body of its own to each of those paths, so a load of
    one of them by the tab itself (a going back) draws it. `keep` keeps the
    tab's session storage, where a card walk lives."""
    asked.clear()
    fetched.clear()

    def respond(route):
        url = route.request.url
        parts = urlsplit(url)
        if url.startswith(CARD_HOST + "/"):
            fetched.append(url)
            route.fulfill(status=200, content_type="text/plain", body="%PDF-1.7 card")
        elif url.startswith(TAX_HOST + "/"):
            asked.append(url)
            if not reachable:
                route.abort()
                return
            route.fulfill(status=200, content_type="application/pdf", body=b"%PDF-1.7 " + parts.path.encode(),
                          headers={"Access-Control-Allow-Origin": BASE})
        elif not url.startswith(host):
            route.abort()
        elif url.endswith("/v2/tax/owner-info"):
            route.fulfill(status=owner_status, content_type="application/json", body=json.dumps(owner))
        elif parts.path == "/v2/tax/forms":
            asked.append(url)
            query = parse_qs(parts.query)
            if "forms_status" in tax:
                route.fulfill(status=tax["forms_status"], content_type="text/html", body="<p>no</p>")
                return
            year = int(query["year"][0])
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps({"data": tax["forms"].get(year, []), "next_cursor": ""}))
        elif parts.path == "/v2/tax/tax-reports":
            asked.append(url)
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"data": tax["reports"]}))
        else:
            page = (pages or {}).get(parts.path, body)
            route.fulfill(status=200, content_type="text/html; charset=utf-8",
                          body=f"<!doctype html><meta charset=utf-8><title>Coinbase</title>{page}")
    tab.unroute("**/*")
    tab.route("**/*", respond)
    tab.goto(host + path)
    if not keep:
        tab.evaluate("sessionStorage.clear()")
    add_recipe(tab)


def add_recipe(tab):
    tab.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    tab.add_script_tag(content=(ROOT / "providers" / "coinbase.page.js").read_text())


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_months_are_read_newest_first_at_their_last_day_and_the_window_is_skipped(tab):
    load(tab, statements(*GOOD))
    assert read(tab) == {"state": "ok", "docs": [
        {"id": "2026-09", "date": "2026-09-30", "title": "Monthly Statement", "method": "click"},
        {"id": "2026-08", "date": "2026-08-31", "title": "Monthly Statement", "method": "click"},
    ]}


def test_signed_out_on_the_sign_in_address_and_by_password_field(tab):
    load(tab, "", path="/signin")
    assert read(tab) == {"state": "signed_out"}
    load(tab, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_is_a_challenge(tab):
    load(tab, "<main>Enter the code from your authenticator</main>")
    assert read(tab) == {"state": "challenge"}


def test_the_home_page_is_not_the_list(tab):
    load(tab, "<main>Home</main>", path="/home", host="https://www.coinbase.com")
    assert read(tab) == {"state": "no_list"}


def test_a_row_that_does_not_start_with_its_month_stops_and_keeps_the_rest(tab):
    load(tab, statements("<span>Last 30 days</span>", "<span>September 2026</span>",
                         "<span>New</span> <span>August 2026</span>"))
    got = read(tab)
    assert got["state"] == "stopped" and [d["id"] for d in got["docs"]] == ["2026-09"]


def test_a_load_more_that_shows_stops_with_what_was_read(tab):
    load(tab, statements(*GOOD, after="<button data-testid='load-more'>Load more</button>"))
    got = read(tab)
    assert got["state"] == "stopped" and "Load more" in got["why"] and len(got["docs"]) == 2


def test_a_list_short_of_the_first_month_stops(tab):
    load(tab, statements(*GOOD), owner={"first_transaction_date": "2024-02-03"})
    assert read(tab)["state"] == "stopped"


def test_no_first_transaction_stops(tab):
    load(tab, statements(*GOOD), owner={})
    assert read(tab)["state"] == "stopped"


def test_click_presses_only_that_months_pdf_button(tab):
    load(tab, statements(*GOOD))
    assert tab.evaluate("__sweep.clickDoc({id: '2026-08'})") == {"ok": True}
    pressed = tab.evaluate("pressed")
    assert len(pressed) == 1 and pressed[0].startswith("August 2026")


@pytest.mark.parametrize("doc", ["../x", "2026-13", "2020-01"])
def test_a_month_that_cannot_be_bound_presses_nothing(tab, doc):
    load(tab, statements(*GOOD))
    assert tab.evaluate(f"__sweep.clickDoc({{id: '{doc}'}})")["ok"] is False
    assert tab.evaluate("pressed") == []


def test_a_button_that_does_not_read_pdf_stops_and_is_not_pressed(tab):
    load(tab, statements(*GOOD).replace(">PDF<", ">Generate<"))
    assert read(tab)["state"] == "stopped"
    assert tab.evaluate("__sweep.clickDoc({id: '2026-08'})")["ok"] is False
    assert tab.evaluate("pressed") == []


def test_without_walking_load_more_is_not_pressed(tab):
    load(tab, statements(*GOOD, after=more_button()))
    got = read(tab)
    assert got["state"] == "stopped" and "Load more" in got["why"]
    assert tab.evaluate("loads") == 0


# Months older than August 2026, oldest last, as Load more would add them.
MONTHS_BACK = ["July 2026", "June 2026", "May 2026", "April 2026", "March 2026"]
# A Load more that draws two older months a press, after a moment, and goes
# once there are none left. `more` is the months it has to give.
LOAD_MORE = ("<button type='button' data-testid='load-more' onclick='loadMore(this)'>{label}</button>"
             "<script>window.loads=0;window.left={more!r};window.step=2;window.endless=false;"
             "function loadMore(b){{loads++;setTimeout(()=>{{"
             "for(let i=0;i<step;i++){{if(endless&&!left.length){{const d=new Date(Date.UTC(2026,6-loads*step-i,1));"
             "left.push(d.toLocaleString('en-US',{{month:'long',timeZone:'UTC'}})+' '+d.getUTCFullYear())}}"
             "const m=left.shift();if(!m)break;const row=document.createElement('div');row.className='row';"
             "row.innerHTML='<span>'+m+'</span>'+{buttons!r};document.querySelector('.list').appendChild(row)}}"
             "if(!left.length&&!endless)b.remove()}},40)}}</script>")


def more_button(label="Load more", more=MONTHS_BACK):
    return LOAD_MORE.format(label=label, more=list(more), buttons=BUTTONS)


def walk(tab):
    return tab.evaluate("__sweep.readList({walk: true})")


def test_walking_presses_load_more_until_the_whole_list_shows(tab):
    load(tab, statements(*GOOD, after=more_button()), owner={"first_transaction_date": "2026-03-09"})
    got = walk(tab)
    assert got["state"] == "ok", got
    assert [d["id"] for d in got["docs"]] == ["2026-09", "2026-08", "2026-07", "2026-06", "2026-05", "2026-04", "2026-03"]
    assert tab.evaluate("loads") == 3
    assert tab.evaluate("__sweep.clickDoc({id: '2026-03'})") == {"ok": True}
    assert tab.evaluate("pressed")[0].startswith("March 2026")


def test_a_load_more_that_never_ends_stops_at_the_cap(tab):
    load(tab, statements(*GOOD, after=more_button(more=[])).replace("window.endless=false", "window.endless=true")
         .replace("window.step=2", "window.step=1").replace("},40)", "},0)"),
         owner={"first_transaction_date": "2012-01-09"})
    got = walk(tab)
    assert got["state"] == "stopped" and "60 presses" in got["why"]
    assert tab.evaluate("loads") == 60
    assert len([d for d in got["docs"] if d["method"] == "click"]) == 62


def test_a_load_more_that_brings_nothing_stops(tab):
    load(tab, statements(*GOOD, after=more_button()).replace("loads++;", "loads++;return;"))
    got = walk(tab)
    assert got["state"] == "stopped" and "no more months" in got["why"] and len(got["docs"]) == 2


def test_a_load_more_with_other_words_on_it_is_not_pressed(tab):
    load(tab, statements(*GOOD, after=more_button(label="Load more and trade")))
    got = walk(tab)
    assert got["state"] == "stopped" and tab.evaluate("loads") == 0


def test_walking_a_list_with_no_load_more_reads_as_before(tab):
    load(tab, statements(*GOOD))
    assert walk(tab) == read(tab)


TAX = {
    "forms": {2025: [{"id": "11111111-2222-3333-4444-555555555555", "form_type": "1099-DA", "tax_year": 2025,
                      "files": [{"file_type": "pdf", "url": TAX_HOST + "/2025/f1.pdf?X-Amz-Signature=abc"}]}],
              2026: []},
    "reports": [{"id": "rpt0001", "name": "PregeneratedGainLossPDF", "year": 2025,
                 "file": {"file_type": "PDF", "url": TAX_HOST + "/r1.pdf"}},
                {"id": "rpt0002", "name": "PregeneratedGainLossCSV", "year": 2025,
                 "file": {"file_type": "CSV", "url": TAX_HOST + "/r1.csv"}}],
}
TAX_OWNER = {"first_transaction_date": "2025-08-03"}
TAX_MONTHS = GOOD + ("<span>July 2026</span>",) + tuple(f"<span>{m} 2026</span>" for m in
                     ["June", "May", "April", "March", "February", "January"]) + tuple(
                     f"<span>{m} 2025</span>" for m in ["December", "November", "October", "September", "August"])


def test_tax_forms_and_pdf_reports_follow_the_statements_under_their_own_ids(tab):
    load(tab, statements(*TAX_MONTHS), owner=TAX_OWNER, tax=TAX)
    got = read(tab)
    assert got["state"] == "ok"
    statements_ = [d for d in got["docs"] if d["method"] == "click"]
    assert [d["id"] for d in statements_][:2] == ["2026-09", "2026-08"] and len(statements_) == 14
    assert got["docs"][:14] == statements_
    assert got["docs"][14:] == [
        {"id": "tax-form:11111111-2222-3333-4444-555555555555", "date": "2025-12-31",
         "title": "1099-DA Tax Year 2025", "method": "fetch", "year": "2025"},
        {"id": "tax-report:rpt0001", "date": "2025-12-31", "title": "Gain Loss Report Tax Year 2025",
         "method": "fetch", "year": "2025"},
    ]
    years = sorted(parse_qs(urlsplit(u).query)["year"][0] for u in asked if "/v2/tax/forms" in u)
    assert years == ["2025", "2026"]


def test_two_of_one_form_in_a_year_keep_names_of_their_own(tab):
    two = {"forms": {2025: [{"id": "form0001-1111", "form_type": "1099-DA"}, {"id": "form0001-2222", "form_type": "1099-DA"}]},
           "reports": []}
    load(tab, statements(*TAX_MONTHS), owner=TAX_OWNER, tax=two)
    titles = [d["title"] for d in read(tab)["docs"] if d["method"] == "fetch"]
    assert titles == ["1099-DA Tax Year 2025 (#form00011111)", "1099-DA Tax Year 2025 (#form00012222)"]


@pytest.mark.parametrize("bad", [
    {"forms_status": 500},
    {"forms": {2025: [{"id": "", "form_type": "1099-DA"}]}, "reports": []},
    {"forms": {2025: [{"id": "a", "form_type": "1099-DA"}, {"id": "a", "form_type": "1099-B"}]}, "reports": []},
    {"forms": {2025: [{"id": "a", "form_type": "1099-DA", "tax_year": 2024}]}, "reports": []},
    {"forms": {}, "reports": [{"id": "r", "name": "PregeneratedGainLossPDF", "file": {"file_type": "pdf"}}]},
])
def test_a_tax_list_this_cannot_read_stops_and_keeps_the_statements(tab, bad):
    load(tab, statements(*TAX_MONTHS), owner=TAX_OWNER, tax=bad)
    got = read(tab)
    assert got["state"] == "stopped" and "tax" in got["why"]
    assert len(got["docs"]) == 14 and all(d["method"] == "click" for d in got["docs"])


# The page may not read Coinbase's tax host, so the recipe hands its checked
# link to the extension, which fetches it (background.js fetchHere).
def test_a_tax_form_hands_over_its_own_checked_link(tab):
    load(tab, statements(*TAX_MONTHS), owner=TAX_OWNER, tax=TAX)
    doc = [d for d in read(tab)["docs"] if d["id"].startswith("tax-form:")][0]
    asked.clear()
    got = tab.evaluate("(doc) => __sweep.fetchPdf(doc)", doc)
    assert got == {"ok": True, "fetchUrl": TAX_HOST + "/2025/f1.pdf?X-Amz-Signature=abc"}
    assert not any(u.startswith(TAX_HOST) for u in asked)
    report = tab.evaluate("(doc) => __sweep.fetchPdf(doc)", {"id": "tax-report:rpt0001", "year": "2025"})
    assert report == {"ok": True, "fetchUrl": TAX_HOST + "/r1.pdf"}


def test_a_tax_link_on_another_host_is_not_fetched(tab):
    evil = {"forms": {2025: [{"id": "abc", "form_type": "1099-DA",
                              "files": [{"file_type": "pdf", "url": "https://tax-center-forms-production.s3.amazonaws.com.evil.test/x.pdf"}]}]},
            "reports": []}
    load(tab, statements(*TAX_MONTHS), owner=TAX_OWNER, tax=evil)
    asked.clear()
    got = tab.evaluate("__sweep.fetchPdf({id: 'tax-form:abc', year: '2025'})")
    assert got["ok"] is False and not any("evil" in u for u in asked)


@pytest.mark.parametrize("doc", [{"id": "tax-form:../x", "year": "2025"}, {"id": "tax-form:abc", "year": "20x5"},
                                 {"id": "2026-08"}, {"id": "tax-form:nope", "year": "2025"}])
def test_a_tax_document_that_cannot_be_bound_is_not_fetched(tab, doc):
    load(tab, statements(*TAX_MONTHS), owner=TAX_OWNER, tax=TAX)
    asked.clear()
    assert tab.evaluate("(doc) => __sweep.fetchPdf(doc)", doc)["ok"] is False
    assert not any(u.startswith(TAX_HOST) for u in asked)


def test_the_page_never_asks_the_tax_host_itself(tab):
    load(tab, statements(*TAX_MONTHS), owner=TAX_OWNER, tax=TAX, reachable=False)
    asked.clear()
    got = tab.evaluate("__sweep.fetchPdf({id: 'tax-report:rpt0001', year: '2025'})")
    assert got["ok"] is True and not any(u.startswith(TAX_HOST) for u in asked)


# The Credit Card tab's list, the shape PaperPull's
# test_statement_rows_in_a_browser.py draws: one row per month, its text
# "<Month YYYY>", and a button of an icon glyph and "PDF" with no test id.
# Invented. A press is recorded, and goes to `window.goTo` when it is set.
CARD_BUTTON = "<div><button type='button' onclick='cardPress(this)'>\U000f0382 PDF</button></div>"
CARD_MONTHS = ("October 2026", "September 2026", "August 2026")


def card_list(*rows, after=""):
    body = "".join(f"<div class='row'><div>{r}</div>{CARD_BUTTON}</div>" for r in rows)
    return (f"<main><h1>Credit Card Statements</h1><div class='list'>{body}</div>{after}"
            "<button type='button'>Generate</button></main>")


# The Statements page's sub-navigation. Its Credit Card tab, as surveyed, has
# no address; pressing it draws the card list in place, as the site's own
# router does, and counts the press.
def nav(card="<a data-testid='subpage-navigation-item' onclick='openCard()'>Credit Card</a>"):
    return f"<nav><a data-testid='subpage-navigation-item' href='/statements'>Transactions</a>{card}</nav>"


def card_script(card_body):
    return ("<script>window.cardPressed=[];window.carded=0;"
            "function cardPress(b){cardPressed.push(b.closest('.row').innerText.slice(0,20));"
            "if(window.goTo)location.assign(window.goTo)}"
            "function openCard(){carded++;history.pushState({},'','/statements/credit-card');"
            f"document.querySelector('main').outerHTML={json.dumps(card_body)}}}</script>")


def with_card(card_body=None, rows=GOOD, card=None):
    card_body = card_list(*CARD_MONTHS) if card_body is None else card_body
    return (nav() if card is None else nav(card)) + statements(*rows) + card_script(card_body)


def card_page(card_body=None):
    return nav() + (card_list(*CARD_MONTHS) if card_body is None else card_body) + card_script("")


CARD_DOCS = [
    {"id": "card:2026-10", "date": "2026-10", "title": "Coinbase One Card Statement", "method": "newtab"},
    {"id": "card:2026-09", "date": "2026-09", "title": "Coinbase One Card Statement", "method": "newtab"},
    {"id": "card:2026-08", "date": "2026-08", "title": "Coinbase One Card Statement", "method": "newtab"},
]


def open_cards(tab, card_body=None):
    """The first view read, then the card view, as a sweep walks them."""
    load(tab, with_card(card_body))
    first = walk(tab)
    assert first["state"] == "ok" and first.get("more") is True and "note" not in first, first
    assert tab.evaluate("carded") == 0
    assert tab.evaluate("__sweep.nextView()") == {"moved": True}
    assert tab.evaluate("carded") == 1
    return walk(tab)


def card_click(tab, doc_id):
    return tab.evaluate("(id) => __sweep.clickDoc({id})", doc_id)


def test_a_credit_card_tab_makes_a_second_view_and_reading_never_presses_it(tab):
    load(tab, with_card())
    got = walk(tab)
    assert got == {**read_again(tab, walk=True), "more": True}
    assert [d["id"] for d in got["docs"]] == ["2026-09", "2026-08"]
    assert tab.evaluate("carded") == 0


def read_again(tab, walk=False):
    load(tab, nav(card="") + statements(*GOOD))
    got = tab.evaluate("(w) => __sweep.readList({walk: w})", walk)
    load(tab, with_card())
    return got


def test_in_a_tab_of_yours_the_card_tab_is_said_and_not_pressed(tab):
    load(tab, with_card())
    got = read(tab)
    assert got["state"] == "ok" and "more" not in got and "Statement Sweep opens" in got["note"]
    assert "not saved yet" not in got["note"]
    assert tab.evaluate("carded") == 0


def test_the_card_view_lists_each_month_newest_first_by_its_month(tab):
    got = open_cards(tab)
    assert got == {"state": "ok", "docs": CARD_DOCS}
    assert tab.evaluate("cardPressed") == []


def test_a_card_statement_presses_only_its_own_rows_pdf_button(tab):
    open_cards(tab)
    assert card_click(tab, "card:2026-09") == {"ok": True}
    pressed = tab.evaluate("cardPressed")
    assert len(pressed) == 1 and pressed[0].startswith("September 2026")
    assert tab.evaluate("carded") == 1


def test_the_press_sends_the_tab_to_the_statement_and_the_list_works_after_going_back(tab):
    pages = {"/statements": with_card(), "/statements/credit-card": card_page()}
    load(tab, with_card(), pages=pages)
    assert walk(tab).get("more") is True
    tab.evaluate("__sweep.nextView()")
    assert walk(tab)["docs"] == CARD_DOCS
    there = CARD_HOST + "/tok123_2026-10-04_Coinbase.pdf?Expires=1&Signature=s&Key-Pair-Id=k"
    tab.evaluate("(u) => { window.goTo = u; }", there)
    with tab.expect_navigation(url=there):
        assert card_click(tab, "card:2026-10") == {"ok": True}
    assert fetched == [there]
    tab.go_back()
    assert tab.url == BASE + "/statements/credit-card"
    add_recipe(tab)
    assert card_click(tab, "card:2026-08") == {"ok": True}
    assert tab.evaluate("cardPressed")[-1].startswith("August 2026")


def test_a_going_back_that_lands_on_the_transactions_list_presses_the_card_tab_again(tab):
    open_cards(tab)
    load(tab, with_card(), keep=True)
    assert tab.evaluate("carded") == 0
    assert card_click(tab, "card:2026-08") == {"ok": True}
    assert tab.evaluate("carded") == 1
    pressed = tab.evaluate("cardPressed")
    assert len(pressed) == 1 and pressed[0].startswith("August 2026")


def test_a_card_statement_is_never_pressed_outside_the_card_walk(tab):
    load(tab, with_card())
    got = card_click(tab, "card:2026-08")
    assert got["ok"] is False and "tab that opened" in got["why"]
    assert tab.evaluate("carded") == 0


@pytest.mark.parametrize("doc", ["card:2026-13", "card:../x", "card:2026-9", "card:2026-08x"])
def test_a_card_month_that_cannot_be_bound_presses_nothing(tab, doc):
    open_cards(tab)
    assert card_click(tab, doc)["ok"] is False
    assert tab.evaluate("cardPressed") == []


def test_a_card_month_not_on_the_list_presses_nothing(tab):
    open_cards(tab)
    assert card_click(tab, "card:2025-01") == {"ok": False, "why": "Its row was not there exactly once."}
    assert tab.evaluate("cardPressed") == []


def test_the_months_buttons_and_the_card_rows_are_kept_apart(tab):
    open_cards(tab)
    assert tab.evaluate("__sweep.clickDoc({id: '2026-09'})")["ok"] is False
    assert tab.evaluate("cardPressed") == []


@pytest.mark.parametrize("card_body, why", [
    (card_list("October 2026", "<span>New</span> September 2026"), "no month"),
    (card_list("October 2026", "October 2026"), "one month"),
    (card_list("October 2026", "August 2026"), "skip a month"),
    (card_list(*CARD_MONTHS, after="<button data-testid='load-more'>Load more</button>"), "Load more"),
])
def test_a_card_list_this_cannot_read_whole_stops(tab, card_body, why):
    got = open_cards(tab, card_body)
    assert got["state"] == "stopped" and why in got["why"]
    assert tab.evaluate("cardPressed") == []


def test_other_buttons_on_a_card_row_are_not_its_pdf_button(tab):
    row = card_list(*CARD_MONTHS).replace("PDF</button></div>", "PDF</button><button>Pay</button></div>", 1)
    assert open_cards(tab, row) == {"state": "ok", "docs": CARD_DOCS}


def test_the_card_list_outside_a_walk_is_not_read(tab):
    load(tab, card_page(), path="/statements/credit-card")
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []
    # A tab the sweep kept from an earlier run: the engine takes it to the list.
    assert walk(tab) == {"state": "no_list"}


def test_a_card_tab_that_does_not_open_its_list_stops(tab):
    load(tab, with_card())
    tab.evaluate("sessionStorage.setItem('statementSweep.coinbase.cardWalk',"
                 " JSON.stringify({t: Date.now(), p: Date.now() - 60000}))")
    got = walk(tab)
    assert got["state"] == "stopped" and "did not open" in got["why"]


def test_a_credit_card_link_to_anywhere_else_is_not_the_tab(tab):
    load(tab, with_card(card="<a data-testid='subpage-navigation-item' href='/creditcard'"
                             " onclick='openCard();return false'>Credit Card</a>"))
    got = walk(tab)
    assert got["state"] == "ok" and "more" not in got and "note" not in got
    assert tab.evaluate("__sweep.nextView()")["why"]
    assert tab.evaluate("carded") == 0


def test_two_credit_card_tabs_are_said_and_neither_is_pressed(tab):
    two = ("<a data-testid='subpage-navigation-item' onclick='openCard()'>Credit Card</a>"
           "<a data-testid='subpage-navigation-item' onclick='openCard()'>Credit Card</a>")
    load(tab, with_card(card=two))
    got = walk(tab)
    assert got["state"] == "ok" and "more" not in got and "two Credit Card tabs" in got["note"]
    assert tab.evaluate("__sweep.nextView()")["why"]
    assert tab.evaluate("carded") == 0


def test_next_view_presses_nothing_off_the_statements_page(tab):
    load(tab, "<main>Home</main>", path="/home", host="https://www.coinbase.com")
    assert tab.evaluate("__sweep.nextView()")["why"]


def test_a_check_on_the_card_list_is_a_challenge(tab):
    open_cards(tab)
    tab.evaluate("document.querySelector('main').outerHTML = '<main>Enter the code from your authenticator</main>'")
    assert walk(tab) == {"state": "challenge"}


def test_the_card_statement_host_is_the_one_file_host():
    meta = json.loads((ROOT / "providers" / "coinbase.meta.json").read_text())
    assert meta["fileHosts"] == ["statements.cardless.com"]
    assert meta.get("enabled", True) is True
