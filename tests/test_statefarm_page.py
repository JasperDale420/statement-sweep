"""The State Farm page logic, in a real Chromium, on stand-in pages. A control
carrying its own PDF link is fetched; a View Documents row is listed by its
date, and clickDoc opens the row once and presses the one document it reveals,
which opens as a blob in a new tab. Every date and name is invented."""
import base64
from datetime import date, timedelta
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://edocuments.statefarm.com"
PAGE = "/DocumentCenterUI/"
PRESS = "window.pressed = (window.pressed || 0) + 1"
LINK = "/DocumentCenterProxyV1/document/abc/file.pdf"
OTHER = "/DocumentCenterProxyV1/document/def/file.pdf"
AHEAD = (date.today() + timedelta(days=700)).strftime("%m/%d/%Y")

# The stand-in Document Center: rows fold like an accordion, one open at a
# time; `redraw` draws the pressed row anew, open; `byPlace` opens the row
# above instead. A document opens in a new tab as a blob the page made.
SCRIPT = """<script>
window.views = []; window.opened = []; window.blobs = [];
function openDoc(a) {
  opened.push(a.innerText);
  const bytes = new TextEncoder().encode('%PDF-1.4 ' + a.innerText);
  blobs.push(URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'})));
  window.open(blobs[blobs.length - 1], '_blank');
}
function toggle(btn) {
  views.push(btn.innerText);
  document.querySelectorAll('[role=row]').forEach(r => {
    const v = r.querySelector('button.view');
    if (!v) return;
    const open = v === btn && v.getAttribute('aria-expanded') !== 'true';
    v.setAttribute('aria-expanded', open ? 'true' : 'false');
    r.querySelector('.docs').hidden = !open;
  });
}
function redraw(btn) {
  views.push(btn.innerText);
  const r = btn.closest('[role=row]');
  const n = r.cloneNode(true);
  n.querySelector('.docs').hidden = false;
  n.querySelector('button.view').setAttribute('aria-expanded', 'true');
  setTimeout(() => r.replaceWith(n), 200);
}
function byPlace(btn) {
  views.push(btn.innerText);
  const rows = [...document.querySelectorAll('[role=row]')];
  rows[rows.indexOf(btn.closest('[role=row]')) - 1].querySelector('.docs').hidden = false;
}
</script>"""


def row(when, control, more=""):
    return f'<div role="row"><span>{when}</span> {control} <span>{more}</span></div>'


def link(name, href=LINK):
    return f'<a href="{href}" onclick="{PRESS}; return false">{name}</a>'


def vrow(when, docs, n=1, kind="", opens="toggle", extra=""):
    """A row whose documents are folded behind its own View Documents."""
    if isinstance(docs, str):
        docs = [docs]
    links = "".join(d if d.startswith("<") else f"<a href='#' onclick='openDoc(this);return false'>{d}</a>" for d in docs)
    return (f"<div role='row'><span>{when}</span> <span>{kind}</span> "
            f"<span>Available online until {AHEAD}</span>{extra}"
            f"<button class='view' aria-expanded='false' onclick='{opens}(this)'>View Documents{n}</button>"
            f"<div class='docs' hidden>{links}</div></div>")


VIEW = vrow("03/14/2026", "Renewal Notice - 2017 Invented Roadster")


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, url, body, pdf=None):
    def route(r):
        if ".pdf" in r.request.url and pdf:
            r.fulfill(**pdf)
        elif r.request.url.startswith(BASE):
            r.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body}{SCRIPT}")
        else:
            r.abort()
    for extra in tab.context.pages:
        if extra is not tab:
            extra.close()
    tab.goto("about:blank")
    tab.unroute("**/*")
    tab.route("**/*", route)
    tab.goto(url)
    tab.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    tab.add_script_tag(content=(ROOT / "providers" / "statefarm.page.js").read_text())


def read(tab):
    return tab.evaluate("__sweep.readList()")


def doc():
    return {"id": LINK, "date": "2026-05-08", "title": "Account Statement", "method": "fetch", "url": BASE + LINK}


def rdoc(when="2026-03-14", title="Renewal Notice"):
    return {"id": f"row:{when}", "date": when, "title": title, "method": "newtab"}


