"""The Shelby County Trustee page logic, in a real Chromium's isolated world."""
import base64
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOST = "https://apps2.shelbycountytrustee.com"
def bill_address(parcel, **more):
    data = base64.b64encode(json.dumps({"parcel": parcel, "billNumber": 11223344, **more}).encode()).decode()
    return "/Transaction?billNumberData=" + data


TX = bill_address("012345 00099")
KEY = "01234500099"
RECEIPT = f"receipt-{KEY}-2025-02-27-7623"
PARCEL = "/Parcel?parcel=012345%2000099"
PDF_TEXT = "%PDF-1.3 DATE 2/27/2025 2:34 PM Receipt # 7887623 Property Tax Notice 2025"


def receipt(number="7887623", date="02/27/2025", label="Print Receipt"):
    return f'<tr><td><a href="#" class="print">{label}</a></td><td>{number}</td><td>{date}</td><td>TAX</td><td>$1,856.87</td></tr>'


def table(rows, footer="PAGE 1 OF 1 ROWS: 10 TOTAL RECORDS: 1"):
    return f"<h2>PAYMENT HISTORY</h2><table><tbody>{rows}</tbody></table><div>{footer}</div>"


def bill(year="2025"):
    return f'<tr><td><a href="Transaction?billNumberData=YWJj">11223344</a></td><td>{year}</td><td>County</td><td>$1</td></tr>'


# What the site does on a press: build a Blob, and ask to open its object URL.
BUILDS = """<script>
const makes = (text, type) => { const u = URL.createObjectURL(new Blob([text], {type})); window.open(u); };
document.addEventListener('click', e => {
  if (e.target.matches('.print, .notice')) { e.preventDefault(); window.__press = (window.__press || 0) + 1;
    (window.__make || (() => makes(window.__text, 'application/pdf')))(); }
});
window.__text = %r;
</script>"""


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


class World:
    """The page file run where the extension runs it: an isolated world."""

    def __init__(self, tab):
        self.cdp = tab.context.new_cdp_session(tab)
        frame = self.cdp.send("Page.getFrameTree")["frameTree"]["frame"]["id"]
        self.ctx = self.cdp.send("Page.createIsolatedWorld", {"frameId": frame})["executionContextId"]
        self.run((ROOT / "providers" / "shelbycounty.page.js").read_text())

    def run(self, expression):
        got = self.cdp.send("Runtime.evaluate", {
            "expression": expression, "contextId": self.ctx, "awaitPromise": True, "returnByValue": True,
        })
        assert "exceptionDetails" not in got, got
        return got["result"].get("value")


def load(tab, path, body, text=PDF_TEXT):
    tab.unroute("**/*")
    tab.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body}{BUILDS % text}"))
    tab.goto(HOST + path)
    return World(tab)


def read(world):
    return world.run("__sweep.readList()")


def press(world, doc_id):
    return world.run(f"__sweep.fetchPdf({{id: {doc_id!r}}})")


def test_a_page_that_refuses_inserted_scripts_is_saved_through_the_page_world_listener(tab):
    # Live, the inserted <script> did not run in the user's Chrome. The engine
    # now puts shelbycounty.main.js in the page's world (chrome.scripting, world
    # MAIN), and the press is watched through it. Here a policy lets only the
    # page's own nonce-tagged script run, so an inserted one cannot.
    body = table(receipt()) + (BUILDS % PDF_TEXT).replace("<script>", '<script nonce="site">')
    tab.unroute("**/*")
    tab.route("**/*", lambda route: route.fulfill(
        status=200, content_type="text/html", body=f"<!doctype html>{body}",
        headers={"Content-Security-Policy": "script-src 'nonce-site'"}))
    tab.goto(HOST + TX)
    world = World(tab)
    # Without the listener, nothing can watch the press.
    assert press(world, RECEIPT)["ok"] is False
    # With it, as the engine puts it there (Runtime.evaluate, like world MAIN, ignores the page's policy).
    tab.evaluate((ROOT / "providers" / "shelbycounty.main.js").read_text())
    got = press(world, RECEIPT)
    assert got["ok"] is True and got["base64"]


