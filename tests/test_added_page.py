"""Add This Site's picker (picker.js) and the one recipe for added sites
(providers/added.page.js), in a real Chromium, on stand-in statements pages
served at an invented host: a table with a Statement Date column, a plain
list with the dates in each link's words, a list with no dates, and a table
whose statement links sit beside pay buttons and links. The picker is run
with its shadow root kept aside so the test can read its card, and pressed
with real mouse clicks, as a person would. Every number and name is invented."""
import json
from pathlib import Path
from urllib.parse import urlsplit
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "https://bank.example.test"
PDF = b"%PDF-1.4 invented\n%%EOF"

# The page's own listener records any press that reaches it, and a page that
# opens a link would leave this address.
SPY = """<script>
window.reached = [];
document.addEventListener('click', (e) => { const a = e.target.closest('a, button'); if (a) reached.push(a.textContent.trim()); });
</script>"""

TABLE = f"""<!doctype html><title>Statements | Acme Bank</title>
<h1>Statements</h1>
<nav><a href="/accounts">Accounts</a> <a href="/pay">Pay Now</a></nav>
<table id="docs"><thead><tr><th>Statement Date</th><th>Description</th><th>Document</th></tr></thead>
<tbody>
<tr class="row odd"><td>Oct 31, 2026</td><td>Monthly statement</td><td><a href="/statements/99990003/pdf">Download</a></td></tr>
<tr class="row even"><td>Sep 30, 2026</td><td>Monthly statement</td><td><a href="/statements/99990002/pdf">Download</a></td></tr>
<tr class="row odd"><td>Aug 31, 2026</td><td>Monthly statement</td><td><a href="/statements/99990001/pdf">Download</a></td></tr>
</tbody></table>
<p><a href="/help">Download help</a></p>{SPY}"""

LIST = f"""<!doctype html><title>Acme Card - Documents</title>
<div class="docs">
  <a class="doc" href="/docs/view?id=a9F3kd92Lq0Zx1">October 2026 Statement</a><br>
  <a class="doc" href="/docs/view?id=b8E2jc81Kp9Yw2">September 2026 Statement</a><br>
  <a class="doc" href="/docs/view?id=c7D1ib70Jo8Xv3">August 2026 Statement</a><br>
</div>
<p><a href="/docs/settings">Paperless Settings</a></p>{SPY}"""

NO_DATES = f"""<!doctype html><title>Files</title>
<ul class="files">
  <li><span>Checking</span> <a href="/files/99990001.pdf">PDF</a></li>
  <li><span>Checking</span> <a href="/files/99990002.pdf">PDF</a></li>
</ul>{SPY}"""

BUTTONS = f"""<!doctype html><title>Acme Loans</title>
<table><thead><tr><th>Date</th><th></th></tr></thead><tbody>
<tr><td>2026-10-31</td><td><a href="/stmt/99990002">View</a> <button type="button">Pay</button> <a href="/pay/99990002">Pay Now</a></td></tr>
<tr><td>2026-09-30</td><td><a href="/stmt/99990001">View</a> <button type="button">Pay</button> <a href="/pay/99990001">Pay Now</a></td></tr>
</tbody></table>
<form action="/pay" method="post"><button type="submit">Submit Payment</button></form>
<input type="password" style="display:none">{SPY}"""

CARDS = f"""<!doctype html><title>Acme Insurance</title>
<div class="stack">
  <div class="stmt-card"><span>Statement Date: 10/31/2026</span> <a href="/policy/doc/99990002" target="_blank">Open</a></div>
  <div class="stmt-card"><span>Statement Date: 09/30/2026</span> <a href="/policy/doc/99990001" target="_blank">Open</a></div>
</div>{SPY}"""

PAGES = {"/statements": TABLE, "/documents": LIST, "/files": NO_DATES, "/loans": BUTTONS, "/insurance": CARDS,
         "/statements-moved": TABLE.replace("<a href=\"/statements/", "<a href=\"/new/").replace("Download</a>", "Get</a>")}

