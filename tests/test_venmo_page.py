"""The Venmo page logic, in a real Chromium, on stand-in pages."""
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOST = "https://account.venmo.com"
PROFILE = "4455667788990011"
OTHER = "9988776655443322"
KEY = "__sweepVenmoWalk"
TODAY = "2026-10-15T12:00:00"
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
COMPLETED = "transactionListItem_completedTransactionList__nfpG1"
ITEM = "transactionListItem_transactionItem__x"
EMPTY = "No transactions yet for this month, but as soon as they start rolling in, we'll list them here."
# A Show more that draws ten more rows a moment after each press, `left` in all.
PAGER_JS = f"""<script>
window.presses = 0;
function more() {{
  window.presses += 1;
  setTimeout(() => {{
    const list = document.querySelector("[class*=completedTransactionList]");
    const pager = list.lastElementChild;
    for (let i = 0; i < 10 && window.left > 0; i++, window.left--) {{
      const a = document.createElement("a"); a.className = "{ITEM}"; list.insertBefore(a, pager);
    }}
    if (window.left <= 0) pager.remove();
  }}, 50);
}}
</script>"""
# Venmo writes the Wallet's name into a plain address once it draws tabs.
NAMES_WALLET = "<script>if (!location.search.includes('accountTab')) history.replaceState(null, '', location.href + '&accountTab=venmo-account')</script>"


def query(month=9, year=2026, account="personal", tab="", profile=PROFILE):
    extra = f"&accountTab={tab}" if tab else ""
    return f"/statement?accountType={account}&month={month}&profileId={profile}&year={year}{extra}"


def url(month=9, year=2026, tab=""):
    return HOST + query(month, year, tab=tab)


def rows(n=3):
    return "".join(f'<a class="{ITEM}" href="/t/{i}"><span data-testid="money">$1</span></a>' for i in range(n))


def tx_list(n=3, pager=""):
    return f'<div class="{COMPLETED}">{rows(n)}{pager}</div>'


def page(month=9, year=2026, body=None, next_data=""):
    body = tx_list() if body is None else body
    picker = f'<input type="text" value="{MONTHS[month - 1]} {year}">'
    data = f'<script id="__NEXT_DATA__" type="application/json">{next_data}</script>' if next_data else ""
    return f'<main><h1>Account Statement</h1>{picker}{body}</main>{data}'


def tabbed(body, open_tab="wallet"):
    tab_id = "venmo-account-tab-body" if open_tab == "wallet" else "venmo-balance-account-tab-body"
    return f'<div data-testid="account-statement-layout"><section data-testid="{tab_id}">{body}</section></div>'


def wallet(month=9, year=2026, body=None):
    return page(month, year, tabbed(tx_list() if body is None else body)) + NAMES_WALLET


def balance(month=9, year=2026, body=None):
    return page(month, year, tabbed(tx_list() if body is None else body, "balance"))


def serve(tab, pages):
    """Answers a statement address with pages["YYYY-MM"] or
    pages["YYYY-MM-balance"], any other path with pages[path], and a month
    not named with its words for no transactions."""
    def respond(route):
        parts = urlsplit(route.request.url)
        if parts.hostname != "account.venmo.com":
            return route.abort()
        q = {k: v[0] for k, v in parse_qs(parts.query).items()}
        body = pages.get(parts.path + ("?" + parts.query if parts.query else ""), pages.get(parts.path))
        if body is None and "month" in q:
            month = f"{q['year']}-{int(q['month']):02d}"
            body = pages.get(month + ("-balance" if q.get("accountTab") == "venmo-balance" else ""))
            if body is None:
                body = page(int(q["month"]), int(q["year"]), f"<p>{EMPTY}</p>")
        route.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body or ''}")
    tab.unroute("**/*")
    tab.route("**/*", respond)


def inject(tab, fast=False):
    tab.evaluate(f"Date.now = () => new Date('{TODAY}').getTime()")
    if fast:
        # Waits that run out end at once, so a page that never settles says so quickly.
        tab.evaluate("(() => { const st = window.setTimeout; window.setTimeout = (f) => st(f, 0); })()")
    tab.add_script_tag(content=(ROOT / "providers" / "venmo.page.js").read_text())