def test_a_bills_receipts_are_read_with_their_own_dates(tab):
    world = load(tab, TX, table(receipt()))
    got = read(world)
    assert got["state"] == "stopped" and "other bills" in got["why"]
    assert got["docs"] == [{"id": RECEIPT, "date": "2025-02-27", "title": "Property Tax Receipt", "method": "fetch"}]


def test_two_receipts_on_one_day_are_told_apart_and_newest_comes_first(tab):
    rows = receipt("7887650", "03/13/2020") + receipt("7887623", "03/13/2020") + receipt("7000001", "04/01/2021")
    world = load(tab, TX, table(rows, "PAGE 1 OF 1 TOTAL RECORDS: 3"))
    docs = read(world)["docs"]
    assert [d["date"] for d in docs] == ["2021-04-01", "2020-03-13", "2020-03-13"]
    assert docs[1]["title"] == "Property Tax Receipt (#7650)"


def test_an_empty_payment_history_still_leaves_the_other_bills(tab):
    world = load(tab, TX, "<p>No transactions for selected tax year</p>")
    got = read(world)
    assert got["state"] == "stopped" and "other bills" in got["why"] and got["docs"] == []


def test_a_second_parcels_receipt_has_its_own_id(tab):
    world = load(tab, bill_address("777777 00011"), table(receipt()))
    assert read(world)["docs"][0]["id"] == "receipt-77777700011-2025-02-27-7623"


def test_a_plus_in_the_bills_address_is_still_read(tab):
    address = bill_address("012345 00099", owner=">>>")
    assert "+" in address
    world = load(tab, address, table(receipt()))
    assert read(world)["docs"][0]["id"] == RECEIPT


@pytest.mark.parametrize("address", [
    "/Transaction?billNumberData=YWJj",
    "/Transaction?billNumberData=not*base64",
    bill_address(""),
    bill_address(None),
    bill_address("---"),
])
def test_a_bill_whose_parcel_cannot_be_read_stops(tab, address):
    world = load(tab, address, table(receipt()))
    got = read(world)
    assert got["state"] == "stopped" and "parcel" in got["why"] and got["docs"] == []


def test_a_sign_in_page_is_known(tab):
    world = load(tab, "/login", "<p>Sign in</p>")
    assert read(world) == {"state": "signed_out"}


def test_a_robot_check_waits_for_the_person(tab):
    world = load(tab, TX, "<p>Are you a robot?</p>")
    assert read(world) == {"state": "challenge"}


def test_the_bare_lookup_stops_and_says_what_to_do(tab):
    world = load(tab, "/Parcel", "<p>Search</p>")
    got = read(world)
    assert got["state"] == "stopped" and "parcel" in got["why"].lower()


def test_a_second_page_of_receipts_stops_with_what_was_read(tab):
    world = load(tab, TX, table(receipt(), "PAGE 1 OF 2 TOTAL RECORDS: 11"))
    got = read(world)
    assert got["state"] == "stopped" and len(got["docs"]) == 1


def test_a_second_page_is_avoided_by_the_sites_own_rows_picker(tab):
    # The live site shows 10 rows a page and has "Rows:" up to 50. The recipe
    # sets it so the whole table is on one page, then reads every receipt.
    many = [receipt(str(7000000 + i), f"0{1 + i % 9}/1{i % 9}/20{10 + i}") for i in range(12)]
    page = (
        "<h2>PAYMENT HISTORY</h2><table><tbody id=rows>" + "".join(many[:10]) + "</tbody></table>"
        "<div id=foot>PAGE 1 OF 2 TOTAL RECORDS: 12</div>"
        '<div><span>Rows:</span><select id=size><option value="5">5</option><option value="10" selected>10</option>'
        '<option value="20">20</option><option value="50">50</option></select></div>'
        "<script>const all = %s; document.getElementById('size').addEventListener('change', e => {"
        " const n = +e.target.value; setTimeout(() => { document.getElementById('rows').innerHTML = all.slice(0, n).join('');"
        " document.getElementById('foot').textContent = 'PAGE 1 OF ' + Math.ceil(all.length / n) + ' TOTAL RECORDS: 12'; }, 300); });</script>"
    ) % json.dumps(many)
    world = load(tab, TX, page)
    got = read(world)
    assert len(got["docs"]) == 12
    assert tab.evaluate("document.getElementById('size').value") == "20"
    assert tab.evaluate("JSON.parse(localStorage.getItem('statementSweepParcel'))") == "012345 00099"
    tab.evaluate("localStorage.clear()")


