"""Every recipe, on a page of nothing but controls it must never press.

Each enabled site's recipe is put on a stand-in for its own list page, served
at its real address, that holds only pay, transfer, autopay, settings,
sign-out, delete and account controls, some dressed as statement rows. Every
part of the recipe's contract is then called with a made-up document of each
kind. Whatever it answers, none of those controls may be pressed, no form may
be submitted, and nothing may be asked of a host outside the site's own.
Every value here is invented."""
import json
from pathlib import Path
from urllib.parse import urlsplit
import fnmatch
import pytest
from playwright.sync_api import sync_playwright, Error as PlaywrightError

ROOT = Path(__file__).resolve().parents[1]
METAS = [m for m in (json.loads(p.read_text()) for p in sorted((ROOT / "providers").glob("*.meta.json"))) if m.get("enabled", True)]

# Labels a recipe must never press, alone and inside rows that also say
# "statement", the way a list row may carry a pay link beside it.
DANGER = [
    "Pay Now", "Make a Payment", "Pay Bill", "Schedule Payment", "Transfer Money", "Transfer Funds",
    "Set Up AutoPay", "Turn Off AutoPay", "Settings", "Account Settings", "Paperless Settings",
    "Update Password", "Sign Out", "Log Out", "Delete", "Close Account", "Withdraw", "Buy", "Sell",
    "Accept Terms", "Remove Card", "Statement October 2026 Make a Payment", "Statement Settings",
    "Download Statement and Pay",
]

PAGE = """<!doctype html><title>Stand-in</title>
<main><h1>Statements</h1><nav aria-label="Account">%s</nav>
<ul>%s</ul>
<form action="/danger/form" method="post" onsubmit="window.pressed.push('submit');return false">
  <input name="amount" value="1.00"><button type="submit">Submit Payment</button></form>
<input type="password" style="display:none" aria-hidden="true">
</main>
<script>
window.pressed = [];
for (const el of document.querySelectorAll('[data-danger]')) {
  el.addEventListener('click', (e) => { window.pressed.push(el.dataset.danger); e.preventDefault(); }, true);
}
const realSubmit = HTMLFormElement.prototype.submit, realRequest = HTMLFormElement.prototype.requestSubmit;
HTMLFormElement.prototype.submit = function () { window.pressed.push('form.submit'); };
HTMLFormElement.prototype.requestSubmit = function () { window.pressed.push('form.requestSubmit'); };
</script>"""


def controls():
    links = "".join(f'<a href="/danger/{i}" data-danger="{t}">{t}</a>' for i, t in enumerate(DANGER))
    buttons = "".join(f'<li><button type="button" data-danger="{t}" aria-label="{t}">{t}</button>'
                      f'<span role="button" tabindex="0" data-danger="{t}">{t}</span></li>' for t in DANGER)
    return PAGE % (links, buttons)


def own_host(meta, host):
    return any(fnmatch.fnmatch(f"https://{host}/", pattern[:-1]) for pattern in meta["match"]) \
        or host in meta.get("fileHosts", [])


# Sites whose list address is a sign-in on another host (TriNet W-2 starts at
# TriNet's own sign-in link): the page on their own host the sign-in lands on.
SIGNED_IN_PAGE = {"trinetw2": "https://www.paperlessemployee.com/trinettaxforms/PE/TaxStatements"}


def stand_in_url(meta):
    """The stand-in's address: the site's list address, or where its sign-in lands."""
    url = meta["listUrl"]
    if own_host(meta, urlsplit(url).hostname):
        return url
    assert meta["id"] in SIGNED_IN_PAGE, f"{meta['id']}: its list address is on another host; say where its sign-in lands"
    return SIGNED_IN_PAGE[meta["id"]]