def load(tab, path, pages, clear=True, fast=False):
    serve(tab, pages)
    tab.goto(HOST + path)
    if clear:
        tab.evaluate("sessionStorage.clear()")
    inject(tab, fast)


def moved(tab, call, arg=None):
    """A call that sends the tab to another address. The load wipes the
    recipe, so it is added again, as the engine does."""
    with tab.expect_navigation():
        got = tab.evaluate(call, arg)
    inject(tab)
    return got


def read(tab, walk=True):
    return tab.evaluate("(w) => __sweep.readList({walk: w})", walk)


def walk_state(tab):
    return tab.evaluate(f"JSON.parse(sessionStorage.getItem('{KEY}'))")


def seed(tab, at, **more):
    """A walk already under way, at month `at` of the 24 from 2026-09 back."""
    months = [f"{y}-{m:02d}" for y in (2026, 2025, 2024) for m in range(12, 0, -1)]
    months = [m for m in months if "2024-10" <= m <= "2026-09"]
    w = {"where": {"accountType": "personal", "profileId": PROFILE}, "months": months, "at": at,
         "balance": False, "tabs": False, "rows": 0, "went": True, **more}
    tab.evaluate(f"(w) => sessionStorage.setItem('{KEY}', JSON.stringify({{...w, t: Date.now()}}))", w)


def statement(month="2026-09", balance=False):
    y, m = month.split("-")
    last = {"02": "28", "04": "30", "06": "30", "09": "30", "11": "30"}.get(m, "31")
    return {"id": month + ("-balance" if balance else ""), "date": f"{month}-{last}",
            "title": "Balance Statement" if balance else "Statement", "method": "print",
            "url": url(int(m), int(y), "venmo-balance" if balance else "")}


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


# ---- Who is asked, and what is left alone

def test_a_tab_of_yours_is_left_alone(tab):
    load(tab, query(), {"2026-09": page()})
    got = read(tab, walk=False)
    assert got["state"] == "stopped" and got["docs"] == [] and "opens itself" in got["why"]


def test_a_read_of_a_tab_of_yours_ends_a_walk_left_behind(tab):
    load(tab, query(), {"2026-09": page()})
    seed(tab, 3)
    read(tab, walk=False)
    assert walk_state(tab) is None


def test_a_sign_in_address_is_known(tab):
    load(tab, "/signin", {"/signin": "<p>Sign in</p>"})
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_known(tab):
    load(tab, query(), {"2026-09": "<input type=password>"})
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_waits_for_the_person(tab):
    load(tab, query(), {"2026-09": "<p>We sent a code to your phone</p>"})
    assert read(tab) == {"state": "challenge"}


def test_venmo_asking_for_a_pause_stops(tab):
    load(tab, query(), {"2026-09": "<p>Too many requests</p>"})
    assert read(tab)["state"] == "stopped"


def test_another_page_is_not_the_list(tab):
    load(tab, "/", {"/": "<h1>Home</h1>"})
    assert read(tab) == {"state": "no_list"}


# ---- The walk over the months

def test_a_walk_starts_at_the_last_finished_month(tab):
    load(tab, query(10, 2026), {"2026-10": page(10, 2026)})
    assert moved(tab, "__sweep.readList({walk: true})") == {"state": "walking"}
    assert tab.url == url(9, 2026)
    w = walk_state(tab)
    assert len(w["months"]) == 24 and w["months"][0] == "2026-09" and w["months"][-1] == "2024-10"
    assert w["at"] == 0 and w["went"] is True


def test_a_month_is_finished_only_a_whole_day_after_its_end(tab):
    load(tab, query(10, 2026), {})
    tab.evaluate("Date.now = () => new Date('2026-10-01T12:00:00').getTime()")
    moved(tab, "__sweep.readList({walk: true})")
    assert walk_state(tab)["months"][0] == "2026-08"


