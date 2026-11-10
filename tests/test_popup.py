"""What the popup shows, in a real Chromium with the extension's own files and
Chrome's own storage stood in for."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://x.test/"
TYPES = {".js": "text/javascript", ".html": "text/html", ".css": "text/css"}
CHROME = """
const saved = JSON.parse(sessionStorage.getItem('state') || '{}');
window.__session = saved.board ? {board: saved.board} : {};
window.__local = Object.assign(saved.off ? {off: saved.off} : {}, saved.local || {});
window.__sent = []; window.__listeners = [];
const area = (name) => ({
  get: async (keys) => { const out = {}; for (const k of [].concat(keys)) if (k in window[name]) out[k] = window[name][k]; return out; },
  set: async (o) => { Object.assign(window[name], o); },
});
Object.defineProperty(window, 'chrome', {value: {
  storage: {session: area('__session'), local: area('__local')},
  runtime: {sendMessage: (m) => { __sent.push(m); return Promise.resolve(); }, openOptionsPage: () => { __sent.push('options'); },
            onMessage: {addListener: (f) => __listeners.push(f)}, getURL: (p) => 'chrome-extension://sweep' + p},
  tabs: {update: async (id, o) => { __sent.push(['tab', id, o]); return {id, windowId: 70}; }},
  windows: {update: async (id, o) => { __sent.push(['window', id, o]); return {id}; }},
}});
"""


@pytest.fixture(scope="module")
def tab():
    def serve(route):
        path = ROOT / route.request.url[len(BASE):].split("?")[0]
        if path.is_file():
            route.fulfill(status=200, content_type=TYPES.get(path.suffix, "text/plain"), body=path.read_text())
        else:
            route.fulfill(status=200, content_type="text/html", body="<!doctype html><title>x</title>")
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        t.add_init_script(CHROME)
        t.route(BASE + "**", serve)
        yield t
        b.close()


def st(state, text, tab=None):
    return {"state": state, "text": text, "at": 1, **({"tab": tab} if tab is not None else {})}


def show(tab, board=None, off=None, local=None, today="2026-11-09T12:00:00"):
    tab.clock.set_fixed_time(today)
    tab.goto(BASE)
    tab.evaluate("s => sessionStorage.setItem('state', JSON.stringify(s))", {"board": board or {}, "off": off or [], "local": local or {}})
    tab.goto(BASE + "popup.html")
    tab.wait_for_selector("#scroll li")


def headings(tab):
    return tab.locator("h2").all_inner_texts()


def names_under(tab, state):
    # textContent, so a folded row is named too.
    return tab.locator(f"section[data-state='{state}'] .name").evaluate_all("ns => ns.map((n) => n.textContent)")


def unfold(tab):
    """Opens the row of sites up to date, if it is folded."""
    if not tab.evaluate("document.querySelector('details.fold').open"):
        tab.click("details.fold > summary")


def names_in_site_order(tab):
    return tab.evaluate("async () => (await import('/providers/index.js')).PROVIDERS.map((p) => p.name)")


def test_before_any_run_it_says_how_many_sites_need_updating(tab):
    # With no history every site needs updating, so every one not switched off is ticked.
    show(tab, off=["amex", "chase"])
    assert tab.inner_text("#summary") == f"{len(SITES) - 2} sites need updating"
    for name in ("American Express", "Chase"):
        box = tab.locator(f"li:has(button[aria-label='Run {name}']) input[type=checkbox]")
        assert box.is_disabled() and not box.is_checked()
    # Every site that will run needs a look, and the button says how many it runs.
    # The two switched off fold away; they never run.
    assert headings(tab) == ["Needs a Look"] and names_under(tab, "rest") == ["American Express", "Chase"]
    assert tab.inner_text("details.fold > summary") == "2 sites switched off"
    assert tab.inner_text("#go") == f"Get New Documents · {len(SITES) - 2} sites" and not tab.is_disabled("#go")


def test_what_needs_you_comes_first_and_is_named_at_the_top(tab):
    show(tab, {"alpaca": st("ok", "Nothing new."), "coinbase": st("working", "Looking…"), "chase": st("needs_you", "Sign in to Chase in its tab. This goes on by itself."), "irs": st("bad", "Stopped waiting for you to sign in.")})
    # While the sync goes, only a site that needs you leaves the run's list.
    assert headings(tab) == ["Needs You", "This Sync", "Not in This Sync"]
    assert names_under(tab, "needs_you") == ["Chase"]
    assert sorted(names_under(tab, "run")) == ["Alpaca", "Coinbase", "IRS"]
    assert tab.inner_text("#summary") == "Chase needs you"
    assert tab.get_attribute("#summary", "data-kind") == "attention"
    # Once it ends, a site that stopped needs a look, and says why.
    show(tab, {"alpaca": st("ok", "Nothing new."), "chase": st("needs_you", "Sign in to Chase in its tab. This goes on by itself.") | {"state": "bad"}, "irs": st("bad", "Stopped waiting for you to sign in.")})
    assert headings(tab) == ["Needs a Look"]
    assert {"Chase", "IRS"} <= set(names_under(tab, "look"))
    assert tab.inner_text("li:has(button[aria-label='Run IRS']) .say") == "Stopped waiting for you to sign in."


def test_several_sites_needing_you_are_counted(tab):
    show(tab, {"amex": st("needs_you", "a"), "chase": st("needs_you", "b")})
    assert tab.inner_text("#summary") == "2 sites need you"


def test_while_working_nothing_can_be_started_and_the_button_stops_it(tab):
    show(tab, {"coinbase": st("working", "Saving 1 of 2…")})
    assert tab.inner_text("#summary") == "Working on Coinbase…"
    assert tab.locator(".one:not(:disabled)").count() == 0
    assert tab.inner_text("#go") == "Stop" and not tab.is_disabled("#go")
    assert tab.get_attribute("#go", "class") == "secondary"
    tab.click("#go")
    assert tab.evaluate("__sent.filter(m => m && m.type)") == [{"type": "stop"}]
    assert tab.inner_text("#go") == "Stopping…" and tab.is_disabled("#go")


def prog(done, total, exact):
    return {"progress": {"done": done, "total": total, "exact": exact}}


def bar_of(tab, name):
    return tab.locator(f"li:has(button[aria-label='Run {name}']) .progress")


def test_each_site_in_the_sync_has_a_bar_and_the_sync_has_one(tab):
    show(tab, {"amex": st("ok", "2 new.") | prog(2, 2, True) | {"run": 5},
               "chase": st("working", "Saving 2 of 5…") | prog(1, 5, True) | {"run": 5},
               "coinbase": st("working", "Looking…") | prog(0, 3, False) | {"run": 5},
               "irs": st("working", "Looking…") | prog(0, None, False) | {"run": 5},
               "sdge": st("ok", "9 new.") | prog(9, 9, True) | {"run": 1}})
    # The whole sync adds up this run's sites only, and says "about" while any is a guess.
    assert tab.inner_text("#summary") == "Working on 3 sites… · 3 of about 10"
    assert tab.is_visible("#allbar") and tab.get_attribute("#allbar", "aria-valuenow") == "30"
    chase = bar_of(tab, "Chase")
    assert chase.inner_text() == "1 of 5"
    assert chase.locator(".bar").get_attribute("aria-valuenow") == "20"
    assert chase.locator(".bar").get_attribute("aria-valuetext") == "1 of 5"
    assert bar_of(tab, "Coinbase").inner_text() == "0 of about 3"
    # No number yet: the bar moves in stripes and says no value.
    irs = bar_of(tab, "IRS").locator(".bar")
    assert irs.get_attribute("data-unknown") == "" and irs.get_attribute("aria-valuenow") is None
    # A site that finished has its check, not a bar; a line from an older run has neither.
    assert bar_of(tab, "American Express").count() == 0 and bar_of(tab, "SDG&E").count() == 0


def test_a_site_waiting_for_you_has_an_orange_bar_and_a_stopped_one_keeps_where_it_got(tab):
    show(tab, {"chase": st("needs_you", "Sign in to Chase in its tab.") | prog(0, 1, False),
               "amex": st("bad", "3 saved. You stopped the sync. The rest wait for next time.") | prog(3, 5, True)})
    assert bar_of(tab, "Chase").locator(".bar").get_attribute("data-kind") == "needs_you"
    amex = bar_of(tab, "American Express")
    assert amex.inner_text() == "3 of 5" and amex.locator(".bar").get_attribute("data-kind") == "bad"


def test_with_nothing_going_there_is_no_sync_bar(tab):
    show(tab, {"amex": st("ok", "2 new.") | prog(2, 2, True)})
    assert not tab.is_visible("#allbar")
    assert tab.inner_text("#go") == f"Get New Documents · {len(SITES)} sites" and tab.get_attribute("#go", "class") == "primary"


def test_finished_results_are_added_up(tab):
    show(tab, {"amex": st("ok", "12 new."), "chase": st("ok", "1 new. A note."), "sdge": st("ok", "Nothing new.")})
    assert tab.inner_text("#summary") == "13 new documents"
    assert not tab.is_disabled("#go")


def test_nothing_new_says_so(tab):
    show(tab, {"amex": st("ok", "Nothing new.")})
    assert tab.inner_text("#summary") == "Nothing new"


def test_a_stop_is_counted_with_what_it_saved(tab):
    show(tab, {"amex": st("bad", "3 saved, then it stopped."), "chase": st("ok", "2 new.")})
    assert tab.inner_text("#summary") == "5 new, 1 stopped"


def test_offers_added_are_said_on_the_sites_line_and_never_stop_it(tab):
    # Invented counts. A stopped offers pass is a note on a line that is done.
    show(tab, {"amex": st("ok", "2 new. Added 3 offers · 4 already on your cards."),
               "chase": st("ok", "Nothing new. Offers stopped: Chase signed you out.")})
    assert tab.inner_text("#summary") == "2 new documents"
    assert tab.get_attribute("#summary", "data-kind") == ""
    # A site that is done says what it saved and where it now stands, on one line.
    line = tab.inner_text("li:has(button[aria-label='Run American Express']) .when")
    assert line == "2 new. Added 3 offers · 4 already on your cards · Nothing saved yet"
    assert tab.locator("li:has(button[aria-label='Run American Express']) .say").count() == 0
    assert tab.locator("li .state[data-state=bad]").count() == 0


def test_every_message_is_shown_whole(tab):
    long = "0 saved. The page was not what this expected. " * 4
    show(tab, {"amex": st("bad", long)})
    assert tab.inner_text("section[data-state=look] .say").strip() == long.strip()


def test_unticking_every_site_leaves_nothing_to_start(tab):
    show(tab)
    for box in tab.locator("input[type=checkbox]").all():
        box.uncheck()
    tab.wait_for_function("document.getElementById('summary').textContent.endsWith('need updating, none ticked')")
    assert tab.is_disabled("#go")
    # Unticking chooses for this time only: nothing is switched off.
    assert tab.evaluate("window.__local.off || []") == []


def test_run_asks_for_one_site_and_get_new_for_all(tab):
    show(tab)
    tab.click("button[aria-label='Run Chase']")
    tab.wait_for_function("__sent.length === 1")
    tab.click("#go")
    tab.wait_for_function("__sent.length === 2")
    sent = tab.evaluate("__sent")
    assert sent[0] == {"type": "sweep", "only": "chase"}
    assert sent[1]["type"] == "sweep" and sent[1].get("only") is None


def test_settings_opens_the_settings_page(tab):
    show(tab)
    tab.click("#settings")
    assert tab.evaluate("__sent") == ["options"]


def test_a_redraw_keeps_the_keyboards_place(tab):
    show(tab, {"amex": st("ok", "1 new.")})
    tab.focus("button[aria-label='Run Chase']")
    tab.evaluate("__session.board.alpaca = {state: 'ok', text: '2 new.', at: 1}; __listeners.forEach(f => f({type: 'board'}))")
    tab.wait_for_function("document.querySelector(\"li:has(button[aria-label='Run Alpaca']) .when\").textContent.startsWith('2 new')")
    assert tab.evaluate("document.activeElement.getAttribute('aria-label')") == "Run Chase"


def test_status_is_announced_and_lists_are_named_by_their_heading(tab):
    show(tab, {"chase": st("needs_you", "a")})
    assert tab.get_attribute("#summary", "role") == "status"
    assert tab.locator("section[data-state=needs_you] ul").get_attribute("aria-labelledby") == "heading-needs_you"


def test_sites_working_at_once_are_counted(tab):
    show(tab, {"amex": st("working", "Looking…"), "chase": st("working", "Saving 1 of 3…")})
    assert tab.inner_text("#summary") == "Working on 2 sites…"


def test_a_site_with_an_open_tab_can_show_it_even_while_working(tab):
    show(tab, {"chase": st("needs_you", "Sign in to Chase in its tab.", tab=41), "amex": st("working", "Looking…", tab=42),
               "irs": st("bad", "0 saved.", tab=43), "alpaca": st("ok", "1 new."), "sdge": st("working", "Waiting for x.")})
    assert tab.locator("button.show").evaluate_all("b => b.map(x => x.getAttribute('aria-label'))") == ["Show Chase", "Show American Express", "Show IRS"]
    assert tab.locator("button.show:disabled").count() == 0
    assert tab.inner_text("button[aria-label='Show Chase']") == "Show"
    tab.click("button[aria-label='Show Chase']")
    tab.wait_for_function("__sent.length === 2")
    assert tab.evaluate("__sent") == [["tab", 41, {"active": True}], ["window", 70, {"focused": True}]]


def test_show_sits_in_the_row_beside_its_name(tab):
    show(tab, {"chase": st("needs_you", "Sign in to Chase in its tab. This goes on by itself.", tab=41)})
    name, button, state, run = (tab.locator(f"section[data-state=needs_you] {s}").bounding_box() for s in (".name", ".show", ".state", ".one"))
    assert name["x"] + name["width"] <= button["x"] < state["x"] < run["x"]
    assert abs((button["y"] + button["height"] / 2) - (name["y"] + name["height"] / 2)) < 2
    assert tab.locator("section[data-state=needs_you] .say").bounding_box()["y"] > button["y"] + button["height"] - 1


def test_each_site_has_its_own_icon_from_chromes_favicon_cache(tab):
    import json, urllib.parse
    show(tab)
    icons = tab.locator("li .name img.favicon").evaluate_all("i => i.map(x => [x.getAttribute('src'), x.alt, x.getAttribute('aria-hidden')])")
    listed = json.loads(tab.evaluate("import('/providers/index.js').then(m => JSON.stringify(m.PROVIDERS.map(p => p.listUrl)))"))
    assert len(icons) == len(listed) == tab.locator("li").count()
    for (src, alt, hidden), url in zip(icons, listed):
        parts = urllib.parse.urlsplit(src)
        assert (parts.scheme, parts.netloc, parts.path) == ("chrome-extension", "sweep", "/_favicon/")
        assert urllib.parse.parse_qs(parts.query) == {"pageUrl": [url], "size": ["32"]}
        assert alt == "" and hidden == "true"
    assert tab.locator(".name").first.inner_text() == "Alpaca"


# What is due, from the dates each site has saved (cadence.js).
from datetime import date, timedelta
import json as _json
TODAY = date(2026, 11, 9)
# Every site that is switched on, as tools/build.py lists them.
SITES = [m["id"] for m in (_json.loads(p.read_text()) for p in sorted((Path(__file__).resolve().parents[1] / "providers").glob("*.meta.json"))) if m.get("enabled", True)]


def monthly(site, newest, n=12, gap=30, prefix="card"):
    """A site's record of n documents `gap` days apart, the newest `newest`."""
    ids = [f"{prefix}:{(newest - timedelta(days=gap * i)).isoformat()}" for i in range(n)]
    return {f"seen:{site}": ids}


