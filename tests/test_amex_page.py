"""The American Express page logic, in a real Chromium, on stand-in pages that
follow PaperPull's test fixtures. Every card and date is invented."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LIST = "https://global.americanexpress.com/activity/statements"
PRE = "myca-activity-statements/common/Table"


def row(date, section="recent", attr="data-testid"):
    return (f'<div class="row">Statement closing {date}'
            f'<button class="dl" {attr}="{PRE}/{section}-statements/{date}/download-button">Download</button>'
            f'<button class="dl mobile" style="display:none" {attr}="{PRE}/{section}-statements/{date}/download-button">Download</button></div>')


DIALOG = """<div role="dialog" id="filetype" hidden>
  <label><input type="radio" name="ft" value="statement_pdf" id="ft-pdf">PDF</label>
  <label><input type="radio" name="ft" value="statement_accessible_pdf">Screen reader PDF</label>
  <label><input type="radio" name="ft" value="csv">CSV</label>
  <a href="#" role="button" data-test-id="myca-activity-download-footer-download-confirm-anchor">&#x2913;</a>
  <button id="ft-cancel">Cancel</button>
</div>"""

SCRIPT = """<script>
window.said = [];
document.addEventListener('click', (e) => {
  const t = e.target.closest('button, a'); if (!t) return;
  e.preventDefault();
  const tid = t.dataset.testid || t.dataset.testId || t.id;
  if (tid.endsWith('/download-button')) { said.push('row:' + tid.split('/').slice(-2)[0]); document.getElementById('filetype').hidden = false; }
  if (tid.endsWith('confirm-anchor')) said.push('confirm:' + document.querySelector('input[name=ft]:checked').value);
  if (t.id === 'ft-cancel') { said.push('cancel'); document.getElementById('filetype').hidden = true; }
});
</script>"""


def switcher(options, name="Blue Cash Everyday®", number="••••12345"):
    ops = "".join(
        f'<div data-testid="simple_switcher_product_option_CARD_{i}" role="option" style="display:none">'
        f'<span data-testid="simple_switcher_display_name">{n}</span><span data-testid="simple_switcher_display_number">{d}</span></div>'
        for i, (n, d) in enumerate(options))
    return (f'<div data-testid="simple_switcher_combobox" role="combobox" aria-expanded="false">'
            f'<span data-testid="simple_switcher_display_name">{name}</span>'
            f'<span data-testid="simple_switcher_display_number">{number}</span></div>{ops}')


def page(rows, extra=""):
    return f"<main>{extra}<section id='table-area'>{rows}</section>{DIALOG}</main>{SCRIPT}"


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
    tab.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body=f"<!doctype html><meta charset=utf-8>{body}"))
    tab.goto(url)
    source = (ROOT / "providers" / "amex.page.js").read_text().replace("LIST_WAIT_MS = 12000", "LIST_WAIT_MS = 300").replace("DIALOG_WAIT_MS = 10000", "DIALOG_WAIT_MS = 500").replace("WALK_WAIT_MS = 30000", "WALK_WAIT_MS = 300")
    tab.add_script_tag(content=source)


def read(tab):
    return tab.evaluate("__sweep.readList()")


def walk(tab):
    return tab.evaluate("__sweep.readList({ walk: true })")


GO = "history.pushState({}, '', '{to}'); document.getElementById('{show}').hidden = false; this.hidden = true; window.presses = (window.presses || 0) + 1"
HOME = "https://global.americanexpress.com/dashboard"


def walkable(start=HOME):
    first = GO.replace("{to}", "/activity").replace("{show}", "pdf")
    second = GO.replace("{to}", "/activity/statements").replace("{show}", "table-area")
    return (f'<a id="activity" href="/activity" onclick="{first}">Statements &amp; Activity</a>'
            f'<a id="pdf" hidden data-testid="goToPdfLinkLg" href="/activity/statements" onclick="{second}">Go to PDF Statements</a>'
            f"<main><section id='table-area' hidden>{row('2026-08-14')}</section>{DIALOG}</main>{SCRIPT}")


def test_a_walk_goes_from_the_dashboard_to_the_list_one_press_at_a_time(tab):
    load(tab, HOME, walkable())
    assert walk(tab)["state"] == "walking"
    assert tab.evaluate("[location.pathname, window.presses]") == ["/activity", 1]
    assert walk(tab)["state"] == "walking"
    assert tab.evaluate("[location.pathname, window.presses]") == ["/activity/statements", 2]
    found = walk(tab)
    assert found["state"] == "ok"
    assert [d["date"] for d in found["docs"]] == ["2026-08-14"]


def test_without_leave_to_walk_nothing_is_pressed(tab):
    load(tab, HOME, walkable())
    assert read(tab)["state"] == "stopped"
    assert tab.evaluate("window.presses || 0") == 0


def test_a_link_that_does_nothing_is_pressed_once_then_it_stops(tab):
    load(tab, HOME, "<a id='activity' href='#' onclick='window.presses = (window.presses || 0) + 1'>Statements &amp; Activity</a>" + SCRIPT)
    assert walk(tab)["state"] == "walking"
    assert walk(tab)["state"] == "walking"
    tab.wait_for_timeout(400)
    assert walk(tab)["state"] == "stopped"
    assert tab.evaluate("window.presses") == 1


def test_an_overview_with_no_link_opens_the_switcher_then_takes_a_card(tab):
    body = ("<div data-testid='simple_switcher_combobox' id='cb' onclick=\"document.getElementById('op').hidden = false; window.said2 = 'open'\">Cards</div>"
            "<div data-testid='simple_switcher_product_option_CARD_0' id='op' hidden onclick=\"window.said2 = 'card'\">Card</div>")
    load(tab, "https://global.americanexpress.com/overview", body)
    assert walk(tab)["state"] == "walking"
    assert tab.evaluate("window.said2") == "open"
    assert walk(tab)["state"] == "walking"
    assert tab.evaluate("window.said2") == "card"


def test_a_sign_in_page_is_never_walked(tab):
    load(tab, "https://www.americanexpress.com/en-us/account/login", "<input type='password'><a id='activity' href='#'>Statements &amp; Activity</a>" + SCRIPT)
    assert walk(tab)["state"] == "signed_out"


def test_a_walk_opens_older_statements_once(tab):
    older = "<button id='ol' aria-controls='content-older-statements' aria-expanded='false' onclick=\"this.setAttribute('aria-expanded', 'true')\">Older</button>"
    load(tab, LIST, page(row("2026-08-14"), older))
    assert walk(tab)["state"] == "walking"
    assert walk(tab)["state"] == "ok"


def test_a_login_address_is_known(tab):
    load(tab, "https://www.americanexpress.com/en-us/account/login/", "<h1>Log in</h1>")
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_known(tab):
    load(tab, LIST, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_verification_address_is_a_check(tab):
    load(tab, "https://global.americanexpress.com/verification/one", "<p>x</p>")
    assert read(tab) == {"state": "challenge"}


def test_a_security_check_on_the_page_is_known(tab):
    load(tab, LIST, "<p>Let's confirm it's you.</p>")
    assert read(tab) == {"state": "challenge"}


def test_good_rows_are_dated_from_their_test_ids_newest_first(tab):
    load(tab, LIST, page(row("2026-07-09", "older") + row("2026-09-09") + row("2026-08-09", attr="data-test-id")))
    got = read(tab)
    assert got["state"] == "ok"
    assert [d["date"] for d in got["docs"]] == ["2026-09-09", "2026-08-09", "2026-07-09"]
    assert got["docs"][0] == {"id": "stmt:2026-09-09", "date": "2026-09-09", "method": "click", "title": "Monthly Statement"}


def test_a_year_end_summary_shown_is_filed_at_the_years_end(tab):
    body = page(row("2026-09-09") + f'<button data-testid="{PRE}/year-end-summary/2025/download-button">Download</button>')
    load(tab, LIST, body)
    assert [(d["id"], d["date"]) for d in read(tab)["docs"]] == [("stmt:2026-09-09", "2026-09-09"), ("ye:2025", "2025-12-31")]


def test_saying_there_are_no_statements_is_an_empty_list(tab):
    load(tab, LIST, page("<p>There are no statements available.</p>"))
    assert read(tab) == {"state": "ok", "docs": []}


def test_a_page_that_says_nothing_stops(tab):
    load(tab, LIST, page(""))
    assert read(tab)["state"] == "stopped"


def test_another_page_is_stopped_and_never_navigated(tab):
    load(tab, "https://global.americanexpress.com/dashboard", "<h1>Hello</h1>")
    got = read(tab)
    assert got["state"] == "stopped" and "Go to PDF Statements" in got["why"]


def test_a_date_that_is_not_a_day_stops(tab):
    load(tab, LIST, page(row("2026-02-31")))
    assert read(tab)["state"] == "stopped"


def test_a_button_naming_two_documents_stops(tab):
    body = f'<button data-testid="{PRE}/recent-statements/2026-09-09/download-button" data-test-id="{PRE}/recent-statements/2026-08-09/download-button">Download</button>'
    load(tab, LIST, page(body))
    assert read(tab)["state"] == "stopped"


def test_a_card_switcher_with_two_cards_keeps_the_card_on_shows_rows_with_a_note(tab):
    extra = switcher([("Blue Cash Everyday®", "••••12345"), ("EveryDay® Card", "••••67890")])
    load(tab, LIST, page(row("2026-09-09"), extra))
    got = read(tab)
    assert got["state"] == "ok" and "other 1" in got["note"]
    assert got["docs"][0]["id"] == "12345:stmt:2026-09-09"
    assert got["docs"][0]["title"] == "Monthly Statement Blue Cash Everyday (12345)"


def test_unreadable_card_digits_beside_other_cards_list_nothing(tab):
    extra = switcher([("Blue Cash Everyday®", "••••12345"), ("EveryDay® Card", "••••67890")], number="no digits")
    load(tab, LIST, page(row("2026-09-09"), extra))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == [] and "could not be read" in got["why"]


def test_unreadable_digits_on_every_card_beside_each_other_list_nothing(tab):
    extra = switcher([("Blue Cash Everyday®", "none"), ("EveryDay® Card", "none")], number="no digits")
    load(tab, LIST, page(row("2026-09-09"), extra))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


def test_unreadable_digits_with_the_switchers_list_not_drawn_list_nothing(tab):
    load(tab, LIST, page(row("2026-09-09"), switcher([], number="no digits")))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


def test_unreadable_digits_with_one_card_offered_keeps_its_rows(tab):
    extra = switcher([("Blue Cash Everyday®", "••••12345")], number="no digits")
    load(tab, LIST, page(row("2026-09-09"), extra))
    got = read(tab)
    assert got["state"] == "ok" and got["docs"][0]["id"] == "stmt:2026-09-09"


def test_a_switcher_with_one_card_is_whole(tab):
    extra = switcher([("Blue Cash Everyday®", "••••12345")])
    load(tab, LIST, page(row("2026-09-09"), extra))
    assert read(tab)["state"] == "ok"


def test_a_switcher_that_cannot_be_read_is_noted(tab):
    load(tab, LIST, page(row("2026-09-09"), switcher([])))
    got = read(tab)
    assert got["state"] == "ok" and "other cards" in got["note"]


def test_older_statements_closed_stops(tab):
    load(tab, LIST, page(row("2026-09-09"), '<button aria-controls="content-older-statements" aria-expanded="false">Older Statements</button>'))
    assert read(tab)["state"] == "stopped"


def test_a_download_presses_its_row_the_plain_pdf_and_the_dialogs_download(tab):
    load(tab, LIST, page(row("2026-09-09") + row("2026-08-09")))
    assert tab.evaluate("__sweep.clickDoc({id: 'stmt:2026-08-09'})") == {"ok": True}
    assert tab.evaluate("said") == ["row:2026-08-09", "confirm:statement_pdf"]


def test_the_dialog_left_open_is_cancelled_before_the_next(tab):
    load(tab, LIST, page(row("2026-09-09") + row("2026-08-09")))
    tab.evaluate("__sweep.clickDoc({id: 'stmt:2026-08-09'})")
    assert tab.evaluate("__sweep.clickDoc({id: 'stmt:2026-09-09'})") == {"ok": True}
    assert tab.evaluate("said") == ["row:2026-08-09", "confirm:statement_pdf", "cancel", "row:2026-09-09", "confirm:statement_pdf"]


def test_a_dialog_with_no_plain_pdf_presses_nothing_more(tab):
    body = page(row("2026-09-09")).replace('value="statement_pdf"', 'value="csv2"').replace('value="statement_accessible_pdf"', 'value="csv3"')
    load(tab, LIST, body)
    got = tab.evaluate("__sweep.clickDoc({id: 'stmt:2026-09-09'})")
    assert got["ok"] is False and tab.evaluate("said") == ["row:2026-09-09"]


def test_another_card_on_show_is_not_pressed(tab):
    load(tab, LIST, page(row("2026-09-09"), switcher([("Blue", "••••12345")])))
    got = tab.evaluate("__sweep.clickDoc({id: '67890:stmt:2026-09-09'})")
    assert got["ok"] is False and tab.evaluate("said") == []


def test_a_bad_id_is_refused(tab):
    load(tab, LIST, page(row("2026-09-09")))
    assert tab.evaluate("__sweep.clickDoc({id: \"x'] , a[href='\"})")["ok"] is False