def test_a_month_with_transactions_is_listed_dated_its_last_day(tab):
    load(tab, query(10, 2026), {"2026-09": page()})
    moved(tab, "__sweep.readList({walk: true})")
    assert read(tab) == {"state": "ok", "docs": [statement()], "more": True}


def test_a_month_already_on_screen_is_read_at_once(tab):
    load(tab, query(), {"2026-09": page()})
    assert read(tab) == {"state": "ok", "docs": [statement()], "more": True}


def test_an_empty_month_lists_nothing_and_the_walk_goes_on(tab):
    load(tab, query(), {})
    assert read(tab) == {"state": "ok", "docs": [], "more": True}


def test_the_older_pages_words_for_an_empty_month_count(tab):
    load(tab, query(), {"2026-09": page(body="<p>There are no transactions for these dates.</p>")})
    assert read(tab) == {"state": "ok", "docs": [], "more": True}


def test_the_next_view_is_the_month_before(tab):
    load(tab, query(), {"2026-08": page(8)})
    read(tab)
    assert moved(tab, "__sweep.nextView()") == {"moved": True}
    assert tab.url == url(8, 2026)
    assert read(tab) == {"state": "ok", "docs": [statement("2026-08")], "more": True}


def test_the_walk_crosses_into_the_year_before(tab):
    load(tab, query(1, 2026), {"2025-12": page(12, 2025)})
    seed(tab, 8)
    assert moved(tab, "__sweep.nextView()") == {"moved": True}
    assert tab.url == url(12, 2025)
    assert read(tab)["docs"] == [statement("2025-12")]


def test_the_walk_ends_after_its_oldest_month(tab):
    load(tab, query(10, 2024), {})
    seed(tab, 23)
    assert read(tab) == {"state": "ok", "docs": [], "more": True}
    assert tab.evaluate("__sweep.nextView()") == {"moved": False}
    assert walk_state(tab) is None


def test_an_oldest_month_with_transactions_says_older_months_may_have_them(tab):
    load(tab, query(10, 2024), {"2024-10": page(10, 2024)})
    seed(tab, 23)
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == [statement("2024-10")] and "24 months" in got["why"]
    assert walk_state(tab) is None


def test_a_lost_place_is_said(tab):
    load(tab, query(), {})
    got = tab.evaluate("__sweep.nextView()")
    assert got.get("why") and "moved" not in got


def test_a_month_that_will_not_stay_stops(tab):
    load(tab, query(10, 2026), {"2026-10": page(10, 2026)})
    seed(tab, 0)
    got = read(tab)
    assert got["state"] == "stopped" and "2026-09" in got["why"]


def test_another_profile_mid_walk_stops(tab):
    load(tab, query(9, 2026, profile=OTHER), {"2026-09": page()})
    seed(tab, 0)
    got = read(tab)
    assert got["state"] == "stopped" and "profile" in got["why"]


def test_a_business_profile_is_not_listed(tab):
    load(tab, query(account="business"), {"2026-09": page()})
    assert read(tab)["state"] == "stopped"


def test_a_query_of_another_shape_stops(tab):
    load(tab, f"/statement?accountType=personal&month=9&profileId={PROFILE}&year=2026&extra=1", {"/statement": page()}, fast=True)
    assert read(tab)["state"] == "stopped"


@pytest.mark.parametrize("body", [
    page(8),
    page(body="<p>Hello</p>"),
    page(body='<div class="pendingTransactionList_x"><a>Pending</a></div>'),
    page(body=tx_list() + '<div data-testid="shimmer"></div>'),
    page(next_data=json.dumps({"props": {"pageProps": {"isAccountRestructuringEnabledSSR": True}}})),
], ids=["another month in the picker", "neither rows nor words", "only pending", "still loading", "server says tabs"])
def test_a_month_that_does_not_settle_stops_the_walk(tab, body):
    load(tab, query(), {"2026-09": body}, fast=True)
    seed(tab, 0)
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == [] and "2026-09" in got["why"]
    assert walk_state(tab) is None


def test_a_load_more_control_stops(tab):
    load(tab, query(), {"2026-09": page(body=tx_list() + "<button>Load more</button>")})
    assert read(tab)["state"] == "stopped"