def history(**sites):
    out = {}
    for record in sites.values():
        out.update(record)
    return out


LATE = history(
    chase=monthly("chase", date(2026, 10, 31)),                      # up to date, next around Dec 1 (posts a day late)
    amex=monthly("amex", date(2026, 8, 31)),                         # overdue
    paypal=monthly("paypal", date(2026, 9, 10)),                     # new one likely (posts 15 days late)
    sdge=monthly("sdge", date(2026, 10, 28), n=12) | {"seen:sdge": [f"card:2026-{m:02d}-28" for m in range(1, 11) if m != 3]},  # a gap
    irs={"seen:irs": ["only-one"]},                                  # too little history
)


def whens(tab):
    return tab.locator("#scroll li").evaluate_all(
        "ls => ls.map(l => [l.querySelector('.name').textContent, (l.querySelector('.when') || {}).textContent || '', (l.querySelector('.when') || {dataset: {}}).dataset.need || ''])")


def test_each_site_says_where_it_stands_under_its_name(tab):
    show(tab, local=LATE)
    got = {name: (text, need) for name, text, need in whens(tab)}
    assert got["Chase"] == ("Up to date · next around Dec 1", "current")
    assert got["American Express"] == ("Overdue by 39 days · newest Aug 31", "overdue")
    assert got["PayPal"] == ("New one likely · expected around Oct 25", "due")
    assert got["SDG&E"] == ("Up to date · next around Nov 28 · Possible gap: Mar 2026 Dismiss", "gap")
    assert got["IRS"] == ("No schedule yet · 1 saved", "unknown")
    assert got["Alpaca"] == ("Nothing saved yet", "never")
    # Under the name, inside the row.
    name, when = (tab.locator(f"li:has(button[aria-label='Run PayPal']) {s}").bounding_box() for s in (".name", ".when"))
    assert when["y"] >= name["y"] + name["height"] - 1 and abs(when["x"] - (name["x"] + 23)) < 2