def test_a_count_that_does_not_add_up_stops(tab):
    world = load(tab, TX, table(receipt(), "PAGE 1 OF 1 TOTAL RECORDS: 2"))
    assert read(world)["state"] == "stopped"


@pytest.mark.parametrize("date", ["02/30/2025", "2025-02-27", ""])
def test_a_date_that_is_not_one_stops(tab, date):
    world = load(tab, TX, table(receipt(date=date)))
    assert read(world)["state"] == "stopped"


def test_a_page_saying_its_data_did_not_load_stops(tab):
    world = load(tab, TX, "<p>Data retrieval error</p>")
    assert read(world)["state"] == "stopped"


def test_a_parcel_page_stops_and_points_at_the_bills(tab):
    world = load(tab, PARCEL, "<table><tbody>" + bill() + "</tbody></table><div>PAGE 1 OF 1 TOTAL RECORDS: 1</div>")
    got = read(world)
    assert got["state"] == "stopped" and got["docs"] == []


def test_a_notice_is_listed_while_a_balance_is_due(tab):
    body = ("<p>TOTAL BALANCE\n$1,234.56</p><table><tbody>" + bill("2025") + bill("2024")
            + "</tbody></table><div>PAGE 1 OF 1 TOTAL RECORDS: 2</div><button class=notice>Print Notice</button>")
    world = load(tab, PARCEL, body.replace("TOTAL BALANCE\n", "TOTAL BALANCE<br>"))
    assert read(world)["docs"] == [{"id": f"notice-{KEY}-2025", "date": "2025-12-31", "title": "Property Tax Notice", "method": "fetch"}]


def test_a_second_parcels_notice_has_its_own_id_and_no_parcel_means_no_notice(tab):
    body = ("<p>TOTAL BALANCE<br>$1.00</p><table><tbody>" + bill("2025")
            + "</tbody></table><div>PAGE 1 OF 1 TOTAL RECORDS: 1</div><button class=notice>Print Notice</button>")
    world = load(tab, "/Parcel?parcel=777777%2000011", body)
    assert read(world)["docs"][0]["id"] == "notice-77777700011-2025"
    world = load(tab, "/Parcel?parcel=---", body)
    got = read(world)
    assert got["state"] == "stopped" and got["docs"] == []


def test_a_receipt_of_another_parcel_is_not_pressed(tab):
    world = load(tab, TX, table(receipt()))
    got = press(world, "receipt-77777700011-2025-02-27-7623")
    assert got["ok"] is False and "parcel" in got["why"]
    assert tab.evaluate("window.__press") is None


def test_a_notice_of_another_parcel_is_not_pressed(tab):
    body = ("<p>TOTAL BALANCE<br>$1.00</p><table><tbody>" + bill("2025")
            + "</tbody></table><div>PAGE 1 OF 1 TOTAL RECORDS: 1</div><button class=notice>Print Notice</button>")
    world = load(tab, PARCEL, body)
    got = press(world, "notice-77777700011-2025")
    assert got["ok"] is False and "parcel" in got["why"]
    assert tab.evaluate("window.__press") is None


def test_an_old_id_with_no_parcel_is_refused(tab):
    world = load(tab, TX, table(receipt()))
    assert press(world, "receipt-2025-02-27-7623")["ok"] is False


