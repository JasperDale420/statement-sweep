"""The Apple Card page logic, in a real Chromium, on stand-in pages that keep
the recorded button shape. Every month is invented."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOME = "https://card.apple.com/"
NAV = '<nav><a href="#">Statements</a><a href="#">Savings</a></nav>'
CARD_ONLY = '<nav><a href="#">Statements</a></nav>'


def button(month, year, id_=""):
    return (f'<ui-button role="button" tabindex="0" id="{id_}" style="display:inline-block" '
            f'aria-label="Download statement of {month} {year} (PDF)"><svg width="16" height="16"></svg></ui-button>')


def row(month, year, id_=""):
    return f"<li><div>{month}</div>{button(month, year, id_)}</li>"


def page(rows, nav=NAV, extra=""):
    return f"{nav}<main><h2>Statements</h2>{extra}<ul>{rows}</ul></main>" + """<script>
    window.pressed = [];
    document.addEventListener('click', (e) => { const b = e.target.closest('ui-button'); if (b) pressed.push(b.id); });
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
    source = (ROOT / "providers" / "applecard.page.js").read_text().replace("DRAW_WAIT_MS = 30000", "DRAW_WAIT_MS = 300") \
        .replace("STEP_WAIT_MS = 8000", "STEP_WAIT_MS = 400").replace("STEP_SETTLE_MS = 1500", "STEP_SETTLE_MS = 50") \
        .replace("ARRIVE_WAIT_MS = 10000", "ARRIVE_WAIT_MS = 400").replace("REVEAL_MS = 600", "REVEAL_MS = 40")
    tab.add_script_tag(content=source)


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_a_sign_in_address_is_known(tab):
    load(tab, "https://card.apple.com/signin", "<p>x</p>")
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_known(tab):
    load(tab, HOME, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_sign_in_frame_with_nothing_else_is_known(tab):
    load(tab, HOME, '<iframe src="https://idmsa.apple.com/appleauth" width=100 height=100></iframe>')
    assert read(tab) == {"state": "signed_out"}


def test_a_frame_on_a_signed_in_page_is_nothing(tab):
    load(tab, HOME, page(row("March", 2031), nav=CARD_ONLY, extra='<iframe src="https://idmsa.apple.com/x" width=10 height=10></iframe>'))
    assert read(tab)["state"] == "ok"


def test_a_security_check_is_known(tab):
    load(tab, HOME, "<p>Enter the code sent to your trusted device.</p>")
    assert read(tab) == {"state": "challenge"}


def test_good_rows_are_dated_at_month_end_newest_first(tab):
    load(tab, HOME, page(row("February", 2028) + row("March", 2028) + row("January", 2028), nav=CARD_ONLY))
    assert read(tab) == {"state": "ok", "docs": [
        {"id": "card:2028-03-31", "date": "2028-03-31", "title": "Statement", "method": "click"},
        {"id": "card:2028-02-29", "date": "2028-02-29", "title": "Statement", "method": "click"},
        {"id": "card:2028-01-31", "date": "2028-01-31", "title": "Statement", "method": "click"}]}


def test_in_a_tab_of_yours_the_card_is_read_and_savings_is_left_with_a_reason(tab):
    load(tab, HOME, page(row("March", 2031, "m")))
    got = tab.evaluate("__sweep.readList({ walk: false })")
    assert got["state"] == "stopped" and "Savings" in got["why"]
    assert [d["id"] for d in got["docs"]] == ["card:2031-03-31"]
    assert tab.evaluate("pressed") == []


def test_a_control_of_another_shape_is_not_a_document(tab):
    load(tab, HOME, page(row("March", 2031) + '<button aria-label="Download PDF">x</button><a href="#">Export Transactions</a>'))
    assert [d["id"] for d in read(tab)["docs"]] == ["card:2031-03-31"]


def test_a_signed_in_front_page_of_yours_asks_to_be_carried_on_in(tab):
    # Apple keeps the sign-in in this tab only, so the engine takes it over.
    load(tab, HOME, NAV + "<main><h1>Apple Card</h1></main>")
    got = read(tab)
    assert got["state"] == "ready" and "docs" not in got


def test_the_signed_out_welcome_page_is_a_sign_in(tab):
    load(tab, HOME, "<main><h1>Pay your bill online.</h1><button>Sign In</button></main>")
    assert read(tab)["state"] == "signed_out"


def test_a_side_menu_of_buttons_outside_a_nav_counts_as_signed_in(tab):
    load(tab, HOME, '<aside><button>Payments</button><button>Installments</button><button>Statements</button></aside>'
         '<iframe src="https://idmsa.apple.com/x" style="width:10px;height:10px"></iframe><main><h1>Payments</h1></main>')
    assert read(tab)["state"] == "ready"


def test_a_page_that_never_draws_stops(tab):
    load(tab, HOME, "<main></main>")
    assert read(tab)["state"] == "stopped"


def test_a_savings_address_stops(tab):
    load(tab, "https://card.apple.com/savings", page(row("March", 2031)))
    got = read(tab)
    assert got["state"] == "stopped" and "Savings" in got["why"]


def test_a_savings_heading_stops(tab):
    load(tab, HOME, page(row("March", 2031)).replace("<h2>Statements</h2>", "<h2>Savings</h2>"))
    assert read(tab)["state"] == "stopped"


def test_the_savings_lists_link_back_stops(tab):
    load(tab, HOME, page(row("March", 2031), extra='<a href="#" aria-current="page">Documents</a>'))
    assert read(tab)["state"] == "stopped"


def test_a_row_that_says_tax_stops(tab):
    load(tab, HOME, page("<li>1099-INT 2030 " + button("March", 2030) + "</li>"))
    assert read(tab)["state"] == "stopped"


def test_two_buttons_for_one_month_stop_and_neither_is_listed(tab):
    load(tab, HOME, page(row("March", 2031) + row("March", 2031) + row("April", 2031)))
    got = read(tab)
    assert got["state"] == "stopped" and [d["id"] for d in got["docs"]] == ["card:2031-04-30"]


def test_the_press_lands_on_its_own_month(tab):
    load(tab, HOME, page(row("March", 2031, "m") + row("April", 2031, "a")))
    assert tab.evaluate("__sweep.clickDoc({id: 'card:2031-03-31'})") == {"ok": True}
    assert tab.evaluate("pressed") == ["m"]


def test_a_doubled_month_is_not_pressed(tab):
    load(tab, HOME, page(row("March", 2031, "a") + row("March", 2031, "b")))
    assert tab.evaluate("__sweep.clickDoc({id: 'card:2031-03-31'})")["ok"] is False
    assert tab.evaluate("pressed") == []


def test_a_bad_id_is_refused(tab):
    load(tab, HOME, page(row("March", 2031)))
    for bad in ["savings:2031-03-31", "tax:2031", "card:2031-03", "tax:2031-12-31", "x:2031-03-31"]:
        assert tab.evaluate(f"__sweep.clickDoc({{id: '{bad}'}})")["ok"] is False
    assert tab.evaluate("pressed") == []


# A small card.apple.com that draws each section itself when its menu link is
# pressed, as PaperPull recorded: the card's Statements at the front page's
# address, and under /savings the Savings page, its Documents, and the two
# lists below that, each with a link back to Documents. Every list is drawn
# anew, so no button of one list is a button of the next.
WORLD = """<nav id="nav"></nav><main id="main"></main><script>
const cfg = %(cfg)s;
window.moves = []; window.pressed = [];
let view = 'front';
function btn(m, y, id) {
  return `<ui-button role="button" tabindex="0" id="${id}" style="display:inline-block" aria-label="Download statement of ${m} ${y} (PDF)"><svg width="16" height="16"></svg></ui-button>`;
}
function rows(list, prefix, words) {
  return '<ul>' + list.map(([m, y], i) => `<li><div>${words(m, y)}</div>${btn(m, y, prefix + i)}</li>`).join('') + '</ul>';
}
const back = '<a href="#" aria-current="page">Documents</a>';
function draw() {
  document.getElementById('nav').innerHTML = '<a href="#">Statements</a>' + (cfg.savings ? '<a href="#">Savings</a>' : '') + '<a href="#">Payments</a>';
  let main = '';
  if (view === 'front') main = '<h1>Apple Card</h1><a href="#">Make a Payment</a>';
  if (view === 'card') main = '<h2>Statements</h2><a href="#">Export Transactions</a>' + rows(cfg.card, 'c', (m, y) => `${m} ${y}`);
  if (view === 'savings') main = '<h1>Savings</h1><a href="#">Transfer</a><a href="#">Withdraw</a>' + (cfg.documents ? '<a href="#">Documents</a>' : '') + (cfg.twoDocuments ? '<a href="#">Documents</a>' : '');
  if (view === 'docs') main = '<h1>Savings</h1><a href="#">Statements ' + (cfg.savingsCount ?? cfg.saved.length) + '</a>' + (cfg.taxLink ? '<a href="#">Tax Documents ' + cfg.tax.length + '</a>' : '');
  if (view === 'sstmts') main = '<h1>Savings</h1>' + back + rows(cfg.saved, 's', (m, y) => `${m} ${y}`);
  if (view === 'tax') main = '<h1>Savings</h1>' + back + rows(cfg.tax, 't', (m, y) => `1099-INT ${y}`);
  const keep = cfg.sticky && view !== 'card' && view !== 'front' ? Array.from(document.querySelectorAll('#main ui-button')) : [];
  document.getElementById('main').innerHTML = main;
  keep.forEach((b) => document.getElementById('main').appendChild(b));
  history.pushState({}, '', view === 'front' || view === 'card' ? '/' : '/savings');
}
draw();
document.addEventListener('click', (e) => {
  const b = e.target.closest('ui-button'); if (b) { pressed.push(b.id); return; }
  const a = e.target.closest('a'); if (!a) return; e.preventDefault();
  const words = a.innerText.trim(), inNav = Boolean(a.closest('nav'));
  moves.push((inNav ? 'nav:' : 'main:') + words);
  let next = null;
  if (inNav && words === 'Statements') next = 'card';
  else if (inNav && words === 'Savings') next = 'savings';
  else if (!inNav && words === 'Documents') next = 'docs';
  else if (!inNav && /^Statements \\d+$/.test(words)) next = 'sstmts';
  else if (!inNav && /^Tax Documents \\d+$/.test(words)) next = 'tax';
  if (next) setTimeout(() => { view = next; draw(); }, 60);
});
</script>"""

CARD_MONTHS = [["September", 2031], ["August", 2031]]
SAVED_MONTHS = [["September", 2031], ["August", 2031], ["July", 2031]]
TAX_YEARS = [["January", 2030], ["January", 2029]]


def world(**changes):
    import json
    cfg = {"savings": True, "documents": True, "taxLink": True, "card": CARD_MONTHS,
           "saved": SAVED_MONTHS, "tax": TAX_YEARS}
    cfg.update(changes)
    return WORLD % {"cfg": json.dumps(cfg)}


def walk_everything(tab, press_each=False):
    docs, notes, lists = [], [], 0
    for _ in range(20):
        got = tab.evaluate("__sweep.readList({ walk: true })")
        if got["state"] == "walking":
            continue
        assert got["state"] == "ok", got
        lists += 1
        docs += got["docs"]
        if got.get("note"):
            notes.append(got["note"])
        if press_each:
            for d in got["docs"]:
                assert tab.evaluate("(d) => __sweep.clickDoc(d)", d) == {"ok": True}, d
        if not got.get("more"):
            break
        next_view = tab.evaluate("__sweep.nextView()")
        assert "why" not in next_view, next_view
        if next_view.get("note"):
            notes.append(next_view["note"])
        if not next_view["moved"]:
            break
    return docs, notes, lists


def test_a_walk_reads_the_card_then_savings_statements_then_tax_forms(tab):
    load(tab, HOME, world())
    docs, notes, lists = walk_everything(tab)
    assert lists == 3 and notes == []
    assert [(d["id"], d["date"], d["title"]) for d in docs] == [
        ("card:2031-09-30", "2031-09-30", "Statement"),
        ("card:2031-08-31", "2031-08-31", "Statement"),
        ("savings:2031-09-30", "2031-09-30", "Savings Statement"),
        ("savings:2031-08-31", "2031-08-31", "Savings Statement"),
        ("savings:2031-07-31", "2031-07-31", "Savings Statement"),
        ("tax:2030", "2030-12-31", "1099-INT"),
        ("tax:2029", "2029-12-31", "1099-INT"),
    ]
    assert all(d["method"] == "click" for d in docs)
    # Only the menu's section links were pressed, never Payments, Transfer,
    # Withdraw, Make a Payment or Export, and Tax Documents through Documents.
    assert tab.evaluate("moves") == ["nav:Statements", "nav:Savings", "main:Documents", "main:Statements 3",
                                     "main:Documents", "main:Tax Documents 2"]
    assert tab.evaluate("pressed") == []
    assert tab.evaluate("globalThis.__appleCardWalk") is None


def test_each_document_is_pressed_on_its_own_list(tab):
    load(tab, HOME, world())
    docs, _, _ = walk_everything(tab, press_each=True)
    assert tab.evaluate("pressed") == ["c0", "c1", "s0", "s1", "s2", "t0", "t1"]


def test_ids_are_unique_and_the_same_on_a_second_sweep(tab):
    load(tab, HOME, world())
    first = [d["id"] for d in walk_everything(tab)[0]]
    load(tab, HOME, world())
    second = [d["id"] for d in walk_everything(tab)[0]]
    assert first == second and len(set(first)) == len(first) == 7


def test_a_document_of_another_list_is_not_pressed(tab):
    load(tab, HOME, world())
    tab.evaluate("__sweep.readList({ walk: true })")
    for other in ["{id: 'savings:2031-09-30'}", "{id: 'tax:2030'}"]:
        got = tab.evaluate(f"__sweep.clickDoc({other})")
        assert got["ok"] is False and "not on screen" in got["why"]
    assert tab.evaluate("__sweep.nextView()")["moved"] is True
    assert tab.evaluate("__sweep.clickDoc({id: 'card:2031-09-30'})")["ok"] is False
    assert tab.evaluate("pressed") == []


def test_no_savings_in_the_menu_ends_after_the_card_with_a_note(tab):
    load(tab, HOME, world(savings=False))
    docs, notes, lists = walk_everything(tab)
    assert [d["id"] for d in docs] == ["card:2031-09-30", "card:2031-08-31"]
    assert len(notes) == 1 and "no Savings" in notes[0]
    assert tab.evaluate("moves") == ["nav:Statements"]


def test_savings_with_no_documents_link_ends_with_a_note(tab):
    load(tab, HOME, world(documents=False))
    docs, notes, _ = walk_everything(tab)
    assert len(docs) == 2 and len(notes) == 1 and "Documents" in notes[0]
    assert tab.evaluate("moves") == ["nav:Statements", "nav:Savings"]


def test_tax_documents_counted_none_are_not_opened(tab):
    load(tab, HOME, world(tax=[]))
    docs, notes, lists = walk_everything(tab)
    assert [d["id"].split(":")[0] for d in docs] == ["card"] * 2 + ["savings"] * 3
    assert lists == 2 and notes == []
    assert "main:Tax Documents 0" not in tab.evaluate("moves")


def test_no_tax_documents_link_still_reads_the_savings_statements(tab):
    load(tab, HOME, world(taxLink=False))
    docs, notes, _ = walk_everything(tab)
    assert len([d for d in docs if d["id"].startswith("savings:")]) == 3
    assert len(notes) == 1 and "Tax Documents" in notes[0]


def test_a_list_left_from_before_the_press_is_not_read_as_the_next(tab):
    load(tab, HOME, world(sticky=True))
    assert tab.evaluate("__sweep.readList({ walk: true })")["more"] is True
    got = tab.evaluate("__sweep.nextView()")
    assert "why" in got and tab.evaluate("pressed") == []


def test_more_buttons_than_the_link_counted_is_not_read(tab):
    load(tab, HOME, world(savingsCount=2))
    assert tab.evaluate("__sweep.readList({ walk: true })")["more"] is True
    assert "why" in tab.evaluate("__sweep.nextView()")


def test_two_documents_links_are_not_pressed(tab):
    load(tab, HOME, world(twoDocuments=True))
    tab.evaluate("__sweep.readList({ walk: true })")
    got = tab.evaluate("__sweep.nextView()")
    assert "why" in got and "two links" in got["why"]
    assert tab.evaluate("moves") == ["nav:Statements", "nav:Savings"]


def test_a_savings_list_in_a_tab_of_yours_is_left_alone(tab):
    load(tab, HOME, world())
    walk_to_savings = ["__sweep.readList({ walk: true })", "__sweep.nextView()"]
    for js in walk_to_savings:
        tab.evaluate(js)
    tab.evaluate("moves.length = 0")
    got = tab.evaluate("__sweep.readList({ walk: false })")
    assert got["state"] == "stopped" and "Savings" in got["why"] and "docs" not in got
    assert tab.evaluate("moves") == [] and tab.evaluate("pressed") == []


def test_a_tab_of_yours_on_the_front_page_is_not_walked(tab):
    load(tab, HOME, world())
    got = tab.evaluate("__sweep.readList({ walk: false })")
    assert got["state"] == "ready" and tab.evaluate("moves") == []


# Every month from August 2019, the first Apple Card statement, to September
# 2026, the way a list that draws more as it is reached would hold them.
LONG = """<script>
const NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
window.months = [];
for (let y = 2026, m = 8; y > 2019 || m >= 7; m--) { if (m < 0) { m = 11; y--; } months.push([NAMES[m], y]); }
window.drawn = 0;
window.more = function (n) {
  const ul = document.getElementById('list');
  for (const [m, y] of months.slice(drawn, drawn + n)) ul.insertAdjacentHTML('beforeend',
    `<li style="height:30px"><div>${m} ${y}</div><ui-button role="button" tabindex="0" style="display:inline-block" aria-label="Download statement of ${m} ${y} (PDF)"><svg width="16" height="16"></svg></ui-button></li>`);
  drawn = Math.min(months.length, drawn + n);
};
</script>"""


def long_list(how):
    if how == "scroll":
        body = ('<div id="box" style="height:200px;overflow:auto"><ul id="list"></ul></div>' + LONG
                + "<script>more(12); box.addEventListener('scroll', () => { if (box.scrollTop + box.clientHeight >= box.scrollHeight - 5) setTimeout(() => more(12), 10); });</script>")
    else:
        body = ('<ul id="list"></ul><button id="more">Show More</button>' + LONG
                + "<script>more(12); window.presses = 0; document.getElementById('more').addEventListener('click', (e) => { presses++; more(12); if (drawn >= months.length) e.target.remove(); });</script>")
    return f"{CARD_ONLY}<main><h2>Statements</h2>{body}</main>"


@pytest.mark.parametrize("walk", [False, True])
def test_a_list_that_draws_more_as_it_is_scrolled_is_read_to_its_first_month(tab, walk):
    load(tab, HOME, long_list("scroll"))
    got = tab.evaluate(f"__sweep.readList({{ walk: {'true' if walk else 'false'} }})")
    assert got["state"] == "ok", got
    dates = [d["date"] for d in got["docs"]]
    assert len(dates) == 86 and len(set(dates)) == 86
    assert dates[0] == "2026-09-30" and dates[-1] == "2019-08-31"
    assert sum(d.startswith("2019-") for d in dates) == 5 and sum(d.startswith("2026-") for d in dates) == 9


def test_the_lists_show_more_is_pressed_in_the_sweeps_tab_until_every_month_is_drawn(tab):
    load(tab, HOME, long_list("more"))
    got = tab.evaluate("__sweep.readList({ walk: true })")
    assert got["state"] == "ok" and len(got["docs"]) == 86 and got["docs"][-1]["id"] == "card:2019-08-31"
    assert tab.evaluate("presses") == 7


def test_in_a_tab_of_yours_show_more_is_never_pressed(tab):
    load(tab, HOME, long_list("more"))
    got = tab.evaluate("__sweep.readList({ walk: false })")
    assert len(got["docs"]) == 12 and tab.evaluate("presses") == 0


def test_a_link_reading_show_more_is_never_pressed(tab):
    load(tab, HOME, page(row("March", 2031)).replace("<ul>", '<a id="away" href="#">See All</a><ul>'))
    tab.evaluate("document.getElementById('away').addEventListener('click', () => { window.wentAway = true; })")
    assert tab.evaluate("__sweep.readList({ walk: true })")["state"] == "ok"
    assert tab.evaluate("window.wentAway") is None


def test_a_home_page_notice_is_not_taken_for_a_check(tab):
    load(tab, HOME, world().replace("<h1>Apple Card</h1>", "<h1>Apple Card</h1><p>We noticed unusual activity. Check your phone for details.</p>"))
    got = tab.evaluate("__sweep.readList({ walk: true })")
    assert got["state"] == "ok" and [d["id"] for d in got["docs"]] == ["card:2031-09-30", "card:2031-08-31"]


def test_a_button_named_by_the_words_it_is_labelled_by_is_read(tab):
    labelled = ('<li><span id="l1">Download statement of March 2031 (PDF)</span>'
                '<ui-button role="button" tabindex="0" id="m" style="display:inline-block" aria-labelledby="l1"><svg width="16" height="16"></svg></ui-button></li>')
    load(tab, HOME, page(labelled, nav=CARD_ONLY))
    assert [d["id"] for d in read(tab)["docs"]] == ["card:2031-03-31"]
    assert tab.evaluate("__sweep.clickDoc({id: 'card:2031-03-31'})") == {"ok": True}
    assert tab.evaluate("pressed") == ["m"]