def test_rows_are_ordered_by_what_needs_you(tab):
    show(tab, local=LATE)
    names = [n for n, _, _ in whens(tab)]
    assert names[:3] == ["American Express", "PayPal", "SDG&E"]
    assert names[-1] == "Chase" and names.index("Alpaca") < names.index("IRS") < names.index("Chase")
    # The one site up to date is folded away, and the fold says when it is next due.
    assert headings(tab) == ["Needs a Look"] and names_under(tab, "rest") == ["Chase"]
    assert not tab.evaluate("document.querySelector('details.fold').open")
    assert tab.inner_text("details.fold > summary") == "1 site up to date\nNext due Dec 1"
    unfold(tab)
    assert tab.is_visible("li:has(button[aria-label='Run Chase'])")


def test_after_a_run_what_stopped_needs_a_look_and_what_is_done_folds_away(tab):
    show(tab, {"chase": st("ok", "1 new."), "irs": st("bad", "Skipped.")}, local=LATE)
    assert headings(tab) == ["Needs a Look"]
    look = names_under(tab, "look")
    assert look[:3] == ["American Express", "PayPal", "SDG&E"] and "IRS" in look
    assert names_under(tab, "rest") == ["Chase"]
    assert tab.text_content("li:has(button[aria-label='Run Chase']) .when") == "1 new · Up to date · next around Dec 1"