def test_the_page_is_left_as_it_was_when_the_file_cannot_be_read(tab):
    world = load(tab, TX, table(receipt()))
    before = tab.evaluate("[window.open.toString(), URL.createObjectURL.toString()]")
    tab.evaluate("""window.__make = () => {
      const blob = new Blob(['%PDF-1.3'], {type: 'application/pdf'});
      blob.arrayBuffer = () => Promise.reject(new Error('could not be read'));
      window.open(URL.createObjectURL(blob));
    }""")
    got = press(world, RECEIPT)
    assert got["ok"] is False and "not a PDF" in got["why"]
    assert tab.evaluate("[window.open.toString(), URL.createObjectURL.toString()]") == before


def test_the_pdf_the_page_builds_is_kept(tab):
    world = load(tab, TX, table(receipt()))
    got = press(world, RECEIPT)
    assert got["ok"] and base64.b64decode(got["base64"]).decode() == PDF_TEXT
    assert tab.evaluate("window.__press") == 1


def test_the_page_is_left_as_it_was_after_a_press(tab):
    world = load(tab, TX, table(receipt()))
    before = tab.evaluate("[window.open.toString(), URL.createObjectURL.toString()]")
    press(world, RECEIPT)
    assert tab.evaluate("[window.open.toString(), URL.createObjectURL.toString()]") == before


def test_it_presses_only_the_receipt_it_is_asked_for(tab):
    world = load(tab, TX, table(receipt("7887623") + receipt("7000001", "04/01/2021"), "PAGE 1 OF 1 TOTAL RECORDS: 2"))
    press(world, RECEIPT)
    assert tab.evaluate("window.__press") == 1


def test_a_pdf_naming_another_receipt_is_refused(tab):
    world = load(tab, TX, table(receipt("7887624")))
    got = press(world, f"receipt-{KEY}-2025-02-27-7624")
    assert got["ok"] is False and "number" in got["why"]


def test_bytes_that_are_not_a_pdf_are_refused(tab):
    world = load(tab, TX, table(receipt()), text="<html>not a pdf</html>")
    assert press(world, RECEIPT)["ok"] is False


def test_two_files_from_one_press_are_refused(tab):
    world = load(tab, TX, table(receipt()))
    tab.evaluate("window.__make = () => { makes(window.__text, 'application/pdf'); makes(window.__text, 'application/pdf'); }")
    got = press(world, RECEIPT)
    assert got["ok"] is False and "exactly one" in got["why"]


def test_a_receipt_not_on_the_page_is_refused(tab):
    world = load(tab, TX, table(receipt()))
    assert press(world, f"receipt-{KEY}-2025-03-01-1111")["ok"] is False


def test_a_bad_id_is_refused(tab):
    world = load(tab, TX, table(receipt()))
    assert press(world, "../../etc")["ok"] is False


# ---- The walk: parcel page, then each bill by its own link ----

def serve(tab, pages):
    """Serve each address in `pages` as its own page; None answers 204, which
    leaves the tab where it was."""
    def answer(route):
        path = route.request.url[len(HOST):]
        if path in pages and pages[path] is None:
            return route.fulfill(status=204, body="")
        page = pages.get(path, "<p>Not found</p>")
        route.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{page}{BUILDS % PDF_TEXT}")
    tab.unroute("**/*")
    tab.route("**/*", answer)


def forget(tab):
    tab.evaluate("localStorage.clear(); sessionStorage.clear()")


def walk(tab):
    return World(tab).run("__sweep.readList({walk: true})")


def step(tab, moves=True):
    world = World(tab)
    if not moves:
        return world.run("__sweep.nextView()")
    with tab.expect_navigation():
        return world.run("__sweep.nextView()")


def walk_state(tab):
    return tab.evaluate("JSON.parse(sessionStorage.getItem('statementSweepWalk'))")


def bill_row(year, parcel="012345 00099", number=None):
    href = bill_address(parcel, billNumber=number or int(year) * 10).lstrip("/")
    return f'<tr><td><a href="{href}">{number or year}</a></td><td>{year}</td><td>County</td><td>$1</td></tr>'


