"""The Venmo page logic, in a real Chromium, on stand-in pages."""
from datetime import date
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOST = "https://account.venmo.com"
PROFILE = "4455667788990011"
MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
COMPLETED = "transactionListItem_completedTransactionList__nfpG1"
ITEM = "transactionListItem_transactionItem__x"
EMPTY = "No transactions yet for this month, but as soon as they start rolling in, we'll list them here."


def query(month=9, year=2026, account="personal", tab=""):
    extra = f"&accountTab={tab}" if tab else ""
    return f"/statement?accountType={account}&month={month}&profileId={PROFILE}&year={year}{extra}"


def rows(n=3):
    return "".join(f'<a class="{ITEM}" href="/t/{i}"><span data-testid="money">$1</span></a>' for i in range(n))


def tx_list(n=3, pager=""):
    return f'<div class="{COMPLETED}">{rows(n)}{pager}</div>'


def page(month=9, year=2026, body=tx_list(), next_data=""):
    picker = f'<input type="text" value="{MONTHS[month - 1]} {year}">'
    data = f'<script id="__NEXT_DATA__" type="application/json">{next_data}</script>' if next_data else ""
    return f'<main><h1>Account Statement</h1>{picker}{body}</main>{data}'


def tabbed(body, open_tab="wallet"):
    tab_id = "venmo-account-tab-body" if open_tab == "wallet" else "venmo-balance-account-tab-body"
    return f'<div data-testid="account-statement-layout"><section data-testid="{tab_id}">{body}</section></div>'


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, path, body):
    tab.unroute("**/*")
    tab.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body}"))
    tab.goto(HOST + path)
    tab.add_script_tag(content=(ROOT / "providers" / "venmo.page.js").read_text())


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_a_finished_month_is_listed_dated_its_last_day(tab):
    load(tab, query(), page())
    assert read(tab) == {"state": "ok", "docs": [{
        "id": "2026-09", "date": "2026-09-30", "title": "Statement", "method": "print",
        "url": f"{HOST}/statement?accountType=personal&month=9&profileId={PROFILE}&year=2026",
    }]}


def test_a_leap_february_ends_on_its_last_day(tab):
    load(tab, query(2, 2024), page(2, 2024))
    assert read(tab)["docs"][0]["date"] == "2024-02-29"


def test_a_sign_in_address_is_known(tab):
    load(tab, "/signin", "<p>Sign in</p>")
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_known(tab):
    load(tab, query(), "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_waits_for_the_person(tab):
    load(tab, query(), "<p>We sent a code to your phone</p>")
    assert read(tab) == {"state": "challenge"}


def test_another_page_is_not_the_list(tab):
    load(tab, "/", "<h1>Home</h1>")
    assert read(tab) == {"state": "no_list"}


def test_the_month_under_way_is_not_listed(tab):
    this_month = date.today()
    load(tab, query(this_month.month, this_month.year), page(this_month.month, this_month.year))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


@pytest.mark.parametrize("today, state", [("2026-10-01T12:00:00", "stopped"), ("2026-10-02T12:00:00", "ok")])
def test_a_month_counts_as_finished_a_whole_day_after_its_end(tab, today, state):
    load(tab, query(9, 2026), page(9, 2026))
    tab.evaluate(f"Date.now = () => new Date('{today}').getTime()")
    assert read(tab)["state"] == state


def test_a_picker_that_disagrees_with_the_address_stops(tab):
    load(tab, query(9), page(8))
    assert read(tab)["state"] == "stopped"


def test_a_busy_month_with_show_more_is_not_printed_in_part(tab):
    pager = '<div><button>Show more</button></div>'
    load(tab, query(), page(body=tx_list(10, pager)))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == [] and "Show more" in got["why"]


def test_a_load_more_control_stops(tab):
    load(tab, query(), page(body=tx_list() + "<button>Load more</button>"))
    assert read(tab)["state"] == "stopped"


def test_an_empty_month_lists_nothing(tab):
    load(tab, query(), page(body=f"<p>{EMPTY}</p>"))
    assert read(tab) == {"state": "ok", "docs": []}


def test_a_month_with_neither_rows_nor_words_stops(tab):
    load(tab, query(), page(body="<p>Hello</p>"))
    assert read(tab)["state"] == "stopped"


def test_only_pending_transactions_stop(tab):
    load(tab, query(), page(body='<div class="pendingTransactionList_x"><a>Pending</a></div>'))
    assert read(tab)["state"] == "stopped"


def test_a_business_profile_is_not_listed(tab):
    load(tab, query(account="business"), page())
    assert read(tab)["state"] == "stopped"


def test_a_query_of_another_shape_stops(tab):
    load(tab, f"/statement?accountType=personal&month=9&profileId={PROFILE}&year=2026&extra=1", page())
    assert read(tab)["state"] == "stopped"


def test_the_servers_word_on_tabs_is_read_from_the_page(tab):
    told = json.dumps({"props": {"pageProps": {"isAccountRestructuringEnabledSSR": True}}})
    load(tab, query(), page(next_data=told))
    assert read(tab)["state"] == "stopped"


def test_a_wallet_tab_is_saved_and_the_balance_tab_left_to_say_so(tab):
    load(tab, query(tab="venmo-account"), page(body=tabbed(tx_list())))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"][0]["id"] == "2026-09" and "accountTab" not in got["docs"][0]["url"]


def test_a_balance_tab_is_its_own_statement(tab):
    load(tab, query(tab="venmo-balance"), page(body=tabbed(tx_list(), "balance")))
    got = read(tab)
    doc = got["docs"][0]
    assert got["state"] == "stopped" and doc["id"] == "2026-09-balance" and doc["title"] == "Balance Statement"
    assert doc["url"].endswith("accountTab=venmo-balance")


def test_a_wallet_tabs_empty_words_alone_are_not_believed(tab):
    load(tab, query(tab="venmo-account"), page(body=tabbed(f"<p>{EMPTY}</p>")))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []
