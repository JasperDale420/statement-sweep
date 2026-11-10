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
    page.goto(meta["listUrl"])
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
