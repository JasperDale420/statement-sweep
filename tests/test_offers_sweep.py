"""Card offers inside a whole sweep (background.js with offers.js), in a real
Chromium with the stand-in for Chrome's extension APIs from test_log.py, a
stand-in statements recipe and a stand-in offers recipe. It checks that offers
run only when turned on, after the statements, and that whatever the offers
do is only a note on the site's line, never a change to how the site stands.
Every offer, card and number here is invented."""
import json
import re
import pytest
from playwright.sync_api import sync_playwright
import test_log as base

PROVIDER = dict(base.PROVIDER, offers={"file": "providers/fake.offers.js", "cards": "personal"})
INDEX = "export const PROVIDERS = " + json.dumps([PROVIDER]) + ";\n"


def statements(fail_second=False):
    docs = "[{ id: 'f1', date: '2026-10-28', title: 'Statement', method: 'fetch' }" + \
        (", { id: 'f2', date: '2026-09-28', title: 'Statement', method: 'fetch' }]" if fail_second else "]")
    return """(() => {
  const readList = () => ({ state: 'ok', docs: %s });
  const fetchPdf = (doc) => doc.id === 'f2' ? { ok: false, why: 'Invented failure.' } : { ok: true, base64: btoa('%%PDF-1.4 invented\\n%%%%EOF'), size: 20 };
  globalThis.__sweep = { readList, fetchPdf };
})();""" % docs


# The offers recipe answers from window.__offersPlan, set before the sweep:
# `read` is what readOffers answers, `adds` what addOne answers by offer id,
# `throws` makes addOne fail outright, and `closes` has the first read close the
# sweep's tab, as you might mid-run. Every call is kept in __offersCalls.
OFFERS = """(() => {
  const plan = () => window.__offersPlan;
  globalThis.__offers = {
    readOffers: async (o) => {
      (window.__offersCalls ||= []).push(['read', o]);
      if (plan().closes) { __tabs.clear(); return { state: 'walking' }; }
      return plan().read;
    },
    addOne: async (offer) => {
      (window.__offersCalls ||= []).push(['add', offer.id]);
      if (plan().throws) throw new Error('invented');
      return (plan().adds || {})[offer.id] || { ok: true };
    },
  };
})();"""

START = """async ({ on, plan, local }) => {
  window.__offersPlan = plan;
  if (on) __local.offersOn = ['fake'];
  Object.assign(__local, local || {});
""" + base.START.split("async ({ close, swap }) => {\n  __close = close; __swap = swap;\n", 1)[1].replace(
    "return { files: out, board: __session.board, events: __events };",
    "return { files: out, board: __session.board, events: __events, calls: window.__offersCalls || [], local: __local };")


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


def sweep(browser, on=True, plan=None, local=None, fail_second=False):
    t = base.page_with(browser, base.ENGINE, {"providers/index.js": INDEX, "providers/fake.page.js": statements(fail_second),
                                              "providers/fake.offers.js": OFFERS})
    try:
        got = t.evaluate(START, {"on": on, "plan": plan or {"read": {"state": "ok", "card": "1111", "offers": []}}, "local": local or {}})
    finally:
        t.context_.close()
    site = next((v for k, v in got["files"].items() if re.match(r"Chosen/Statement Sweep/Fake Bank/Logs/run-\d{8}-\d{6}\.log$", k)), "")
    return got, site


def offer(i, added=False):
    return {"id": f"1111:o{i}", "card": "1111", "title": f"Earn {i}% back", "merchant": f"Invented Shop {i}", "added": added}


def adds(got):
    return [c[1] for c in got["calls"] if c[0] == "add"]


def test_offers_are_off_until_turned_on(browser):
    got, _ = sweep(browser, on=False, plan={"read": {"state": "ok", "card": "1111", "offers": [offer(1)]}})
    assert got["calls"] == []
    assert (got["board"]["fake"]["state"], got["board"]["fake"]["text"]) == ("ok", "1 new.")
    assert "offers:fake" not in got["local"]


def test_turned_on_they_are_added_after_the_statements_and_kept(browser):
    got, site = sweep(browser, plan={"read": {"state": "ok", "card": "1111", "offers": [offer(1), offer(2), offer(3, added=True)]}})
    assert got["calls"][0] == ["read", {"walk": True, "cards": "personal"}]
    assert adds(got) == ["1111:o1", "1111:o2"]
    assert (got["board"]["fake"]["state"], got["board"]["fake"]["text"]) == ("ok", "1 new. Added 2 offers · 1 already on your card.")
    assert got["local"]["offers:fake"] == {"added": ["1111:o1", "1111:o2"], "seen": ["1111:o3"], "left": []}
    assert "fake: Offers: 2 added, 0 left, 0 not added." in site
    assert "Invented Shop" not in site
    # The statement was saved before any offer was looked at.
    assert site.index("Document f1 by fetch: saved") < site.index("offers: Card 1111")


def test_an_offer_in_the_record_is_never_pressed_again(browser):
    got, _ = sweep(browser, plan={"read": {"state": "ok", "card": "1111", "offers": [offer(1), offer(2)]}},
                   local={"offers:fake": {"added": ["1111:o1"], "seen": [], "left": []}})
    assert adds(got) == ["1111:o2"]


def test_a_sign_out_on_the_offers_page_is_a_note_and_the_site_is_still_done(browser):
    got, _ = sweep(browser, plan={"read": {"state": "signed_out"}})
    assert adds(got) == []
    assert (got["board"]["fake"]["state"], got["board"]["fake"]["text"]) == ("ok", "1 new. Offers stopped: Fake & Bank signed you out.")


def test_a_check_while_adding_stops_the_offers_and_the_site_is_still_done(browser):
    plan = {"read": {"state": "ok", "card": "1111", "offers": [offer(1), offer(2)]}, "adds": {"1111:o1": {"ok": False, "state": "challenge"}}}
    got, _ = sweep(browser, plan=plan)
    assert adds(got) == ["1111:o1"]
    assert got["board"]["fake"]["state"] == "ok"
    assert got["board"]["fake"]["text"] == "1 new. Offers stopped: Fake & Bank asked you to confirm something."


def test_an_add_that_breaks_is_a_note_and_the_site_is_still_done(browser):
    got, _ = sweep(browser, plan={"read": {"state": "ok", "card": "1111", "offers": [offer(1)]}, "throws": True})
    assert adds(got) == ["1111:o1"]
    assert got["board"]["fake"]["state"] == "ok"
    assert got["board"]["fake"]["text"] == "1 new. No new offers. 1 offer did not add and is tried again next time."


def test_offers_that_break_outright_are_a_note_and_the_site_is_still_done(browser):
    got, site = sweep(browser, plan={"closes": True})
    assert adds(got) == []
    assert (got["board"]["fake"]["state"], got["board"]["fake"]["text"]) == ("ok", "1 new. Offers stopped: Fake & Bank's tab closed.")
    assert "ERROR  fake: " in site and "fake: Offers: 0 added" in site


def test_with_a_statement_that_did_not_save_offers_wait_and_the_line_is_the_statements(browser):
    got, _ = sweep(browser, fail_second=True, plan={"read": {"state": "ok", "card": "1111", "offers": [offer(1)]}})
    assert got["calls"] == []
    assert got["board"]["fake"]["state"] == "ok"
    assert got["board"]["fake"]["text"] == "1 new. 1 other did not save and is tried again next time. Invented failure. Card offers wait until every statement here has saved."
