"""offers.js, the engine that adds a site's card offers after its statements,
in a real Chromium with the extension's own module, a stand-in for Chrome's
extension APIs, and a stand-in recipe. Every offer is invented."""
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://x.test/"
PROVIDER = {"id": "site", "name": "Example Card", "match": ["https://x.test/*"],
            "offers": {"file": "providers/site.offers.js", "url": "https://x.test/offers"}}

# The stand-in recipe answers from window.__script: a list of reads, one per
# card, and what each add answers, by offer id. Chrome's storage, tabs and
# scripting are stood in for, and every call is logged.
CHROME = """
window.__log = []; window.__local = {}; window.__tabUrl = 'https://x.test/statements';
window.__script = { reads: [], adds: {}, next: [] };
window.__offers = {
  readOffers: async (o) => { __log.push(['read', o]); const r = __script.reads.shift(); return r === undefined ? { state: 'no_list' } : r; },
  addOne: async (offer) => { __log.push(['add', offer.id]); const a = __script.adds[offer.id]; return a === undefined ? { ok: true } : a; },
  nextCard: async () => { __log.push(['next']); return __script.next.shift() || { moved: false }; },
};
Object.defineProperty(window, 'chrome', { value: {
  storage: { local: {
    get: async (keys) => { const out = {}; for (const k of [].concat(keys)) if (k in __local) out[k] = JSON.parse(JSON.stringify(__local[k])); return out; },
    set: async (o) => { Object.assign(__local, JSON.parse(JSON.stringify(o))); },
  } },
  tabs: {
    get: async (id) => ({ id, url: __tabUrl, status: 'complete' }),
    update: async (id, o) => { __log.push(['load', o.url]); if (o.url) __tabUrl = o.url; return { id }; },
  },
  scripting: { executeScript: async ({ target, func, args, files }) => {
    if (files) { __log.push(['inject', files]); return [{ result: undefined }]; }
    return [{ result: await func(...(args || [])) }];
  } },
} });
"""

RUN = """async ([provider, ours]) => {
  const m = await import('/offers.js');
  const host = (u) => { try { return new URL(u).hostname === 'x.test'; } catch (e) { return false; } };
  const engine = m.makeOffers({
    loaded: async (id) => chrome.tabs.get(id),
    tabChange: async () => {},
    onHost: (u) => host(u),
    pause: async () => { __log.push(['pause']); },
    log: (p, text) => { __log.push(['log', p.id, text]); },
  });
  const said = [];
  const sum = await engine.run(7, provider, { ours, progress: async (t) => { said.push(t); } });
  return { sum, words: m.offersWords(sum), said, log: __log, local: __local };
}"""


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture
def tab(browser):
    t = browser.new_page()
    t.add_init_script(CHROME)

    def serve(route):
        path = ROOT / route.request.url[len(BASE):].split("?")[0]
        if path.is_file():
            route.fulfill(status=200, content_type="text/javascript", body=path.read_text())
        else:
            route.fulfill(status=200, content_type="text/html", body="<!doctype html><title>x</title>")
    t.route(BASE + "**", serve)
    t.goto(BASE)
    yield t
    t.close()


def offer(i, added=False, card="1111"):
    return {"id": f"{card}:o{i}", "card": card, "title": f"Earn {i}% back", "merchant": f"Shop {i}", "added": added}


def ok(*offers, **more):
    return {"state": "ok", "card": "1111", "offers": list(offers), **more}


def run(tab, reads, adds=None, nexts=None, local=None, ours=True, provider=PROVIDER):
    tab.evaluate("([r, a, n, l]) => { __log.length = 0; __script.reads = r; __script.adds = a; __script.next = n; Object.assign(__local, l); }",
                 [reads, adds or {}, nexts or [], local or {}])
    return tab.evaluate(RUN, [provider, ours])


def adds_in(got):
    return [e[1] for e in got["log"] if e[0] == "add"]


def test_offers_not_yet_added_are_added_and_kept(tab):
    got = run(tab, [ok(offer(1), offer(2), offer(3, added=True))])
    assert adds_in(got) == ["1111:o1", "1111:o2"]
    assert got["words"] == {"kind": "done", "text": "Added 2 offers · 1 already on your card.", "stopped": False}
    # What the sweep added is kept apart from what the site already showed as added.
    assert got["local"]["offers:site"] == {"added": ["1111:o1", "1111:o2"], "seen": ["1111:o3"], "left": []}
    assert got["said"] == ["Adding offers · 1 of 2 on Card ·· 1111", "Adding offers · 2 of 2 on Card ·· 1111"]