def parcel_page(years, due=True, extra=""):
    rows = "".join(bill_row(y) for y in years) + extra
    notice = "<p>TOTAL BALANCE<br>$1,234.56</p><button class=notice>Print Notice</button>" if due else ""
    count = len(years) + (1 if extra else 0)
    return f"{notice}<table><tbody>{rows}</tbody></table><div>PAGE 1 OF 1 ROWS: 10 TOTAL RECORDS: {count}</div>"


def bill_of(year, parcel="012345 00099"):
    return bill_address(parcel, billNumber=int(year) * 10)


def start(tab, pages, at=PARCEL):
    serve(tab, pages)
    tab.goto(HOST + at)
    forget(tab)


def test_the_walk_goes_to_every_bill_newest_first_and_ends(tab):
    pages = {
        PARCEL: parcel_page(["2023", "2025", "2024"]),
        bill_of("2025"): table(receipt("7000002", "02/27/2026") + receipt("7887623", "02/27/2025"), "PAGE 1 OF 1 TOTAL RECORDS: 2"),
        bill_of("2024"): "<p>No transactions for selected tax year</p>",
        bill_of("2023"): table(receipt("7111111", "01/15/2024")),
    }
    start(tab, pages)
    got = walk(tab)
    assert got == {"state": "ok", "more": True,
                   "docs": [{"id": f"notice-{KEY}-2025", "date": "2025-12-31", "title": "Property Tax Notice", "method": "fetch"}]}
    seen, visited = [d["id"] for d in got["docs"]], []
    while True:
        moved = step(tab, moves=walk_state(tab)["at"] + 1 < 3)
        if not moved["moved"]:
            break
        visited.append(tab.url[len(HOST):])
        got = walk(tab)
        assert got["state"] == "ok" and got["more"] is True and "note" not in got
        seen += [d["id"] for d in got["docs"]]
    assert visited == [bill_of("2025"), bill_of("2024"), bill_of("2023")]
    assert seen == [f"notice-{KEY}-2025", f"receipt-{KEY}-2026-02-27-0002", RECEIPT, f"receipt-{KEY}-2024-01-15-1111"]
    assert walk_state(tab) is None
    assert tab.evaluate("localStorage.getItem('statementSweepParcel')") == json.dumps("012345 00099")


def test_a_remembered_parcel_is_opened_on_a_later_walk(tab):
    pages = {PARCEL: parcel_page(["2025"]), "/Parcel": "<p>Search</p>"}
    start(tab, pages)
    assert walk(tab)["state"] == "ok"
    tab.goto(HOST + "/Parcel")
    tab.evaluate("sessionStorage.clear()")
    world = World(tab)
    with tab.expect_navigation():
        assert world.run("__sweep.readList({walk: true})") == {"state": "walking"}
    assert tab.url == HOST + PARCEL
    got = walk(tab)
    assert got["state"] == "ok" and got["more"] is True


def test_a_remembered_parcel_that_does_not_open_is_not_sent_for_again(tab):
    start(tab, {PARCEL: parcel_page(["2025"])})
    walk(tab)
    serve(tab, {PARCEL: None, "/Parcel": "<p>Search</p>"})
    tab.goto(HOST + "/Parcel")
    tab.evaluate("sessionStorage.clear()")
    assert walk(tab) == {"state": "walking"}
    tab.wait_for_timeout(300)
    assert tab.url == HOST + "/Parcel" and walk(tab) == {"state": "walking"}
    tab.evaluate("sessionStorage.setItem('statementSweepSent', String(Date.now() - 31000))")
    got = walk(tab)
    assert got["state"] == "stopped" and "Look up your parcel" in got["why"]


def test_with_no_parcel_remembered_the_sweep_waits_for_the_lookup(tab):
    start(tab, {"/Parcel": "<p>Search</p>"}, at="/Parcel")
    got = walk(tab)
    assert got["state"] == "waiting" and "Look up your parcel" in got["why"] and "remembers it" in got["why"]
    assert tab.url == HOST + "/Parcel"


