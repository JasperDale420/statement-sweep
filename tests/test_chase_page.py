"""The Chase page logic, in a real Chromium, on stand-in pages. Every card and
date is invented."""
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CENTER = "https://secure.chase.com/web/auth/dashboard#/dashboard/documents/myDocs/index"
RESERVE = "SAPPHIRE RESERVE (...1234)"
SOUTHWEST = "SOUTHWEST RAPID REWARDS PLUS (...5678)"
PICKER = '<input id="header-filterstyledselect-0" value="2026">'
ONE_YEAR = PICKER + '<div role="option">2026</div>'


def card(label, open_=True):
    return f'<button aria-expanded="{"true" if open_ else "false"}">{label}</button>'


def row(date, label=RESERVE, kind="Statement", id_=""):
    return f'<a href="#" class="row" id="{id_}">{date} {kind} {label} Saves document</a>'


def center(cards, rows, picker=ONE_YEAR):
    return f"<main>{picker}{cards}<div>{rows}</div></main>" + """<script>
    window.pressed = [];
    document.addEventListener('click', (e) => { const a = e.target.closest('a'); if (a) { e.preventDefault(); pressed.push(a.id); } });
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
    source = (ROOT / "providers" / "chase.page.js").read_text().replace("DRAW_WAIT_MS = 30000", "DRAW_WAIT_MS = 300") \
        .replace("SETTLE_MS = 1500", "SETTLE_MS = 50").replace("CARD_WAIT_MS = 15000", "CARD_WAIT_MS = 300") \
        .replace("YEAR_WAIT_MS = 8000", "YEAR_WAIT_MS = 300").replace("OPTION_WAIT_MS = 5000", "OPTION_WAIT_MS = 300")\
        .replace("MENU_SETTLE_MS = 3000", "MENU_SETTLE_MS = 100")
    tab.add_script_tag(content=source)


def read(tab):
    return tab.evaluate("__sweep.readList()")


DOCS_URL = "https://secure.chase.com/web/auth/dashboard#/dashboard/documents/myDocs/index"


def test_a_sign_in_drawn_in_a_frame_over_the_documents_address_is_known(tab):
    load(tab, DOCS_URL, "<iframe name='logonbox' src='about:blank' style='width:400px;height:400px'></iframe>")
    assert read(tab) == {"state": "signed_out"}


def test_a_hidden_sign_in_frame_is_not_a_sign_in(tab):
    load(tab, DOCS_URL, "<iframe name='logonbox' src='about:blank' style='display:none'></iframe>")
    assert read(tab)["state"] == "stopped"


def test_a_sign_in_address_is_known(tab):
    load(tab, "https://secure.chase.com/web/auth/#/logon/logon/chaseOnline", "<h1>Welcome</h1>")
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_known(tab):
    load(tab, CENTER, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_is_known(tab):
    load(tab, CENTER, "<p>Enter the code we sent to your phone.</p>")
    assert read(tab) == {"state": "challenge"}


def test_a_session_that_ended_is_a_sign_in(tab):
    load(tab, CENTER, "<p>For your security, we signed you out.</p>")
    assert read(tab) == {"state": "signed_out"}


def test_good_rows_come_newest_first_with_their_dates(tab):
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026") + row("Sep 09, 2026") + row("Jul 09, 2026")))
    got = read(tab)
    assert got["state"] == "ok"
    assert [d["date"] for d in got["docs"]] == ["2026-09-09", "2026-08-09", "2026-07-09"]
    assert got["docs"][0] == {"id": f"2026-09-09|Statement|{RESERVE}", "date": "2026-09-09", "title": RESERVE, "method": "click"}


def test_a_card_named_rewards_is_a_card_and_is_read(tab):
    load(tab, CENTER, center(card(SOUTHWEST), row("Aug 09, 2026", SOUTHWEST)))
    assert read(tab)["state"] == "ok"


def test_rows_of_a_closed_card_are_not_read_and_the_list_stops(tab):
    load(tab, CENTER, center(card(RESERVE) + card(SOUTHWEST, False),
                             row("Aug 09, 2026") + row("Aug 15, 2026", SOUTHWEST)))
    got = read(tab)
    assert got["state"] == "stopped" and "other 1" in got["why"]
    assert [d["date"] for d in got["docs"]] == ["2026-08-09"]


def test_a_view_with_no_rows_is_not_called_empty(tab):
    load(tab, CENTER, center(card(RESERVE), ""))
    got = read(tab)
    assert got["state"] == "stopped" and got["docs"] == []


def test_a_picker_whose_years_are_not_drawn_stops_with_the_rows_on_screen(tab):
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026"), picker=PICKER))
    got = read(tab)
    assert got["state"] == "stopped" and "2026" in got["why"] and "View picker" in got["why"]
    assert [d["date"] for d in got["docs"]] == ["2026-08-09"]


def test_a_picker_offering_older_years_stops_with_the_rows_on_screen(tab):
    picker = PICKER + '<div role="option">2026, current selection</div><div role="option">2025, you\'ve reached the end of the list</div>'
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026"), picker=picker))
    got = read(tab)
    assert got["state"] == "stopped" and "View picker" in got["why"]
    assert [d["date"] for d in got["docs"]] == ["2026-08-09"]


def test_a_year_named_only_in_an_options_label_counts(tab):
    picker = PICKER + '<div role="option" aria-label="2026, current selection"></div><div role="option" aria-label="2025"></div>'
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026"), picker=picker))
    assert read(tab)["state"] == "stopped"


def test_a_picker_offering_only_some_other_year_stops(tab):
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026"), picker=PICKER + '<div role="option">2025</div>'))
    assert read(tab)["state"] == "stopped"


def test_one_year_offered_as_the_current_selection_is_whole(tab):
    picker = PICKER + '<div role="option">2026, current selection</div>'
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026"), picker=picker))
    assert read(tab)["state"] == "ok"


def test_no_card_open_stops(tab):
    load(tab, CENTER, center(card(RESERVE, False), row("Aug 09, 2026")))
    assert read(tab)["state"] == "stopped"


def test_a_date_that_is_not_a_day_stops(tab):
    load(tab, CENTER, center(card(RESERVE), row("Feb 31, 2026")))
    assert read(tab)["state"] == "stopped"


def test_a_year_end_row_is_left_alone(tab):
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026") + row("Dec 31, 2025", kind="Year-End Summary")))
    assert [d["date"] for d in read(tab)["docs"]] == ["2026-08-09"]


@pytest.mark.parametrize("tail", ["&documentType=TAX_DOCUMENTS", "&documentType=YEAR_END_STATEMENTS"])
def test_another_tab_of_the_center_is_not_the_list(tab, tail):
    load(tab, CENTER + tail, center(card(RESERVE), row("Aug 09, 2026")))
    assert read(tab) == {"state": "no_list"}


def test_the_dashboard_is_not_the_list_yet(tab):
    load(tab, "https://secure.chase.com/web/auth/dashboard", "<h1>Accounts</h1>")
    assert read(tab) == {"state": "no_list"}


def test_a_center_that_never_draws_stops(tab):
    load(tab, CENTER, "<h1>Accounts</h1>")
    assert read(tab)["state"] == "stopped"


def test_a_picker_of_something_else_is_not_the_center(tab):
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026"), picker='<input id="x-filterstyledselect" value="All">'))
    assert read(tab)["state"] == "stopped"


def test_the_press_lands_on_its_own_row_only(tab):
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026", id_="a") + row("Sep 09, 2026", id_="b")))
    got = tab.evaluate(f"__sweep.clickDoc({{id: '2026-08-09|Statement|{RESERVE}'}})")
    assert got == {"ok": True}
    assert tab.evaluate("pressed") == ["a"]


def test_a_row_not_on_the_page_is_not_pressed(tab):
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026", id_="a")))
    got = tab.evaluate(f"__sweep.clickDoc({{id: '2031-01-01|Statement|{RESERVE}'}})")
    assert got["ok"] is False and tab.evaluate("pressed") == []


def test_a_row_naming_an_action_is_refused(tab):
    bad = "PAY CARD (...1234)"
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026", bad, id_="a")))
    assert tab.evaluate(f"__sweep.clickDoc({{id: '2026-08-09|Statement|{bad}'}})")["ok"] is False
    assert tab.evaluate("pressed") == []


# A small statements page that really switches years and opens cards. A card
# keeps its open state across years, as Chase's does, and a year draws only
# the cards that existed in it.
FREEDOM = "FREEDOM (...9012)"
WORLD = """<main id="m"></main><script>
const data = {
  'SAPPHIRE RESERVE (...1234)': {2026: ['Sep 09, 2026', 'Aug 09, 2026'], 2025: ['Dec 09, 2025'], 2024: ['Nov 09, 2024']},
  'SOUTHWEST RAPID REWARDS PLUS (...5678)': {2026: ['Sep 15, 2026'], 2025: []},
  'FREEDOM (...9012)': {2024: ['Oct 20, 2024']},
};
const years = ['2026', '2025', '2024'];
let shownYear = '2026', dataYear = '2026', listOpen = false;
const expanded = {'SAPPHIRE RESERVE (...1234)': true};
window.moves = []; window.frozen = false; window.stuck = ''; window.extra = '';
function draw() {
  let html = `<input id="header-filterstyledselect-0" value="${shownYear}">`;
  if (listOpen) html += years.map((y, i) => `<div role="option" id="container-${i}-filterstyledselect-0">${y}${y === shownYear ? ', current selection' : i === years.length - 1 ? ", you've reached the end of the list" : ''}</div>`).join('');
  for (const label of Object.keys(data)) {
    const rows = data[label][dataYear];
    if (!rows) continue;
    html += `<button aria-expanded="${expanded[label] ? 'true' : 'false'}">${label}</button>`;
    if (expanded[label]) html += rows.map((d) => `<a href="#">${d} Statement ${label} Saves document</a>`).join('');
  }
  document.getElementById('m').innerHTML = html + window.extra;
}
draw();
document.addEventListener('click', (e) => {
  const t = e.target.closest('a, button, input, [role=option]'); if (!t) return; e.preventDefault();
  if (t.tagName === 'BUTTON') {
    const label = t.textContent;
    if (!data[label]) { moves.push('pressed:' + label); return; }
    if (label === window.stuck) return;
    expanded[label] = !expanded[label]; moves.push((expanded[label] ? 'open:' : 'close:') + label);
  } else if (t.tagName === 'INPUT') listOpen = !listOpen;
  else if (t.getAttribute('role') === 'option') {
    listOpen = false; shownYear = t.textContent.slice(0, 4); if (!window.frozen) dataYear = shownYear; moves.push('year:' + shownYear);
  } else moves.push('link');
  draw();
});
</script>"""


def walk_everything(tab):
    ids, views = [], 0
    for _ in range(40):
        got = tab.evaluate("__sweep.readList({ walk: true })")
        assert got["state"] == "ok" and got["more"] is True, got
        ids += [d["id"] for d in got["docs"]]
        views += 1
        next_view = tab.evaluate("__sweep.nextView()")
        assert "why" not in next_view, next_view
        if not next_view["moved"]:
            return ids, views
    raise AssertionError("the walk never ended")


def test_a_walk_reads_every_card_of_every_year_once_and_ends(tab):
    load(tab, CENTER, WORLD)
    ids, _ = walk_everything(tab)
    assert ids == [
        f"2026-09-09|Statement|{RESERVE}", f"2026-08-09|Statement|{RESERVE}",
        f"2026-09-15|Statement|{SOUTHWEST}",
        f"2025-12-09|Statement|{RESERVE}",
        f"2024-11-09|Statement|{RESERVE}",
        f"2024-10-20|Statement|{FREEDOM}",
    ]
    assert len(set(ids)) == len(ids)
    assert tab.evaluate("moves") == [
        f"close:{RESERVE}", f"open:{SOUTHWEST}",
        "year:2025", f"close:{SOUTHWEST}", f"open:{RESERVE}", f"close:{RESERVE}", f"open:{SOUTHWEST}",
        "year:2024", f"open:{RESERVE}", f"close:{RESERVE}", f"open:{FREEDOM}",
    ]
    # Each card is opened once a year, and nothing but cards and years is pressed.
    segments = [[]]
    for m in tab.evaluate("moves"):
        if m.startswith("year:"):
            segments.append([])
        elif m.startswith("open:"):
            segments[-1].append(m)
    assert all(len(s) == len(set(s)) for s in segments)
    assert not any(m.startswith(("pressed:", "link")) for m in tab.evaluate("moves"))
    assert tab.evaluate("globalThis.__chaseWalk") is None


def test_a_card_already_open_is_opened_afresh_for_a_new_year(tab):
    load(tab, CENTER, WORLD)
    tab.evaluate("__sweep.readList({ walk: true })")
    tab.evaluate("__sweep.nextView()")  # to Southwest
    tab.evaluate("__sweep.readList({ walk: true })")
    assert tab.evaluate("__sweep.nextView()") == {"moved": True}  # to 2025, every card closed
    got = tab.evaluate("__sweep.readList({ walk: true })")
    assert got == {"state": "ok", "docs": [], "more": True}


def test_ids_are_the_ones_a_single_view_always_gave(tab):
    load(tab, CENTER, WORLD)
    walked = tab.evaluate("__sweep.readList({ walk: true })")["docs"]
    load(tab, CENTER, center(card(RESERVE), row("Sep 09, 2026") + row("Aug 09, 2026")))
    assert [d["id"] for d in read(tab)["docs"]] == [d["id"] for d in walked]


def test_without_leave_to_walk_nothing_is_pressed_and_the_list_stops(tab):
    load(tab, CENTER, WORLD)
    got = read(tab)
    assert got["state"] == "stopped" and "Only the open card was read" in got["why"]
    assert [d["date"] for d in got["docs"]] == ["2026-09-09", "2026-08-09"]
    assert tab.evaluate("moves") == []


def test_reading_without_leave_to_walk_forgets_a_walk(tab):
    load(tab, CENTER, WORLD)
    tab.evaluate("__sweep.readList({ walk: true })")
    tab.evaluate("__sweep.nextView()")
    assert tab.evaluate("Boolean(globalThis.__chaseWalk)") is True
    read(tab)
    assert tab.evaluate("globalThis.__chaseWalk") is None


@pytest.mark.parametrize("words", ["FREEDOM (...9999) details", "freedom (...9999)"])
def test_a_card_that_does_not_read_wholly_as_a_card_is_never_pressed(tab, words):
    load(tab, CENTER, WORLD)
    tab.evaluate(f"window.extra = '<button aria-expanded=\"false\">{words}</button>'; document.querySelector('input').click(); document.querySelector('input').click()")
    assert tab.evaluate("__sweep.readList({ walk: true })")["more"] is True
    assert "will not press" in tab.evaluate("__sweep.nextView()")["why"]
    assert tab.evaluate("moves") == []


def test_a_button_naming_an_action_is_left_alone(tab):
    load(tab, CENTER, WORLD)
    tab.evaluate("window.extra = '<button aria-expanded=\"false\">PAY CARD (...1234)</button>'; document.querySelector('input').click(); document.querySelector('input').click()")
    ids, _ = walk_everything(tab)
    assert len(ids) == 6
    assert "pressed:PAY CARD (...1234)" not in tab.evaluate("moves")


def test_a_year_option_of_other_words_stops_the_walk(tab):
    load(tab, CENTER, WORLD)
    tab.evaluate("""window.extra = '<div role="option">2025 and older, delete</div>'; document.querySelector('input').click(); document.querySelector('input').click()""")
    assert tab.evaluate("__sweep.readList({ walk: true })")["more"] is True
    assert "cannot read" in tab.evaluate("__sweep.nextView()")["why"]
    assert tab.evaluate("moves") == []


def test_rows_that_never_change_to_the_chosen_year_stop_the_walk(tab):
    load(tab, CENTER, WORLD)
    tab.evaluate("window.frozen = true")
    for _ in range(3):
        assert tab.evaluate("__sweep.readList({ walk: true })")["more"] is True
        got = tab.evaluate("__sweep.nextView()")
        if "why" in got:
            break
    assert "did not redraw" in got["why"] and "2025" in got["why"]


def test_a_card_that_will_not_open_stops_the_walk(tab):
    load(tab, CENTER, WORLD)
    tab.evaluate(f"window.stuck = '{SOUTHWEST}'")
    tab.evaluate("__sweep.readList({ walk: true })")
    got = tab.evaluate("__sweep.nextView()")
    assert "did not open" in got["why"] and SOUTHWEST in got["why"]


def test_one_card_and_one_year_ends_at_once(tab):
    load(tab, CENTER, center(card(RESERVE), row("Aug 09, 2026"), picker=PICKER))
    tab.evaluate("""() => { const p = document.querySelector('input'); p.addEventListener('click', () => {
      if (!document.querySelector('[role=option]')) p.insertAdjacentHTML('afterend', '<div role="option">2026, current selection</div>');
      else document.querySelector('[role=option]').remove(); }); }""")
    got = tab.evaluate("__sweep.readList({ walk: true })")
    assert [d["id"] for d in got["docs"]] == [f"2026-08-09|Statement|{RESERVE}"] and got["more"] is True
    assert tab.evaluate("__sweep.nextView()") == {"moved": False}
    assert tab.evaluate("pressed") == []


# A sign-in that also holds business accounts. Chase Business saves those, so
# the personal recipe never opens or reads one, whatever its rows say.
CHK = "BUS COMPLETE CHK (...4321)"
BIZCARD = "BUSINESS CARD (...8765)"
HOLDER = "Z. QUILLFEATHER (...2468)"
MIXED = WORLD.replace("const data = {", "const data = {\n" + "".join(
    f"  '{label}': {rows},\n" for label, rows in [
        (CHK, "{2026: ['Sep 30, 2026'], 2025: ['Dec 31, 2025']}"),
        (BIZCARD, "{2026: ['Sep 26, 2026']}"),
        (HOLDER, "{2026: []}"),
    ]))


def test_a_walk_beside_business_accounts_reads_only_the_personal_cards(tab):
    load(tab, CENTER, MIXED)
    ids, _ = walk_everything(tab)
    assert ids == [
        f"2026-09-09|Statement|{RESERVE}", f"2026-08-09|Statement|{RESERVE}",
        f"2026-09-15|Statement|{SOUTHWEST}",
        f"2025-12-09|Statement|{RESERVE}",
        f"2024-11-09|Statement|{RESERVE}",
        f"2024-10-20|Statement|{FREEDOM}",
    ]
    assert not any(name in m for m in tab.evaluate("moves") for name in (CHK, BIZCARD, HOLDER))


def test_an_open_business_account_is_left_open_and_unread(tab):
    load(tab, CENTER, center(card(CHK) + card(RESERVE), row("Aug 09, 2026") + row("Sep 30, 2026", CHK)))
    got = read(tab)
    assert got["state"] == "ok" and [d["id"] for d in got["docs"]] == [f"2026-08-09|Statement|{RESERVE}"]


@pytest.mark.parametrize("walk", [False, True])
def test_a_center_of_business_accounts_alone_says_so(tab, walk):
    load(tab, CENTER, center(card(CHK) + card(BIZCARD, False), row("Sep 30, 2026", CHK)))
    got = tab.evaluate(f"__sweep.readList({{ walk: {'true' if walk else 'false'} }})")
    assert got["state"] == "stopped" and "only business accounts" in got["why"] and "Chase Business" in got["why"]
    assert tab.evaluate("pressed") == []


# Chase Business's document center, as its survey found it: an account menu
# and one accordion per document type. It is what the old pasted address drew.
NAV = '<nav><a id="nav" href="#/dashboard/documents/myDocs/index;mode=documents">Statements &amp; documents</a></nav>'


def business_center(entries=(f"{CHK}, current selection", BIZCARD), nav=NAV):
    menu = "".join(f'<a id="bottom-77001{i}" href="#">{e}</a>' for i, e in enumerate(entries))
    return center(nav + menu, "", picker='<button id="button-accountsAccordian-STATEMENTS" aria-expanded="false">Statements</button>')


def test_the_business_center_in_a_tab_not_walked_is_no_list(tab):
    load(tab, CENTER, business_center())
    assert read(tab) == {"state": "no_list"}
    assert tab.evaluate("pressed") == []


def test_the_business_center_in_the_sweeps_tab_presses_statements_and_documents_once(tab):
    load(tab, CENTER, business_center())
    assert tab.evaluate("__sweep.readList({ walk: true })") == {"state": "walking"}
    assert tab.evaluate("pressed") == ["nav"]
    got = tab.evaluate("__sweep.readList({ walk: true })")
    assert got["state"] == "stopped" and "only business accounts" in got["why"]
    assert tab.evaluate("pressed") == ["nav"]


def test_a_menu_holding_a_personal_card_says_how_to_go_on(tab):
    load(tab, CENTER, business_center(entries=(f"{RESERVE}, current selection", CHK), nav=""))
    got = tab.evaluate("__sweep.readList({ walk: true })")
    assert got["state"] == "stopped" and "account menu" in got["why"]
    assert tab.evaluate("pressed") == []


def test_a_center_that_never_draws_presses_statements_and_documents_in_the_sweeps_tab(tab):
    load(tab, CENTER, NAV + '<h1>Accounts</h1><a id="pay" href="#">Pay card</a><a id="other" href="#">Statements</a>' + center("", ""))
    assert tab.evaluate("__sweep.readList({ walk: true })") == {"state": "walking"}
    assert tab.evaluate("pressed") == ["nav"]


@pytest.mark.parametrize("link", [
    '<a id="nav" href="https://example.com/documents">Statements &amp; documents</a>',
    '<a id="nav" href="#" aria-label="Statements &amp; documents, pay bills">Statements &amp; documents</a>',
    '<a id="nav" href="#">Statements &amp; documents settings</a>',
])
def test_a_link_that_is_not_the_dashboards_own_is_never_pressed(tab, link):
    load(tab, CENTER, link + center("", ""))
    assert tab.evaluate("__sweep.readList({ walk: true })")["state"] == "stopped"
    assert tab.evaluate("pressed") == []


def test_the_list_address_is_where_paperpulls_press_lands_and_reads_as_the_center(tab):
    url = json.loads((ROOT / "providers" / "chase.meta.json").read_text())["listUrl"]
    assert url == "https://secure.chase.com/web/auth/dashboard#/dashboard/documents/myDocs/index;mode=documents"
    load(tab, url, center(card(RESERVE), row("Aug 09, 2026")))
    assert [d["id"] for d in read(tab)["docs"]] == [f"2026-08-09|Statement|{RESERVE}"]


@pytest.mark.parametrize("words", ["2025, 2 of 8", "2025 selected", "2025, option 3 of 8", "2025 (current selection)"])
def test_a_year_option_with_screen_reader_words_still_reads_as_its_year(tab, words):
    load(tab, CENTER, WORLD)
    tab.evaluate(f"""window.extra = '<div role="option" aria-label="{words}">{words}</div>'; document.querySelector('input').click(); document.querySelector('input').click()""")
    assert tab.evaluate("__sweep.readList({ walk: true })")["more"] is True
    got = tab.evaluate("__sweep.nextView()")
    assert "cannot read" not in (got.get("why") or "")