# Kept aside: every shadow root made, and what the picker sends.
WORLD = """window.__roots = []; window.__sent = [];
const attach = Element.prototype.attachShadow;
Element.prototype.attachShadow = function (o) { const r = attach.call(this, o); __roots.push(r); return r; };
window.chrome = { runtime: { sendMessage: async (m) => { __sent.push(m); return window.__answer || { ok: true, name: m.config && m.config.name }; } } };
"""


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture
def site(browser):
    context = browser.new_context()
    page = context.new_page()
    page.asked = []

    def route(r):
        url = r.request.url
        page.asked.append(url)
        path = urlsplit(url).path
        if path in PAGES:
            r.fulfill(status=200, content_type="text/html; charset=utf-8", body=PAGES[path])
        elif path.endswith(".pdf") or path.endswith("/pdf"):
            r.fulfill(status=200, content_type="application/pdf", body=PDF)
        else:
            r.fulfill(status=200, content_type="text/html", body="<!doctype html><p>elsewhere</p>")
    page.route("**/*", route)
    page.add_init_script(WORLD)
    yield page
    context.close()


def open_page(page, path, picker=True):
    page.goto(ORIGIN + path)
    page.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    page.add_script_tag(content=(ROOT / "providers" / "added.page.js").read_text())
    if picker:
        page.add_script_tag(content=(ROOT / "picker.js").read_text())
        assert page.evaluate("__sweepPicker.start({})") == "shown"


def card(page):
    return page.evaluate("() => { const r = __roots[__roots.length - 1]; const c = r && r.querySelector('.card'); return c && c.isConnected ? c.innerText : null; }")


def press_card(page, text):
    """A real click on the card's button with these words."""
    box = page.evaluate("""(t) => { const b = [...__roots[__roots.length - 1].querySelectorAll('button')].find((x) => x.textContent === t);
        const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }""", text)
    page.mouse.click(*box)


def boxes(page):
    return page.evaluate("() => [...__roots[__roots.length - 1].querySelectorAll('.box.like')].map((b) => [b.dataset.kind, b.textContent, b.style.display])")


def pick(page, selector):
    page.click(selector)
    page.wait_for_function("() => { const r = __roots[__roots.length - 1]; return r && /Found|Pick a|isn't|look|button|another/.test(r.querySelector('.card').innerText.split('\\n').slice(1).join(' ')); }")


# -- the picker ---------------------------------------------------------------------------

def test_the_card_asks_for_one_statement(site):
    open_page(site, "/statements")
    text = card(site)
    assert "Pick One Statement" in text
    assert "Click the link you would press to open one statement. Statement Sweep finds the others like it." in text
    assert "Cancel" in text


def test_a_hovered_link_gets_a_dashed_outline(site):
    open_page(site, "/statements")
    site.hover("tbody tr:nth-child(2) a")
    got = site.evaluate("""() => { const b = __roots[__roots.length - 1].querySelector('.box.hover');
        const a = document.querySelector('tbody tr:nth-child(2) a').getBoundingClientRect();
        return [b.style.display, getComputedStyle(b).outlineStyle, Math.round(parseFloat(b.style.left)) === Math.round(a.left)]; }""")
    assert got == ["block", "dashed", True]


def test_a_statements_table_is_read_with_its_date_column(site):
    open_page(site, "/statements")
    pick(site, "tbody tr:nth-child(2) a")
    text = card(site)
    assert "3 Statements Found" in text
    assert "Aug 31, 2026 to Oct 31, 2026" in text
    assert "Dates from the Statement Date column" in text
    assert "Save all 3 here now" in text and "Only new ones from now on" in text
    assert "Pick Again" in text and "Add Site" in text
    # The press reached nothing on the page, and nothing opened.
    assert site.evaluate("reached") == [] and site.url == ORIGIN + "/statements"
    assert sorted(boxes(site)) == [["like", "Like it", "block"], ["like", "Like it", "block"], ["picked", "You picked this", "block"]]
    # The help link that also says Download, and the pay link, are not like it.
    assert site.evaluate("() => __roots[__roots.length - 1].querySelectorAll('.box.like').length") == 3
    # The name comes from the page's title.
    assert site.evaluate("() => __roots[__roots.length - 1].querySelector('input[type=text]').value") == "Acme Bank"