def test_a_busy_month_with_show_more_is_listed_for_printing_whole(tab):
    load(tab, query(), {"2026-09": page(body=tx_list(10, "<div><button>Show more</button></div>"))})
    assert read(tab) == {"state": "ok", "docs": [statement()], "more": True}


# ---- A page with Wallet and Balance tabs

def test_both_tabs_of_a_month_are_read_each_its_own_statement(tab):
    load(tab, query(10, 2026), {"2026-09": wallet(), "2026-09-balance": balance(), "2026-08": wallet(8)})
    moved(tab, "__sweep.readList({walk: true})")
    assert read(tab) == {"state": "ok", "docs": [statement()], "more": True}
    assert walk_state(tab)["tabs"] is True
    assert moved(tab, "__sweep.nextView()") == {"moved": True}
    assert tab.url == url(9, 2026, "venmo-balance")
    assert read(tab) == {"state": "ok", "docs": [statement(balance=True)], "more": True}
    assert moved(tab, "__sweep.nextView()") == {"moved": True}
    assert tab.url.startswith(url(8, 2026))
    assert read(tab)["docs"] == [statement("2026-08")]


def test_a_wallet_doc_keeps_the_plain_address(tab):
    load(tab, query(), {"2026-09": wallet()})
    assert "accountTab" not in read(tab)["docs"][0]["url"]


def test_an_empty_balance_tab_lists_nothing(tab):
    load(tab, query(tab="venmo-balance"), {"2026-09-balance": balance(body=f"<p>{EMPTY}</p>")})
    seed(tab, 0, tabs=True, balance=True, rows=3)
    assert read(tab) == {"state": "ok", "docs": [], "more": True}


def test_a_wallet_tabs_empty_words_alone_are_not_believed(tab):
    load(tab, query(), {"2026-09": wallet(body=f"<p>{EMPTY}</p>")})
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == [] and "Wallet" in got["why"]


def test_a_balance_tab_that_never_opens_is_said(tab):
    # Venmo draws the Wallet under the Balance tab's address when the profile
    # has no Balance account, and when the Balance answer failed.
    load(tab, query(tab="venmo-balance"), {"2026-09-balance": page(body=tabbed(tx_list()))}, fast=True)
    seed(tab, 0, tabs=True, balance=True)
    got = read(tab)
    assert got["state"] == "stopped" and "Balance tab" in got["why"]


def test_tabs_first_drawn_after_months_without_them_stop(tab):
    load(tab, query(8), {"2026-08": wallet(8)})
    seed(tab, 1)
    got = read(tab)
    assert got["state"] == "stopped" and "tabs" in got["why"]


def test_the_oldest_month_counts_both_tabs(tab):
    load(tab, query(10, 2024, tab="venmo-balance"), {"2024-10-balance": balance(10, 2024, f"<p>{EMPTY}</p>")})
    seed(tab, 23, tabs=True, balance=True, rows=2)
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == [] and "24 months" in got["why"]


# ---- Showing a statement and saying when it is ready to print

def test_show_doc_opens_the_statements_own_address(tab):
    load(tab, query(10, 2026), {"2026-08": page(8)})
    assert moved(tab, "(d) => __sweep.showDoc(d)", statement("2026-08")) == {"ok": True}
    assert tab.url == url(8, 2026)


def test_show_doc_opens_a_balance_tab_by_its_address(tab):
    load(tab, query(10, 2026), {})
    assert moved(tab, "(d) => __sweep.showDoc(d)", statement(balance=True)) == {"ok": True}
    assert tab.url == url(9, 2026, "venmo-balance")


@pytest.mark.parametrize("doc", [
    {**statement(), "url": url().replace(PROFILE, OTHER)},
    {**statement(), "id": "2026-9"},
    {**statement(), "date": "2026-09-29"},
    {**statement("2026-10"), "date": "2026-10-31"},
    {k: v for k, v in statement().items() if k != "url"},
], ids=["another profile", "bad id", "wrong date", "month under way", "no address"])
def test_show_doc_refuses_what_it_did_not_list(tab, doc):
    load(tab, query(10, 2026), {})
    assert tab.evaluate("(d) => __sweep.showDoc(d)", doc)["ok"] is False


