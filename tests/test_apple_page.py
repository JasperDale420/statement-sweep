"""The Apple Store page logic, in a real Chromium, on stand-in pages built from
PaperPull's recorded shapes. Every order and product is invented."""
import copy
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SECURE = "https://secure9.store.apple.com"
WWW = "https://www.apple.com"
LIST = WWW + "/shop/order/list"
KEY = "statementSweep.apple.walk"


def detail_url(number, base=SECURE):
    return "%s/shop/order/detail/100001/%s?_si=TEST" % (base, number)


def invoice_url(number, base=SECURE):
    return "%s/shop/order/print/invoice/100001/INV%s" % (base, number[-7:])


def listed(number, product, base=SECURE, item_key="0000101"):
    return {"d": {"webOrderNumber": number}, "c": [item_key],
            item_key: {"d": {"quantity": 1, "deliveryDate": "Delivered", "productShortName": product,
                             "orderDetailUrl": detail_url(number, base)}}}


def order_list(base=SECURE, more=False):
    return {"orderList": {
        "d": {"moreOrdersAvailable": more, "pageOffset": 0},
        "c": ["order-W0000000002", "order-W0000000001"],
        "order-W0000000002": listed("W0000000002", "AirPods 4", base),
        "order-W0000000001": listed("W0000000001", "iPad Air", base)}}


def detail(number, placed, product, status, invoice=True, base=SECURE):
    header = {"orderNumber": number, "orderPlacedDate": placed}
    if invoice:
        header["invoiceUrl"] = invoice_url(number, base)
    item = {"orderItemDetails": {"d": {"quantity": 1, "itemShortName": product, "productName": product + " - Starlight"}},
            "orderItemStatusTracker": {"d": {"statusDescription": status, "currentStatus": status}}}
    return {"orderDetail": {"c": ["orderHeader", "orderItems"], "orderHeader": {"d": header},
                            "orderItems": {"c": ["orderItem-0000101"], "orderItem-0000101": item}}}


def html(init):
    return '<script type="application/json" id="init_data">%s</script><h1>Your Orders</h1>' % json.dumps(init)


def invoice_page(number, late_ms=0):
    """An invoice drawn by the page's own script, as Apple's is."""
    draw = ("document.getElementById('inv').innerHTML = '<h1>Invoice</h1><p>Order Number %s</p>"
            "<p>iPad Air  $599.00</p>';" % number)
    script = ("<script>setTimeout(function(){%s}, %d)</script>" % (draw, late_ms)) if late_ms else ("<script>%s</script>" % draw)
    return '<button id="pr">Print</button><div id="inv"></div>' + script


AIRPODS = {"id": "W0000000002", "date": "2026-05-03", "title": "AirPods 4", "method": "print", "url": invoice_url("W0000000002")}
IPAD = {"id": "W0000000001", "date": "2026-04-28", "title": "iPad Air", "method": "print", "url": invoice_url("W0000000001")}


def store(**extra):
    pages = {LIST: html(order_list()),
             detail_url("W0000000002"): html(detail("W0000000002", "May 3, 2026", "AirPods 4", "PICKED_UP")),
             detail_url("W0000000001"): html(detail("W0000000001", "April 28, 2026", "iPad Air", "DELIVERED")),
             invoice_url("W0000000002"): invoice_page("W0000000002"),
             invoice_url("W0000000001"): invoice_page("W0000000001")}
    pages.update(extra)
    return pages


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


SOURCE = (ROOT / "providers" / "apple.page.js").read_text().replace("DATA_WAIT_MS = 20000", "DATA_WAIT_MS = 300") \
    .replace("PAUSE_MS = 2000", "PAUSE_MS = 0").replace("STEADY_MS = 800", "STEADY_MS = 50")


def inject(tab):
    tab.add_script_tag(content=SOURCE)


