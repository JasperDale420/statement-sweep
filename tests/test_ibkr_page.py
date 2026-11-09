"""The Interactive Brokers page logic, in a real Chromium, on stand-in pages."""
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOST = "https://www.interactivebrokers.com"
PAGE = "/AccountManagement/AmAuthentication?action=RM_STATEMENTS&service=AM.LOGIN&webaccess=true"
ACCOUNT = "U1234567"
MONTHS = [["September, 2026", "202609"], ["August, 2026", "202608"], ["February, 2024", "202402"]]

# Modelled on PaperPull's stand-in in tests/test_a_statements_list_it_never_read.py:
# the list draws a moment after the page, Run opens the dialog, and the Date
# select shows once Monthly is chosen. Download PDF records what it was asked.
STATEMENTS = """<title>Statements</title>%(notice)s
<h1>Statements <span>%(account)s</span></h1>
<h3>Default Statements</h3>
<div id="list"></div><div id="dlg"></div>
%(other)s
<script>
window.pressed = [];
const MONTHS = %(months)s;
function dialog() {
  document.getElementById('dlg').innerHTML =
    '<div role="dialog" aria-label="Activity Statement">' +
    '<div class="modal-title">Activity Statement</div><form name="statementForm">' +
    '<select id="period"><option>Daily</option><option>Custom Date Range</option>' +
    '<option>Monthly</option><option>Annual</option></select>' +
    '<select id="date" hidden>' + MONTHS.map(m => '<option value="string:' + m[1] + '">' + m[0] + '</option>').join('') + '</select>' +
    '<button type="button" id="pdf">Download PDF</button></form></div>';
  const p = document.getElementById('period'), d = document.getElementById('date');
  p.addEventListener('change', () => { d.hidden = p.value !== 'Monthly'; });
  document.getElementById('pdf').addEventListener('click', () => {
    window.pressed.push(d.value.replace('string:', ''));
    if (window.closesItself) document.getElementById('dlg').innerHTML = '';
  });
}
setTimeout(() => {
  document.getElementById('list').innerHTML =
    '<div class="row"><strong>Monthly Activity Statement</strong> <a href="#" aria-label="Run" id="wrong">x</a></div>' +
    '<div class="row"><strong>Activity Statement</strong> <a href="#" aria-label="Info">i</a> <a href="#" aria-label="Run" id="run">&rarr;</a></div>';
  document.getElementById('run').addEventListener('click', (e) => { e.preventDefault(); window.runs = (window.runs || 0) + 1; dialog(); });
  document.getElementById('wrong').addEventListener('click', (e) => { e.preventDefault(); window.wrongRun = true; });
}, 200);
</script>"""

OTHER_DIALOG = """<div role="dialog" aria-label="MTM Summary"><div class="modal-title">MTM Summary</div>
<form name="mtmForm"><select><option>Daily</option><option>Monthly</option><option>Annual</option></select></form></div>"""


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, url, body):
    tab.unroute("**/*")
    tab.route("**/*", lambda r: r.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body}"))
    tab.goto(url if url.startswith("http") else HOST + url)
    tab.add_script_tag(content=(ROOT / "providers" / "ibkr.page.js").read_text())


def statements(account=ACCOUNT, months=MONTHS, other="", notice=""):
    return STATEMENTS % {"account": account, "months": json.dumps(months), "other": other, "notice": notice}


def read(tab):
    return tab.evaluate("__sweep.readList()")


DOC = "{code: '202608', account: 'U1234567'}"


@pytest.mark.parametrize("url,body", [
    ("/sso/Login", "<p>Sign in</p>"),
    ("/AccountManagement/Expire", "<p>x</p>"),
    ("/AccountManagement/x", "<title>Your Session Has Expired.</title><p>x</p>"),
    ("/portal/", "<input type=password>"),
])
def test_a_sign_in_is_known(tab, url, body):
    load(tab, url, body)
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_is_known(tab):
    load(tab, "/sso/Dispatcher", "<p>Open the IBKR notification on your phone</p>")
    assert read(tab) == {"state": "challenge"}


def test_throttling_stops(tab):
    load(tab, "/portal/", "<p>Too many attempts</p>")
    assert read(tab)["state"] == "stopped"


def test_the_portal_is_not_the_list(tab):
    load(tab, "/portal/", "<h1>Portfolio</h1>")
    assert read(tab) == {"state": "no_list"}


def test_a_regional_site_says_so_rather_than_be_sent_to_dot_com(tab):
    load(tab, "https://www.interactivebrokers.co.uk/portal/", "<h1>Portfolio</h1>")
    got = read(tab)
    assert got["state"] == "stopped" and "interactivebrokers.co.uk" in got["why"]


def test_a_good_list_with_month_end_dates(tab):
    load(tab, PAGE, statements())
    got = read(tab)
    assert got["state"] == "ok"
    assert all(d.pop("nameMustMatch") for d in got["docs"])
    assert got["docs"] == [
        {"id": "U1234567-202609", "date": "2026-09-30", "title": "Activity Statement 4567", "method": "click", "account": ACCOUNT, "code": "202609"},
        {"id": "U1234567-202608", "date": "2026-08-31", "title": "Activity Statement 4567", "method": "click", "account": ACCOUNT, "code": "202608"},
        {"id": "U1234567-202402", "date": "2024-02-29", "title": "Activity Statement 4567", "method": "click", "account": ACCOUNT, "code": "202402"},
    ]
    assert tab.evaluate("window.wrongRun") in (None, False)
    assert tab.evaluate("window.pressed") == []