def press(tab, d):
    """clickDoc, which has to open exactly one tab, a blob of the page's own."""
    with tab.expect_popup(timeout=20000) as pop:
        got = tab.evaluate("(d) => __sweep.clickDoc(d)", d)
    assert got == {"ok": True}
    pop.value.close()
    return tab.evaluate("blobs[blobs.length - 1]")


def refused(tab, d):
    got = tab.evaluate("(d) => __sweep.clickDoc(d)", d)
    assert got["ok"] is False and got["why"]
    assert tab.evaluate("window.opened") == [] and len(tab.context.pages) == 1
    return got["why"]


# Listing

def test_documents_with_their_own_link_are_read_newest_first(tab):
    load(tab, BASE + PAGE, row("03/14/2026", link("View PDF", OTHER)) + row("05/08/2026", link("Download Statement")))
    got = read(tab)
    assert got["state"] == "ok"
    assert [d["date"] for d in got["docs"]] == ["2026-05-08", "2026-03-14"]
    assert got["docs"][0] == doc()
    assert tab.evaluate("window.pressed") is None


def test_a_view_documents_row_is_listed_by_its_date_and_not_pressed(tab):
    load(tab, BASE + PAGE, row("05/08/2026", link("View PDF")) + vrow("03/14/2026", "Renewal Notice - 2017 Invented Roadster", kind="Renewal Notice")
         + vrow("01/27/2026", "Payment Receipt - Payment Receipt", n=2))
    got = read(tab)
    assert got["state"] == "ok" and "Time Period" in got["note"]
    assert got["docs"] == [doc(), rdoc(), rdoc("2026-01-27", "Document")]
    assert tab.evaluate("window.views") == [] and tab.evaluate("window.pressed") is None


def test_a_row_naming_two_types_is_titled_document(tab):
    load(tab, BASE + PAGE, vrow("03/14/2026", "Renewal Notice - Auto", kind="Renewal Notice, Declarations Page"))
    assert read(tab)["docs"] == [rdoc(title="Document")]


def test_an_open_rows_documents_are_not_listed_apart_from_it(tab):
    load(tab, BASE + PAGE, VIEW)
    tab.evaluate("toggle(document.querySelector('button.view'))")
    got = read(tab)
    assert got["state"] == "ok" and [d["id"] for d in got["docs"]] == ["row:2026-03-14"]


def test_two_rows_on_one_date_are_left_and_said(tab):
    load(tab, BASE + PAGE, vrow("03/14/2026", "Renewal Notice - Auto") + vrow("03/14/2026", "Payment Receipt - Payment Receipt", n=2)
         + vrow("01/27/2026", "Payment Receipt - Payment Receipt", n=3))
    got = read(tab)
    assert got["state"] == "stopped" and "share their date" in got["why"]
    assert [d["id"] for d in got["docs"]] == ["row:2026-01-27"]


def test_a_row_sharing_its_date_with_a_link_elsewhere_is_left(tab):
    load(tab, BASE + PAGE, row("03/14/2026", link("View PDF")) + VIEW)
    got = read(tab)
    assert got["state"] == "stopped" and [d["method"] for d in got["docs"]] == ["fetch"]


def test_a_row_whose_date_cannot_be_read_stops(tab):
    load(tab, BASE + PAGE, vrow("soon", "Renewal Notice - Auto"))
    assert read(tab)["state"] == "stopped"


def test_a_control_with_no_link_and_no_row_is_said(tab):
    load(tab, BASE + PAGE, VIEW + row("05/08/2026", "<button>View PDF</button>"))
    got = read(tab)
    assert got["state"] == "stopped" and "no PDF link" in got["why"]
    assert [d["id"] for d in got["docs"]] == ["row:2026-03-14"]


def test_a_day_the_document_stays_online_until_is_not_its_date(tab):
    load(tab, BASE + PAGE, row("05/08/2026", link("View PDF"), more=f"Available until {AHEAD}"))
    assert read(tab)["docs"][0]["date"] == "2026-05-08"


def test_a_tax_form_is_named_as_one(tab):
    load(tab, BASE + PAGE, row("01/24/2026", link("1098 PDF")))
    assert read(tab)["docs"][0]["title"] == "Tax Document"