def load(tab, url, pages, clear=True):
    def answer(route):
        # The longest matching key, so an invoice is not taken for its host.
        for key in sorted(pages, key=len, reverse=True):
            if route.request.url.startswith(key):
                route.fulfill(status=200, content_type="text/html", body="<!doctype html>" + pages[key])
                return
        route.fulfill(status=404, content_type="text/html", body="<p>not found</p>")
    tab.goto("about:blank")
    tab.unroute("**/*")
    tab.route("**/*", answer)
    tab.goto(url)
    if clear:
        tab.evaluate("sessionStorage.clear()")
    inject(tab)


def follow(tab, url):
    """The recipe moved the tab: wait for it there, and inject it again."""
    tab.wait_for_url(url)
    tab.wait_for_load_state("load")
    inject(tab)


def read(tab, walk=True):
    return tab.evaluate("(w) => __sweep.readList({walk: w})", walk)


def walk_state(tab):
    return tab.evaluate("(k) => JSON.parse(sessionStorage.getItem(k))", KEY)


def set_walk(tab, visited, age_ms=0):
    tab.evaluate("([k, v, a]) => sessionStorage.setItem(k, JSON.stringify({visited: v, t: Date.now() - a}))", [KEY, visited, age_ms])


# --- signed out, checks, other pages ---

def test_a_sign_in_address_is_known(tab):
    load(tab, SECURE + "/shop/signIn/orders", {SECURE: "<p>Sign in</p>"})
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_known(tab):
    load(tab, LIST, {WWW: "<input type=password>"})
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_is_known(tab):
    load(tab, LIST, {WWW: "<p>Please verify you are a human.</p>"})
    assert read(tab) == {"state": "challenge"}


def test_a_list_page_with_no_data_stops(tab):
    load(tab, LIST, {WWW: "<h1>Your Orders</h1>"})
    assert read(tab)["state"] == "stopped"


def test_another_apple_page_is_not_the_list(tab):
    load(tab, WWW + "/iphone/", {WWW: "<h1>iPhone</h1>"})
    assert read(tab) == {"state": "no_list"}


def test_a_lookalike_host_is_not_read(tab):
    load(tab, "https://secure9.store.apple.com.evil.test/shop/order/list", {"https://secure9": html(order_list())})
    assert read(tab)["state"] == "no_list"


def test_a_tab_of_yours_is_not_walked_and_drops_a_left_walk(tab):
    load(tab, LIST, store())
    set_walk(tab, ["W0000000002"])
    got = read(tab, walk=False)
    assert got["state"] == "stopped" and got["docs"] == [] and "own tab" in got["why"]
    assert walk_state(tab) is None


# --- the walk ---

def test_the_list_asks_to_walk_its_orders(tab):
    load(tab, LIST, store())
    assert read(tab) == {"state": "ok", "docs": [], "more": True}
    assert walk_state(tab) is None  # reading changes nothing


def test_the_walk_visits_every_order_and_ends_back_on_the_list(tab):
    load(tab, LIST, store())
    assert read(tab)["more"] is True
    assert tab.evaluate("__sweep.nextView()") == {"moved": True}
    assert read(tab) == {"state": "walking"}  # this page is being left
    follow(tab, detail_url("W0000000002"))
    assert read(tab) == {"state": "ok", "docs": [AIRPODS], "more": True}
    assert tab.evaluate("__sweep.nextView()") == {"moved": True}
    follow(tab, LIST)
    assert walk_state(tab)["visited"] == ["W0000000002"]
    assert read(tab) == {"state": "ok", "docs": [], "more": True}
    assert tab.evaluate("__sweep.nextView()") == {"moved": True}
    follow(tab, detail_url("W0000000001"))
    assert read(tab) == {"state": "ok", "docs": [IPAD], "more": True}
    tab.evaluate("__sweep.nextView()")
    follow(tab, LIST)
    assert read(tab) == {"state": "ok", "docs": []}
    assert walk_state(tab) is None


