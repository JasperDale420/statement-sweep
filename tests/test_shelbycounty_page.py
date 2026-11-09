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
