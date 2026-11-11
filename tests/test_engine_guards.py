"""The engine's (background.js) guards against a site that misbehaves, with
test_log.py's stand-in for Chrome's extension APIs and a stand-in recipe:
only a PDF counts as saved, a page or a save that never answers is given up
on and the run still ends, Stop cuts a list read short, a list is kept
within bounds, a document's id is logged without its query, a run is asked
for only from the extension's own pages, and Add Site leaves a built-in
site's host alone. Every number, address and account here is invented."""
import json
import re
import pytest
from playwright.sync_api import sync_playwright
from test_log import ENGINE, PROVIDER, page_with
from test_added_engine import ADD, FROM_TAB, MORE, PICKED

INDEX = "export const PROVIDERS = " + json.dumps([PROVIDER]) + ";\n"
PDF = "%PDF-1.4 invented\n%%EOF"

# Does what window.__plan says: lists its docs, hands over its bodies, or
# never answers.
RECIPE = """(() => {
  const plan = window.__plan;
  const never = () => new Promise(() => {});
  const readList = () => (plan.hangList ? never() : { state: 'ok', docs: plan.docs, more: Boolean(plan.more) });
  const fetchPdf = (doc) => (plan.hangFetch ? never() : { ok: true, base64: btoa((plan.bodies || {})[doc.id] || '%PDF-1.4 invented\\n%%EOF') });
  const nextView = () => (plan.hangNext ? never() : { moved: false });
  const clickDoc = (doc) => { setTimeout(() => window.__download(doc), 10); return { ok: true }; };
  globalThis.__sweep = { readList, fetchPdf, nextView, clickDoc };
})();"""

# The engine's waits of two and five minutes cut short when __shrink is set,
# a download the page starts (written to the inbox as Chrome would), and
# which downloads were taken out again.
EXTRA = """
window.__on = on;
const realTimeout = window.setTimeout;
window.__realTimeout = realTimeout;
// Two minutes become 300 ms, and five or more 3 s, so a page call still ends before its save.
window.setTimeout = (f, ms, ...rest) => realTimeout(f, !window.__shrink || ms < 120000 ? ms : ms < 300000 ? 300 : 3000, ...rest);
chrome.downloads.removeFile = async (id) => { __events.push(['removeFile', id]); };
chrome.downloads.erase = async ({ id }) => { __events.push(['erase', id]); };
window.__download = () => {
  const id = 77;
  const item = { id, url: 'https://bank.test/files/s.pdf', finalUrl: 'https://bank.test/files/s.pdf', referrer: 'https://bank.test/docs', mime: 'application/pdf', filename: 's.pdf' };
  for (const f of on.name.set) f(item, async (s) => {
    if (!s) return;
    const inbox = await (await import('/folders.js')).getFolder('inbox');
    const file = await inbox.getFileHandle(s.filename.split('/').pop(), { create: true });
    const w = await file.createWritable(); await w.write(window.__plan.clickBody); await w.close();
    on.dl.set.forEach((g) => g({ id, state: { current: 'complete' } }));
  });
};
"""