def test_while_a_sync_goes_its_sites_keep_one_order(tab):
    # Done or still going, the run's sites stay where they are; the rest keep their order by need.
    show(tab, {"irs": st("working", "Looking…"), "chase": st("ok", "1 new.")}, local=LATE)
    assert headings(tab) == ["This Sync", "Not in This Sync"]
    run = names_under(tab, "run")
    assert sorted(run) == ["Chase", "IRS"] and run == [n for n in names_in_site_order(tab) if n in run]
    assert names_under(tab, "")[:3] == ["American Express", "PayPal", "SDG&E"]


def test_get_new_runs_only_what_needs_running(tab):
    show(tab, local=LATE, off=["paypal"])
    assert tab.inner_text("#summary") == f"{len(SITES) - 2} sites need updating, 1 up to date"
    tab.click("#go")
    tab.wait_for_function("__sent.length === 1")
    sent = tab.evaluate("__sent")[0]
    assert sent["type"] == "sweep" and sent.get("only") is None
    assert "chase" not in sent["sites"] and "paypal" not in sent["sites"]
    assert {"amex", "sdge", "irs", "alpaca"} <= set(sent["sites"]) and len(sent["sites"]) == len(SITES) - 2


def test_a_site_whose_last_run_stopped_is_run_again_even_if_up_to_date(tab):
    everything = history(**{p: monthly(p, date(2026, 11, 1)) for p in SITES})
    show(tab, {"chase": st("bad", "0 saved. Stopped waiting for you to sign in.")}, local=everything)
    tab.click("#go")
    tab.wait_for_function("__sent.length === 1")
    assert tab.evaluate("__sent")[0]["sites"] == ["chase"]