@pytest.mark.parametrize("remembered", ['"../../evil"', '"x?y=1"', '"a/b"', "{}", "not json"])
def test_an_odd_remembered_parcel_is_not_used(tab, remembered):
    start(tab, {"/Parcel": "<p>Search</p>"}, at="/Parcel")
    tab.evaluate(f"localStorage.setItem('statementSweepParcel', {json.dumps(remembered)})")
    got = walk(tab)
    assert got["state"] == "waiting" and "Look up your parcel" in got["why"]
    tab.wait_for_timeout(300)
    assert tab.url == HOST + "/Parcel"


def test_without_walk_only_the_parcel_is_remembered_and_nothing_opened(tab):
    start(tab, {PARCEL: parcel_page(["2025", "2024"]), "/Parcel": "<p>Search</p>", bill_of("2025"): table(receipt())})
    got = read(World(tab))
    assert got["state"] == "stopped" and "each bill's own page" in got["why"] and len(got["docs"]) == 1
    # A parcel the person looked up in their own tab is kept for the next sweep;
    # no walk is started and nothing else is stored.
    assert tab.evaluate("[localStorage.length, sessionStorage.length]") == [1, 0]
    assert tab.evaluate("JSON.parse(localStorage.getItem('statementSweepParcel'))").strip()
    tab.evaluate("localStorage.clear()")
    tab.evaluate("localStorage.setItem('statementSweepParcel', JSON.stringify('012345 00099'))")
    tab.goto(HOST + "/Parcel")
    got = read(World(tab))
    assert got["state"] == "stopped" and "Look up your parcel" in got["why"]
    tab.wait_for_timeout(300)
    assert tab.url == HOST + "/Parcel"
    tab.goto(HOST + bill_of("2025"))
    got = read(World(tab))
    assert got["state"] == "stopped" and "other bills" in got["why"] and got["docs"][0]["id"] == RECEIPT
    assert World(tab).run("__sweep.nextView()") == {"why": "No walk of the parcel's bills is under way in this tab."}
    assert tab.url == HOST + bill_of("2025")


def test_a_billing_row_linking_to_another_parcels_bill_stops(tab):
    start(tab, {PARCEL: parcel_page(["2025"], extra=bill_row("2024", parcel="777777 00011"))})
    got = walk(tab)
    assert got["state"] == "stopped" and "parcel" in got["why"] and got["docs"] == []
    assert walk_state(tab) is None


@pytest.mark.parametrize("href", [
    "https://payit901.example/Transaction?billNumberData=" + bill_of("2024").split("=", 1)[1],
    "//elsewhere.example/Transaction?billNumberData=" + bill_of("2024").split("=", 1)[1],
    bill_of("2024").lstrip("/") + "&billNumberData=" + bill_of("2023").split("=", 1)[1],
    bill_of("2024").lstrip("/") + "&pay=1",
    "/Parcel/Transaction?billNumberData=" + bill_of("2024").split("=", 1)[1],
])
def test_a_billing_row_linking_anywhere_else_stops(tab, href):
    row = f'<tr><td><a href="{href}">1</a></td><td>2024</td><td>County</td><td>$1</td></tr>'
    start(tab, {PARCEL: parcel_page(["2025"], extra=row)})
    got = walk(tab)
    assert got["state"] == "stopped" and "not a bill of this parcel" in got["why"] and got["docs"] == []
    assert walk_state(tab) is None


def test_a_bill_page_for_another_parcel_stops_the_walk(tab):
    other = bill_address("777777 00011", billNumber=5)
    start(tab, {PARCEL: parcel_page(["2025"]), other: table(receipt())})
    walk(tab)
    tab.goto(HOST + other)
    got = walk(tab)
    assert got["state"] == "stopped" and "another parcel" in got["why"] and got["docs"] == []
    assert walk_state(tab) is None