def test_the_walks_log_lines_name_no_order_number(tab):
    load(tab, LIST, store())
    # Read in the same call: the walk then leaves this page.
    got = tab.evaluate("() => { const lines = []; globalThis.__sweepLog = (t) => { lines.push(String(t)); }; return [__sweep.nextView(), lines]; }")
    assert got[0] == {"moved": True}
    lines = got[1]
    assert "Next: the details of order 1 of this walk." in lines
    assert not any("W000" in line for line in lines), lines


def test_next_view_on_a_finished_walk_does_not_move(tab):
    load(tab, LIST, store())
    set_walk(tab, ["W0000000002", "W0000000001"])
    assert tab.evaluate("__sweep.nextView()") == {"moved": False}
    assert walk_state(tab) is None


def test_a_walk_older_than_its_age_starts_again(tab):
    load(tab, LIST, store())
    set_walk(tab, ["W0000000002", "W0000000001"], age_ms=3600000)
    assert read(tab)["more"] is True


def test_a_new_order_in_the_middle_of_a_walk_is_still_visited(tab):
    newer = order_list()
    newer["orderList"]["c"].insert(0, "order-W0000000003")
    newer["orderList"]["order-W0000000003"] = listed("W0000000003", "Mac mini")
    load(tab, LIST, store(**{LIST: html(newer)}))
    set_walk(tab, ["W0000000002", "W0000000001"])
    assert read(tab)["more"] is True
    tab.evaluate("__sweep.nextView()")
    follow(tab, detail_url("W0000000003"))


def test_older_orders_are_said(tab):
    load(tab, LIST, store(**{LIST: html(order_list(more=True))}))
    got = read(tab)
    assert got["state"] == "ok" and got["more"] is True and "older" in got["note"]


def test_an_order_with_no_details_page_is_said_and_passed(tab):
    data = order_list()
    data["orderList"]["order-W0000000001"]["0000101"]["d"]["orderDetailUrl"] = "https://evil.test/shop/order/detail/1/W0000000001"
    load(tab, LIST, store(**{LIST: html(data)}))
    set_walk(tab, ["W0000000002"])
    got = read(tab)
    assert got["state"] == "ok" and "more" not in got and "no details page" in got["note"]


# --- one order's details page ---

def test_an_orders_own_details_page_gives_that_order(tab):
    load(tab, detail_url("W0000000001"), store())
    assert read(tab) == {"state": "ok", "docs": [IPAD], "more": True}


def test_a_canceled_order_has_no_invoice_and_is_passed(tab):
    url = detail_url("W0000000001")
    load(tab, url, {url: html(detail("W0000000001", "March 9, 2026", "Mac mini", "CANCELED", invoice=False))})
    assert read(tab) == {"state": "ok", "docs": [], "more": True}


def test_an_order_not_invoiced_yet_is_said_and_passed(tab):
    url = detail_url("W0000000001")
    load(tab, url, {url: html(detail("W0000000001", "March 9, 2026", "Mac mini", "SHIPPED", invoice=False))})
    got = read(tab)
    assert got["state"] == "ok" and got["docs"] == [] and got["more"] is True and "not invoiced" in got["note"]


def test_a_date_that_is_not_a_day_stops(tab):
    url = detail_url("W0000000001")
    load(tab, url, {url: html(detail("W0000000001", "February 31, 2026", "iPad Air", "DELIVERED"))})
    got = read(tab)
    assert got["state"] == "stopped" and "date" in got["why"]


def test_an_invoice_off_apples_hosts_stops(tab):
    bad = copy.deepcopy(detail("W0000000001", "April 28, 2026", "iPad Air", "DELIVERED"))
    bad["orderDetail"]["orderHeader"]["d"]["invoiceUrl"] = "https://secure9.store.apple.com.evil.test/shop/order/print/invoice/1/2"
    url = detail_url("W0000000001")
    load(tab, url, {url: html(bad)})
    assert read(tab)["state"] == "stopped"


