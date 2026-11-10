"""The First Horizon page logic, in a real Chromium, on stand-in pages.
Every value is invented, shaped as PaperPull's survey saw them."""
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://digital.firsthorizon.com"
PAGE = "/#accounts/documents"


def card(mdy, date_label=None, button=True, extra=""):
    label = date_label or mdy
    b = (f'<button class="edocs-download-btn" aria-label="Open New Tab to Download PDF for {mdy} statement" '
         f'onclick="(window.pressed = window.pressed || []).push(\'{mdy}\')" {extra}>Download PDF</button>') if button else ""
    return f'<div class="card edocs-item-card" aria-label="Monthly statement for {label}">{b}</div>'


def panel(cards, nick="Everyday", product="Express Checking", mask="4821", expanded="true", region="p1", style=""):
    return (f'<div class="accordion-panel" role="button" aria-expanded="{expanded}" aria-controls="{region}" style="{style}">'
            f'{nick} ({product}) (*{mask}) $12.34</div><div id="{region}">{cards}</div>')


def documents(panels):
    return f'<h1>View Statements</h1><button class="edocs-estatements-tab">STATEMENTS</button>{panels}'


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, body, url=BASE + PAGE):
    tab.goto("about:blank")
    tab.unroute("**/*")
    tab.route("**/*", lambda r: r.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body}"))
    tab.goto(url)
    source = (ROOT / "providers" / "firsthorizon.page.js").read_text()
    assert "OPEN_WAIT_MS = 20000" in source
    tab.add_script_tag(content=source.replace("OPEN_WAIT_MS = 20000", "OPEN_WAIT_MS = 1500"))


def read(tab):
    return tab.evaluate("__sweep.readList()")


def click(tab, doc_id):
    return tab.evaluate("(id) => __sweep.clickDoc({id})", doc_id)


TWO = documents(panel(card("08/15/2026") + card("09/15/2026")) + panel(card("09/20/2026"), mask="7000", region="p2"))


def test_open_panels_are_read_newest_first_with_their_dates(tab):
    load(tab, TWO)
    assert read(tab) == {"state": "ok", "docs": [
        {"id": "7000-2026-09-20", "date": "2026-09-20", "title": "Express Checking (*7000)", "method": "click"},
        {"id": "4821-2026-09-15", "date": "2026-09-15", "title": "Express Checking (*4821)", "method": "click"},
        {"id": "4821-2026-08-15", "date": "2026-08-15", "title": "Express Checking (*4821)", "method": "click"}]}


def test_a_closed_panel_is_not_opened_and_says_so(tab):
    load(tab, documents(panel(card("09/15/2026")) + panel("", mask="7000", expanded="false", region="p2")))
    got = read(tab)
    assert got["state"] == "stopped" and "closed" in got["why"]
    assert [d["date"] for d in got["docs"]] == ["2026-09-15"]
    assert tab.evaluate("window.pressed") is None