START = """async ({ plan, local, shrink, stopWhen, sender }) => {
  window.__plan = plan; window.__shrink = shrink;
  Object.assign(__local, local || {});
  const f = await import('/folders.js');
  const root = await navigator.storage.getDirectory();
  await f.setFolder('destination', await root.getDirectoryHandle('Chosen', { create: true }));
  await f.setFolder('inbox', await root.getDirectoryHandle('Inbox', { create: true }));
  await import('/background.js');
  __on.message.set.forEach((g) => g({ type: 'sweep', only: 'fake' }, sender || __popup, () => {}));
  const began = Date.now();
  let stopped = false;
  for (;;) {
    const line = (__session.board || {}).fake;
    if (stopWhen && !stopped && line && line.state === stopWhen && Date.now() - began > 300) {
      stopped = true;
      __on.message.set.forEach((g) => g({ type: 'stop' }, __popup, () => {}));
    }
    const out = {};
    async function walk(d, p) { for await (const [n, h] of d.entries()) {
      if (h.kind === 'directory') await walk(h, p + n + '/');
      else { try { out[p + n] = await (await h.getFile()).text(); } catch (e) { if (!['NotFoundError', 'NotReadableError'].includes(e.name)) throw e; } } } }
    await walk(root, '');
    const summary = Object.keys(out).find((p) => /^Chosen\\/Statement Sweep\\/Logs\\/run-\\d{8}-\\d{6}\\.log$/.test(p));
    if ((summary && out[summary].includes('Run ended')) || Date.now() - began > (sender ? 1500 : 25000)) {
      return { files: out, board: __session.board, local: __local, events: __events, ms: Date.now() - began };
    }
    await new Promise((r) => __realTimeout(r, 100));
  }
}"""


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture
def engine(browser):
    t = page_with(browser, ENGINE + EXTRA, {"providers/index.js": INDEX, "providers/fake.page.js": RECIPE})
    yield t
    t.context_.close()


def doc(id, method="fetch", date="2026-10-28"):
    return {"id": id, "date": date, "title": "Statement", "method": method}


def sweep(engine, plan, local=None, shrink=False, stop_when=None, sender=None):
    got = engine.evaluate(START, {"plan": plan, "local": local or {}, "shrink": shrink, "stopWhen": stop_when, "sender": sender})
    site = next((v for k, v in got["files"].items() if re.match(r"Chosen/Statement Sweep/Fake Bank/Logs/run-\d{8}-\d{6}\.log$", k)), "")
    # The inbox is Downloads, where the stand-in for Chrome never removes a file.
    pdfs = [k for k in got["files"] if k.endswith(".pdf") and not k.startswith("Inbox/")]
    return got, site, pdfs


# -- only a PDF is saved -------------------------------------------------------

def test_a_fetched_document_that_is_not_a_pdf_is_not_saved_or_marked_seen(engine):
    got, site, pdfs = sweep(engine, {"docs": [doc("f1"), doc("f2", date="2026-09-28")], "bodies": {"f2": "<html>Sign in</html>"}})
    assert got["board"]["fake"]["state"] == "ok"
    assert "1 other did not save" in got["board"]["fake"]["text"] and "not a PDF" in got["board"]["fake"]["text"]
    assert got["local"]["seen:fake"] == ["f1"]
    assert pdfs == ["Chosen/Statement Sweep/Fake Bank/2026-10-28 Fake Statement.pdf"]
    assert "Document f2 by fetch: not saved: The site sent something that is not a PDF." in site


def test_a_download_that_is_not_a_pdf_is_not_saved_and_is_taken_out_of_downloads(engine):
    got, site, pdfs = sweep(engine, {"docs": [doc("c1", "click")], "clickBody": "<html>Sign in</html>"})
    assert got["board"]["fake"]["state"] == "bad"
    assert "not a PDF" in got["board"]["fake"]["text"]
    assert "seen:fake" not in got["local"]
    assert pdfs == []
    assert ["removeFile", 77] in got["events"] and ["erase", 77] in got["events"]


def test_a_download_that_is_a_pdf_is_still_moved_and_marked_seen(engine):
    got, _, pdfs = sweep(engine, {"docs": [doc("c1", "click")], "clickBody": PDF})
    assert got["board"]["fake"]["text"] == "1 new.", got["board"]
    assert got["local"]["seen:fake"] == ["c1"]
    assert pdfs == ["Chosen/Statement Sweep/Fake Bank/2026-10-28 Fake Statement.pdf"]
    assert got["files"][pdfs[0]] == PDF


# -- waits that never end --------------------------------------------------------

