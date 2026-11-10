"""How far a sync has got (progress.js), and the engine that keeps it
(background.js): each site's bar and its estimate, the whole sync's bar, and
Stop. In a real Chromium; the engine runs with the stand-in for Chrome's
extension APIs from test_log.py. Every count here is invented."""
import json
import pytest
import test_log as base
import test_offers_now as now
from test_log import browser  # noqa: F401  (the module's one Chromium)


@pytest.fixture(scope="module")
def tab(browser):  # noqa: F811
    t = base.page_with(browser)
    yield t
    t.context_.close()


def call(tab, name, *args):
    return tab.evaluate(f"async (a) => (await import('/progress.js')).{name}(...a)", list(args))


def standing(status, documents=12):
    return {"status": status, "documents": documents}


# -- the estimate ----------------------------------------------------------------

def test_a_first_sync_has_no_estimate(tab):
    assert call(tab, "estimateNew", [], standing("never", 0)) is None
    assert call(tab, "estimateNew", [3], standing("never", 0)) is None
    assert call(tab, "estimateNew", [], standing("due")) is None


def test_a_due_site_expects_its_usual_batch(tab):
    # The middle of the syncs that found some; checks that found none do not pull it down.
    assert call(tab, "estimateNew", [2, 0, 2, 0, 3], standing("due")) == 2
    assert call(tab, "estimateNew", [1, 1, 24], standing("overdue")) == 1
    assert call(tab, "estimateNew", [4, 5], standing("unknown")) == 5


def test_an_up_to_date_site_expects_one_at_most(tab):
    assert call(tab, "estimateNew", [4, 4, 4], standing("current")) == 1
    assert call(tab, "estimateNew", [4, 4, 4], standing("checked")) == 1


def test_a_site_that_never_found_anything_still_expects_one_when_due(tab):
    assert call(tab, "estimateNew", [0, 0], standing("due")) == 1


def test_only_the_last_syncs_are_kept(tab):
    assert call(tab, "addFound", [1, 2, 3, 4, 5, 6], 7) == [2, 3, 4, 5, 6, 7]
    assert call(tab, "foundOf", {"found:a": [1, -1, 2.5, "x", 0]}, "a") == [1, 0]
    assert call(tab, "foundOf", {}, "a") == []


# -- a site's bar ------------------------------------------------------------------

def test_before_its_list_is_read_the_bar_uses_the_estimate(tab):
    assert call(tab, "siteProgress", {"estimate": 4}) == {"done": 0, "total": 4, "exact": False}
    assert call(tab, "siteProgress", {}) == {"done": 0, "total": None, "exact": False}


def test_a_list_bigger_than_the_estimate_raises_the_total(tab):
    assert call(tab, "siteProgress", {"done": 1, "listed": 5, "more": True, "estimate": 4}) == {"done": 1, "total": 5, "exact": False}


def test_once_every_list_is_read_the_total_is_exact(tab):
    assert call(tab, "siteProgress", {"done": 2, "listed": 5, "more": False, "estimate": 9}) == {"done": 2, "total": 5, "exact": True}
    assert call(tab, "siteProgress", {"done": 0, "listed": 0, "more": False, "estimate": 3}) == {"done": 0, "total": 0, "exact": True}


def test_an_estimate_never_shows_a_full_bar(tab):
    assert call(tab, "percent", {"done": 4, "total": 4, "exact": False}) == 90
    assert call(tab, "percent", {"done": 4, "total": 4, "exact": True}) == 100
    assert call(tab, "percent", {"done": 1, "total": 4, "exact": True}) == 25
    assert call(tab, "percent", {"done": 0, "total": None, "exact": False}) is None
    assert call(tab, "percent", {"done": 0, "total": 0, "exact": True}) == 100


def test_the_count_says_about_until_it_is_exact(tab):
    assert call(tab, "countWords", {"done": 0, "total": 4, "exact": False}) == "0 of about 4"
    assert call(tab, "countWords", {"done": 3, "total": 5, "exact": True}) == "3 of 5"
    assert call(tab, "countWords", {"done": 0, "total": None, "exact": False}) == ""