def test_reading_twice_uses_the_dialog_it_opened(tab):
    load(tab, PAGE, statements())
    assert read(tab)["state"] == "ok"
    assert read(tab)["state"] == "ok"
    assert tab.evaluate("window.runs") == 1


def test_an_account_on_the_page_is_required(tab):
    load(tab, PAGE, statements(account="(no number)"))
    got = read(tab)
    assert got["state"] == "stopped" and "account" in got["why"]
    assert tab.evaluate("window.runs") in (None, 0)


def test_a_notice_above_the_heading_does_not_hide_the_account(tab):
    load(tab, PAGE, statements(notice="<p>" + ("Notice words. " * 200) + "</p>"))
    assert read(tab)["docs"][0]["account"] == ACCOUNT


def test_another_statements_dialog_is_not_used(tab):
    load(tab, PAGE, statements(other=OTHER_DIALOG))
    got = read(tab)
    assert got["state"] == "stopped" and "dialog" in got["why"]
    assert tab.evaluate("window.runs") in (None, 0)


def test_a_month_that_cannot_be_read_stops(tab):
    months = MONTHS + [["Sometime, 2020", "202001"]]
    load(tab, PAGE, statements(months=months))
    got = read(tab)
    assert got["state"] == "stopped" and len(got["docs"]) == 3


def test_a_label_and_value_that_disagree_stop(tab):
    load(tab, PAGE, statements(months=[["September, 2026", "202608"], ["August, 2026", "202608"], ["July, 2026", "202607"]]))
    assert read(tab)["state"] == "stopped"


def name_passes(tab, doc, name):
    return tab.evaluate("([src, name]) => new RegExp(src).test(name)", [doc["nameMustMatch"], name])


@pytest.mark.parametrize("name,passes", [
    ("U1234567_202608_202608.pdf", True),
    ("u1234567_202608_202608.PDF", True),
    ("/Users/someone/Downloads/U1234567_202608_202608.pdf", True),
    # PaperPull's checks say nothing of a name in another shape.
    ("ActivityStatement.pdf", True),
    ("U1234567_202608.pdf", True),
    ("", True),
    ("U1234567_202607_202607.pdf", False),
    ("U1234567_202607_202608.pdf", False),
    ("U1234567_202608_202609.pdf", False),
    ("Statement_202607_202607.pdf", False),
    ("/Users/someone/Downloads/U1234567_202607_202607.pdf", False),
    ("U7654321_202608_202608.pdf", False),
    ("U12345678_202608_202608.pdf", False),
    ("DU1234567_202608_202608.pdf", False),
    ("C:\\Downloads\\U7654321_202608_202608.pdf", False),
])
def test_a_file_must_not_name_another_month_or_account(tab, name, passes):
    load(tab, PAGE, statements())
    doc = next(d for d in read(tab)["docs"] if d["code"] == "202608")
    assert name_passes(tab, doc, name) is passes


def test_each_month_carries_its_own_name_rule(tab):
    load(tab, PAGE, statements())
    docs = {d["code"]: d for d in read(tab)["docs"]}
    assert name_passes(tab, docs["202609"], "U1234567_202609_202609.pdf")
    assert not name_passes(tab, docs["202609"], "U1234567_202608_202608.pdf")


def test_the_click_asks_for_the_month_named(tab):
    load(tab, PAGE, statements())
    read(tab)
    assert tab.evaluate(f"__sweep.clickDoc({DOC})") == {"ok": True}
    assert tab.evaluate("window.pressed") == ["202608"]


def test_the_dialog_is_opened_again_when_it_closed_itself(tab):
    load(tab, PAGE, statements())
    read(tab)
    tab.evaluate("window.closesItself = true")
    tab.evaluate(f"__sweep.clickDoc({DOC})")
    assert tab.evaluate("document.getElementById('date')") is None
    assert tab.evaluate(f"__sweep.clickDoc({{code: '202609', account: '{ACCOUNT}'}})")["ok"] is True
    assert tab.evaluate("window.pressed") == ["202608", "202609"]
    assert tab.evaluate("window.runs") == 2


def test_a_button_under_something_else_is_not_pressed(tab):
    load(tab, PAGE, statements())
    read(tab)
    tab.evaluate("""() => {
      const cover = document.createElement('div');
      cover.style.cssText = 'position:fixed;inset:0;background:white;z-index:9999';
      document.body.appendChild(cover);
    }""")
    got = tab.evaluate(f"__sweep.clickDoc({DOC})")
    assert got["ok"] is False and "covering" in got["why"]
    assert tab.evaluate("window.pressed") == []


def test_another_account_on_the_page_is_not_pressed_for(tab):
    load(tab, PAGE, statements())
    read(tab)
    got = tab.evaluate("__sweep.clickDoc({code: '202608', account: 'U7654321'})")
    assert got["ok"] is False and tab.evaluate("window.pressed") == []


@pytest.mark.parametrize("doc", ["{code: '../x', account: 'U1234567'}", "{code: '202613', account: 'U1234567'}", "{code: '202608'}", "null"])
def test_a_bad_month_is_refused(tab, doc):
    load(tab, PAGE, statements())
    read(tab)
    assert tab.evaluate(f"__sweep.clickDoc({doc})")["ok"] is False
    assert tab.evaluate("window.pressed") == []
