"""The Wealthfront page logic, in a real Chromium, on stand-in pages."""
import base64
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOST = "https://www.wealthfront.com"
PAGE = "/documents"
STATEMENT = "/documents/90000017/document/DOCD-AA18"
FORM = "/documents/90000017/2025/FORM_1099_PDF?idx=0"


def dated(date="12/31/2025", title="Monthly Statement for Joint Cash Account (from Wealthfront Brokerage Corp)", href=STATEMENT):
    return f'<tr><td>{date}</td><td>{title}</td><td><a href="{href}">Link</a></td></tr>'


def tax(account="Joint Cash Account", form="Form 1099", year=""):
    return (f'<tr><td>{account}</td><td>{form}{year}</td>'
            '<td><button data-testid="tax-forms-account-view-dialog-trigger">Download</button></td></tr>')


def year_menu(*years):
    return '<select aria-label="tax year">' + "".join(f"<option>Tax Year: {y}</option>" for y in years) + "</select>"


def page_body(rows, menu=year_menu("2025"), older=""):
    return f"{menu}<table><tbody>{rows}</tbody></table>{older}" + """
<script>document.addEventListener('click', e => {
  if (e.target.matches('[data-testid=tax-forms-account-view-dialog-trigger]')) {
    window.__pressed = (window.__pressed || 0) + 1;
    const d = document.createElement('div'); d.setAttribute('role', 'dialog');
    d.innerHTML = window.__links || '<a href="/documents/90000017/2025/FORM_1099_PDF?idx=0">PDF</a>';
    d.insertAdjacentHTML('beforeend', '<button data-testid="dismiss-dialog">Close</button>');
    document.body.append(d);
  }
  if (e.target.matches('[data-testid=dismiss-dialog]')) e.target.closest('[role=dialog]').remove();
});</script>"""


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, path=PAGE, body=page_body(dated()), files=None):
    files = files or {}

    def answer(route):
        wanted = route.request.url.replace(HOST, "")
        if wanted in files:
            route.fulfill(**files[wanted])
        else:
            route.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body}")
    tab.unroute("**/*")
    tab.route("**/*", answer)
    tab.goto(HOST + path)
    tab.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    tab.add_script_tag(content=(ROOT / "providers" / "wealthfront.page.js").read_text())


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_a_statement_row_is_read_with_its_own_date(tab):
    load(tab)
    got = read(tab)
    assert got["state"] == "ok"
    assert got["docs"] == [{
        "id": STATEMENT, "date": "2025-12-31", "title": "Monthly Statement Joint Cash Account",
        "method": "fetch", "url": HOST + STATEMENT,
    }]


def test_a_tax_row_is_filed_at_the_end_of_the_year_the_menu_shows(tab):
    load(tab, body=page_body(tax(), menu=year_menu("2024")))
    doc = read(tab)["docs"][0]
    assert doc["date"] == "2024-12-31" and doc["title"] == "1099 Tax Form Joint Cash Account"


def test_trade_confirmations_are_passed_over(tab):
    load(tab, body=page_body(dated(title="Trade Confirmation for Investing") + dated("11/30/2025", href="/documents/1/document/B")))
    assert [d["date"] for d in read(tab)["docs"]] == ["2025-11-30"]


def test_the_list_is_newest_first_across_both_tables(tab):
    load(tab, body=page_body(dated("03/31/2025", href="/documents/1/document/A") + tax() + dated("11/30/2025", href="/documents/1/document/B")))
    assert [d["date"] for d in read(tab)["docs"]] == ["2025-12-31", "2025-11-30", "2025-03-31"]