def test_the_whole_sync_adds_up_its_sites(tab):
    rows = [{"progress": {"done": 2, "total": 2, "exact": True}},
            {"progress": {"done": 1, "total": 4, "exact": False}},
            {"progress": {"done": 0, "total": None, "exact": False}},
            {"state": "working"}]
    assert call(tab, "runProgress", rows) == {"done": 3, "total": 6, "exact": False}
    assert call(tab, "runProgress", rows[:1]) == {"done": 2, "total": 2, "exact": True}
    assert call(tab, "runProgress", []) == {"done": 0, "total": None, "exact": True}


# -- the engine ---------------------------------------------------------------------

# The test_log site, with a way to ask as one of the extension's pages.
ENGINE = now.ENGINE
OWN_PAGE = {"id": "self", "url": "chrome-extension://self/popup.html"}

# A site that stays signed out until the run is stopped or gives up.
SIGNED_OUT = """(() => {
  globalThis.__sweep = { readList: () => ({ state: 'signed_out' }), fetchPdf: () => ({ ok: false }) };
})();"""

RUN = """async ({ found, stopFrom, waitFor }) => {
  if (found) await chrome.storage.local.set({ 'found:fake': found });
  const f = await import('/folders.js');
  const root = await navigator.storage.getDirectory();
  await f.setFolder('destination', await root.getDirectoryHandle('Chosen', { create: true }));
  // Every line the engine writes for the site, in order.
  const boards = [];
  const write = chrome.storage.session.set;
  chrome.storage.session.set = async (o) => {
    if (o.board && o.board.fake) boards.push(JSON.parse(JSON.stringify(o.board.fake)));
    return write(o);
  };
  await import('/background.js');
  const until = Date.now() + 25000;
  __fire.message({ type: 'sweep', only: 'fake' });
  let stopped = false;
  for (;;) {
    const line = (__session.board || {}).fake;
    if (stopFrom && !stopped && line && line.state === waitFor) {
      stopped = true;
      // Stop sends no answer, so its promise is not waited on.
      for (const s of stopFrom) __fire.ask({ type: 'stop' }, s);
    }
    const ended = line && (line.state === 'ok' || line.state === 'bad');
    if (ended || Date.now() > until) {
      const { 'found:fake': kept } = await chrome.storage.local.get('found:fake');
      return { boards, board: __session.board, found: kept || null };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}"""


@pytest.fixture
def engine(request, browser):  # noqa: F811
    recipe = getattr(request, "param", base.RECIPE)
    t = base.page_with(browser, ENGINE, {"providers/index.js": base.INDEX, "providers/fake.page.js": recipe})
    yield t
    t.context_.close()


def test_each_line_carries_the_sites_progress_and_its_run(engine):
    got = engine.evaluate(RUN, {"found": [2, 2, 3]})
    line = got["board"]["fake"]
    assert line["state"] == "ok"
    assert line["progress"] == {"done": 1, "total": 1, "exact": True}
    assert isinstance(line["run"], (int, float)) and line["run"] > 0
    # Before its list was read, a site with no saved history has no estimate.
    first = next(b for b in got["boards"] if b["text"] == "Looking…")
    assert first["progress"] == {"done": 0, "total": None, "exact": False}
    # What this sync found is kept for the next one's estimate.
    assert got["found"] == [2, 2, 3, 1]


@pytest.mark.parametrize("engine", [SIGNED_OUT], indirect=True)
def test_stop_ends_a_wait_for_a_sign_in(engine):
    got = engine.evaluate(RUN, {"stopFrom": [OWN_PAGE], "waitFor": "needs_you"})
    line = got["board"]["fake"]
    assert (line["state"], line["text"]) == ("bad", "0 saved. You stopped the sync. The rest wait for next time.")
    # A stopped site found nothing it could count, so the next estimate is not changed.
    assert got["found"] is None


@pytest.mark.parametrize("engine", [SIGNED_OUT], indirect=True)
@pytest.mark.parametrize("sender", [{}, {"id": "self"}, {"id": "other", "url": "chrome-extension://other/popup.html"}])
def test_stop_is_heard_only_from_the_extensions_own_pages(engine, sender):
    # Asked from elsewhere, nothing stops: the site still waits for you.
    got = engine.evaluate(RUN.replace("const until = Date.now() + 25000;", "const until = Date.now() + 3000;"),
                          {"stopFrom": [sender], "waitFor": "needs_you"})
    assert got["board"]["fake"]["state"] == "needs_you", json.dumps(got["board"])