def test_a_save_whose_page_never_answers_is_given_up_and_the_run_ends(engine):
    got, site, _ = sweep(engine, {"docs": [doc("f1")], "hangFetch": True}, shrink=True)
    assert got["board"]["fake"]["state"] == "bad"
    assert "The page did not answer within 2 minutes." in got["board"]["fake"]["text"]
    assert "seen:fake" not in got["local"]


def test_a_next_view_that_never_answers_is_given_up_and_the_run_ends(engine):
    got, site, _ = sweep(engine, {"docs": [], "more": True, "hangNext": True}, shrink=True)
    assert got["board"]["fake"]["state"] == "bad"
    assert got["board"]["fake"]["text"] == "That did not finish. The page did not answer within 2 minutes."


def test_stop_cuts_short_a_list_read_that_never_answers(engine):
    got, _, _ = sweep(engine, {"hangList": True}, stop_when="working")
    assert got["board"]["fake"]["state"] == "bad"
    assert "You stopped the sync." in got["board"]["fake"]["text"]
    # Long before the page call's own two minutes.
    assert got["ms"] < 10000


# -- a list within bounds, and what is logged of it -----------------------------

def test_an_id_too_long_is_left_unread_and_a_query_in_an_id_is_not_logged(engine):
    long_id = "/docs/" + "x" * 300
    got, site, pdfs = sweep(engine, {"docs": [doc(long_id), doc("/docs/view?docId=123")]})
    assert got["board"]["fake"]["text"] == "1 new.", got["board"]
    # The id itself is kept as the site gave it: the record depends on it.
    assert got["local"]["seen:fake"] == ["/docs/view?docId=123"]
    assert "WARN   fake: 1 document(s) left unread: an id longer than 300 characters." in site
    assert "fake: Document /docs/view by fetch: saved" in site
    assert "docId" not in site and "x" * 300 not in site


def test_a_list_gives_at_most_five_thousand_documents(engine):
    ids = [f"d{i}" for i in range(5001)]
    got, site, pdfs = sweep(engine, {"docs": [doc(i) for i in ids]}, local={"seen:fake": ids[:5000]})
    assert "WARN   fake: The list held 5,001 documents; only the first 5,000 are taken." in site
    assert got["board"]["fake"]["text"] == "Nothing new."
    assert pdfs == []


# -- who may ask for a run -------------------------------------------------------

@pytest.mark.parametrize("why,sender", [
    ("no sender", {}),
    ("a site's tab", {"id": "self", "url": "https://bank.test/docs", "tab": {"id": 3}, "frameId": 0}),
    ("another extension", {"id": "someone-else", "url": "chrome-extension://someone-else/popup.html"}),
])
def test_a_run_is_asked_for_only_from_the_extensions_own_pages(engine, why, sender):
    got, _, _ = sweep(engine, {"docs": [doc("f1")]}, sender=sender)
    assert not (got["board"] or {}).get("fake"), why
    assert "seen:fake" not in got["local"]


def test_a_message_with_nothing_in_it_is_ignored(engine):
    assert engine.evaluate("""async () => {
      await import('/background.js');
      for (const g of __on.message.set) g(null, __popup, () => {});
      return true;
    }""") is True


# -- Add Site and a built-in site's host ---------------------------------------------

BUILT_IN = {**PROVIDER, "id": "acme-builtin", "name": "Acme Built In", "match": ["https://x.test/*"]}


@pytest.fixture
def bare(browser):
    t = page_with(browser, ENGINE + MORE, {"providers/index.js": "export const PROVIDERS = " + json.dumps([BUILT_IN]) + ";\n"})
    yield t
    t.context_.close()


def test_add_site_leaves_a_built_in_sites_host_alone(bare):
    got = bare.evaluate(ADD, {"config": PICKED, "sender": FROM_TAB})
    assert got["answer"] == {"ok": False, "why": "Acme Built In is already built in to Statement Sweep, so it isn't added again."}
    assert "addedSites" not in got["local"]