def test_the_recipe_files_are_loaded_after_the_shared_ones(tab):
    got = run(tab, [ok()])
    assert ["inject", ["providers/shared.js", "providers/offers-kit.js", "providers/site.offers.js"]] in got["log"]
    assert ["read", {"walk": True, "cards": ""}] in got["log"]


def test_offers_in_the_record_are_not_pressed_again(tab):
    got = run(tab, [ok(offer(1), offer(2), offer(3))], local={"offers:site": {"added": ["1111:o1"], "seen": ["1111:o3"], "left": ["1111:o2"]}})
    assert adds_in(got) == []
    assert got["words"]["text"] == "2 already on your cards."


def test_a_second_sync_never_presses_an_offer_the_first_added(tab):
    first = run(tab, [ok(offer(1), offer(2))])
    assert adds_in(first) == ["1111:o1", "1111:o2"]
    # The site may still draw them as not added; the record is what counts.
    again = run(tab, [ok(offer(1), offer(2), offer(3))])
    assert adds_in(again) == ["1111:o3"]


def test_the_count_for_settings_is_only_what_the_sweep_added(tab):
    got = tab.evaluate("""async () => { const m = await import('/offers.js');
      return [m.addedSoFar({added: ['a', 'b'], seen: ['c', 'd', 'e'], left: ['f']}), m.addedSoFar(undefined), m.addedSoFar({})]; }""")
    assert got == [2, 0, 0]


def test_the_sites_own_count_of_added_offers_is_used(tab):
    got = run(tab, [ok(offer(1), onCards=23)])
    assert got["words"]["text"] == "Added 1 offer · 23 already on your cards."


def test_nothing_to_add_says_so(tab):
    assert run(tab, [ok()])["words"] == {"kind": "done", "text": "No new offers.", "stopped": False}


def test_presses_stop_at_a_careful_cap_and_the_rest_wait(tab):
    got = run(tab, [ok(*[offer(i) for i in range(40)])])
    assert len(adds_in(got)) == 25
    assert got["words"] == {"kind": "capped", "text": "25 offers added · 15 wait for the next sync", "stopped": False}
    # The next sync goes on with the rest, and with the cap again.
    again = run(tab, [ok(*[offer(i) for i in range(40)])])
    assert adds_in(again) == [f"1111:o{i}" for i in range(25, 40)]


def test_the_cap_counts_every_card_of_a_sync(tab):
    reads = [ok(*[offer(i) for i in range(20)], more=True),
             {"state": "ok", "card": "2222", "offers": [offer(i, card="2222") for i in range(20)], "more": True}]
    got = run(tab, reads, nexts=[{"moved": True}, {"moved": False}])
    assert len(adds_in(got)) == 25 and adds_in(got)[-1] == "2222:o4"


def test_a_pause_between_every_two_presses_and_none_before_the_first(tab):
    got = run(tab, [ok(offer(1), offer(2), offer(3))])
    steps = [e[0] for e in got["log"] if e[0] in ("add", "pause")]
    assert steps == ["add", "pause", "add", "pause", "add"]


def test_the_pause_is_a_few_seconds_and_never_the_same(tab):
    got = tab.evaluate("""async () => { const m = await import('/offers.js');
      const many = Array.from({length: 500}, () => m.paceMs());
      return { range: m.PACE_MS, low: m.paceMs(() => 0), high: m.paceMs(() => 0.999999), min: Math.min(...many), max: Math.max(...many), kinds: new Set(many).size, cap: m.MAX_PRESSES }; }""")
    assert got["range"] == [1500, 4000] and got["cap"] == 25
    assert got["low"] == 1500 and got["high"] == 4000
    assert 1500 <= got["min"] and got["max"] <= 4000 and got["kinds"] > 100


def test_a_tab_of_yours_is_never_used(tab):
    got = run(tab, [ok(offer(1))], ours=False)
    assert got["log"] == []
    assert got["words"]["stopped"] is True and "tab Statement Sweep opened" in got["words"]["text"]


def test_a_sign_out_while_adding_stops_the_offers(tab):
    got = run(tab, [ok(offer(1), offer(2), offer(3))], adds={"1111:o2": {"ok": False, "state": "signed_out"}})
    assert adds_in(got) == ["1111:o1", "1111:o2"]
    assert got["words"] == {"kind": "stopped", "text": "Offers stopped: Example Card signed you out. 1 added before that.", "stopped": True}