def test_a_sign_in_address_is_known(tab):
    load(tab, path="/login", body="<p>Sign in</p>")
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_known(tab):
    load(tab, body="<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_waits_for_the_person(tab):
    load(tab, body="<p>Enter the code we sent to your phone</p>")
    assert read(tab) == {"state": "challenge"}


def test_a_page_with_rows_is_not_a_challenge_for_its_words(tab):
    load(tab, body=page_body(dated()) + "<p>verification code</p>")
    assert read(tab)["state"] == "ok"


def test_another_page_is_not_the_list(tab):
    load(tab, path="/dashboard", body="<h1>Home</h1>")
    assert read(tab) == {"state": "no_list"}


def test_more_tax_years_stop_with_what_was_read(tab):
    load(tab, body=page_body(tax(), menu=year_menu("2025", "2024")))
    got = read(tab)
    assert got["state"] == "stopped" and "tax year" in got["why"].lower() and len(got["docs"]) == 1


def test_an_older_page_stops_with_what_was_read(tab):
    load(tab, body=page_body(dated(), older="<button>Older</button>"))
    got = read(tab)
    assert got["state"] == "stopped" and len(got["docs"]) == 1


def test_a_turned_off_older_button_means_the_end(tab):
    load(tab, body=page_body(dated(), older="<button disabled>Older</button>"))
    assert read(tab)["state"] == "ok"


@pytest.mark.parametrize("date", ["13/45/2025", "02/30/2025"])
def test_a_date_that_is_not_one_stops(tab, date):
    load(tab, body=page_body(dated(date)))
    assert read(tab)["state"] == "stopped"


def test_a_tax_row_with_no_year_is_never_given_one(tab):
    load(tab, body=page_body(tax(), menu=""))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


@pytest.mark.parametrize("href", ["https://evil.test/documents/1/document/A", "/account/settings", "/documents/1"])
def test_a_link_that_is_not_a_document_address_stops(tab, href):
    load(tab, body=page_body(dated(href=href)))
    assert read(tab)["state"] == "stopped"


def test_a_filter_menu_named_for_documents_is_not_a_row(tab):
    menu = year_menu("2025") + '<div data-testid="document-filter"><select><option>Quarterly Statements</option></select></div>'
    load(tab, body=page_body(dated(), menu=menu))
    assert read(tab)["state"] == "ok"


def test_a_tax_row_with_no_download_is_said_and_the_rest_is_kept(tab):
    bare = "<tr><td>Joint Cash Account</td><td>Form 1099</td></tr>"
    load(tab, body=page_body(bare + dated()))
    got = read(tab)
    assert got["state"] == "stopped" and len(got["docs"]) == 1


def fetch(tab, doc):
    return tab.evaluate(f"__sweep.fetchPdf({json.dumps(doc)})")


def test_a_bad_address_is_refused(tab):
    load(tab)
    assert fetch(tab, {"id": "x", "url": "https://evil.test/documents/1/document/A"})["ok"] is False


def test_an_official_pdf_comes_back_whole(tab):
    data = b"%PDF-1.7 " + bytes(range(256)) * 400
    load(tab, files={STATEMENT: dict(status=200, content_type="application/pdf", body=data)})
    doc = read(tab)["docs"][0]
    got = fetch(tab, doc)
    assert got["ok"] and base64.b64decode(got["base64"]) == data


def test_html_is_not_kept_as_a_pdf(tab):
    load(tab, files={STATEMENT: dict(status=200, content_type="application/pdf", body=b"<html>sign in</html>")})
    assert fetch(tab, read(tab)["docs"][0])["ok"] is False


def test_a_tax_form_is_taken_from_its_dialog_and_the_dialog_closed(tab):
    data = b"%PDF-1.7 a tax form"
    load(tab, body=page_body(tax()), files={FORM: dict(status=200, content_type="application/pdf", body=data)})
    doc = read(tab)["docs"][0]
    got = fetch(tab, doc)
    assert got["ok"] and base64.b64decode(got["base64"]) == data
    assert tab.evaluate("window.__pressed") == 1
    assert tab.evaluate("document.querySelector('[role=dialog]')") is None


def test_a_tax_form_is_refused_when_the_menu_shows_another_year(tab):
    load(tab, body=page_body(tax()))
    doc = read(tab)["docs"][0]
    tab.evaluate("document.querySelector('select').insertAdjacentHTML('beforeend', '<option selected>Tax Year: 2024</option>')")
    assert fetch(tab, doc)["ok"] is False


def test_a_dialog_link_that_is_not_a_document_address_is_refused(tab):
    load(tab, body=page_body(tax()))
    doc = read(tab)["docs"][0]
    tab.evaluate("window.__links = '<a href=\"https://evil.test/x.pdf\">PDF</a>'")
    assert fetch(tab, doc)["ok"] is False


# A small Documents page that really changes: its Tax Year menu redraws the
# tax table, and Older pages the dated list. Every account and date is
# invented. `?endless` never runs out of Older, `?stuck` leaves the list as it
# was when Older is pressed, and `?refuse` snaps the menu back to 2025.
WORLD = """<main id="m"></main><script>
const q = window.location.search;
const forms = {2025: ['Form 1099', 'Form 5498'], 2024: ['Form 1099'], 2023: []};
const pages = [['12/31/2025', '11/30/2025'], ['10/31/2025', '09/30/2025'], ['08/31/2025']];
let year = '2025', page = 0;
window.moves = [];
function dated(p) {
  if (q.includes('endless')) return [`01/${String(p % 28 + 1).padStart(2, '0')}/${2000 + p}`];
  return pages[p] || [];
}
function draw() {
  const opts = Object.keys(forms).sort().reverse().map(y => `<option ${y === year ? 'selected' : ''}>Tax Year: ${y}</option>`).join('');
  const tax = forms[year].map(f => `<tr><td>Joint Cash Account</td><td>${f}</td><td><button data-testid="tax-forms-account-view-dialog-trigger">Download</button></td></tr>`).join('');
  const rows = dated(page).map((d, i) => `<tr><td>${d}</td><td>Monthly Statement for Joint Cash Account</td><td><a href="/documents/90000017/document/S-${d.replace(/\\//g, '')}">Link</a></td></tr>`).join('');
  const last = !q.includes('endless') && page >= pages.length - 1;
  document.getElementById('m').innerHTML = `<select aria-label="tax year">${opts}</select><table><tbody>${tax}</tbody></table>`
    + `<table><tbody>${rows}</tbody></table><button id="newer">Newer</button><button id="older" ${last ? 'disabled' : ''}>Older</button>`;
}
draw();
document.addEventListener('change', (e) => {
  if (!e.target.matches('select')) return;
  moves.push('year:' + e.target.value.slice(-4));
  year = q.includes('refuse') ? '2025' : e.target.value.slice(-4);
  draw();
});
document.addEventListener('click', (e) => {
  if (e.target.id === 'older') { moves.push('older'); if (!q.includes('stuck')) page += 1; draw(); }
  if (e.target.id === 'newer') moves.push('newer');
  if (e.target.matches('[data-testid=tax-forms-account-view-dialog-trigger]')) {
    const d = document.createElement('div'); d.setAttribute('role', 'dialog');
    d.innerHTML = window.__links || `<a href="/documents/90000017/${year}/FORM_1099_PDF?idx=0">PDF</a><button data-testid="dismiss-dialog">Close</button>`;
    document.body.append(d);
  }
  if (e.target.matches('[data-testid=dismiss-dialog]')) e.target.closest('[role=dialog]').remove();
});
</script>"""


def load_world(tab, query="", files=None):
    files = files or {}

    def answer(route):
        wanted = route.request.url.replace(HOST, "")
        if wanted in files:
            route.fulfill(**files[wanted])
        else:
            route.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{WORLD}")
    tab.unroute("**/*")
    tab.route("**/*", answer)
    tab.goto(HOST + PAGE + query)
    source = (ROOT / "providers" / "wealthfront.page.js").read_text() \
        .replace("OPTION_WAIT_MS = 5000", "OPTION_WAIT_MS = 300").replace("YEAR_WAIT_MS = 4000", "YEAR_WAIT_MS = 300") \
        .replace("OLDER_WAIT_MS = 10000", "OLDER_WAIT_MS = 300").replace("MAX_OLDER = 200", "MAX_OLDER = 5")
    tab.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    tab.add_script_tag(content=source)


def walk_everything(tab, limit=50):
    docs, notes = [], []
    for _ in range(limit):
        got = tab.evaluate("__sweep.readList({ walk: true })")
        if got["state"] != "ok":
            return docs, got
        docs += got["docs"]
        if got.get("note"):
            notes.append(got["note"])
        if not got.get("more"):
            return docs, None
        step = tab.evaluate("__sweep.nextView()")
        if "why" in step or not step["moved"]:
            return docs, step
    raise AssertionError("the walk never ended")


def s(date):
    return "/documents/90000017/document/S-" + date.replace("/", "")


EVERY = [
    "tax-2025-Joint Cash Account-Form 1099", "tax-2025-Joint Cash Account-Form 5498",
    s("12/31/2025"), s("11/30/2025"),
    "tax-2024-Joint Cash Account-Form 1099",
    s("10/31/2025"), s("09/30/2025"), s("08/31/2025"),
]


def test_a_walk_reads_every_tax_year_and_every_older_page_to_the_end(tab):
    load_world(tab)
    docs, end = walk_everything(tab)
    assert sorted(d["id"] for d in docs) == sorted(EVERY) and len(docs) == len(EVERY)
    assert end == {"moved": False}
    assert tab.evaluate("moves") == ["year:2024", "year:2023", "older", "older"]
    assert tab.evaluate("globalThis.__wealthfrontWalk") is None
    by_id = {d["id"]: d for d in docs}
    assert by_id["tax-2024-Joint Cash Account-Form 1099"] == {
        "id": "tax-2024-Joint Cash Account-Form 1099", "date": "2024-12-31", "title": "1099 Tax Form Joint Cash Account",
        "method": "fetch", "account": "Joint Cash Account", "form": "Form 1099", "year": "2024"}
    assert by_id[s("08/31/2025")]["url"] == HOST + s("08/31/2025")


def test_a_walk_ids_are_the_ones_a_plain_read_gives_and_the_same_on_every_run(tab):
    load_world(tab)
    plain = {d["id"] for d in read(tab)["docs"]}
    load_world(tab)
    once = [d["id"] for d in walk_everything(tab)[0]]
    load_world(tab)
    again = [d["id"] for d in walk_everything(tab)[0]]
    assert once == again and plain <= set(once)


def test_without_walk_nothing_on_the_page_is_changed(tab):
    load_world(tab)
    got = read(tab)
    assert got["state"] == "stopped" and "Only what is on screen" in got["why"]
    assert tab.evaluate("moves") == [] and tab.evaluate("document.querySelector('select').value") == "Tax Year: 2025"


def test_a_tax_form_of_a_walked_year_is_taken_from_that_years_dialog(tab):
    data = b"%PDF-1.7 the 2024 form"
    load_world(tab, files={"/documents/90000017/2024/FORM_1099_PDF?idx=0": dict(status=200, content_type="application/pdf", body=data)})
    tab.evaluate("__sweep.readList({ walk: true })")
    assert tab.evaluate("__sweep.nextView()") == {"moved": True}
    doc = next(d for d in tab.evaluate("__sweep.readList({ walk: true })")["docs"] if d.get("year") == "2024")
    got = fetch(tab, doc)
    assert got["ok"] and base64.b64decode(got["base64"]) == data


def test_a_dialog_link_for_another_year_is_refused(tab):
    load_world(tab)
    tab.evaluate("__sweep.readList({ walk: true })")
    tab.evaluate("__sweep.nextView()")
    doc = next(d for d in tab.evaluate("__sweep.readList({ walk: true })")["docs"] if d.get("year") == "2024")
    tab.evaluate("window.__links = '<a href=\"/documents/90000017/2025/FORM_1099_PDF?idx=0\">PDF</a><button data-testid=\"dismiss-dialog\">x</button>'")
    got = fetch(tab, doc)
    assert got["ok"] is False and "2025" in got["why"]


def test_an_older_that_never_ends_stops_at_the_cap(tab):
    load_world(tab, "?endless")
    docs, end = walk_everything(tab)
    assert "past 5 presses" in end["why"]
    assert tab.evaluate("moves").count("older") == 5
    assert len({d["id"] for d in docs}) == len(docs)


def test_a_list_that_stays_the_same_after_older_stops_the_walk(tab):
    load_world(tab, "?stuck")
    _, end = walk_everything(tab)
    assert "did not change after Older" in end["why"]


def test_a_year_the_page_will_not_show_stops_the_walk(tab):
    load_world(tab, "?refuse")
    _, end = walk_everything(tab)
    assert "2024" in end["why"]


@pytest.mark.parametrize("attrs", ['aria-label="Older transfers"', 'title="Withdraw"'])
def test_an_older_that_says_something_else_is_never_pressed(tab, attrs):
    load(tab, body=page_body(dated(), older=f'<button {attrs} onclick="window.hit=1">Older</button>'))
    assert tab.evaluate("__sweep.readList({ walk: true })")["more"] is True
    assert "not read as one" in tab.evaluate("__sweep.nextView()")["why"]
    assert tab.evaluate("window.hit") is None


def test_with_a_tax_older_too_the_statements_older_is_pressed(tab):
    # As on the real page (2026-11-09): Tax Documents first, with its own
    # Older, then the statements list with another.
    tax_part = ('<section><table><tbody>' + tax() + '</tbody></table>'
           '<button onclick="window.hit=\'tax\'">Older</button></section>')
    statements = (f'<section><table><tbody>{dated()}</tbody></table>'
                  '<button onclick="window.hit=\'statements\'">Older</button></section>')
    load(tab, body=page_body("", older=tax_part + statements))
    tab.evaluate("__sweep.readList({ walk: true })")
    tab.evaluate("__sweep.nextView()")
    assert tab.evaluate("window.hit") == "statements"


def test_two_olders_are_not_pressed(tab):
    load(tab, body=page_body(dated(), older='<button onclick="window.hit=1">Older</button>' * 2))
    tab.evaluate("__sweep.readList({ walk: true })")
    assert "more than one" in tab.evaluate("__sweep.nextView()")["why"]
    assert tab.evaluate("window.hit") is None


def test_a_page_with_nothing_more_walks_to_its_end_at_once(tab):
    load(tab)
    got = tab.evaluate("__sweep.readList({ walk: true })")
    assert got["state"] == "ok" and "more" not in got and len(got["docs"]) == 1


def test_a_tax_form_with_no_download_is_a_note_in_a_walk(tab):
    bare = "<tr><td>Joint Cash Account</td><td>Form 1099</td></tr>"
    load(tab, body=page_body(bare + dated(), menu=year_menu("2025", "2024")))
    got = tab.evaluate("__sweep.readList({ walk: true })")
    assert got["state"] == "ok" and got["more"] is True and len(got["docs"]) == 1


# The Documents page with its filter menus, as PaperPull reads it: accounts,
# document type and date menus above a statements list paged by Older, and a
# tax list with an Older of its own. Every account, date and number is
# invented. `?one` starts the accounts menu on one account, `?noquarterly`
# leaves Quarterly Statements out of the type menu, `?stucktype` leaves the
# type menu where it was.
FILTERED = """<main id="m"></main><script>
const q = window.location.search;
const forms = {2025: ['Form 1099'], 2024: ['Form 5498']};
const docs = [
  ['Statements', 'Joint Cash Account', '12/31/2025'], ['Statements', 'Joint Cash Account', '11/30/2025'],
  ['Statements', 'Joint Cash Account', '10/31/2025'], ['Statements', 'Roth IRA', '12/31/2025'],
  ['Statements', 'Roth IRA', '11/30/2025'], ['Quarterly Statements', 'Roth IRA', '09/30/2025'],
  ['Trade Confirmations', 'Roth IRA', '12/15/2025'], ['Trade Confirmations', 'Roth IRA', '12/16/2025'],
  ['Trade Confirmations', 'Roth IRA', '12/17/2025'],
];
const types = ['All Document Types', 'Statements'].concat(q.includes('noquarterly') ? [] : ['Quarterly Statements']).concat(['Trade Confirmations']);
let year = '2025', account = q.includes('one') ? 'Roth IRA' : 'All Accounts', type = 'All Document Types', page = 0;
window.moves = [];
const opts = (list, on) => list.map(v => `<option ${v === on ? 'selected' : ''}>${v}</option>`).join('');
function shown() {
  return docs.filter(([t, a]) => (type === 'All Document Types' || t === type) && (account === 'All Accounts' || a === account))
    .sort((x, y) => (x[2] < y[2] ? 1 : -1));
}
function draw() {
  const list = shown();
  const rows = list.slice(page * 2, page * 2 + 2).map(([t, a, d]) => {
    const what = t === 'Trade Confirmations' ? 'Trade Confirmation' : t === 'Quarterly Statements' ? 'Quarterly Statement' : 'Monthly Statement';
    const id = `${a.split(' ')[0]}-${d.replace(/\\//g, '')}`;
    return `<tr><td>${d}</td><td>${what} for ${a}</td><td><a href="/documents/90000017/document/S-${id}">Link</a></td></tr>`;
  }).join('');
  const last = page * 2 + 2 >= list.length;
  const tax = forms[year].map(f => `<tr><td>Joint Cash Account</td><td>${f}</td><td><button data-testid="tax-forms-account-view-dialog-trigger">Download</button></td></tr>`).join('');
  document.getElementById('m').innerHTML =
    `<section><select aria-label="tax year">${opts(Object.keys(forms).sort().reverse().map(y => 'Tax Year: ' + y), 'Tax Year: ' + year)}</select>`
    + `<table><tbody>${tax}</tbody></table><button id="taxolder">Older</button></section>`
    + `<section><select name="selectedAccountId">${opts(['All Accounts', 'Joint Cash Account', 'Roth IRA'], account)}</select>`
    + `<select name="selectedDocumentType">${opts(types, type)}</select>`
    + `<select name="selectedYearMonth">${opts(['All', 'December 2025'], 'All')}</select>`
    + `<table><tbody>${rows}</tbody></table><button id="newer">Newer</button><button id="older" ${last ? 'disabled' : ''}>Older</button></section>`;
}
draw();
document.addEventListener('change', (e) => {
  const v = e.target.value, n = e.target.getAttribute('name') || 'year';
  moves.push(n + ':' + v);
  if (n === 'year') year = v.slice(-4);
  if (n === 'selectedAccountId') account = v;
  if (n === 'selectedDocumentType' && !q.includes('stucktype')) type = v;
  page = 0;
  draw();
});
document.addEventListener('click', (e) => {
  if (e.target.id === 'older') { moves.push('older'); page += 1; draw(); }
  if (e.target.id === 'taxolder') moves.push('taxolder');
  if (e.target.id === 'newer') moves.push('newer');
});
</script>"""


def load_filtered(tab, query=""):
    tab.unroute("**/*")
    tab.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{FILTERED}"))
    tab.goto(HOST + PAGE + query)
    source = (ROOT / "providers" / "wealthfront.page.js").read_text() \
        .replace("OPTION_WAIT_MS = 5000", "OPTION_WAIT_MS = 300").replace("YEAR_WAIT_MS = 4000", "YEAR_WAIT_MS = 300") \
        .replace("OLDER_WAIT_MS = 10000", "OLDER_WAIT_MS = 300").replace("FILTER_WAIT_MS = 6000", "FILTER_WAIT_MS = 300")
    tab.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    tab.add_script_tag(content=source)


def f(account, date):
    return "/documents/90000017/document/S-" + account.split(" ")[0] + "-" + date.replace("/", "")


EVERY_STATEMENT = [f("Joint Cash Account", "12/31/2025"), f("Joint Cash Account", "11/30/2025"), f("Joint Cash Account", "10/31/2025"),
                   f("Roth IRA", "12/31/2025"), f("Roth IRA", "11/30/2025"), f("Roth IRA", "09/30/2025")]


def test_a_walk_sets_statements_then_quarterly_statements_and_pages_each_to_its_end(tab):
    load_filtered(tab)
    docs, end = walk_everything(tab)
    assert end == {"moved": False}
    ids = [d["id"] for d in docs]
    assert len(ids) == len(set(ids))
    assert sorted(i for i in ids if not i.startswith("tax-")) == sorted(EVERY_STATEMENT)
    assert sorted(i for i in ids if i.startswith("tax-")) == ["tax-2024-Joint Cash Account-Form 5498", "tax-2025-Joint Cash Account-Form 1099"]
    assert tab.evaluate("moves") == ["year:Tax Year: 2024", "selectedDocumentType:Statements", "older", "older",
                                     "selectedDocumentType:Quarterly Statements"]
    by_id = {d["id"]: d for d in docs}
    assert by_id[f("Roth IRA", "09/30/2025")]["title"] == "Quarterly Statement Roth IRA"
    assert by_id[f("Joint Cash Account", "10/31/2025")]["title"] == "Monthly Statement Joint Cash Account"


def test_the_tax_lists_own_older_is_never_pressed(tab):
    load_filtered(tab)
    walk_everything(tab)
    assert "taxolder" not in tab.evaluate("moves")


def test_an_accounts_menu_on_one_account_is_put_back_on_all_accounts(tab):
    load_filtered(tab, "?one")
    docs, end = walk_everything(tab)
    assert end == {"moved": False}
    assert tab.evaluate("moves")[:2] == ["year:Tax Year: 2024", "selectedAccountId:All Accounts"]
    assert sorted(d["id"] for d in docs if not d["id"].startswith("tax-")) == sorted(EVERY_STATEMENT)


def test_a_type_menu_without_quarterly_statements_ends_after_statements(tab):
    load_filtered(tab, "?noquarterly")
    docs, end = walk_everything(tab)
    assert end == {"moved": False}
    assert "selectedDocumentType:Quarterly Statements" not in tab.evaluate("moves")
    assert len([d for d in docs if not d["id"].startswith("tax-")]) == 5


def test_a_type_menu_that_will_not_change_stops_the_walk(tab):
    load_filtered(tab, "?stucktype")
    _, end = walk_everything(tab)
    assert "document type" in end["why"]


def test_statement_ids_are_the_same_under_any_document_type(tab):
    load_filtered(tab)
    plain = {d["id"] for d in read(tab)["docs"] if not d["id"].startswith("tax-")}
    load_filtered(tab)
    walked = {d["id"] for d in walk_everything(tab)[0]}
    assert plain and plain <= walked


def test_a_page_with_a_type_menu_and_no_older_still_walks_the_menu(tab):
    menu = year_menu("2025") + '<select name="selectedDocumentType"><option selected>All Document Types</option><option>Statements</option></select>'
    load(tab, body=page_body(dated(), menu=menu))
    got = tab.evaluate("__sweep.readList({ walk: true })")
    assert got["state"] == "ok" and got["more"] is True
    assert tab.evaluate("__sweep.nextView()") == {"moved": True}
    assert tab.evaluate("document.querySelector('[name=selectedDocumentType]').value") == "Statements"