@pytest.mark.parametrize("url", [BASE + "/sso/logout", "https://security.firsthorizon.com/"])
def test_a_sign_in_address_is_signed_out(tab, url):
    load(tab, "<p>Sign in</p>", url=url)
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_signed_out(tab):
    load(tab, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_the_session_timeout_warning_is_signed_out(tab):
    load(tab, documents(panel(card("09/15/2026"))) + "<div>Session Timeout Warning</div>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_needs_the_person(tab):
    load(tab, "<h1>Enter the code we sent you</h1>")
    assert read(tab) == {"state": "challenge"}


def test_a_statement_card_is_not_a_security_check(tab):
    load(tab, documents(panel(card("09/15/2026"))) + "<p>Enter the code from your authenticator</p>")
    assert read(tab)["state"] == "ok"


def test_another_route_is_not_the_list_yet(tab):
    load(tab, "<h1>Accounts</h1>", url=BASE + "/#accounts/list")
    assert read(tab) == {"state": "no_list"}


@pytest.mark.parametrize("label", ["13/40/2026", "02/31/2026", "September 15, 2026"])
def test_a_date_that_is_not_one_stops(tab, label):
    load(tab, documents(panel(card("09/15/2026", date_label=label))))
    assert read(tab)["state"] == "stopped"


def test_two_statements_of_one_date_stop(tab):
    load(tab, documents(panel(card("09/15/2026") + card("09/15/2026"))))
    assert read(tab)["state"] == "stopped"


def test_a_card_with_no_download_stops(tab):
    load(tab, documents(panel(card("09/15/2026", button=False))))
    assert read(tab)["state"] == "stopped"


def test_a_panel_the_page_hides_stops(tab):
    load(tab, documents(panel(card("09/15/2026")) + panel("", mask="7000", expanded="false", region="p2", style="display:none")))
    got = read(tab)
    assert got["state"] == "stopped" and "hidden" in got["why"]


def test_the_click_presses_only_that_statements_button(tab):
    load(tab, TWO)
    assert click(tab, "4821-2026-09-15") == {"ok": True}
    assert tab.evaluate("window.pressed") == ["09/15/2026"]


@pytest.mark.parametrize("doc_id", ["../../etc", "4821-2026-09-16", "9999-2026-09-15", ""])
def test_a_statement_not_on_the_page_is_not_pressed(tab, doc_id):
    load(tab, TWO)
    assert click(tab, doc_id)["ok"] is False
    assert tab.evaluate("window.pressed") is None


def test_a_turned_off_button_is_not_pressed(tab):
    load(tab, documents(panel(card("09/15/2026", extra="disabled"))))
    assert click(tab, "4821-2026-09-15")["ok"] is False
    assert tab.evaluate("window.pressed") is None


def test_a_button_labelled_for_another_date_is_not_pressed(tab):
    wrong = card("09/15/2026").replace("for 09/15/2026 statement", "for 08/15/2026 statement")
    load(tab, documents(panel(wrong)))
    assert click(tab, "4821-2026-09-15")["ok"] is False
    assert tab.evaluate("window.pressed") is None


# A small statements page whose closed panels really open, drawing their
# cards a moment after, as the bank's answer comes in. `exclusive` closes
# the open panel when another opens; `stuck` panels never open.
ACCOUNTS = [("Everyday", "Express Checking", "4821", ["09/15/2026", "08/15/2026"]),
            ("Rainy Day", "Savings", "7000", ["09/30/2026"]),
            ("Joint", "Express Checking", "3300", ["09/15/2026", "07/15/2026", "06/15/2026"])]


def world(accounts=ACCOUNTS, opened=(0,), exclusive=False, stuck=(), lazy=False):
    panels = "".join(
        panel("".join(card(d) for d in dates) if i in opened else "", nick=nick, product=product, mask=mask,
              expanded="true" if i in opened else "false", region=f"r{i}")
        for i, (nick, product, mask, dates) in enumerate(accounts))
    data = {f"r{i}": dates for i, (_, _, _, dates) in enumerate(accounts)}
    return documents(panels) + f"""<script>
    const data = {json.dumps(data)}, stuck = {json.dumps([f"r{i}" for i in stuck])};
    window.opened = [];
    // As on the real site (2026-11-09): a closed panel's list is not drawn
    // at all until the panel opens.
    if ({json.dumps(lazy)}) document.querySelectorAll('.accordion-panel[aria-expanded=false]').forEach((p) => {{
      const box = document.getElementById(p.getAttribute('aria-controls')); if (box) box.remove();
    }});
    const card = (d) => `<div class="card edocs-item-card" aria-label="Monthly statement for ${{d}}">` +
      `<button class="edocs-download-btn" aria-label="Open New Tab to Download PDF for ${{d}} statement" ` +
      `onclick="(window.pressed = window.pressed || []).push('${{d}}')">Download PDF</button></div>`;
    document.querySelectorAll('.accordion-panel').forEach((p) => p.addEventListener('click', () => {{
      const r = p.getAttribute('aria-controls');
      opened.push(r);
      if (stuck.includes(r)) return;
      if ({json.dumps(exclusive)}) document.querySelectorAll('.accordion-panel').forEach((o) => {{
        if (o !== p) {{ o.setAttribute('aria-expanded', 'false'); const box = document.getElementById(o.getAttribute('aria-controls')); if (box) box.innerHTML = ''; }}
      }});
      p.setAttribute('aria-expanded', 'true');
      setTimeout(() => {{
        if (!document.getElementById(r)) {{ const box = document.createElement('div'); box.id = r; p.after(box); }}
        document.getElementById(r).innerHTML = data[r].map(card).join('');
      }}, 150);
    }}));
    </script>"""


def walk(tab, views=10):
    """The engine's walk: read, save what is new, then move on while there is more."""
    docs, moves, saved = [], [], []
    for _ in range(views):
        got = tab.evaluate("__sweep.readList({walk: true})")
        docs += got.get("docs", [])
        for d in got.get("docs", []):
            saved.append(click(tab, d["id"]))
        if got["state"] != "ok" or not got.get("more"):
            return got, docs, moves, saved
        moves.append(tab.evaluate("__sweep.nextView()"))
        if not moves[-1].get("moved"):
            return got, docs, moves, saved
    raise AssertionError("the walk did not end")


def every(accounts=ACCOUNTS):
    out = set()
    for _, _, mask, dates in accounts:
        for d in dates:
            m, day, y = d.split("/")
            out.add(f"{mask}-{y}-{m}-{day}")
    return out


@pytest.mark.parametrize("exclusive", [False, True])
def test_the_walk_opens_each_closed_panel_once_and_reads_every_statement(tab, exclusive):
    load(tab, world(exclusive=exclusive))
    got, docs, moves, saved = walk(tab)
    # The reading after the last panel opened has no more, which ends the walk.
    assert got["state"] == "ok" and "more" not in got and moves == [{"moved": True}, {"moved": True}]
    assert {d["id"] for d in docs} == every()
    assert len(docs) == 6 and all(s == {"ok": True} for s in saved)
    assert tab.evaluate("window.opened") == ["r1", "r2"]
    assert sorted(tab.evaluate("window.pressed")) == sorted(["09/15/2026", "08/15/2026", "09/30/2026", "09/15/2026", "07/15/2026", "06/15/2026"])
    assert tab.evaluate("window.__firstHorizonWalk") is None


@pytest.mark.parametrize("exclusive", [False, True])
def test_panels_whose_list_is_drawn_only_when_opened_are_walked(tab, exclusive):
    load(tab, world(exclusive=exclusive, lazy=True))
    got, docs, moves, saved = walk(tab)
    assert got["state"] == "ok" and moves == [{"moved": True}, {"moved": True}]
    assert {d["id"] for d in docs} == every()
    assert all(s == {"ok": True} for s in saved)
    assert tab.evaluate("window.opened") == ["r1", "r2"]


def test_a_walk_with_every_panel_closed_opens_them_all(tab):
    load(tab, world(opened=()))
    got, docs, moves, _ = walk(tab)
    assert got["state"] == "ok" and moves == [{"moved": True}] * 3
    assert {d["id"] for d in docs} == every()
    assert tab.evaluate("window.opened") == ["r0", "r1", "r2"]


def test_the_walks_ids_are_the_ones_read_without_a_walk(tab):
    load(tab, world())
    plain = read(tab)
    assert plain["state"] == "stopped" and "2 account panel(s) are closed" in plain["why"]
    assert tab.evaluate("window.opened") == [] and tab.evaluate("window.pressed") is None
    load(tab, world())
    _, docs, _, _ = walk(tab)
    assert plain["docs"] == [d for d in docs if d["id"].startswith("4821-")]


def test_a_panel_that_will_not_open_stops(tab):
    load(tab, world(stuck=(1,)))
    got, docs, moves, _ = walk(tab)
    assert "did not open" in moves[-1]["why"]
    assert {d["id"] for d in docs} == {"4821-2026-09-15", "4821-2026-08-15"}
    assert tab.evaluate("window.opened") == ["r1"]


def test_a_panel_whose_title_reads_like_another_control_is_not_pressed(tab):
    accounts = ACCOUNTS[:1] + [("Bill Pay", "Express Checking", "7000", ["09/30/2026"])]
    load(tab, world(accounts))
    got, _, moves, _ = walk(tab)
    assert got["more"] and "not one this will press" in moves[-1]["why"]
    assert tab.evaluate("window.opened") == []


def test_a_walk_with_every_panel_open_presses_no_panel(tab):
    load(tab, world(opened=(0, 1, 2)))
    got, docs, moves, _ = walk(tab)
    assert got == {"state": "ok", "docs": got["docs"]} and moves == []
    assert {d["id"] for d in docs} == every()
    assert tab.evaluate("window.opened") == []


def test_a_next_view_with_no_closed_panel_left_does_not_move(tab):
    load(tab, world(opened=(0, 1, 2)))
    assert tab.evaluate("__sweep.nextView()") == {"moved": False}
    assert tab.evaluate("window.opened") == [] and tab.evaluate("window.__firstHorizonWalk") is None
