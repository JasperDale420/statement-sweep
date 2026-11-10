"""Add Offers Now (background.js): only the offers pass for one site, no
statements, with the sweep's own tab handling, cap, pace and stops. In a real
Chromium with the stand-in for Chrome's extension APIs from test_log.py, a
stand-in statements recipe that only says where the tab stands, and a
stand-in offers recipe. Every offer, card and number here is invented."""
import json
import re
import pytest
from playwright.sync_api import sync_playwright
import test_log as base

PROVIDER = dict(base.PROVIDER, offers={"file": "providers/fake.offers.js"})
INDEX = "export const PROVIDERS = " + json.dumps([PROVIDER]) + ";\n"

# The statements recipe: signed out for the first `__signedOutReads` reads,
# then the list. Saving a statement is never asked for here; if it is, that
# is kept in __saved.
STATEMENTS = """(() => {
  const readList = () => ((window.__listReads = (window.__listReads || 0) + 1) <= (window.__signedOutReads || 0)
    ? { state: 'signed_out' } : { state: 'ok', docs: [{ id: 'f1', date: '2026-10-28', title: 'Statement', method: 'fetch' }] });
  const fetchPdf = (doc) => { (window.__saved ||= []).push(doc.id); return { ok: true, base64: btoa('%PDF-1.4 invented\\n%%EOF') }; };
  globalThis.__sweep = { readList, fetchPdf };
})();"""

OFFERS = """(() => {
  globalThis.__offers = {
    readOffers: async (o) => { (window.__offersCalls ||= []).push(['read', o]); return window.__offersPlan.read; },
    addOne: async (offer) => { (window.__offersCalls ||= []).push(['add', offer.id]); return (window.__offersPlan.adds || {})[offer.id] || { ok: true }; },
  };
})();"""

# The engine's stand-in, with a way to hear a message's answer, an address
# for the extension's own pages, and the pace between presses (1.5 to 4
# seconds, and the sign-in wait's 2-second looks) cut to nothing, so a test
# of the cap does not take a minute.
ENGINE = base.ENGINE.replace(
    "window.__fire = { message: (m) => on.message.set.forEach((f) => f(m, {}, () => {})) };",
    "window.__fire = { message: (m) => on.message.set.forEach((f) => f(m, {}, () => {})),"
    " ask: (m, sender) => new Promise((resolve) => on.message.set.forEach((f) => f(m, sender || {}, resolve))) };"
).replace("runtime: { id: 'self',", "runtime: { id: 'self', getURL: (p) => 'chrome-extension://self/' + p,") + """
const realTimeout = window.setTimeout;
window.setTimeout = (f, ms, ...rest) => realTimeout(f, ms >= 1500 && ms <= 4000 ? 1 : ms, ...rest);
"""
assert "ask:" in ENGINE and "getURL" in ENGINE

START = """async ({ on, plan, local, board, signedOut, sender, sweepFirst }) => {
  window.__offersPlan = plan;
  window.__signedOutReads = signedOut || 0;
  if (on) __local.offersOn = ['fake'];
  Object.assign(__local, local || {});
  if (board) __session.board = board;
  const f = await import('/folders.js');
  const root = await navigator.storage.getDirectory();
  await f.setFolder('destination', await root.getDirectoryHandle('Chosen', { create: true }));
  await import('/background.js');
  let during = null;
  if (sweepFirst) {
    __fire.message({ type: 'sweep', only: 'fake' });
    during = await __fire.ask({ type: 'offersNow', site: 'fake' }, sender);
  }
  const answer = sweepFirst ? null : await __fire.ask({ type: 'offersNow', site: 'fake' }, sender);
  const files = async () => {
    const out = {};
    async function walk(d, p) { for await (const [n, h] of d.entries()) {
      if (h.kind === 'directory') await walk(h, p + n + '/');
      else { try { out[p + n] = await (await h.getFile()).text(); } catch (e) { if (!['NotFoundError', 'NotReadableError'].includes(e.name)) throw e; } } } }
    await walk(root, '');
    return out;
  };
  const until = Date.now() + 25000;
  for (;;) {
    const out = await files();
    const summary = Object.keys(out).find((p) => /^Chosen\\/Statement Sweep\\/Logs\\/run-\\d{8}-\\d{6}\\.log$/.test(p));
    const ended = summary && out[summary].includes('Run ended');
    if ((answer && !answer.ok) || ended || Date.now() > until) {
      return { answer, during, files: out, board: __session.board, events: __events, calls: window.__offersCalls || [],
               saved: window.__saved || [], listReads: window.__listReads || 0, local: __local };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}"""


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


# Card Offers, as Chrome describes a message from it.
OWN_PAGE = {"id": "self", "url": "chrome-extension://self/offers.html"}


def now(browser, on=True, plan=None, local=None, board=None, signed_out=0, sender=None, sweep_first=False):
    t = base.page_with(browser, ENGINE, {"providers/index.js": INDEX, "providers/fake.page.js": STATEMENTS, "providers/fake.offers.js": OFFERS})
    try:
        got = t.evaluate(START, {"on": on, "plan": plan or {"read": {"state": "ok", "card": "1111", "offers": []}}, "local": local or {},
                                 "board": board, "signedOut": signed_out, "sender": OWN_PAGE if sender is None else sender, "sweepFirst": sweep_first})
    finally:
        t.context_.close()
    site = next((v for k, v in got["files"].items() if re.match(r"Chosen/Statement Sweep/Fake Bank/Logs/run-\d{8}-\d{6}\.log$", k)), "")
    return got, site


