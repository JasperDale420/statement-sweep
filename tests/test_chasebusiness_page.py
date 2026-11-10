"""The Chase Business page logic, in a real Chromium, on stand-in pages. Every
account and date is invented, and the markup follows PaperPull's survey."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CENTER = "https://secure.chase.com/web/auth/dashboard#/dashboard/documents/myDocs/index"
CHK = "BUS COMPLETE CHK (...4321)"
CARD = "BUSINESS CARD (...8765)"
SHOW = 'style="display:block;width:10px;height:10px"'


def entry(label, on=True, id_="bottom-7700112233"):
    return f'<a id="{id_}" href="#">{label}{", current selection" if on else ""}</a>'


def check_row(n, date, kind="Statement", pages="2 pages"):
    tail = f"-row{n}-cell3-downloadDocumentDropdown"
    return (f'<tr id="accountsTable-STATEMENTS-row{n}"><td>{date}</td><td>{kind}</td><td>{pages}</td><td>'
            f'<a href="#" id="header-accountsTable-STATEMENTS{tail}" aria-expanded="false" aria-controls="m{n}">{date} Opens menu to save document</a>'
            f'<div id="m{n}" hidden><a href="#" id="item-0-{n}-downloadPDFOption">Save as PDF</a></div></td></tr>')


def card_row(n, date):
    base = f"accountsTable-STATEMENTS-row{n}-cell3-requestThisDocumentAnchor"
    return (f'<tr id="accountsTable-STATEMENTS-row{n}"><td>{date}</td><td>Statement</td><td>2 pages</td><td>'
            f'<a href="#" id="{base}-pdf">{date} , opens document</a>'
            f'<a href="#" id="{base}-download">{date} Saves document</a></td></tr>')


def center(rows="", menu=None, section=True, expanded=True, picker=True, extra="", years=("2026",)):
    menu = entry(CHK) if menu is None else menu
    state = "true" if expanded else "false"
    acc = f'<button id="button-accountsAccordian-STATEMENTS" aria-expanded="{state}">Statements</button>' if section \
        else '<button id="button-accountsAccordian-OTHER" aria-expanded="false">ATM receipts</button>'
    year = '<input id="header-filterstyledselect-0" value="2026" aria-label=" View:: 2026">' if picker else ""
    year += "".join(f'<div id="container-{i}-filterstyledselect-0" role="option">{y}</div>' for i, y in enumerate(years))
    return f"<main>{menu}{acc}{year}<table>{rows}</table>{extra}</main>" + """<script>
    window.pressed = [];
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a'); if (!a) return; e.preventDefault(); pressed.push(a.id);
      if (a.id.endsWith('downloadDocumentDropdown')) {
        a.setAttribute('aria-expanded', 'true');
        document.getElementById(a.getAttribute('aria-controls')).hidden = false;
      }
    });
    </script>"""


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, url, body):
    tab.goto("about:blank")
    tab.unroute("**/*")
    tab.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body}"))
    tab.goto(url)
    source = (ROOT / "providers" / "chasebusiness.page.js").read_text() \
        .replace("READY_WAIT_MS = 30000", "READY_WAIT_MS = 300").replace("SETTLE_MS = 1500", "SETTLE_MS = 50") \
        .replace("YEAR_WAIT_MS = 8000", "YEAR_WAIT_MS = 300").replace("ACCOUNT_WAIT_MS = 15000", "ACCOUNT_WAIT_MS = 300").replace("OPTION_WAIT_MS = 5000", "OPTION_WAIT_MS = 300")
    tab.add_script_tag(content=source)


def read(tab):
    return tab.evaluate("__sweep.readList()")


# A small document center that really switches accounts and years.
WORLD = """<main id="m"></main><script>
const data = {
  A: {label: 'BUS COMPLETE CHK (...4321)', years: {2026: ['Sep 30, 2026'], 2025: ['Dec 31, 2025', 'Nov 30, 2025']}},
  B: {label: 'BUSINESS CARD (...8765)', years: {2026: ['Oct 5, 2026']}},
  C: {label: 'J. SMITH (...8765)', years: null},
};
const stuck = window.location.search.includes('stuck');
let acct = 'A', year = '2026', open = false, expanded = {A: true};
function draw() {
  const a = data[acct];
  const menu = Object.keys(data).map(k => `<a href="#" id="bottom-${k}">${data[k].label}${k === acct ? ', current selection' : ''}</a>`).join('');
  let body = '<button id="button-accountsAccordian-OTHER" aria-expanded="false">Notices</button><input id="header-filterstyledselect-0" value="Last 30 days">' + (open ? '<div role="option" id="container-0-filterstyledselect-0">2025</div>' : '');
  if (a.years) {
    const opts = open ? Object.keys(a.years).sort().reverse().map((y, i) => `<div role="option" id="container-${i}-filterstyledselect-0">${y}${y === year ? ', current selection' : ''}</div>`).join('') : '';
    const rows = expanded[acct] ? a.years[year].map((d, n) => `<tr id="accountsTable-STATEMENTS-row${n}"><td>${d}</td><td>Statement</td><td>2 pages</td><td><a href="#" id="header-accountsTable-STATEMENTS-row${n}-cell3-downloadDocumentDropdown">${d} Opens menu to save document</a></td></tr>`).join('') : '';
    body = `<button id="button-accountsAccordian-STATEMENTS" aria-expanded="${expanded[acct] ? 'true' : 'false'}">Statements</button><input id="header-filterstyledselect-0" value="${year}">${opts}<table>${rows}</table>`;
  }
  document.getElementById('m').innerHTML = menu + body;
}
draw();
window.moves = [];
document.addEventListener('click', (e) => {
  const t = e.target.closest('a, button, input, [role=option]'); if (!t) return; e.preventDefault();
  if (t.id.startsWith('bottom-')) { acct = t.id.slice(7); year = '2026'; open = false; moves.push('account:' + acct); }
  else if (t.id === 'button-accountsAccordian-STATEMENTS') { expanded[acct] = true; moves.push('open:' + acct); }
  else if (t.id === 'header-filterstyledselect-0') open = !open;
  else if (t.getAttribute('role') === 'option') { open = false; if (!window.frozen) year = t.textContent.slice(0, 4); else { document.querySelector('input').value = t.textContent.slice(0, 4); return; } moves.push('year:' + year); }
  draw();
});
</script>"""


def walk_everything(tab):
    ids, notes = [], []
    for _ in range(20):
        got = tab.evaluate("__sweep.readList({ walk: true })")
        if got["state"] == "walking":
            continue
        assert got["state"] == "ok", got
        ids += [d["id"] for d in got["docs"]]
        if not got.get("more"):
            break
        next_view = tab.evaluate("__sweep.nextView()")
        assert "why" not in next_view, next_view
        if next_view.get("note"):
            notes.append(next_view["note"])
        if not next_view["moved"]:
            break
    return ids, notes


def test_a_walk_reads_every_year_of_every_account_and_passes_over_a_cardholder(tab):
    load(tab, CENTER, WORLD)
    ids, notes = walk_everything(tab)
    assert ids == ["chk|4321|2026-09-30", "chk|4321|2025-12-31", "chk|4321|2025-11-30", "card|8765|2026-10-05"]
    assert len(notes) == 1 and "1 Chase entry" in notes[0]
    assert tab.evaluate("moves") == ["year:2025", "account:B", "open:B", "account:C"]


@pytest.mark.parametrize("words", ["Pay bills", "Sign out", "Transfer money (...1234)", "Close account (...1234)"])
def test_a_menu_entry_that_is_not_an_account_is_never_pressed(tab, words):
    menu = entry(CHK) + f'<a id="bottom-other" href="#">{words}</a>'
    load(tab, CENTER, center(check_row(0, "Sep 30, 2026"), menu=menu, years=("2026, current selection",)))
    assert tab.evaluate("__sweep.readList({ walk: true })")["more"] is True
    assert "not one this will press" in tab.evaluate("__sweep.nextView()")["why"]
    assert "bottom-other" not in tab.evaluate("pressed")


def test_rows_that_never_change_to_the_chosen_year_stop_the_walk(tab):
    load(tab, CENTER, WORLD)
    tab.evaluate("window.frozen = true")
    assert tab.evaluate("__sweep.readList({ walk: true })")["more"] is True
    assert "did not redraw" in tab.evaluate("__sweep.nextView()")["why"]


def test_rows_left_from_the_last_account_are_not_taken_for_the_new_ones(tab):
    menu = entry(CHK) + entry(CARD, False, "bottom-7700445566")
    load(tab, CENTER, center(check_row(0, "Sep 30, 2026"), menu=menu, years=("2026, current selection",)))
    # The menu moves to the card when pressed, and the old rows stay drawn.
    tab.evaluate("""() => { const b = document.getElementById('bottom-7700445566');
      b.addEventListener('click', () => { b.textContent = 'BUSINESS CARD (...8765), current selection';
        document.getElementById('bottom-7700112233').textContent = 'BUS COMPLETE CHK (...4321)'; }); }""")
    assert tab.evaluate("__sweep.readList({ walk: true })")["more"] is True
    assert "did not redraw" in tab.evaluate("__sweep.nextView()")["why"]


def test_a_sign_in_page_is_known(tab):
    load(tab, "https://secure.chase.com/web/auth/logon", "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_the_timeout_dialog_drawn_open_is_a_sign_in(tab):
    load(tab, CENTER, center(check_row(0, "Sep 30, 2026"), extra=f'<mds-dialog id="octagonSessionTimeoutDialogue" open {SHOW}></mds-dialog>'))
    assert read(tab) == {"state": "signed_out"}


def test_the_timeout_dialog_hidden_in_the_page_is_nothing(tab):
    load(tab, CENTER, center(check_row(0, "Sep 30, 2026"), extra='<mds-dialog id="octagonSessionTimeoutDialogue"></mds-dialog>'))
    assert read(tab)["state"] == "ok"


def test_a_security_check_is_known(tab):
    load(tab, CENTER, "<p>Confirm your identity.</p>")
    assert read(tab) == {"state": "challenge"}


def test_good_rows_are_dated_and_named_by_the_accounts_class(tab):
    load(tab, CENTER, center(check_row(1, "Aug 31, 2026") + check_row(0, "Sep 30, 2026")))
    got = read(tab)
    assert got == {"state": "ok", "docs": [
        {"id": "chk|4321|2026-09-30", "date": "2026-09-30", "title": "Business Checking", "method": "click"},
        {"id": "chk|4321|2026-08-31", "date": "2026-08-31", "title": "Business Checking", "method": "click"}]}


def test_another_account_in_the_menu_stops_after_this_ones_rows(tab):
    menu = entry(CHK) + entry(CARD, False, "bottom-7700445566")
    load(tab, CENTER, center(check_row(0, "Sep 30, 2026"), menu=menu))
    got = read(tab)
    assert got["state"] == "stopped" and len(got["docs"]) == 1


def test_a_picker_whose_years_are_not_drawn_stops_with_the_rows_on_screen(tab):
    load(tab, CENTER, center(check_row(0, "Sep 30, 2026"), years=()))
    got = read(tab)
    assert got["state"] == "stopped" and "2026" in got["why"] and "View picker" in got["why"]
    assert [d["date"] for d in got["docs"]] == ["2026-09-30"]


def test_a_picker_offering_older_years_stops_with_the_rows_on_screen(tab):
    years = ("2026, current selection", "2025", "2024 , you've reached the end of the menu")
    load(tab, CENTER, center(check_row(0, "Sep 30, 2026"), years=years))
    got = read(tab)
    assert got["state"] == "stopped" and "View picker" in got["why"]
    assert [d["date"] for d in got["docs"]] == ["2026-09-30"]


def test_a_picker_offering_only_some_other_year_stops(tab):
    load(tab, CENTER, center(check_row(0, "Sep 30, 2026"), years=("2025",)))
    assert read(tab)["state"] == "stopped"


def test_one_year_offered_as_the_current_selection_is_whole(tab):
    load(tab, CENTER, center(check_row(0, "Sep 30, 2026"), years=("2026, current selection",)))
    assert read(tab)["state"] == "ok"


def test_a_closed_statements_section_stops(tab):
    load(tab, CENTER, center(check_row(0, "Sep 30, 2026"), expanded=False))
    assert read(tab)["state"] == "stopped"


def test_an_account_with_no_statements_section_stops(tab):
    load(tab, CENTER, center("", section=False))
    assert read(tab)["state"] == "stopped"


def test_an_empty_year_is_not_called_empty(tab):
    load(tab, CENTER, center(""))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


@pytest.mark.parametrize("date,kind,pages", [("Feb 31, 2026", "Statement", "2 pages"), ("September 2026", "Statement", "2 pages"), ("Sep 30, 2026", "Statement", "many")])
def test_a_row_that_cannot_be_read_stops(tab, date, kind, pages):
    load(tab, CENTER, center(check_row(0, date, kind, pages)))
    assert read(tab)["state"] == "stopped"


def test_a_row_of_another_type_stops(tab):
    load(tab, CENTER, center(check_row(0, "Sep 30, 2026", "Notice")))
    assert read(tab)["state"] == "stopped"


def test_two_statements_on_one_date_stop(tab):
    load(tab, CENTER, center(check_row(0, "Sep 30, 2026") + check_row(1, "Sep 30, 2026")))
    assert read(tab)["state"] == "stopped"


def test_a_row_with_both_ways_or_neither_stops(tab):
    both = check_row(0, "Sep 30, 2026").replace("</td></tr>", '<a id="accountsTable-STATEMENTS-row0-cell3-requestThisDocumentAnchor-download">x</a></td></tr>')
    load(tab, CENTER, center(both))
    assert read(tab)["state"] == "stopped"


def test_a_cardholders_entry_on_show_stops(tab):
    load(tab, CENTER, center(check_row(0, "Sep 30, 2026"), menu=entry("Z. QUILLFEATHER (...2468)")))
    assert read(tab)["state"] == "stopped"


def test_an_elsewhere_page_is_not_the_list(tab):
    load(tab, "https://secure.chase.com/web/auth/dashboard", "<h1>Accounts</h1>")
    assert read(tab) == {"state": "no_list"}


def test_a_center_that_never_draws_stops(tab):
    load(tab, CENTER, "<h1>Accounts</h1>")
    assert read(tab)["state"] == "stopped"


def test_a_card_row_presses_its_saves_document_only(tab):
    load(tab, CENTER, center(card_row(0, "Oct 13, 2026"), menu=entry(CARD, id_="bottom-7700445566")))
    got = tab.evaluate("__sweep.clickDoc({id: 'card|8765|2026-10-13'})")
    assert got == {"ok": True}
    assert tab.evaluate("pressed") == ["accountsTable-STATEMENTS-row0-cell3-requestThisDocumentAnchor-download"]


def test_a_checking_row_presses_its_menu_then_its_save_as_pdf(tab):
    load(tab, CENTER, center(check_row(0, "Sep 30, 2026") + check_row(1, "Aug 31, 2026")))
    got = tab.evaluate("__sweep.clickDoc({id: 'chk|4321|2026-09-30'})")
    assert got == {"ok": True}
    assert tab.evaluate("pressed") == ["header-accountsTable-STATEMENTS-row0-cell3-downloadDocumentDropdown", "item-0-0-downloadPDFOption"]


def test_another_account_on_show_is_not_pressed(tab):
    load(tab, CENTER, center(check_row(0, "Sep 30, 2026")))
    got = tab.evaluate("__sweep.clickDoc({id: 'card|8765|2026-09-30'})")
    assert got["ok"] is False and tab.evaluate("pressed") == []


def test_a_bad_id_is_refused(tab):
    load(tab, CENTER, center(check_row(0, "Sep 30, 2026")))
    assert tab.evaluate("__sweep.clickDoc({id: '../x'})")["ok"] is False