def test_add_site_sends_only_the_pattern_and_says_it_was_added(site):
    open_page(site, "/statements")
    pick(site, "tbody tr:nth-child(1) a")
    site.evaluate("() => { const i = __roots[__roots.length - 1].querySelector('input[type=text]'); i.value = 'Acme'; }")
    site.evaluate("() => __roots[__roots.length - 1].querySelector('input[value=new]').click()")
    press_card(site, "Add Site")
    site.wait_for_function("() => /Added/.test(__roots[__roots.length - 1].querySelector('.card').innerText)")
    assert "Acme Added" in card(site) and "It syncs with your other sites." in card(site)
    [sent] = site.evaluate("__sent")
    config = sent["config"]
    assert sent["type"] == "addSite"
    assert config == {
        "row": {"tag": "tr", "classes": ["row"]},
        "path": [["td", 3], ["a", 1]],
        "href": "/statements/{id}/pdf",
        "text": "Download",
        "date": {"from": "column", "column": 0, "header": "Statement Date"},
        "method": "fetch",
        "listUrl": "/statements",
        "listPath": "/statements",
        "name": "Acme",
        "firstSync": "new",
    }
    # Nothing from the page that could be personal: no number, no row's words.
    assert "9999" not in json.dumps(config) and "Monthly" not in json.dumps(config)
    press_card(site, "Done")
    site.wait_for_function("() => !document.querySelector('statement-sweep-picker')")


def test_a_plain_list_reads_dates_from_each_links_words(site):
    open_page(site, "/documents")
    pick(site, ".docs a:nth-of-type(2)")
    text = card(site)
    assert "3 Statements Found" in text
    # "October 2026" is dated the month's last day.
    assert "Aug 31, 2026 to Oct 31, 2026" in text
    assert "Dates from each link's text" in text
    assert site.evaluate("() => __roots[__roots.length - 1].querySelector('input[type=text]').value") == "Acme Card"
    press_card(site, "Add Site")
    site.wait_for_function("__sent.length === 1")
    config = site.evaluate("__sent[0].config")
    assert config["href"] == "/docs/view?id={id}" and config["text"] == "" and config["method"] == "click"
    assert config["row"] == {"tag": "a", "classes": ["doc"]} and config["path"] == []


def test_a_page_with_no_dates_says_so_and_can_still_be_added(site):
    open_page(site, "/files")
    pick(site, ".files li:first-child a")
    text = card(site)
    assert "2 Statements Found" in text and "No dates found" in text
    assert "Each is told apart by its link instead" in text
    site.evaluate("() => { __roots[__roots.length - 1].querySelector('input[type=text]').value = 'Acme Files'; }")
    press_card(site, "Add Site")
    site.wait_for_function("__sent.length === 1")
    config = site.evaluate("__sent[0].config")
    assert config["date"] == {"from": "none"} and config["text"] == "PDF" and config["method"] == "fetch"


def test_statement_links_beside_pay_buttons_find_only_the_statements(site):
    open_page(site, "/loans")
    pick(site, "tbody tr:first-child a:first-of-type")
    text = card(site)
    assert "2 Statements Found" in text and "Sep 30, 2026 to Oct 31, 2026" in text and "Dates from the Date column" in text
    assert site.evaluate("reached") == []


def test_repeated_cards_that_open_a_new_tab(site):
    open_page(site, "/insurance")
    pick(site, ".stmt-card:first-child a")
    text = card(site)
    assert "2 Statements Found" in text and "Sep 30, 2026 to Oct 31, 2026" in text and "Dates from each row's text" in text
    press_card(site, "Add Site")
    site.wait_for_function("__sent.length === 1")
    config = site.evaluate("__sent[0].config")
    assert config["method"] == "newtab" and config["row"] == {"tag": "div", "classes": ["stmt-card"]}
    assert len(site.context.pages) == 1