def test_show_doc_off_the_statements_page_refuses(tab):
    load(tab, "/", {"/": "<h1>Home</h1>"}, fast=True)
    assert tab.evaluate("(d) => __sweep.showDoc(d)", statement())["ok"] is False


def ready(tab, doc=None):
    return tab.evaluate("(d) => __sweep.printReady(d)", doc or statement())


def test_a_settled_month_is_ready(tab):
    load(tab, query(), {"2026-09": page()})
    assert ready(tab) == {"ready": True}


def test_a_balance_tab_is_ready_on_its_own_tab_only(tab):
    load(tab, query(tab="venmo-balance"), {"2026-09-balance": balance()})
    assert ready(tab, statement(balance=True)) == {"ready": True}
    assert ready(tab)["ok"] is False


def test_show_more_is_pressed_until_every_row_is_drawn(tab):
    pager = '<div><button onclick="more()">Show more</button></div>'
    load(tab, query(), {"2026-09": page(body=tx_list(10, pager)) + PAGER_JS})
    tab.evaluate("window.left = 25")
    assert ready(tab) == {"ready": True}
    assert tab.evaluate("window.presses") == 3
    assert tab.evaluate(f"document.querySelectorAll('a.{ITEM}').length") == 35


def test_a_show_more_that_draws_nothing_leaves_the_month(tab):
    pager = '<div><button onclick="window.presses = (window.presses || 0) + 1">Show more</button></div>'
    load(tab, query(tab="venmo-balance"), {"2026-09-balance": balance(body=tx_list(10, pager))}, fast=True)
    got = ready(tab, statement(balance=True))
    assert got["ok"] is False and "Show more" in got["why"]
    assert tab.evaluate("window.presses") == 1


def test_a_show_more_turned_off_is_not_pressed(tab):
    pager = '<div><button disabled onclick="window.presses = 1">Show more</button></div>'
    load(tab, query(), {"2026-09": page(body=tx_list(10, pager))})
    got = ready(tab)
    assert got["ok"] is False and "turned off" in got["why"]
    assert tab.evaluate("window.presses") is None


def test_a_covered_show_more_is_not_pressed(tab):
    pager = '<div><button onclick="window.presses = 1">Show more</button></div>'
    cover = '<div style="position:fixed;inset:0;background:#fff"></div>'
    load(tab, query(), {"2026-09": page(body=tx_list(10, pager)) + cover})
    got = ready(tab)
    assert got["ok"] is False and "covers" in got["why"]
    assert tab.evaluate("window.presses") is None


def test_a_month_that_now_shows_nothing_is_not_printed(tab):
    load(tab, query(), {})
    assert ready(tab)["ok"] is False


def test_a_load_more_control_is_not_printed(tab):
    load(tab, query(), {"2026-09": page(body=tx_list() + "<button>Load more</button>")})
    assert ready(tab)["ok"] is False


def test_another_month_on_screen_is_not_printed(tab):
    load(tab, query(8), {"2026-08": page(8)})
    assert ready(tab)["ok"] is False


def test_a_month_still_loading_is_not_ready_yet(tab):
    load(tab, query(), {"2026-09": page(body=tx_list() + '<div data-testid="shimmer"></div>')}, fast=True)
    got = ready(tab)
    assert got["ready"] is False and "loading" in got["why"]


def test_signed_out_is_never_ready(tab):
    load(tab, "/signin", {"/signin": "<p>Sign in</p>"})
    got = ready(tab)
    assert got["ok"] is False and "Sign in" in got["why"]


def test_a_check_is_never_ready(tab):
    load(tab, query(), {"2026-09": "<p>Enter the code we sent</p>"})
    assert ready(tab)["ok"] is False


def test_no_leave_doc_is_needed(tab):
    load(tab, query(), {"2026-09": page()})
    assert tab.evaluate("Object.keys(__sweep).sort()") == ["nextView", "printReady", "readList", "showDoc"]
