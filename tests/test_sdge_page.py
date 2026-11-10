"""The SDG&E page logic, in a real Chromium, on stand-in pages."""
import base64
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HEAD = "<tr><th>Statement Date</th><th>Due Date</th><th>Amount</th></tr>"
INV = "ISU000000000201"


def row(inv=INV, date="Sep 12, 2026", first='<td style="display:none">1</td>', extra=""):
    return f'<tr invoiceid="{inv}">{first}<td>{date}</td><td>Oct 1, 2026</td><td>$1</td>{extra}</tr>'


def table(rows, head=HEAD):
    return f'<table id="billHistoryTable"><thead>{head}</thead><tbody>{rows}</tbody></table>'


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, path, body, bill=None):
    def answer(route):
        url = route.request.url
        if "DownloadBillPdf" in url and bill:
            route.fulfill(**bill)
        else:
            route.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body}")
    tab.unroute("**/*")
    tab.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body=""))
    # Each stand-in page starts with the tab's session storage empty.
    tab.goto("https://myenergycenter.com/blank")
    tab.evaluate("sessionStorage.clear()")
    tab.unroute("**/*")
    tab.route("**/*", answer)
    tab.goto("https://myenergycenter.com" + path)
    inject(tab)


FAST = [("TABLE_WAIT_MS = 10000", "TABLE_WAIT_MS = 400"), ("SWITCH_WAIT_MS = 30000", "SWITCH_WAIT_MS = 600"),
        ("EMPTY_SETTLE_MS = 1500", "EMPTY_SETTLE_MS = 50")]


def inject(tab):
    source = (ROOT / "providers" / "sdge.page.js").read_text()
    for old, new in FAST:
        assert old in source
        source = source.replace(old, new)
    tab.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    tab.add_script_tag(content=source)


def read(tab):
    return tab.evaluate("__sweep.readList()")


PAGE = "/portal/BillingHistory/index"


def test_rows_with_a_hidden_number_cell_are_read(tab):
    load(tab, PAGE, table(row()))
    assert read(tab) == {"state": "ok", "docs": [{"id": INV, "date": "2026-09-12", "method": "fetch"}]}


def test_rows_with_no_hidden_cell_are_read_too(tab):
    load(tab, PAGE, table(row(first="")))
    assert read(tab)["docs"][0]["date"] == "2026-09-12"


def test_a_hidden_real_column_stops_rather_than_shift_the_date(tab):
    load(tab, PAGE, table(row(first='<td style="display:none">not a number</td>')))
    assert read(tab)["state"] == "stopped"


@pytest.mark.parametrize("date", ["", "Feb 31, 2026", "2026-09-12", "due Sep 12, 2026"])
def test_a_date_that_is_not_one_stops(tab, date):
    load(tab, PAGE, table(row(date=date)))
    assert read(tab)["state"] == "stopped"


def info(line):
    return f'<div id="billHistoryTable_info">{line}</div>'


def accounts(count):
    options = "".join(f'<option value="{i}">Account {i}</option>' for i in range(count))
    return f'<select id="accountList">{options}</select>'


BILL = {"id": INV, "date": "2026-09-12", "method": "fetch"}


def test_a_count_that_agrees_with_the_rows_is_whole(tab):
    load(tab, PAGE, table(row()) + info("Showing 1 to 1 of 1 entries"))
    assert read(tab) == {"state": "ok", "docs": [BILL]}


def test_more_entries_than_rows_drawn_stops_with_the_rows_drawn(tab):
    load(tab, PAGE, table(row()) + info("Showing 1 to 10 of 1,024 entries"))
    got = read(tab)
    assert got["state"] == "stopped" and "1024" in got["why"] and got["docs"] == [BILL]


def test_a_filtered_table_stops(tab):
    load(tab, PAGE, table(row()) + info("Showing 1 to 1 of 1 entries (filtered from 24 total entries)"))
    got = read(tab)
    assert got["state"] == "stopped" and "search" in got["why"] and got["docs"] == [BILL]


def test_a_count_that_cannot_be_read_stops(tab):
    load(tab, PAGE, table(row()) + info("Some other words"))
    assert read(tab)["state"] == "stopped"


@pytest.mark.parametrize("rows", ["", '<tr><td class="dataTables_empty" colspan="3">Loading...</td></tr>',
                                  '<tr><td class="dataTables_empty" colspan="3">No data available in table</td></tr>'])
def test_rows_not_drawn_yet_are_not_a_list_with_nothing_on_it(tab, rows):
    load(tab, PAGE, table(rows) + info("Showing 0 to 0 of 0 entries") + accounts(2))
    assert read(tab) == {"state": "no_list"}


def test_a_second_account_stops_with_the_rows_on_show(tab):
    load(tab, PAGE, accounts(3) + table(row()) + info("Showing 1 to 1 of 1 entries"))
    got = read(tab)
    assert got["state"] == "stopped" and "other 2" in got["why"] and got["docs"] == [BILL]