def test_a_check_on_the_offers_page_stops_before_any_press(tab):
    got = run(tab, [{"state": "challenge"}])
    assert adds_in(got) == []
    assert got["words"] == {"kind": "stopped", "text": "Offers stopped: Example Card asked you to confirm it is you.", "stopped": True}


def test_a_sign_out_on_the_offers_page_stops_before_any_press(tab):
    got = run(tab, [{"state": "signed_out"}, ok(offer(1))])
    assert adds_in(got) == [] and [e for e in got["log"] if e[0] == "load"] == []
    assert got["words"] == {"kind": "stopped", "text": "Offers stopped: Example Card signed you out.", "stopped": True}


def test_a_check_while_adding_stops_at_once(tab):
    got = run(tab, [ok(offer(1), offer(2), offer(3))], adds={"1111:o1": {"ok": False, "state": "challenge"}})
    assert adds_in(got) == ["1111:o1"]
    assert got["words"]["text"] == "Offers stopped: Example Card asked you to confirm it is you."
    assert "offers:site" not in got["local"]


def test_a_check_after_a_card_switch_stops_before_the_next_card(tab):
    got = run(tab, [ok(offer(1), more=True), {"state": "challenge"}], nexts=[{"moved": True}])
    assert adds_in(got) == ["1111:o1"]
    assert got["words"]["text"] == "Offers stopped: Example Card asked you to confirm it is you. 1 added before that."


def test_three_failures_in_a_row_stop(tab):
    bad = {"ok": False, "why": "It did not add."}
    got = run(tab, [ok(*[offer(i) for i in range(6)])], adds={f"1111:o{i}": bad for i in range(6)})
    assert len(adds_in(got)) == 3
    assert got["words"]["stopped"] is True and "3 offers in a row would not add. It did not add." in got["words"]["text"]
    assert "offers:site" not in got["local"]


def test_one_failure_is_tried_again_next_time(tab):
    got = run(tab, [ok(offer(1), offer(2))], adds={"1111:o1": {"ok": False, "why": "No."}})
    assert got["words"]["text"] == "Added 1 offer. 1 offer did not add and is tried again next time."
    assert got["local"]["offers:site"]["added"] == ["1111:o2"]
    again = run(tab, [ok(offer(1), offer(2))])
    assert adds_in(again) == ["1111:o1"]


def test_an_offer_the_site_wants_more_for_is_left_and_kept_as_left(tab):
    got = run(tab, [ok(offer(1))], adds={"1111:o1": {"ok": False, "left": True, "why": "More."}})
    assert got["words"]["text"] == "No new offers. 1 offer was left for you, since the site asked for more."
    assert got["local"]["offers:site"]["left"] == ["1111:o1"]


def test_a_stop_from_the_recipe_stops_at_once(tab):
    got = run(tab, [ok(offer(1), offer(2))], adds={"1111:o1": {"ok": False, "stop": True, "why": "Chase did not go back to its offers."}})
    assert adds_in(got) == ["1111:o1"]
    assert got["words"]["text"] == "Offers stopped: Chase did not go back to its offers."


def test_each_card_in_turn(tab):
    got = run(tab, [ok(offer(1), more=True), {"state": "ok", "card": "2222", "offers": [offer(1, card="2222")], "more": True}],
              nexts=[{"moved": True}, {"moved": False}])
    assert adds_in(got) == ["1111:o1", "2222:o1"]
    assert [e[0] for e in got["log"] if e[0] == "next"] == ["next", "next"]
    assert got["words"]["text"] == "Added 2 offers."


def test_a_card_switch_that_fails_says_why(tab):
    got = run(tab, [ok(offer(1), more=True)], nexts=[{"why": "Amex did not change to the card chosen."}])
    assert got["words"] == {"kind": "stopped", "text": "Offers stopped: Amex did not change to the card chosen. 1 added before that.", "stopped": True}


def test_cards_of_the_other_kind_only(tab):
    got = run(tab, [{"state": "ok", "card": "9876", "offers": [], "passed": True}])
    assert got["words"]["text"] == "No card of this kind is in this sign-in, so no offers were added."


def test_the_kind_of_card_is_asked_for_by_the_meta(tab):
    business = dict(PROVIDER, offers=dict(PROVIDER["offers"], cards="business"))
    got = run(tab, [ok()], provider=business)
    assert ["read", {"walk": True, "cards": "business"}] in got["log"]