def test_when_nothing_is_due_get_new_has_nothing_to_run_and_says_why(tab):
    everything = history(**{p: monthly(p, date(2026, 11, 1)) for p in SITES})
    show(tab, local=everything)
    assert tab.inner_text("#summary") == "Everything is up to date"
    assert tab.is_disabled("#go") and tab.inner_text("#go") == "Get New Documents"
    # Each site's own Run still runs it.
    tab.click("button[aria-label='Run Chase']")
    tab.wait_for_function("__sent.length === 1")
    assert tab.evaluate("__sent") == [{"type": "sweep", "only": "chase"}]


def test_after_a_run_a_site_left_out_says_it_is_not_due(tab):
    show(tab, {"amex": st("ok", "1 new.")}, local=LATE)
    got = {name: text for name, text, _ in whens(tab)}
    assert got["Chase"] == "Not due yet · next around Dec 1"


def test_tax_forms_in_season_are_said_and_run(tab):
    forms = {"seen:coinbase": [f"{m}" for m in ("2026-12", "2026-11", "2026-10", "2026-09")] + ["tax-1099:2024"],
             "dates:coinbase": {"tax-1099:2024": "2025-02-14"}, "tax:coinbase": ["tax-1099:2024"]}
    show(tab, local=forms, today="2027-01-20T12:00:00")
    got = {name: (text, need) for name, text, need in whens(tab)}
    assert got["Coinbase"] == ("Up to date · next around Feb 1 · Tax forms expected now (2026)", "tax")
    tab.click("#go")
    tab.wait_for_function("__sent.length === 1")
    assert "coinbase" in tab.evaluate("__sent")[0]["sites"]
    show(tab, local=forms, today="2027-03-20T12:00:00")
    assert "2026 tax forms not found yet" in {n: t for n, t, _ in whens(tab)}["Coinbase"]