@pytest.mark.parametrize("path", ["/login", "/auth/x", "/mfa", "/verification", "/challenge"])
def test_a_sign_in_address_is_signed_out(tab, path):
    load(tab, BASE + path, "<p>hello</p>")
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_signed_out(tab):
    load(tab, BASE + PAGE, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_needs_the_person(tab):
    load(tab, BASE + PAGE, "<h1>Let's verify it's you</h1><p>Enter the code</p>")
    assert read(tab) == {"state": "challenge"}


def test_a_document_control_is_not_a_security_check(tab):
    load(tab, BASE + PAGE, row("05/08/2026", link("View PDF")) + "<p>Unusual activity</p>")
    assert read(tab)["state"] == "ok"


def test_another_page_is_not_the_list_yet(tab):
    load(tab, BASE + "/other", "<p>hello</p>")
    assert read(tab) == {"state": "no_list"}


def test_a_row_with_two_dates_stops_rather_than_pick_one(tab):
    load(tab, BASE + PAGE, row("05/08/2026", link("View PDF"), more="03/14/2026"))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


@pytest.mark.parametrize("when", ["02/31/2026", "soon"])
def test_a_date_that_is_not_one_stops(tab, when):
    load(tab, BASE + PAGE, row(when, link("View PDF")))
    assert read(tab)["state"] == "stopped"


def test_a_pay_control_is_not_a_document(tab):
    load(tab, BASE + PAGE, row("05/08/2026", link("View payment PDF")))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


def test_a_link_to_another_host_is_not_a_document(tab):
    load(tab, BASE + PAGE, row("05/08/2026", link("View PDF", "https://evil.example/file.pdf")))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


# Fetching a control's own link

def test_an_official_pdf_comes_back_whole(tab):
    data = b"%PDF-1.7 " + bytes(range(256)) * 400
    load(tab, BASE + PAGE, row("05/08/2026", link("View PDF")), pdf=dict(status=200, content_type="application/pdf", body=data))
    got = tab.evaluate("(d) => __sweep.fetchPdf(d)", doc())
    assert got["ok"] and base64.b64decode(got["base64"]) == data


def test_html_labelled_as_a_pdf_is_not_kept(tab):
    load(tab, BASE + PAGE, row("05/08/2026", link("View PDF")), pdf=dict(status=200, content_type="application/pdf", body=b"<html>"))
    assert tab.evaluate("(d) => __sweep.fetchPdf(d)", doc())["ok"] is False


@pytest.mark.parametrize("bad", [
    {"id": "x", "url": "https://evil.example/file.pdf"},
    {"id": "/DocumentCenterUI/", "url": BASE + "/DocumentCenterUI/"},
    {"id": "/wrong", "url": BASE + LINK},
    {"id": "x"}])
def test_an_address_this_did_not_read_is_refused(tab, bad):
    load(tab, BASE + PAGE, row("05/08/2026", link("View PDF")))
    assert tab.evaluate("(d) => __sweep.fetchPdf(d)", bad)["ok"] is False


# Pressing a row, then its document

@pytest.mark.parametrize("name,title", [
    ("Renewal Notice - 2017 Invented Roadster", "Renewal Notice"),
    ("Renewal Notice - 2019 Invented Wagon Limited", "Renewal Notice"),
    ("Payment Receipt - Billing/Payments", "Payment Receipt"),
    ("Payment Receipt - Payment Receipt", "Document"),
])
def test_the_row_is_opened_once_and_its_document_opens_in_a_new_tab(tab, name, title):
    load(tab, BASE + PAGE, vrow("05/08/2026", "Declarations Page - Homeowners", n=0) + vrow("03/14/2026", name, n=1))
    url = press(tab, rdoc(title=title))
    assert url.startswith(BASE.replace("https://", "blob:https://") + "/")
    assert tab.evaluate("window.views") == ["View Documents1"]
    assert tab.evaluate("window.opened") == [name]


def test_the_next_row_is_pressed_from_where_the_last_one_left_the_tab(tab):
    load(tab, BASE + PAGE, vrow("05/08/2026", "Payment Receipt - Payment Receipt", n=0) + vrow("03/14/2026", "Renewal Notice - Auto", n=1))
    press(tab, rdoc("2026-05-08", "Payment Receipt"))
    press(tab, rdoc("2026-03-14", "Renewal Notice"))
    assert tab.evaluate("window.views") == ["View Documents0", "View Documents1"]
    assert tab.evaluate("window.opened") == ["Payment Receipt - Payment Receipt", "Renewal Notice - Auto"]


def test_an_open_row_is_not_pressed_again(tab):
    load(tab, BASE + PAGE, VIEW)
    tab.evaluate("toggle(document.querySelector('button.view')); views.length = 0")
    press(tab, rdoc())
    assert tab.evaluate("window.views") == []


def test_a_row_drawn_anew_by_its_press_is_found_again_by_its_date(tab):
    load(tab, BASE + PAGE, vrow("03/14/2026", "Renewal Notice - Auto", opens="redraw"))
    press(tab, rdoc())
    assert tab.evaluate("window.views") == ["View Documents1"]


def test_a_row_open_with_nothing_showing_is_not_pressed(tab):
    load(tab, BASE + PAGE, VIEW)
    tab.evaluate("document.querySelector('button.view').setAttribute('aria-expanded', 'true')")
    assert "Reload" in refused(tab, rdoc())
    assert tab.evaluate("window.views") == []


def test_a_document_of_another_type_is_not_pressed(tab):
    load(tab, BASE + PAGE, vrow("03/14/2026", "Declarations Page - Homeowners"))
    assert "no document of this kind" in refused(tab, rdoc(title="Renewal Notice"))


@pytest.mark.parametrize("shown", [
    "Pay Now - Payment Receipt",
    "Payment Receipt - Switch to autopay",
    "Renewal Notice - 2025 Switch to Limited Tort",
    "Renewal Notice - Sign in to view",
    "<a href='#' aria-label='Make a payment' onclick='openDoc(this);return false'>Renewal Notice - Auto</a>",
])
def test_a_document_the_guard_refuses_is_not_pressed(tab, shown):
    load(tab, BASE + PAGE, vrow("03/14/2026", shown))
    refused(tab, rdoc(title="Document"))


def test_a_row_with_two_documents_and_no_type_presses_neither(tab):
    load(tab, BASE + PAGE, vrow("03/14/2026", ["Renewal Notice - Auto", "Declarations Page - Auto"]))
    assert "more than one" in refused(tab, rdoc(title="Document"))


def test_a_row_with_two_documents_presses_the_one_of_its_type(tab):
    load(tab, BASE + PAGE, vrow("03/14/2026", ["Declarations Page - Auto", "Renewal Notice - Auto"]))
    press(tab, rdoc())
    assert tab.evaluate("window.opened") == ["Renewal Notice - Auto"]


def test_two_rows_on_one_date_press_nothing(tab):
    load(tab, BASE + PAGE, vrow("03/14/2026", "Renewal Notice - Auto") + vrow("03/14/2026", "Renewal Notice - Home", n=2))
    assert "Two rows" in refused(tab, rdoc())
    assert tab.evaluate("window.views") == []


def test_a_press_that_opens_another_row_presses_no_document(tab):
    load(tab, BASE + PAGE, vrow("05/08/2026", "Renewal Notice - Home", n=0) + vrow("03/14/2026", "Renewal Notice - Auto", opens="byPlace"))
    assert "showed no document" in refused(tab, rdoc())
    assert tab.evaluate("window.views") == ["View Documents1"]


def test_another_rows_view_documents_inside_the_row_presses_nothing(tab):
    inner = "<span role='button' class='other'>View Documents7</span>"
    load(tab, BASE + PAGE, vrow("03/14/2026", "Renewal Notice - Auto", extra=inner))
    refused(tab, rdoc())
    assert tab.evaluate("window.views") == []


def test_a_row_is_not_pressed_when_the_tab_is_signed_out(tab):
    load(tab, BASE + PAGE, VIEW + "<input type=password>")
    assert "sign-in" in refused(tab, rdoc())
    assert tab.evaluate("window.views") == []


@pytest.mark.parametrize("bad", [
    {"id": "row:2026-03-14", "date": "2026-03-14", "method": "click"},
    {"id": "row:2026-01-01", "date": "2026-03-14", "method": "newtab"},
    {"id": "row:soon", "date": "soon", "method": "newtab"},
    {"id": LINK, "date": "2026-03-14", "method": "newtab"}])
def test_a_document_this_did_not_list_is_refused(tab, bad):
    load(tab, BASE + PAGE, VIEW)
    refused(tab, bad)
    assert tab.evaluate("window.views") == []