def test_a_button_or_a_pay_link_is_not_taken(site):
    open_page(site, "/loans")
    pick(site, "tbody tr:first-child button")
    assert "That's a button, not a link." in card(site)
    pick(site, "tbody tr:first-child a:last-of-type")
    assert "such as paying or changing a setting" in card(site)
    assert "Pick One Statement" in card(site)
    assert site.evaluate("reached") == [] and site.url == ORIGIN + "/loans"


def test_a_link_to_another_site_is_not_taken(site):
    open_page(site, "/statements")
    site.evaluate("() => document.querySelector('nav a').setAttribute('href', 'https://other.example.test/x')")
    pick(site, "nav a")
    assert "That link goes to another site. Pick a statement link on bank.example.test." in card(site)


def test_pick_again_and_cancel(site):
    open_page(site, "/statements")
    pick(site, "tbody tr:first-child a")
    press_card(site, "Pick Again")
    site.wait_for_function("() => /Pick One Statement/.test(__roots[__roots.length - 1].querySelector('.card').innerText)")
    assert boxes(site) == []
    press_card(site, "Cancel")
    site.wait_for_function("() => !document.querySelector('statement-sweep-picker')")
    # Once it is gone, the page's links work again.
    site.click("tbody tr:first-child td:nth-child(2)")
    assert site.evaluate("reached") == []


def test_a_refusal_from_the_engine_is_said_on_the_card(site):
    open_page(site, "/statements")
    site.evaluate("window.__answer = { ok: false, why: 'Statement Sweep isn\\'t allowed to read bank.example.test.' }")
    pick(site, "tbody tr:first-child a")
    press_card(site, "Add Site")
    site.wait_for_function("() => /allowed/.test(__roots[__roots.length - 1].querySelector('.card').innerText)")
    assert "3 Statements Found" in card(site)


# -- dates -------------------------------------------------------------------------------

@pytest.mark.parametrize("text,want", [
    ("Oct 31, 2026", "2026-10-31"),
    ("October 31, 2026", "2026-10-31"),
    ("Sept. 30 2026", "2026-09-30"),
    ("10/31/2026", "2026-10-31"),
    ("2026-10-31", "2026-10-31"),
    ("October 2026", "2026-10-31"),
    ("Feb 2028 statement", "2028-02-29"),
    ("31 October 2026", "2026-10-31"),
    ("Period Oct 1, 2026 - Oct 31, 2026", "2026-10-31"),
    ("Due Nov 25, 2026 · Closing Oct 31, 2026", "2026-11-25"),
    ("Statement 99990001", None),
    ("13/45/2026", None),
    ("May you 2026", None),
])
def test_dates_are_read_in_each_shape(site, text, want):
    open_page(site, "/files", picker=False)
    assert site.evaluate("(t) => __sweepAdded.dateIn(t)", text) == want


# -- the recipe -------------------------------------------------------------------------

def learned(page, selector):
    return page.evaluate("(s) => { const r = __sweepAdded.learn(document.querySelector(s)); return { ...r.config, matches: undefined }; }", selector)


def configure(page, config, **more):
    page.evaluate("(c) => { globalThis.__sweepAddedConfig = c; }", {**config, "origin": ORIGIN, "name": "Acme", **more})


def test_the_recipe_lists_what_the_picker_found_newest_first(site):
    open_page(site, "/statements", picker=False)
    configure(site, learned(site, "tbody tr:first-child a"))
    got = site.evaluate("async () => __sweepCarry(await __sweep.readList({walk: true}))")
    assert got["state"] == "ok"
    assert [(d["id"], d["date"], d["method"]) for d in got["docs"]] == [
        ("2026-10-31", "2026-10-31", "fetch"), ("2026-09-30", "2026-09-30", "fetch"), ("2026-08-31", "2026-08-31", "fetch")]
    assert any("3 like the one picked" in line for line in got["log"])