def test_a_details_page_with_no_order_number_stops(tab):
    url = detail_url("W0000000001")
    load(tab, url, {url: html(detail("NOTANORDER", "April 28, 2026", "iPad Air", "DELIVERED"))})
    assert read(tab)["state"] == "stopped"


# --- showing and printing an invoice ---

def test_show_doc_goes_to_the_invoice_and_it_is_ready_once_drawn(tab):
    load(tab, detail_url("W0000000001"), store())
    assert tab.evaluate("(d) => __sweep.showDoc(d)", IPAD) == {"ok": True}
    # Still on the details page: not ready, not refused.
    assert tab.evaluate("(d) => __sweep.printReady(d)", IPAD)["ready"] is False
    follow(tab, IPAD["url"])
    assert tab.evaluate("(d) => __sweep.printReady(d)", IPAD) == {"ready": True}
    assert tab.evaluate("getComputedStyle(document.getElementById('pr')).display") == "none"


def test_an_invoice_drawn_late_is_waited_for(tab):
    load(tab, IPAD["url"], {IPAD["url"]: invoice_page("W0000000001", late_ms=600)})
    first = tab.evaluate("(d) => __sweep.printReady(d)", IPAD)
    assert first["ready"] is False and "order number" in first["why"]
    tab.wait_for_timeout(800)
    assert tab.evaluate("(d) => __sweep.printReady(d)", IPAD) == {"ready": True}


def test_another_orders_invoice_is_not_ready(tab):
    load(tab, IPAD["url"], {IPAD["url"]: invoice_page("W0000000009")})
    assert tab.evaluate("(d) => __sweep.printReady(d)", IPAD)["ready"] is False


def test_a_sign_in_instead_of_the_invoice_gives_up(tab):
    load(tab, SECURE + "/shop/signIn/orders", {SECURE: "<p>Sign in</p>"})
    got = tab.evaluate("(d) => __sweep.printReady(d)", IPAD)
    assert got["ok"] is False and "sign-in" in got["why"]


def test_show_doc_refuses_what_it_did_not_list(tab):
    load(tab, detail_url("W0000000001"), store())
    for bad in [dict(IPAD, url="https://evil.test/shop/order/print/invoice/100001/INV0000001"),
                dict(IPAD, url="https://secure9.store.apple.com.evil.test/shop/order/print/invoice/1/2"),
                dict(IPAD, url=SECURE + "/shop/order/detail/100001/W0000000001"),
                dict(IPAD, url="http://secure9.store.apple.com/shop/order/print/invoice/100001/INV0000001"),
                dict(IPAD, id="12345"),
                dict(IPAD, method="fetch")]:
        assert tab.evaluate("(d) => __sweep.showDoc(d)", bad)["ok"] is False
        assert tab.evaluate("(d) => __sweep.printReady(d)", bad)["ok"] is False
    tab.wait_for_timeout(300)
    assert tab.url == detail_url("W0000000001")


def test_show_doc_refuses_an_invoice_its_details_page_no_longer_names(tab):
    load(tab, detail_url("W0000000001"), store())
    moved = dict(IPAD, url=SECURE + "/shop/order/print/invoice/100001/INV9999999")
    got = tab.evaluate("(d) => __sweep.showDoc(d)", moved)
    assert got["ok"] is False and "changed" in got["why"]


def test_show_doc_works_from_the_last_invoice(tab):
    load(tab, AIRPODS["url"], store())
    assert tab.evaluate("(d) => __sweep.showDoc(d)", IPAD) == {"ok": True}
    follow(tab, IPAD["url"])
    assert tab.evaluate("(d) => __sweep.printReady(d)", IPAD) == {"ready": True}


def test_after_an_invoice_next_view_goes_back_to_the_list(tab):
    load(tab, AIRPODS["url"], store())
    assert tab.evaluate("__sweep.nextView()") == {"moved": True}
    follow(tab, LIST)
