"""The Nelnet page logic, in a real Chromium, on stand-in pages."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://nelnet.studentaid.gov"
INBOX = "/documents/inbox-statements"


def row(date="09/27/2026", subject="09/27/2026 Statement", ident="statement-1", label=None, extra=""):
    aria = label if label is not None else f"Download document with subject {subject}"
    return (f'<tr><td>{date}</td><td><a data-cy="document-view-{ident}"><span class="sr-only">Open</span>{subject}</a></td>'
            f'<td><button data-cy="document-download-{ident}" aria-label="{aria}" onclick="press(this)" {extra}>Download</button></td></tr>')


def page_of(rows, pager=""):
    return (f'<main><table><thead><tr><th>Date</th><th>Subject</th><th></th></tr></thead><tbody>{rows}</tbody></table>{pager}</main>'
            "<script>window.pressed=[];function press(b){pressed.push(b.dataset.cy)}</script>")


LAST = ('<button aria-label="Next Page" aria-disabled="true"></button>'
        '<button aria-label="Go to first page" aria-disabled="true"></button>')


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, body, path=INBOX, host=BASE):
    def respond(route):
        if route.request.url.startswith(host):
            route.fulfill(status=200, content_type="text/html", body=f"<!doctype html><title>Nelnet</title>{body}")
        else:
            route.abort()
    tab.unroute("**/*")
    tab.route("**/*", respond)
    tab.goto(host + path)
    tab.add_script_tag(content=(ROOT / "providers" / "nelnet.page.js").read_text())


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_a_list_reads_newest_first_with_its_own_ids_and_names(tab):
    rows = row("08/27/2026", "08/27/2026 Statement", "statement-1") + row("9/27/26", "Annual Repayment Notice", "letter-2")
    load(tab, page_of(rows, LAST))
    assert read(tab) == {"state": "ok", "docs": [
        {"id": "letter-2", "date": "2026-09-27", "title": "Annual Repayment Notice", "method": "click"},
        {"id": "statement-1", "date": "2026-08-27", "title": "Statement", "method": "click"},
    ]}


def test_signed_out_on_the_auth_host_and_by_password_field(tab):
    load(tab, "", path="/", host="https://auth.nelnet.studentaid.gov")
    assert read(tab) == {"state": "signed_out"}
    load(tab, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_is_a_challenge(tab):
    load(tab, "<main>Check your email for a verification code</main>")
    assert read(tab) == {"state": "challenge"}


def test_another_page_is_not_the_list(tab):
    load(tab, "<main>Summary</main>", path="/loans")
    assert read(tab) == {"state": "no_list"}


def test_a_list_with_a_next_page_stops_with_what_was_read(tab):
    load(tab, page_of(row(), '<button aria-label="Next Page" aria-disabled="false"></button>'))
    got = read(tab)
    assert got["state"] == "stopped" and len(got["docs"]) == 1


def test_a_list_not_on_its_first_page_stops(tab):
    load(tab, page_of(row(), '<button aria-label="Next Page" aria-disabled="true"></button>'
                             '<button aria-label="Go to first page" aria-disabled="false"></button>'))
    assert read(tab)["state"] == "stopped"


@pytest.mark.parametrize("date", ["", "13/45/2026", "09/27/2026 and 10/27/2026"])
def test_a_date_that_is_not_one_stops(tab, date):
    load(tab, page_of(row(date=date), LAST))
    assert read(tab)["state"] == "stopped"


def test_a_row_whose_id_is_not_plain_stops(tab):
    load(tab, page_of(row(ident="x.y", label="Download document with subject Notice"), LAST))
    assert read(tab)["state"] == "stopped"


def test_a_row_whose_button_also_pays_stops(tab):
    load(tab, page_of(row(label="Make a payment"), LAST))
    assert read(tab)["state"] == "stopped"


def test_the_guard_reads_the_control_and_not_the_title_of_its_document(tab):
    load(tab, page_of(row(subject="Deferment Approved", ident="letter-9"), LAST))
    assert read(tab)["state"] == "ok"
    assert tab.evaluate("__sweep.clickDoc({id: 'letter-9', date: '2026-09-27'})") == {"ok": True}


def test_click_presses_only_its_own_row(tab):
    load(tab, page_of(row(ident="a-1") + row("08/27/2026", ident="a-2"), LAST))
    assert tab.evaluate("__sweep.clickDoc({id: 'a-2', date: '2026-08-27'})") == {"ok": True}
    assert tab.evaluate("pressed") == ["document-download-a-2"]


@pytest.mark.parametrize("doc", [
    "{id: 'a-9', date: '2026-09-27'}",
    "{id: 'a-1', date: '2026-01-01'}",
    "{id: '\"] x', date: '2026-09-27'}",
])
def test_a_document_that_cannot_be_bound_presses_nothing(tab, doc):
    load(tab, page_of(row(ident="a-1"), LAST))
    assert tab.evaluate(f"__sweep.clickDoc({doc})")["ok"] is False
    assert tab.evaluate("pressed") == []


def test_a_turned_off_button_is_not_pressed(tab):
    load(tab, page_of(row(ident="a-1", extra="disabled"), LAST))
    assert tab.evaluate("__sweep.clickDoc({id: 'a-1', date: '2026-09-27'})")["ok"] is False
    assert tab.evaluate("pressed") == []


# A small inbox that really pages, ten rows a page, as Nelnet's does. Every
# date and id is invented. `?start=N` draws it on page N, `?endless` never
# ends, and `?stuck` leaves the rows as they were when Next Page is pressed.
WORLD = """<main id="m"></main><script>
const q = window.location.search;
const endless = q.includes('endless'), stuck = q.includes('stuck');
const total = 23;
let page = +((/start=(\\d+)/.exec(q) || [])[1] || 0);
window.moves = []; window.pressed = [];
function press(b) { pressed.push(b.dataset.cy); }
function rowsOf(p) {
  const out = [];
  for (let i = p * 10; i < (endless ? p * 10 + 10 : Math.min(total, p * 10 + 10)); i++) {
    const d = new Date(Date.UTC(2026, 8, 27) - i * 30 * 864e5);
    const mdy = `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
    const subject = i % 4 === 3 ? 'Annual Repayment Notice' : `${mdy} Statement`;
    out.push(`<tr><td>${mdy}</td><td><a data-cy="document-view-doc-${i}">${subject}</a></td>`
      + `<td><button data-cy="document-download-doc-${i}" aria-label="Download document with subject ${subject}" onclick="press(this)">Download</button></td></tr>`);
  }
  return out.join('');
}
function draw() {
  const last = !endless && (page + 1) * 10 >= total;
  document.getElementById('m').innerHTML = `<table><tbody>${rowsOf(page)}</tbody></table>`
    + `<button aria-label="Go to first page" aria-disabled="${page === 0}" onclick="moves.push('first'); page = 0; draw()"></button>`
    + `<button aria-label="Next Page" aria-disabled="${last}" onclick="moves.push('next'); if (!stuck) { page += 1; draw(); }"></button>`;
}
draw();
</script>"""


def load_world(tab, query=""):
    def respond(route):
        route.fulfill(status=200, content_type="text/html", body=f"<!doctype html><title>Nelnet</title>{WORLD}")
    tab.unroute("**/*")
    tab.route("**/*", respond)
    tab.goto(BASE + INBOX + query)
    source = (ROOT / "providers" / "nelnet.page.js").read_text().replace("PAGER_WAIT_MS = 10000", "PAGER_WAIT_MS = 300")
    tab.add_script_tag(content=source)


def walk_everything(tab, limit=100):
    ids = []
    for _ in range(limit):
        got = tab.evaluate("__sweep.readList({ walk: true })")
        if got["state"] == "walking":
            continue
        if got["state"] != "ok":
            return ids, got
        ids += [d["id"] for d in got["docs"]]
        if not got.get("more"):
            return ids, None
        step = tab.evaluate("__sweep.nextView()")
        if "why" in step:
            return ids, step
        if not step["moved"]:
            return ids, step
    raise AssertionError("the walk never ended")


EVERY = [f"doc-{i}" for i in range(23)]


def test_a_walk_reads_every_page_to_the_end(tab):
    load_world(tab)
    ids, end = walk_everything(tab)
    assert ids == EVERY
    assert end == {"moved": False}
    assert tab.evaluate("moves") == ["next", "next"]
    assert tab.evaluate("pressed") == []
    assert tab.evaluate("globalThis.__nelnetWalk") is None


def test_each_page_of_a_walk_is_newest_first_and_each_row_is_pressed_on_its_own_page(tab):
    load_world(tab)
    first = tab.evaluate("__sweep.readList({ walk: true })")
    assert first["more"] is True and [d["id"] for d in first["docs"]] == EVERY[:10]
    assert first["docs"][0] == {"id": "doc-0", "date": "2026-09-27", "title": "Statement", "method": "click"}
    assert first["docs"][3]["title"] == "Annual Repayment Notice"
    assert tab.evaluate("__sweep.nextView()") == {"moved": True}
    second = tab.evaluate("__sweep.readList({ walk: true })")
    assert [d["id"] for d in second["docs"]] == EVERY[10:20]
    assert tab.evaluate("doc => __sweep.clickDoc(doc)", second["docs"][0]) == {"ok": True}
    assert tab.evaluate("pressed") == ["document-download-doc-10"]


def test_a_walk_ids_are_the_rows_own_and_the_same_on_every_run(tab):
    load_world(tab)
    plain = [d["id"] for d in tab.evaluate("__sweep.readList()")["docs"]]
    load_world(tab)
    once, _ = walk_everything(tab)
    load_world(tab)
    again, _ = walk_everything(tab)
    assert once == again == EVERY and once[:10] == plain


def test_a_walk_that_starts_on_a_later_page_goes_back_to_the_first_once(tab):
    load_world(tab, "?start=1")
    assert tab.evaluate("__sweep.readList({ walk: true })") == {"state": "walking"}
    ids, end = walk_everything(tab)
    assert ids == EVERY and end == {"moved": False}
    assert tab.evaluate("moves") == ["first", "next", "next"]


def test_a_list_that_never_ends_stops_at_the_cap(tab):
    load_world(tab, "?endless")
    ids, end = walk_everything(tab)
    assert "60 pages" in end["why"]
    assert len(ids) == 600 and len(set(ids)) == 600
    assert tab.evaluate("moves.length") == 59


def test_rows_that_stay_the_same_after_next_page_stop_the_walk(tab):
    load_world(tab, "?stuck")
    ids, end = walk_everything(tab)
    assert ids == EVERY[:10] and "stayed the same" in end["why"]


def test_without_walk_the_list_is_left_as_it_is(tab):
    load_world(tab)
    got = tab.evaluate("__sweep.readList()")
    assert got["state"] == "stopped" and "first page" in got["why"] and [d["id"] for d in got["docs"]] == EVERY[:10]
    load_world(tab, "?start=1")
    assert tab.evaluate("__sweep.readList()")["state"] == "stopped"
    assert tab.evaluate("moves") == []


@pytest.mark.parametrize("extra", ['title="Make a payment"', 'title="Go to settings"'])
def test_a_pager_that_says_something_else_is_never_pressed(tab, extra):
    pager = f'<button aria-label="Next Page" aria-disabled="false" {extra} onclick="moves.push(1)"></button>'
    load(tab, page_of(row(), pager) + "<script>window.moves=[]</script>")
    got = tab.evaluate("__sweep.readList({ walk: true })")
    assert got["state"] == "stopped" and "pager" in got["why"]
    assert tab.evaluate("moves") == []


def test_two_next_page_buttons_are_not_pressed(tab):
    two = '<button aria-label="Next Page" onclick="moves.push(1)"></button>' * 2
    load(tab, page_of(row(), two) + "<script>window.moves=[]</script>")
    assert tab.evaluate("__sweep.readList({ walk: true })")["state"] == "stopped"
    assert tab.evaluate("moves") == []


def test_a_one_page_list_walks_to_its_end_at_once(tab):
    load(tab, page_of(row(), LAST))
    got = tab.evaluate("__sweep.readList({ walk: true })")
    assert got == {"state": "ok", "docs": [{"id": "statement-1", "date": "2026-09-27", "title": "Statement", "method": "click"}]}