def test_the_recipe_fetches_only_the_matching_pdf(site):
    open_page(site, "/statements", picker=False)
    configure(site, learned(site, "tbody tr:first-child a"))
    site.asked.clear()
    got = site.evaluate("__sweep.fetchPdf({id: '2026-09-30'})")
    assert got["ok"] and got["size"] == len(PDF)
    assert [urlsplit(u).path for u in site.asked] == ["/statements/99990002/pdf"]
    assert site.evaluate("__sweep.fetchPdf({id: 'guard:2026-10-01'})") == {"ok": False, "why": "Its link was not on the page."}


def test_the_recipe_presses_only_the_matching_link(site):
    open_page(site, "/loans", picker=False)
    configure(site, learned(site, "tbody tr:first-child a:first-of-type"))
    got = site.evaluate("__sweep.readList({walk: true})")
    assert [d["id"] for d in got["docs"]] == ["2026-10-31", "2026-09-30"] and got["docs"][0]["method"] == "click"
    site.evaluate("document.addEventListener('click', (e) => e.preventDefault())")
    assert site.evaluate("__sweep.clickDoc({id: '2026-09-30'})") == {"ok": True}
    assert site.evaluate("reached") == ["View"]
    assert site.evaluate("__sweep.clickDoc({id: 'nothing'})")["ok"] is False


def test_with_no_dates_ids_come_from_each_link(site):
    open_page(site, "/files", picker=False)
    configure(site, learned(site, ".files li:first-child a"))
    docs = site.evaluate("__sweep.readList({walk: true})")["docs"]
    assert len(docs) == 2 and all(d["id"].startswith("h~") and d["date"] == "" for d in docs)
    assert len({d["id"] for d in docs}) == 2
    # The same link gives the same id every time.
    assert [d["id"] for d in site.evaluate("__sweep.readList({walk: true})")["docs"]] == [d["id"] for d in docs]


def test_a_page_that_changed_stops_and_says_why(site):
    open_page(site, "/statements", picker=False)
    config = learned(site, "tbody tr:first-child a")
    open_page(site, "/statements-moved", picker=False)
    configure(site, config, listPath="/statements-moved")
    site.clock.install()
    answer = site.evaluate_handle("__sweep.readList({walk: true})")
    site.clock.run_for(8000)
    got = answer.json_value()
    assert got["state"] == "stopped" and got["noMatch"] is True and got["docs"] == []
    assert got["why"].startswith("No links like the one you picked were found")


def test_a_sign_in_page_is_signed_out(site):
    open_page(site, "/statements", picker=False)
    config = learned(site, "tbody tr:first-child a")
    open_page(site, "/loans", picker=False)
    configure(site, config, listPath="/loans")
    assert site.evaluate("__sweep.readList({walk: true})") == {"state": "signed_out"}


def test_off_the_list_page_it_is_not_the_list_yet(site):
    open_page(site, "/statements", picker=False)
    config = learned(site, "tbody tr:first-child a")
    open_page(site, "/files", picker=False)
    configure(site, config)
    assert site.evaluate("__sweep.readList({walk: true})") == {"state": "no_list"}
    # A list page whose address was not kept (it held an account's number) waits for you to open it.
    configure(site, config, listOpen=False)
    got = site.evaluate("__sweep.readList({walk: true})")
    assert got["state"] == "waiting" and got["why"] == "Open your statements on Acme. Statement Sweep goes on by itself."


def test_a_list_address_with_an_account_number_is_not_kept(site):
    PAGES["/accounts/99990001/statements"] = TABLE
    try:
        open_page(site, "/accounts/99990001/statements", picker=False)
        config = learned(site, "tbody tr:first-child a")
        assert (config["listUrl"], config["listPath"], config["listOpen"]) == ("/", "/accounts/{id}/statements", False)
    finally:
        del PAGES["/accounts/99990001/statements"]
