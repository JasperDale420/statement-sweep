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
        "c": ["order-W0000000001", "order-W0000000002"],
        "order-W0000000001": listed("W0000000001", "iPad Air", base),
        "order-W0000000002": listed("W0000000002", "AirPods 4", base)}}


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


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, url, pages):
    def answer(route):
        for key, body in pages.items():
            if route.request.url.startswith(key):
                route.fulfill(status=200, content_type="text/html", body="<!doctype html>" + body)
                return
        route.fulfill(status=404, content_type="text/html", body="<p>not found</p>")
    tab.goto("about:blank")
    tab.unroute("**/*")
    tab.route("**/*", answer)
    tab.goto(url)
    source = (ROOT / "providers" / "apple.page.js").read_text().replace("DATA_WAIT_MS = 20000", "DATA_WAIT_MS = 300").replace("PAUSE_MS = 2000", "PAUSE_MS = 0")
    tab.add_script_tag(content=source)


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_a_sign_in_address_is_known(tab):
    load(tab, SECURE + "/shop/signIn/orders", {SECURE: "<p>Sign in</p>"})
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_known(tab):
    load(tab, LIST, {WWW: "<input type=password>"})
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_is_known(tab):
    load(tab, LIST, {WWW: "<p>Please verify you are a human.</p>"})
    assert read(tab) == {"state": "challenge"}


def test_an_order_list_on_another_host_says_how_to_go_on(tab):
    load(tab, LIST, {LIST: html(order_list())})
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []
    assert "details page" in got["why"]


def test_orders_on_the_lists_own_host_are_read_with_dates_and_invoices(tab):
    pages = {LIST: html(order_list(base=WWW)),
             detail_url("W0000000001", WWW): html(detail("W0000000001", "April 28, 2026", "iPad Air", "DELIVERED", base=WWW)),
             detail_url("W0000000002", WWW): html(detail("W0000000002", "May 3, 2026", "AirPods 4", "PICKED_UP", base=WWW))}
    load(tab, LIST, pages)
    got = read(tab)
    assert got["state"] == "ok"
    assert got["docs"] == [
        {"id": "W0000000002", "date": "2026-05-03", "title": "AirPods 4", "method": "print", "url": invoice_url("W0000000002", WWW)},
        {"id": "W0000000001", "date": "2026-04-28", "title": "iPad Air", "method": "print", "url": invoice_url("W0000000001", WWW)}]


def test_a_canceled_order_has_no_invoice_and_is_left_out(tab):
    pages = {LIST: html(order_list(base=WWW)),
             detail_url("W0000000001", WWW): html(detail("W0000000001", "April 28, 2026", "iPad Air", "DELIVERED", base=WWW)),
             detail_url("W0000000002", WWW): html(detail("W0000000002", "March 9, 2026", "Mac mini", "CANCELED", invoice=False, base=WWW))}
    load(tab, LIST, pages)
    got = read(tab)
    assert got["state"] == "ok" and [d["id"] for d in got["docs"]] == ["W0000000001"]


def test_an_order_with_no_invoice_not_canceled_stops(tab):
    pages = {LIST: html(order_list(base=WWW)),
             detail_url("W0000000001", WWW): html(detail("W0000000001", "April 28, 2026", "iPad Air", "DELIVERED", base=WWW)),
             detail_url("W0000000002", WWW): html(detail("W0000000002", "March 9, 2026", "Mac mini", "DELIVERED", invoice=False, base=WWW))}
    load(tab, LIST, pages)
    got = read(tab)
    assert got["state"] == "stopped" and [d["id"] for d in got["docs"]] == ["W0000000001"]


def test_a_date_that_is_not_a_day_stops(tab):
    pages = {LIST: html(order_list(base=WWW)),
             detail_url("W0000000001", WWW): html(detail("W0000000001", "February 31, 2026", "iPad Air", "DELIVERED", base=WWW)),
             detail_url("W0000000002", WWW): html(detail("W0000000002", "May 3, 2026", "AirPods 4", "DELIVERED", base=WWW))}
    load(tab, LIST, pages)
    got = read(tab)
    assert got["state"] == "stopped" and [d["id"] for d in got["docs"]] == ["W0000000002"]


def test_a_details_page_naming_another_order_stops(tab):
    pages = {LIST: html(order_list(base=WWW)),
             detail_url("W0000000001", WWW): html(detail("W0000000009", "April 28, 2026", "iPad Air", "DELIVERED", base=WWW)),
             detail_url("W0000000002", WWW): html(detail("W0000000002", "May 3, 2026", "AirPods 4", "DELIVERED", base=WWW))}
    load(tab, LIST, pages)
    assert read(tab)["state"] == "stopped"


def test_an_invoice_off_apples_hosts_is_not_kept(tab):
    bad = copy.deepcopy(detail("W0000000001", "April 28, 2026", "iPad Air", "DELIVERED"))
    bad["orderDetail"]["orderHeader"]["d"]["invoiceUrl"] = "https://secure9.store.apple.com.evil.test/shop/order/print/invoice/1/2"
    url = detail_url("W0000000001")
    load(tab, url, {url: html(bad)})
    assert read(tab)["state"] == "stopped"


def test_older_orders_are_said(tab):
    load(tab, LIST, {LIST: html(order_list(base=WWW, more=True)),
                     detail_url("W0000000001", WWW): html(detail("W0000000001", "April 28, 2026", "iPad Air", "DELIVERED", base=WWW)),
                     detail_url("W0000000002", WWW): html(detail("W0000000002", "May 3, 2026", "AirPods 4", "DELIVERED", base=WWW))})
    got = read(tab)
    assert got["state"] == "stopped" and "older" in got["why"] and len(got["docs"]) == 2


def test_a_list_page_with_no_data_stops(tab):
    load(tab, LIST, {WWW: "<h1>Your Orders</h1>"})
    assert read(tab)["state"] == "stopped"


def test_another_apple_page_is_not_the_list(tab):
    load(tab, WWW + "/iphone/", {WWW: "<h1>iPhone</h1>"})
    assert read(tab) == {"state": "no_list"}


def test_an_orders_own_details_page_gives_that_order(tab):
    url = detail_url("W0000000001")
    load(tab, url, {url: html(detail("W0000000001", "April 28, 2026", "iPad Air", "DELIVERED"))})
    assert read(tab) == {"state": "ok", "docs": [
        {"id": "W0000000001", "date": "2026-04-28", "title": "iPad Air", "method": "print", "url": invoice_url("W0000000001")}]}


def test_a_lookalike_host_is_not_read(tab):
    load(tab, "https://secure9.store.apple.com.evil.test/shop/order/list", {"https://secure9": html(order_list())})
    assert read(tab)["state"] == "no_list"