def test_a_bill_the_walk_did_not_open_stops(tab):
    start(tab, {PARCEL: parcel_page(["2025", "2024"]), bill_of("2024"): table(receipt())})
    walk(tab)
    tab.goto(HOST + bill_of("2024"))
    got = walk(tab)
    assert got["state"] == "stopped" and "not the one the walk opened" in got["why"]


def test_next_view_away_from_the_walks_page_stops(tab):
    start(tab, {PARCEL: parcel_page(["2025"]), "/Other": "<p>x</p>"})
    walk(tab)
    tab.goto(HOST + "/Other")
    got = step(tab, moves=False)
    assert "why" in got and walk_state(tab) is None


def test_a_bill_with_a_table_problem_is_a_note_and_the_walk_goes_on(tab):
    pages = {
        PARCEL: parcel_page(["2025", "2024"], due=False),
        bill_of("2025"): table(receipt(), "PAGE 1 OF 2 TOTAL RECORDS: 11"),
        bill_of("2024"): table(receipt("7111111", "01/15/2024")),
    }
    start(tab, pages)
    assert walk(tab) == {"state": "ok", "docs": [], "more": True}
    assert step(tab) == {"moved": True}
    got = walk(tab)
    assert got["state"] == "ok" and got["more"] is True and [d["id"] for d in got["docs"]] == [RECEIPT]
    assert "2025 bill" in got["note"] and "2 pages" in got["note"]
    assert step(tab) == {"moved": True}
    got = walk(tab)
    assert got["state"] == "ok" and "note" not in got and [d["id"] for d in got["docs"]] == [f"receipt-{KEY}-2024-01-15-1111"]
    assert step(tab, moves=False) == {"moved": False}


def test_a_bad_receipt_row_is_a_note_too(tab):
    start(tab, {PARCEL: parcel_page(["2025"], due=False), bill_of("2025"): table(receipt(date="02/30/2025"))})
    walk(tab)
    step(tab)
    got = walk(tab)
    assert got["state"] == "ok" and got["docs"] == [] and "calendar date" in got["note"]


def test_a_bill_page_still_drawing_is_waited_for(tab):
    start(tab, {PARCEL: parcel_page(["2025"], due=False), bill_of("2025"): "<p>Loading</p>"})
    walk(tab)
    step(tab)
    assert walk(tab) == {"state": "walking"}
    tab.evaluate("const s = JSON.parse(sessionStorage.getItem('statementSweepSeen')); s.at -= 31000; sessionStorage.setItem('statementSweepSeen', JSON.stringify(s))")
    got = walk(tab)
    assert got["state"] == "ok" and "neither rows" in got["note"]


def test_a_parcel_page_still_drawing_is_waited_for(tab):
    start(tab, {PARCEL: "<p>Loading</p>"})
    assert walk(tab) == {"state": "walking"}


def test_the_old_page_still_showing_after_a_move_is_waited_for(tab):
    start(tab, {PARCEL: parcel_page(["2025"], due=False), bill_of("2025"): None})
    walk(tab)
    assert step(tab, moves=False) == {"moved": True}
    tab.wait_for_timeout(300)
    assert tab.url == HOST + PARCEL
    assert walk(tab) == {"state": "walking"}
    tab.evaluate("const w = JSON.parse(sessionStorage.getItem('statementSweepWalk')); w.since -= 31000; sessionStorage.setItem('statementSweepWalk', JSON.stringify(w))")
    got = walk(tab)
    assert got["state"] == "stopped" and "did not open" in got["why"]


def test_the_walk_is_capped(tab):
    years = [str(y) for y in range(1965, 2026)]
    start(tab, {PARCEL: parcel_page(years, due=False)})
    got = walk(tab)
    assert got["state"] == "ok" and "61 bills" in got["note"] and "newest 60" in got["note"]
    bills = walk_state(tab)["bills"]
    assert len(bills) == 60 and bills[0]["year"] == "2025" and bills[-1]["year"] == "1966"