def test_a_single_account_is_whole(tab):
    load(tab, PAGE, accounts(1) + table(row()))
    assert read(tab) == {"state": "ok", "docs": [BILL]}


def test_a_sign_in_page_is_known(tab):
    load(tab, "/account/login", "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_bad_bill_number_is_refused(tab):
    load(tab, PAGE, table(row()))
    assert tab.evaluate("__sweep.fetchPdf({id: '../../etc'})")["ok"] is False


def test_an_official_pdf_comes_back_whole(tab):
    data = b"%PDF-1.7 " + bytes(range(256)) * 400
    load(tab, PAGE, table(row()), bill=dict(status=200, content_type="application/pdf", body=data))
    got = tab.evaluate(f"__sweep.fetchPdf({{id: '{INV}'}})")
    assert got["ok"] and base64.b64decode(got["base64"]) == data


def test_html_labelled_as_a_bill_is_not_kept(tab):
    load(tab, PAGE, table(row()), bill=dict(status=200, content_type="application/pdf", body=b"<html>sign in</html>"))
    assert tab.evaluate(f"__sweep.fetchPdf({{id: '{INV}'}})")["ok"] is False


# A small Billing History that really switches accounts and draws its table
# a page at a time, as the table plugin does. It can also load the page anew
# on a change of account, keeping the account in its own session storage.
MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def bills(start, count):
    out = []
    for i in range(count):
        year, month = 2026 - i // 12, 12 - i % 12
        out.append({"id": f"ISU{start + i:012d}", "date": f"{year}-{month:02d}-12",
                    "shown": f"{MONTH_NAMES[month - 1]} 12, {year}"})
    return out


ACCOUNTS = {"A100": bills(100000, 30), "B200": bills(200000, 3), "C300": []}


def world(accounts=None, lengths=(10, 25), reloads=False, switches=True, next_words="Next"):
    accounts = ACCOUNTS if accounts is None else accounts
    options = "".join(f'<option value="{k}">Account {k}</option>' for k in accounts)
    lens = "".join(f'<option value="{n}">{"All" if n == -1 else n}</option>' for n in lengths)
    data = {k: [[b["id"], b["shown"]] for b in v] for k, v in accounts.items()}
    return f"""<select id="accountList">{options}</select>
<div id="billHistoryTable_length"><label>Show <select name="billHistoryTable_length" aria-controls="billHistoryTable">{lens}</select></label></div>
<table id="billHistoryTable"><thead>{HEAD}</thead><tbody></tbody></table>
<div id="billHistoryTable_info"></div>
<ul><li class="paginate_button page-item next" id="billHistoryTable_next"><a href="#" aria-controls="billHistoryTable" class="page-link">{next_words}</a></li></ul>
<script>
const data = {json.dumps(data)};
window.log = [];
let acct = sessionStorage.getItem('acct') || Object.keys(data)[0];
let page = 0, len = {lengths[0]};
const sel = document.getElementById('accountList');
sel.value = acct;
function draw() {{
  const all = data[acct], size = len === -1 ? all.length : len;
  const rows = all.slice(page * size, page * size + size);
  document.querySelector('#billHistoryTable tbody').innerHTML = rows.length
    ? rows.map((r, i) => `<tr invoiceid="${{r[0]}}"><td style="display:none">${{i + 1}}</td><td>${{r[1]}}</td><td>Oct 1, 2026</td><td>$1</td></tr>`).join('')
    : '<tr><td class="dataTables_empty" colspan="3">No data available in table</td></tr>';
  document.getElementById('billHistoryTable_info').textContent = all.length
    ? `Showing ${{page * size + 1}} to ${{page * size + rows.length}} of ${{all.length}} entries` : 'Showing 0 to 0 of 0 entries';
  document.getElementById('billHistoryTable_next').classList.toggle('disabled', (page + 1) * size >= all.length);
}}
draw();
sel.addEventListener('change', () => {{
  log.push('account ' + sel.value);
  if (!{json.dumps(switches)}) return;
  const v = sel.value;
  if ({json.dumps(reloads)}) {{ setTimeout(() => {{ sessionStorage.setItem('acct', v); location.reload(); }}, 50); return; }}
  document.querySelector('#billHistoryTable tbody').innerHTML = '<tr><td class="dataTables_empty" colspan="3">Loading...</td></tr>';
  setTimeout(() => {{ acct = v; page = 0; draw(); }}, 150);
}});
document.querySelector('[name=billHistoryTable_length]').addEventListener('change', (e) => {{
  log.push('length ' + e.target.value); len = +e.target.value; page = 0; draw();
}});
document.querySelector('#billHistoryTable_next a').addEventListener('click', (e) => {{
  e.preventDefault(); log.push('next');
  if (!document.getElementById('billHistoryTable_next').classList.contains('disabled')) {{ page += 1; draw(); }}
}});
</script>"""


def settled_call(tab, js):
    """Call into the page as the engine does: the files are put in afresh
    when the page has loaded anew."""
    for _ in range(100):
        try:
            tab.wait_for_load_state()
            if tab.evaluate("typeof __sweep === 'undefined'"):
                inject(tab)
            return tab.evaluate(js)
        except Exception as e:  # the page was loading anew
            if "context was destroyed" not in str(e) and "navigat" not in str(e):
                raise
            tab.wait_for_timeout(100)
    raise AssertionError("the page never settled")


def walk(tab, views=20):
    """The engine's walk: read, then move on while there is more."""
    docs, moves = [], []
    for _ in range(views):
        for _ in range(200):
            got = settled_call(tab, "__sweep.readList({walk: true})")
            if got["state"] != "walking":
                break
            tab.wait_for_timeout(50)
        docs += got.get("docs", [])
        if got["state"] != "ok" or not got.get("more"):
            return got, docs, moves
        moves.append(settled_call(tab, "__sweep.nextView()"))
        if not moves[-1].get("moved"):
            return got, docs, moves
    raise AssertionError("the walk did not end")


def every(accounts=None):
    accounts = ACCOUNTS if accounts is None else accounts
    return [{"id": b["id"], "date": b["date"], "method": "fetch"} for v in accounts.values() for b in v]


@pytest.mark.parametrize("reloads", [False, True])
def test_the_walk_reads_every_account_once_and_every_bill(tab, reloads):
    load(tab, PAGE, world(reloads=reloads))
    got, docs, moves = walk(tab)
    assert got["state"] == "ok" and moves == [{"moved": True}, {"moved": True}, {"moved": False}]
    assert sorted(docs, key=lambda d: d["id"]) == sorted(every(), key=lambda d: d["id"])
    assert len({d["id"] for d in docs}) == len(docs) == 33
    if not reloads:  # a page loaded anew keeps no log
        log = settled_call(tab, "window.log")
        assert [x for x in log if x.startswith("account")] == ["account B200", "account C300"]
    assert settled_call(tab, "document.getElementById('accountList').value") == "C300"
    assert settled_call(tab, "sessionStorage.getItem('statementSweep.sdgeWalk')") is None


def test_the_ids_are_the_bill_numbers_read_without_a_walk(tab):
    load(tab, PAGE, world(lengths=(-1,)))
    plain = read(tab)
    assert plain["state"] == "stopped" and "other 2" in plain["why"]
    load(tab, PAGE, world(lengths=(-1,)))
    _, docs, _ = walk(tab)
    assert plain["docs"] == docs[:30]


def test_without_a_walk_nothing_is_changed(tab):
    load(tab, PAGE, world())
    got = read(tab)
    assert got["state"] == "stopped" and "30 bills and 10" in got["why"] and len(got["docs"]) == 10
    assert tab.evaluate("window.log") == []
    assert tab.evaluate("[document.getElementById('accountList').value, document.querySelector('[name=billHistoryTable_length]').value]") == ["A100", "10"]
    assert tab.evaluate("sessionStorage.getItem('statementSweep.sdgeWalk')") is None


def test_a_table_that_offers_all_shows_all_without_turning_pages(tab):
    one = {"A100": ACCOUNTS["A100"]}
    load(tab, PAGE, world(one, lengths=(10, 25, -1)))
    got = tab.evaluate("__sweep.readList({walk: true})")
    assert got == {"state": "ok", "docs": every(one)}
    assert tab.evaluate("window.log") == ["length -1"]


def test_pages_are_turned_when_the_longest_page_is_not_all(tab):
    one = {"A100": ACCOUNTS["A100"]}
    load(tab, PAGE, world(one))
    got = tab.evaluate("__sweep.readList({walk: true})")
    assert got == {"state": "ok", "docs": every(one)}
    assert tab.evaluate("window.log") == ["length 25", "next"]


def test_a_next_control_that_reads_otherwise_is_not_pressed(tab):
    one = {"A100": ACCOUNTS["A100"]}
    load(tab, PAGE, world(one, next_words="Pay now"))
    got = tab.evaluate("__sweep.readList({walk: true})")
    assert got["state"] == "stopped" and len(got["docs"]) == 25
    assert tab.evaluate("window.log") == ["length 25"]


def test_an_account_the_page_never_shows_stops(tab):
    load(tab, PAGE, world(lengths=(-1,), switches=False))
    got, docs, moves = walk(tab)
    assert moves == [{"moved": True}]
    assert got["state"] == "stopped" and "account chosen" in got["why"]
    assert len(docs) == 30


def test_one_account_ends_the_walk_with_no_more(tab):
    load(tab, PAGE, accounts(1) + table(row()))
    assert tab.evaluate("__sweep.readList({walk: true})") == {"state": "ok", "docs": [BILL]}