def test_what_it_did_is_logged_by_id_only(tab):
    got = run(tab, [ok(offer(1), offer(2, added=True))])
    lines = [e[2] for e in got["log"] if e[0] == "log"]
    assert lines == ["Card 1111: 2 offer(s) read, 1 shown as added, 1 to add.", "Offer 1111:o1: added."]
    assert not any("Shop" in l for l in lines)


def test_the_offers_page_is_loaded_once_on_the_sites_own_host(tab):
    got = run(tab, [{"state": "no_list"}, {"state": "no_list"}, ok(offer(1))])
    assert [e for e in got["log"] if e[0] == "load"] == [["load", "https://x.test/offers"]]
    assert adds_in(got) == ["1111:o1"]


def test_an_offers_address_off_the_site_is_never_loaded(tab):
    provider = dict(PROVIDER, offers={"file": "providers/site.offers.js", "url": "https://example.com/offers"})
    got = run(tab, [{"state": "no_list"}] * 6, provider=provider)
    assert [e for e in got["log"] if e[0] == "load"] == []
    assert got["words"] == {"kind": "stopped", "text": "Offers stopped: Example Card's offers page could not be found.", "stopped": True}


def test_a_tab_that_left_the_site_presses_nothing(tab):
    tab.evaluate("__tabUrl = 'https://example.com/elsewhere'")
    got = run(tab, [ok(offer(1))])
    assert adds_in(got) == []
    assert got["words"]["text"] == "Offers stopped: The tab left Example Card's site."


def test_offers_are_wanted_only_when_turned_on_for_the_site(tab):
    wanted = """async ([p, on]) => { const m = await import('/offers.js'); __local.offersOn = on; return m.offersWanted(p); }"""
    assert tab.evaluate(wanted, [PROVIDER, []]) is False
    assert tab.evaluate(wanted, [PROVIDER, ["site"]]) is True
    assert tab.evaluate(wanted, [{"id": "site", "name": "No offers"}, ["site"]]) is False


# -- the details record, for the Card Offers page ------------------------------

def dated(i, expires, added=False, card="1111"):
    return dict(offer(i, added, card), expires=expires)


def test_what_each_card_showed_is_kept_with_its_words_and_status(tab):
    got = run(tab, [ok(dated(1, "2099-03-01"), offer(2), offer(3, added=True), cardName="Invented Gold Card")],
              adds={"1111:o2": {"ok": False, "left": True, "why": "The site asked you to enroll first."}})
    today = tab.evaluate("(async () => (await import('/cadence.js')).localIso())()")
    record = got["local"]["offerDetails:site"]
    card = record["cards"]["1111"]
    assert record["at"] > 0 and card["at"] > 0
    assert card["label"] == "Invented Gold Card ·· 1111"
    assert card["offers"] == [
        {"id": "1111:o1", "merchant": "Shop 1", "title": "Earn 1% back", "expires": "2099-03-01", "status": "added", "on": today},
        {"id": "1111:o2", "merchant": "Shop 2", "title": "Earn 2% back", "expires": None, "status": "needs_you", "why": "The site asked you to enroll first."},
        {"id": "1111:o3", "merchant": "Shop 3", "title": "Earn 3% back", "expires": None, "status": "on_card"},
    ]
    # The record of ids is kept as before, beside it.
    assert got["local"]["offers:site"] == {"added": ["1111:o1"], "seen": ["1111:o3"], "left": ["1111:o2"]}


def test_a_card_label_never_holds_more_than_its_last_four_digits(tab):
    got = tab.evaluate("""async () => { const m = await import('/offers.js');
      return [m.cardLabel('123456'), m.cardLabel('a1234', 'INVENTED REWARDS (...1234)'), m.cardLabel('card'), m.cardLabel('11111', 'Card 99887766')]; }""")
    assert got == ["Card ·· 3456", "Invented Rewards ·· 1234", "Card", "Card ·· 1111"]