def offer(i):
    return {"id": f"1111:o{i}", "card": "1111", "title": f"Earn {i}% back", "merchant": f"Invented Shop {i}", "added": False}


def adds(got):
    return [c[1] for c in got["calls"] if c[0] == "add"]


def read_of(*offers, **more):
    return {"read": {"state": "ok", "card": "1111", "offers": list(offers), **more}}


def test_only_the_offers_pass_runs_and_the_statements_line_is_kept(browser):
    earlier = {"fake": {"state": "ok", "text": "2 new.", "at": 1}}
    got, site = now(browser, plan=read_of(offer(1), offer(2)), board=earlier)
    assert got["answer"] == {"ok": True}
    assert adds(got) == ["1111:o1", "1111:o2"]
    # No statement was saved, and none was written to the folder.
    assert got["saved"] == [] and not any(k.endswith(".pdf") for k in got["files"])
    line = got["board"]["fake"]
    assert (line["state"], line["text"]) == ("ok", "2 new.")
    assert line["offers"] == {"kind": "done", "text": "Added 2 offers."}
    assert "Add Offers Now for Fake & Bank begins: offers only, no statements." in site
    assert "Invented Shop" not in site
    assert got["local"]["offerDetails:fake"]["cards"]["1111"]["offers"][0]["status"] == "added"


def test_it_uses_the_sweeps_own_tab_and_closes_it_after(browser):
    got, site = now(browser, plan=read_of(offer(1)))
    kinds = [e[0] for e in got["events"]]
    assert kinds.count("create") == 1 and kinds[-1] == "remove"
    assert "Tab opened:" in site and "since no open tab showed the list" in site


def test_it_waits_for_a_sign_in_as_a_sweep_does_then_adds(browser):
    got, site = now(browser, plan=read_of(offer(1)), signed_out=2)
    assert got["listReads"] >= 3
    assert "Waiting for you: signed_out, tab brought forward." in site
    assert adds(got) == ["1111:o1"]
    assert got["board"]["fake"]["offers"]["kind"] == "done"


def test_it_keeps_to_the_cap_chosen_in_settings(browser):
    got, _ = now(browser, plan=read_of(*[offer(i) for i in range(12)]), local={"offersCap": 10})
    assert len(adds(got)) == 10
    assert got["board"]["fake"]["offers"] == {"kind": "capped", "text": "10 offers added · 2 wait for the next sync"}


def test_a_check_while_adding_stops_and_the_line_stays_as_it_was(browser):
    earlier = {"fake": {"state": "ok", "text": "1 new.", "at": 1}}
    plan = dict(read_of(offer(1), offer(2), offer(3)), adds={"1111:o2": {"ok": False, "state": "challenge"}})
    got, _ = now(browser, plan=plan, board=earlier)
    assert adds(got) == ["1111:o1", "1111:o2"]
    line = got["board"]["fake"]
    assert (line["state"], line["text"]) == ("ok", "1 new.")
    assert line["offers"] == {"kind": "stopped", "text": "Offers stopped: Fake & Bank asked you to confirm it is you. 1 added before that."}


def test_a_sign_out_on_the_offers_page_presses_nothing(browser):
    got, _ = now(browser, plan={"read": {"state": "signed_out"}})
    assert adds(got) == []
    assert got["board"]["fake"]["offers"] == {"kind": "stopped", "text": "Offers stopped: Fake & Bank signed you out."}


def test_it_is_refused_while_a_sweep_is_running(browser):
    got, _ = now(browser, plan=read_of(offer(1)), on=False, sweep_first=True)
    assert got["during"] == {"ok": False, "why": "A sync is running. Add Offers Now works once it finishes."}
    # The sweep itself went on and saved its statement.
    assert got["board"]["fake"]["text"] == "1 new."


def test_it_is_refused_when_offers_are_off_for_the_site(browser):
    got, _ = now(browser, on=False, plan=read_of(offer(1)))
    assert got["answer"] == {"ok": False, "why": "Card offers are off for Fake & Bank. Turn on Add When Syncing first."}
    assert got["calls"] == [] and got["events"] == []


@pytest.mark.parametrize("sender", [{}, {"id": "self"}, {"id": "other", "url": "chrome-extension://other/offers.html"}])
def test_a_message_without_this_extensions_page_address_is_refused(browser, sender):
    got, _ = now(browser, plan=read_of(offer(1)), sender=sender)
    assert got["answer"] == {"ok": False, "why": "That can only be asked from Card Offers."}
    assert got["calls"] == [] and got["events"] == []


def test_it_is_heard_only_from_the_extensions_own_pages(browser):
    got, _ = now(browser, plan=read_of(offer(1)), sender={"id": "self", "url": "https://bank.test/docs", "tab": {"id": 3}})
    assert got["answer"] == {"ok": False, "why": "That can only be asked from Card Offers."}
    assert got["calls"] == [] and got["events"] == []