def test_only_the_sites_that_need_updating_start_ticked(tab):
    show(tab, local=LATE)
    ticked = {n for n, c in zip(tab.locator(".name").all_inner_texts(), [b.is_checked() for b in tab.locator("input[type=checkbox]").all()]) if c}
    assert "Chase" not in ticked and {"American Express", "PayPal", "SDG&E"} <= ticked


def test_ticking_an_up_to_date_site_adds_it_to_this_run(tab):
    show(tab, local=LATE)
    unfold(tab)
    tab.locator("li:has(button[aria-label='Run Chase']) input[type=checkbox]").check()
    tab.locator("li:has(button[aria-label='Run American Express']) input[type=checkbox]").uncheck()
    assert tab.inner_text("#summary") == f"{len(SITES) - 1} sites ticked, {len(SITES) - 1} sites need updating"
    tab.click("#go")
    tab.wait_for_function("__sent.length === 1")
    sites = tab.evaluate("__sent")[0]["sites"]
    assert "chase" in sites and "amex" not in sites
    assert tab.evaluate("window.__local.off || []") == []


def test_ticks_start_afresh_each_time_it_opens(tab):
    show(tab, local=LATE)
    tab.locator("li:has(button[aria-label='Run American Express']) input[type=checkbox]").uncheck()
    show(tab, local=LATE)
    assert tab.locator("li:has(button[aria-label='Run American Express']) input[type=checkbox]").is_checked()


def test_dismissing_a_possible_gap_stops_flagging_it(tab):
    show(tab, local=LATE)
    row = "li:has(button[aria-label='Run SDG&E'])"
    assert tab.locator(f"{row} input[type=checkbox]").is_checked()
    tab.click(f"{row} button.dismiss")
    tab.wait_for_function("!document.querySelector(\"li:has(button[aria-label='Run SDG&E']) .when\").textContent.includes('gap')")
    # Up to date now, it folds away with the others.
    assert tab.text_content(f"{row} .when") == "Up to date · next around Nov 28"
    assert "SDG&E" in names_under(tab, "rest")
    # It was ticked only for the gap, so it is unticked, and stays so next time.
    assert not tab.locator(f"{row} input[type=checkbox]").is_checked()
    assert tab.evaluate("window.__local['gapsOk:sdge']") == ["2026-02-28|2026-04-28"]
    assert tab.locator(f"{row} button.dismiss").count() == 0


def test_a_site_with_no_gap_has_nothing_to_dismiss(tab):
    show(tab, local=LATE)
    assert tab.locator("li:has(button[aria-label='Run Chase']) button.dismiss").count() == 0