def test_an_offer_past_its_end_drops_off(tab):
    old = {"at": 1, "cards": {"2222": {"label": "Card ·· 2222", "at": 1, "offers": [
        {"id": "2222:old", "merchant": "Gone Shop", "title": "Ended", "expires": "2020-01-01", "status": "waiting"},
        {"id": "2222:live", "merchant": "Still Shop", "title": "Going", "expires": "2099-01-01", "status": "waiting"}]}}}
    got = run(tab, [ok(dated(1, "2020-05-05"), dated(2, "2099-05-05"))], local={"offerDetails:site": old})
    cards = got["local"]["offerDetails:site"]["cards"]
    assert [o["id"] for o in cards["1111"]["offers"]] == ["1111:o2"]
    # A card not read this time keeps what it showed, less what has ended.
    assert [o["id"] for o in cards["2222"]["offers"]] == ["2222:live"]


def test_a_record_from_before_details_were_kept_still_counts(tab):
    kept = {"offers:site": {"added": ["1111:o1"], "seen": ["1111:o2"], "left": ["1111:o3"]}}
    got = run(tab, [ok(offer(1), offer(2), offer(3), offer(4))], local=kept)
    assert adds_in(got) == ["1111:o4"]
    statuses = {o["id"]: (o["status"], o.get("on"), o.get("why")) for o in got["local"]["offerDetails:site"]["cards"]["1111"]["offers"]}
    assert statuses["1111:o1"] == ("added", None, None)
    assert statuses["1111:o2"] == ("on_card", None, None)
    assert statuses["1111:o3"] == ("needs_you", None, "The site asked for more before adding it.")
    assert statuses["1111:o4"][0] == "added"
    assert got["local"]["offers:site"]["added"] == ["1111:o1", "1111:o4"]


def test_a_broken_details_record_is_read_as_empty_not_trusted(tab):
    got = tab.evaluate("""async () => { const m = await import('/offers.js');
      return [m.liveDetails(undefined), m.liveDetails('x'), m.liveDetails({ at: 5, cards: { a: { offers: [null, { id: 'x', status: 'bought' }, { id: 'y', status: 'waiting' }] }, b: { offers: 'no' } } })]; }""")
    assert got[0] == {"at": 0, "cards": {}} and got[1] == {"at": 0, "cards": {}}
    assert got[2] == {"at": 5, "cards": {"a": {"label": "Card", "at": 0, "offers": [{"id": "y", "status": "waiting"}]}}}


def test_the_record_never_reaches_the_log(tab):
    got = run(tab, [ok(dated(1, "2099-03-01"), cardName="Invented Gold Card")])
    lines = " ".join(e[2] for e in got["log"] if e[0] == "log")
    assert "Shop" not in lines and "Earn" not in lines and "Gold" not in lines and "2099" not in lines


# -- which offers, and how many --------------------------------------------------

def test_the_soonest_to_end_are_pressed_first_and_those_with_no_end_last(tab):
    got = run(tab, [ok(dated(1, "2099-12-01"), offer(2), dated(3, "2099-01-15"), dated(4, "2099-06-30"), offer(5))])
    assert adds_in(got) == ["1111:o3", "1111:o4", "1111:o1", "1111:o2", "1111:o5"]


def test_under_the_cap_the_soonest_to_end_are_the_ones_added(tab):
    offers = [dated(i, f"2099-{12 - (i % 12):02d}-01") for i in range(30)]
    got = run(tab, [ok(*offers)], local={"offersCap": 10})
    pressed = adds_in(got)
    ends = sorted(o["expires"] for o in offers)
    assert len(pressed) == 10
    assert sorted(o["expires"] for o in offers if o["id"] in pressed) == ends[:10]


def test_the_cap_is_the_one_chosen_in_settings(tab):
    got = run(tab, [ok(*[offer(i) for i in range(15)])], local={"offersCap": 10})
    assert len(adds_in(got)) == 10
    assert got["words"] == {"kind": "capped", "text": "10 offers added · 5 wait for the next sync", "stopped": False}
    assert got["said"][0] == "Adding offers · 1 of 10 on Card ·· 1111"


def test_a_cap_that_is_not_a_choice_is_never_more_than_25(tab):
    got = run(tab, [ok(*[offer(i) for i in range(40)])], local={"offersCap": 400})
    assert len(adds_in(got)) == 25
    choices = tab.evaluate("async () => { const m = await import('/offers.js'); return [m.CAP_CHOICES, m.MAX_PRESSES]; }")
    assert choices == [[10, 25], 25]


def test_capped_with_another_card_to_come_says_there_may_be_more(tab):
    got = run(tab, [ok(*[offer(i) for i in range(12)], more=True)], local={"offersCap": 10})
    assert got["words"]["text"] == "10 offers added · 2 or more wait for the next sync"