DOCS = [
    {"id": "guard:2026-10-01", "date": "2026-10-01", "title": "Statement", "method": m, "url": "/danger/doc"}
    for m in ("click", "fetch", "newtab", "print")
]
CALL_MS = 6000


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.mark.parametrize("meta", METAS, ids=[m["id"] for m in METAS])
def test_no_recipe_presses_a_control_it_must_not(browser, meta):
    page = browser.new_page()
    asked = []

    def route(r):
        url = r.request.url
        asked.append(url)
        if urlsplit(url).path.startswith("/danger/"):
            r.fulfill(status=200, content_type="text/html", body="<!doctype html><p>danger</p>")
        else:
            r.fulfill(status=200, content_type="text/html; charset=utf-8", body=controls())
    page.route("**/*", route)
    page.goto(stand_in_url(meta))
    asked.clear()
    scripts = [ROOT / "providers" / "shared.js", ROOT / meta["pageFile"]]
    for s in scripts:
        page.add_script_tag(content=s.read_text())

    calls = [("readList", {"walk": True}), ("readList", {"walk": False}), ("nextView", None)]
    calls += [(name, d) for d in DOCS for name in ("clickDoc", "fetchPdf", "showDoc", "printReady", "leaveDoc")]
    pressed, called, moved = [], [], 0
    for name, arg in calls:
        try:
            pressed = page.evaluate(
                """async ([name, arg, ms]) => {
                     const fn = globalThis.__sweep && globalThis.__sweep[name];
                     window.called = window.called || [];
                     if (typeof fn === 'function') {
                       window.called.push(name);
                       await Promise.race([Promise.resolve().then(() => fn(arg)).catch(() => null),
                                           new Promise((r) => setTimeout(r, ms))]);
                     }
                     return [window.pressed, window.called];
                   }""", [name, arg, CALL_MS])
            pressed, now = pressed
            called = sorted(set(called) | set(now))
        except PlaywrightError:
            # The recipe moved the tab (a walk). Where it went is checked below;
            # the stand-in is put back so the rest of the contract is still tried.
            moved += 1
            page.wait_for_load_state()
            if moved > 3 or not page.evaluate("Array.isArray(window.pressed)"):
                break
            for s in scripts:
                page.add_script_tag(content=s.read_text())
        assert pressed == [], f"{meta['id']} {name} pressed {pressed}"

    page.close()
    # The test means nothing unless the recipe was really asked.
    assert "readList" in called, f"{meta['id']}: the recipe never ran ({called})"
    danger = [u for u in asked if urlsplit(u).path.startswith("/danger/")]
    assert danger == [], f"{meta['id']} asked for {danger}"
    away = [u for u in asked if urlsplit(u).scheme in ("http", "https") and not own_host(meta, urlsplit(u).hostname)]
    assert away == [], f"{meta['id']} asked another host: {away}"


# -- the recipe for sites added with Add This Site ---------------------------------------------
# It has no meta of its own: each added site is a saved pattern it is handed.
# Each pattern below is aimed at the page's dangerous controls in a different
# way: a statement pattern that is not there, one shaped like the danger
# links' own addresses, and one that would lead to a button. None may press.
ADDED_ORIGIN = "https://bank.example.test"
ADDED_PATTERNS = [
    {"row": {"tag": "tr", "classes": []}, "path": [["td", 3], ["a", 1]], "href": "/statements/{id}/pdf", "text": "Download",
     "date": {"from": "column", "column": 0, "header": "Statement Date"}, "method": "fetch"},
    {"row": {"tag": "a", "classes": []}, "path": [], "href": "/danger/{n}", "text": "", "date": {"from": "link"}, "method": "click"},
    {"row": {"tag": "li", "classes": []}, "path": [["button", 1]], "href": "", "text": "", "date": {"from": "none"}, "method": "click"},
    {"row": {"tag": "nav", "classes": []}, "path": [["a", 1]], "href": "/danger/{n}", "text": "", "date": {"from": "none"}, "method": "click"},
]


def added_config(pattern, path="/statements"):
    return {**pattern, "id": "added-acme", "name": "Acme", "origin": ADDED_ORIGIN, "listUrl": ADDED_ORIGIN + path,
            "listPath": path, "match": [ADDED_ORIGIN + "/*"], "firstSync": "all"}


def run_contract(page, config, docs):
    """Every part of the recipe's contract, on whatever the page holds. Answers
    what was pressed and which parts were called."""
    page.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    page.add_script_tag(content=(ROOT / "providers" / "added.page.js").read_text())
    page.evaluate("(c) => { globalThis.__sweepAddedConfig = c; }", config)
    return page.evaluate("""async ([docs, ms]) => {
        const called = [];
        const race = (p) => Promise.race([Promise.resolve().then(p).catch(() => null), new Promise((r) => setTimeout(r, ms))]);
        const listed = [];
        for (const walk of [true, false]) {
          called.push('readList');
          const r = await race(() => __sweep.readList({ walk }));
          if (r && r.docs) listed.push(...r.docs);
        }
        for (const d of [...docs, ...listed]) {
          for (const name of ['clickDoc', 'fetchPdf', 'showDoc', 'printReady', 'leaveDoc', 'nextView']) {
            if (typeof __sweep[name] !== 'function') continue;
            called.push(name);
            await race(() => __sweep[name](d));
          }
        }
        return { pressed: window.pressed, called, listed: listed.length };
      }""", [docs, CALL_MS])


@pytest.mark.parametrize("pattern", ADDED_PATTERNS, ids=["statements", "danger-links", "buttons", "nav"])
def test_the_added_sites_recipe_presses_no_control_it_must_not(browser, pattern):
    page = browser.new_page()
    asked = []

    def route(r):
        asked.append(r.request.url)
        if urlsplit(r.request.url).path.startswith("/danger/"):
            r.fulfill(status=200, content_type="text/html", body="<!doctype html><p>danger</p>")
        else:
            r.fulfill(status=200, content_type="text/html; charset=utf-8", body=controls())
    page.route("**/*", route)
    page.goto(ADDED_ORIGIN + "/statements")
    page.clock.install()
    got = run_contract(page, added_config(pattern), DOCS + [{"id": f"h~{i}", "date": "", "method": "click"} for i in range(3)])
    page.close()
    assert got["pressed"] == [] and got["listed"] == 0, got
    assert "readList" in got["called"] and "clickDoc" in got["called"] and "fetchPdf" in got["called"]
    assert [u for u in asked if urlsplit(u).path.startswith("/danger/")] == []
    assert all(urlsplit(u).hostname == "bank.example.test" for u in asked), asked


# Statement links in the same rows as pay links and buttons, under a form.
MIXED = """<!doctype html><title>Stand-in</title><main><h1>Statements</h1>
<ul>%s</ul>
<form action="/danger/form" method="post" onsubmit="window.pressed.push('submit');return false">
  <input name="amount" value="1.00"><button type="submit" data-danger="Submit Payment">Submit Payment</button></form>
</main>
<script>
window.pressed = []; window.opened = [];
for (const el of document.querySelectorAll('[data-danger]')) {
  el.addEventListener('click', (e) => { window.pressed.push(el.dataset.danger); e.preventDefault(); }, true);
}
document.addEventListener('click', (e) => { const a = e.target.closest('a[href^="/statements/"]'); if (a) { opened.push(a.getAttribute('href')); e.preventDefault(); } });
HTMLFormElement.prototype.submit = function () { window.pressed.push('form.submit'); };
HTMLFormElement.prototype.requestSubmit = function () { window.pressed.push('form.requestSubmit'); };
</script>"""


def mixed():
    rows = "".join(
        f'<li><span>Oct {d}, 2026</span> <a href="/statements/{n}.pdf">Statement</a> '
        f'<a href="/danger/pay{n}" data-danger="Pay Now">Pay Now</a> <button type="button" data-danger="Pay">Pay</button> '
        f'<a href="/statements/{n}.pdf?pay=1" data-danger="Statement and Pay">Statement and Pay</a></li>'
        for d, n in ((31, 99990003), (30, 99990002), (29, 99990001)))
    return MIXED % rows


@pytest.mark.parametrize("method", ["fetch", "click", "newtab"])
def test_the_added_sites_recipe_saves_only_the_statements_beside_danger(browser, method):
    page = browser.new_page()
    asked = []

    def route(r):
        asked.append(r.request.url)
        path = urlsplit(r.request.url).path
        if path.startswith("/statements/"):
            r.fulfill(status=200, content_type="application/pdf", body=b"%PDF-1.4 invented\n%%EOF")
        elif path.startswith("/danger/"):
            r.fulfill(status=200, content_type="text/html", body="<!doctype html><p>danger</p>")
        else:
            r.fulfill(status=200, content_type="text/html; charset=utf-8", body=mixed())
    page.route("**/*", route)
    page.goto(ADDED_ORIGIN + "/list")
    pattern = {"row": {"tag": "li", "classes": []}, "path": [["a", 1]], "href": "/statements/{n}.pdf", "text": "Statement",
               "date": {"from": "row"}, "method": method}
    got = run_contract(page, added_config(pattern, "/list"), DOCS)
    opened = page.evaluate("opened")
    page.close()
    assert got["pressed"] == [], got
    assert got["listed"] == 6  # three statements, read twice
    assert sorted(set(opened)) == ["/statements/99990001.pdf", "/statements/99990002.pdf", "/statements/99990003.pdf"]
    fetched = sorted({urlsplit(u).path for u in asked if urlsplit(u).path.startswith("/statements/")})
    assert fetched == (["/statements/99990001.pdf", "/statements/99990002.pdf", "/statements/99990003.pdf"])
    assert [u for u in asked if urlsplit(u).path.startswith("/danger/") or "pay=1" in u] == []
    assert all(urlsplit(u).hostname == "bank.example.test" for u in asked), asked
