"""log.js, the run logs, in a real Chromium: masking, the line format,
buffering and flushing to a folder (the page's private file system stands in
for a chosen folder), the storage fallback, pruning, and shared.js's
__sweepLog. Then the engine itself (background.js), with a stand-in for
Chrome's extension APIs and a stand-in recipe: it writes a site's log and the
run's summary, and gets over a tab that closes or is replaced mid-run.
Every number, address and account here is invented."""
import json
import re
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://x.test/"
LINE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} (DEBUG|INFO |WARN |ERROR)  [a-z0-9_]+: ")


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


def page_with(browser, init="", routes=None):
    context = browser.new_context()
    t = context.new_page()
    if init:
        t.add_init_script(init)

    def serve(route):
        name = route.request.url[len(BASE):].split("?")[0]
        if routes and name in routes:
            route.fulfill(status=200, content_type="text/javascript", body=routes[name])
            return
        path = ROOT / name
        if path.is_file():
            route.fulfill(status=200, content_type="text/javascript", body=path.read_text())
        else:
            route.fulfill(status=200, content_type="text/html", body="<!doctype html><title>x</title>")
    t.route(BASE + "**", serve)
    t.goto(BASE)
    t.context_ = context
    return t


LOCAL = """
window.__local = {};
Object.defineProperty(window, 'chrome', { value: { storage: { local: {
  get: async (keys) => { if (keys === null) return JSON.parse(JSON.stringify(__local)); const out = {}; for (const k of [].concat(keys)) if (k in __local) out[k] = JSON.parse(JSON.stringify(__local[k])); return out; },
  set: async (o) => { Object.assign(__local, JSON.parse(JSON.stringify(o))); },
} } } });
"""

# Every file under the private folder, as {path: text}.
FILES = """async () => {
  const out = {};
  async function walk(d, p) { for await (const [n, h] of d.entries()) {
    if (h.kind === 'directory') await walk(h, p + n + '/');
    else out[p + n] = await (await h.getFile()).text(); } }
  await walk(await navigator.storage.getDirectory(), '');
  return out;
}"""


@pytest.fixture
def tab(browser):
    t = page_with(browser, LOCAL)
    yield t
    t.context_.close()


def call(tab, expr, arg=None):
    return tab.evaluate(f"async (arg) => {{ const m = await import('/log.js'); return ({expr}); }}", arg)


# -- what a line may hold ----------------------------------------------------

def test_long_numbers_keep_only_their_last_four_digits(tab):
    assert call(tab, "m.maskDigits(arg)", "Card ...1234, account 123456789, parcel 0717000123, 2026, 12345") \
        == "Card ...1234, account #####6789, parcel ######0123, 2026, #2345"


def test_addresses_lose_their_query_fragment_and_sign_in(tab):
    got = call(tab, "arg.map(m.cleanUrl)", [
        "https://bank.test/statements?account=99887766&token=abc#top",
        "https://me:secret@bank.test/a/b",
        "https://app.test/#/accounts/44556677/docs?year=2025",
        "https://app.test/page#!/route/1",
        "blob:https://bank.test/2f3a-11",
    ])
    assert got == ["https://bank.test/statements", "https://bank.test/a/b",
                   "https://app.test/#/accounts/####6677/docs", "https://app.test/page#!/route/1",
                   "blob:https://bank.test/2f3a-11"]


def test_an_address_inside_a_line_is_cleaned_too(tab):
    assert call(tab, "m.cleanText(arg)", "went to https://bank.test/x?id=12345678 then stopped") \
        == "went to https://bank.test/x then stopped"


def test_a_line_has_the_time_level_and_site(tab):
    got = call(tab, "m.formatLine(new Date(2026, 9, 12, 16, 43, 32, 244), 'INFO', 'chase', arg)", "Chase: 1 card(s) x 8 year(s)")
    assert got == "2026-10-12 16:43:32.244 INFO   chase: Chase: 1 card(s) x 8 year(s)"
    assert LINE.match(got)


def test_an_error_says_where_it_was_thrown_on_indented_lines(tab):
    got = call(tab, """(() => { function thrower() { throw new Error('No tab with id: 2075551234.'); }
      try { thrower(); } catch (e) { return m.formatLine(new Date(2026, 0, 2, 3, 4, 5, 6), 'ERROR', 'apple', 'sweep: ' + m.errorText(e)); } })()""")
    first, *rest = got.split("\n")
    assert first == "2026-01-02 03:04:05.006 ERROR  apple: sweep: No tab with id: ######1234."
    assert rest and all(line.startswith("    at ") for line in rest)
    assert "thrower" in rest[0]


def test_sizes_are_written_so_they_are_not_masked(tab):
    assert call(tab, "m.cleanText(`${m.amount(1234567)} bytes`)") == "1,234,567 bytes"


# -- where the logs go -------------------------------------------------------

def test_the_site_folder_is_the_one_its_pdfs_go_in(tab):
    got = call(tab, """[
      m.siteFolder(undefined, { id: 'sdge', name: 'SDG&E', fileName: '{date}.pdf' }, 'Documents'),
      m.siteFolder(undefined, { id: 'sdge', name: 'SDG&E', fileName: '{date}.pdf' }, 'Statement Sweep'),
      m.siteFolder({ base: 'Statement Sweep', folder: '{provider}/{year}' }, { id: 'chase', name: 'Chase', fileName: '{date}.pdf' }, 'Docs'),
      m.siteFolder({ base: '', folder: '' }, { id: 'chase', name: 'Chase', fileName: '{date}.pdf' }, 'Docs'),
      m.mainFolder(undefined, 'Documents'),
      m.mainFolder({ base: '' }, 'Documents'),
      m.logPath('Statement Sweep/SDGE', new Date(2026, 9, 12, 16, 43, 32)),
    ]""")
    assert got == ["Statement Sweep/SDGE", "SDGE", "Statement Sweep/Chase", "Chase", "Statement Sweep", "",
                   "Statement Sweep/SDGE/Logs/run-20261012-164332.log"]


MAKE = """async ({ granted = true, folder = true, flushMs = 0, keep = 30 } = {}) => {
  const m = await import('/log.js');
  const f = await import('/folders.js');
  const root = await navigator.storage.getDirectory();
  const chosen = await root.getDirectoryHandle('Chosen', { create: true });
  window.__clock = new Date(2026, 9, 12, 16, 43, 32, 0).getTime();
  window.__logs = m.makeLogs({
    destination: async () => (folder ? chosen : null),
    granted: async () => granted,
    write: f.writeFile,
    local: () => chrome.storage.local,
    naming: async () => undefined,
    now: () => new Date(__clock),
    flushMs, keep,
  });
  window.__site = { id: 'fake', name: 'Fake & Bank', fileName: '{date}.pdf' };
  return 1;
}"""


def make(tab, **options):
    tab.evaluate(MAKE, options)


def test_a_site_log_and_the_summary_are_written_to_the_chosen_folder(tab):
    make(tab)
    files = tab.evaluate("""async () => {
      __logs.begin();
      __logs.started(__site);
      __logs.line(__site, 'INFO', 'readList: ok, 2 doc(s); at https://bank.test/docs?acct=11223344');
      __clock += 1500;
      __logs.counted(__site, 'saved');
      __logs.state(__site, 'ok', '1 new.');
      await __logs.ended(__site);
      await __logs.finish();
      return 1;
    }""") and tab.evaluate(FILES)
    site = files["Chosen/Statement Sweep/Fake Bank/Logs/run-20261012-164332.log"]
    lines = site.strip().split("\n")
    assert all(LINE.match(line) for line in lines), lines
    assert lines[0].endswith("fake: readList: ok, 2 doc(s); at https://bank.test/docs")
    assert "fake: board: ok: 1 new." in site
    assert "Done in 1.5s: ok, 1 saved, 0 failed." in site
    summary = files["Chosen/Statement Sweep/Logs/run-20261012-164332.log"]
    assert "fake: ok, 1 saved, 0 failed, 1.5s, board: 1 new." in summary
    assert "run: Run ended" in summary
    assert tab.evaluate("() => __local") == {}


def test_a_site_still_going_has_its_log_so_far_on_disk(tab):
    make(tab, flushMs=50)
    tab.evaluate("""async () => {
      __logs.begin();
      __logs.started(__site);
      __logs.state(__site, 'needs_you', 'Sign in to Fake & Bank in its tab.');
      __logs.line(__site, 'INFO', 'Waiting for you: signed_out.');
      await new Promise((r) => setTimeout(r, 400));
      return 1;
    }""")
    files = tab.evaluate(FILES)
    site = files["Chosen/Statement Sweep/Fake Bank/Logs/run-20261012-164332.log"]
    assert "Waiting for you: signed_out." in site
    assert "needs_you (still going), 0 saved" in files["Chosen/Statement Sweep/Logs/run-20261012-164332.log"]
    # Written again, over itself, as the run goes on: still one file.
    tab.evaluate("async () => { __logs.line(__site, 'INFO', 'Signed in.'); await new Promise((r) => setTimeout(r, 400)); return 1; }")
    files = tab.evaluate(FILES)
    assert [p for p in files if "Fake Bank/Logs" in p] == ["Chosen/Statement Sweep/Fake Bank/Logs/run-20261012-164332.log"]
    assert "Signed in." in files["Chosen/Statement Sweep/Fake Bank/Logs/run-20261012-164332.log"]


@pytest.mark.parametrize("why", ["no folder", "no permission"])
def test_without_a_folder_the_lines_are_kept_in_storage(tab, why):
    make(tab, folder=why != "no folder", granted=why != "no permission")
    tab.evaluate("""async () => {
      __logs.begin();
      for (let i = 0; i < 2100; i += 1) __logs.line(__site, 'INFO', `line ${i}`);
      __logs.state(__site, 'bad', '0 saved. Stopped waiting for you to sign in.');
      await __logs.ended(__site);
      await __logs.finish();
      return 1;
    }""")
    local = tab.evaluate("() => __local")
    kept = local["log:fake"]
    assert len(kept) == 2000
    assert kept[-1].endswith("fake: Done in 0.0s: bad, 0 saved, 0 failed.")
    assert any(line.endswith("fake: line 2099") for line in kept)
    assert not any(line.endswith("fake: line 0") for line in kept)
    assert any("fake: bad, 0 saved, 0 failed" in line for line in local["log:runs"])
    files = tab.evaluate(FILES)
    assert not any(p.endswith(".log") for p in files)


def test_lines_are_stored_once_however_often_it_flushes(tab):
    make(tab, folder=False, flushMs=20)
    tab.evaluate("""async () => {
      __logs.begin();
      __logs.line(__site, 'INFO', 'one');
      await new Promise((r) => setTimeout(r, 150));
      __logs.line(__site, 'INFO', 'two');
      await __logs.finish();
      return 1;
    }""")
    kept = tab.evaluate("() => __local['log:fake']")
    assert [k.split(": ", 1)[1] for k in kept] == ["one", "two"]


def test_the_stored_logs_export_as_one_text(tab):
    got = call(tab, "m.storedText(arg, (id) => ({ fake: 'Fake & Bank' })[id] || id)",
               {"log:fake": ["a", "b"], "log:runs": ["r"], "seen:fake": ["x"], "log:other": ["c"]})
    assert got == "===== Runs =====\nr\n\n===== Fake & Bank (fake) =====\na\nb\n\n===== other (other) =====\nc\n"
    assert call(tab, "m.storedText({})") == ""


def test_only_the_oldest_run_logs_in_a_logs_folder_are_pruned(tab):
    make(tab, keep=3)
    files = tab.evaluate("""async () => {
      const root = await navigator.storage.getDirectory();
      const chosen = await root.getDirectoryHandle('Chosen', { create: true });
      const f = await import('/folders.js');
      for (const day of ['01', '02', '03', '04', '05']) await f.writeFile(chosen, `Statement Sweep/Fake Bank/Logs/run-202610${day}-090000.log`, new Blob(['old']));
      await f.writeFile(chosen, 'Statement Sweep/Fake Bank/Logs/notes.txt', new Blob(['mine']));
      await f.writeFile(chosen, 'Statement Sweep/Fake Bank/run-20261001-090000.log', new Blob(['not in Logs']));
      await f.writeFile(chosen, 'Statement Sweep/Fake Bank/2026-10-01 Statement.pdf', new Blob(['%PDF-']));
      __logs.begin();
      __logs.line(__site, 'INFO', 'hello');
      await __logs.finish();
      return 1;
    }""") and tab.evaluate(FILES)
    logs = sorted(p.rsplit("/", 1)[1] for p in files if p.startswith("Chosen/Statement Sweep/Fake Bank/Logs/"))
    assert logs == ["notes.txt", "run-20261004-090000.log", "run-20261005-090000.log", "run-20261012-164332.log"]
    assert "Chosen/Statement Sweep/Fake Bank/run-20261001-090000.log" in files
    assert "Chosen/Statement Sweep/Fake Bank/2026-10-01 Statement.pdf" in files


def test_writefile_replaces_only_when_asked(tab):
    files = tab.evaluate("""async () => {
      const f = await import('/folders.js');
      const root = await navigator.storage.getDirectory();
      await f.writeFile(root, 'A/x.log', new Blob(['first']));
      await f.writeFile(root, 'A/x.log', new Blob(['second']));
      await f.writeFile(root, 'A/y.log', new Blob(['a long first copy']));
      await f.writeFile(root, 'A/y.log', new Blob(['short']), { replace: true });
      return 1;
    }""") and tab.evaluate(FILES)
    assert files == {"A/x.log": "first", "A/x (1).log": "second", "A/y.log": "short"}


# -- a recipe's own lines (shared.js) ----------------------------------------

def test_a_recipes_lines_wait_in_the_page_and_ride_on_the_next_answer(tab):
    got = tab.evaluate("""async () => {
      const load = async () => (0, eval)(await (await fetch('/providers/shared.js')).text());
      await load();
      __sweepLog('Layout: menu');
      await load();
      __sweepLog('x'.repeat(500));
      const first = __sweepCarry({ state: 'ok', docs: [] });
      const empty = __sweepCarry({ state: 'ok', docs: [] });
      for (let i = 0; i < 250; i += 1) __sweepLog(`n${i}`);
      const capped = __sweepCarry({ ok: true }).log;
      return { first, empty, capped: [capped.length, capped[0]], passes: [__sweepCarry(null), __sweepCarry([1])] };
    }""")
    assert got["first"]["log"][0] == "Layout: menu"
    assert len(got["first"]["log"][1]) == 300
    assert got["first"]["state"] == "ok"
    assert "log" not in got["empty"]
    assert got["capped"] == [200, "n50"]
    assert got["passes"] == [None, [1]]


# -- the engine ---------------------------------------------------------------

# Not x.test: the engine reads "*." in a match as x., so that host stands for none.
PROVIDER = {"id": "fake", "name": "Fake & Bank", "match": ["https://bank.test/*"], "listUrl": "https://bank.test/docs",
            "pageFile": "providers/fake.page.js", "fileName": "{date} Fake {title}.pdf", "family": "fetch"}
INDEX = "export const PROVIDERS = " + json.dumps([PROVIDER]) + ";\n"
# The stand-in recipe: one statement, fetched; its own line carries an invented account number.
RECIPE = """(() => {
  const readList = () => { __sweepLog('Layout: the test list, account 99887766'); return { state: 'ok', docs: [{ id: 'f1', date: '2026-10-28', title: 'Statement', method: 'fetch' }] }; };
  const fetchPdf = () => ({ ok: true, base64: btoa('%PDF-1.4 invented\\n%%EOF'), size: 20 });
  globalThis.__sweep = { readList, fetchPdf };
})();"""

# Chrome's extension APIs, as far as background.js uses them. Tabs are kept in
# __tabs; `__close` says which reads close the tab they ran in (by count of
# reads), and `__swap` which read Chrome swaps the tab after.
ENGINE = LOCAL.replace("Object.defineProperty(window, 'chrome', { value: { storage: { local: {", "window.__chromeLocal = {") \
    .replace("} } } });", "};") + """
window.__session = {}; window.__events = []; window.__reads = 0; window.__close = []; window.__swap = [];
window.__tabs = new Map(); let nextId = 2075551000;
const listeners = () => { const set = new Set(); return { set, addListener: (f) => set.add(f), removeListener: (f) => set.delete(f), hasListener: (f) => set.has(f) }; };
const on = { message: listeners(), removed: listeners(), replaced: listeners(), updated: listeners(), created: listeners(), dl: listeners(), name: listeners(), startup: listeners(), installed: listeners(), detach: listeners() };
const gone = (id) => new Error(`No tab with id: ${id}.`);
const tabOf = (id) => { const t = __tabs.get(id); if (!t) throw gone(id); return { ...t }; };
const setting = { set: async () => {}, clear: async () => {} };
window.__fire = { message: (m) => on.message.set.forEach((f) => f(m, {}, () => {})) };
const runRecipe = async (files) => { for (const f of files) (0, eval)(await (await fetch('/' + f)).text()); };
Object.defineProperty(window, 'chrome', { value: {
  runtime: { id: 'self', onMessage: on.message, onStartup: on.startup, onInstalled: on.installed, sendMessage: async () => {}, getPlatformInfo: () => {} },
  action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}, setTitle: async () => {} },
  storage: { local: __chromeLocal, session: {
    get: async (k) => { const out = {}; for (const key of [].concat(k)) if (key in __session) out[key] = JSON.parse(JSON.stringify(__session[key])); return out; },
    set: async (o) => { Object.assign(__session, JSON.parse(JSON.stringify(o))); },
  } },
  contentSettings: { automaticDownloads: setting, popups: setting },
  downloads: { onChanged: on.dl, onDeterminingFilename: on.name, download: async () => 1, search: async () => [], cancel: async () => {}, erase: async () => {}, removeFile: async () => {} },
  debugger: { onDetach: on.detach },
  tabs: {
    onRemoved: on.removed, onReplaced: on.replaced, onUpdated: on.updated, onCreated: on.created,
    query: async () => [],
    get: async (id) => tabOf(id),
    create: async ({ url }) => { const t = { id: nextId++, url, status: 'complete' }; __tabs.set(t.id, t); __events.push(['create', t.id]); return { ...t }; },
    update: async (id, o) => { const t = tabOf(id); if (o.url) __tabs.get(id).url = o.url; return t; },
    remove: async (id) => { __tabs.delete(id); __events.push(['remove', id]); },
  },
  scripting: { executeScript: async ({ target, files, func, args }) => {
    tabOf(target.tabId);
    if (files) { await runRecipe(files); return [{ result: undefined }]; }
    const result = await func(...(args || []));
    if (func.name === 'readList') {
      __reads += 1;
      if (__close.includes(__reads)) { __tabs.delete(target.tabId); __events.push(['closed', target.tabId]); }
      if (__swap.includes(__reads)) {
        const t = __tabs.get(target.tabId); __tabs.delete(target.tabId);
        const added = { ...t, id: target.tabId + 500 }; __tabs.set(added.id, added);
        __events.push(['replaced', target.tabId, added.id]);
        on.replaced.set.forEach((f) => f(added.id, target.tabId));
      }
    }
    return [{ result }];
  } },
} });
"""

START = """async ({ close, swap }) => {
  __close = close; __swap = swap;
  const f = await import('/folders.js');
  const root = await navigator.storage.getDirectory();
  await f.setFolder('destination', await root.getDirectoryHandle('Chosen', { create: true }));
  await import('/background.js');
  __fire.message({ type: 'sweep', only: 'fake' });
  const until = Date.now() + 25000;
  for (;;) {
    const out = {};
    async function walk(d, p) { for await (const [n, h] of d.entries()) {
      if (h.kind === 'directory') await walk(h, p + n + '/');
      else out[p + n] = await (await h.getFile()).text(); } }
    await walk(root, '');
    const summary = Object.keys(out).find((p) => /^Chosen\\/Statement Sweep\\/Logs\\/run-\\d{8}-\\d{6}\\.log$/.test(p));
    if ((summary && out[summary].includes('Run ended')) || Date.now() > until) return { files: out, board: __session.board, events: __events };
    await new Promise((r) => setTimeout(r, 200));
  }
}"""


@pytest.fixture
def engine(browser):
    t = page_with(browser, ENGINE, {"providers/index.js": INDEX, "providers/fake.page.js": RECIPE})
    yield t
    t.context_.close()


def sweep(engine, close=(), swap=()):
    got = engine.evaluate(START, {"close": list(close), "swap": list(swap)})
    site = next(v for k, v in got["files"].items() if re.match(r"Chosen/Statement Sweep/Fake Bank/Logs/run-\d{8}-\d{6}\.log$", k))
    summary = next(v for k, v in got["files"].items() if re.match(r"Chosen/Statement Sweep/Logs/run-\d{8}-\d{6}\.log$", k))
    return got, site, summary


def test_the_engine_writes_what_the_site_did_and_a_summary(engine):
    got, site, summary = sweep(engine)
    assert got["board"]["fake"]["state"] == "ok"
    assert "Chosen/Statement Sweep/Fake Bank/2026-10-28 Fake Statement.pdf" in got["files"]
    lines = [l for l in site.split("\n") if l and not l.startswith("    ")]
    assert all(LINE.match(l) for l in lines), lines
    assert "fake: Tab opened: ######1000, at https://bank.test/docs, since no open tab showed the list." in site
    assert "fake: page: Layout: the test list, account ####7766" in site
    assert "fake: readList: ok, 1 doc(s); walk true; at https://bank.test/docs" in site
    assert re.search(r"fake: Document f1 by fetch: saved, \d+ bytes\.", site)
    assert "fake: board: ok: 1 new." in site
    assert re.search(r"DEBUG  fake: took [\d,]+ ms: save", site)
    assert "99887766" not in site
    assert "run: Run of one site: fake." in summary
    assert "run: fake: chosen (never, 0 saved" in summary
    assert re.search(r"fake: ok, 1 saved, 0 failed, [\d.]+s, board: 1 new\.", summary)


def test_a_tab_that_closes_mid_run_is_opened_again_once(engine):
    got, site, _ = sweep(engine, close=[1])
    assert got["board"]["fake"]["state"] == "ok", got["board"]
    assert got["board"]["fake"]["text"] == "1 new."
    assert [e[0] for e in got["events"]][:3] == ["create", "closed", "create"]
    assert "WARN   fake: The sweep's tab ######1000 is gone (saving f1): No tab with id: ######1000." in site
    assert "fake: Tab opened: ######1001, at https://bank.test/docs, in place of the one that closed." in site


def test_a_tab_that_closes_twice_stops_the_site_plainly(engine):
    got, site, summary = sweep(engine, close=[1, 2])
    assert (got["board"]["fake"]["state"], got["board"]["fake"]["text"]) == ("bad", "Fake & Bank's tab closed during the sweep. Run it again.")
    assert [e[0] for e in got["events"]].count("create") == 2
    assert "fake: board: bad: Fake & Bank's tab closed during the sweep. Run it again." in site
    assert "fake: bad, 0 saved, 0 failed" in summary


def test_a_tab_chrome_replaces_is_followed_without_a_new_one(engine):
    got, site, _ = sweep(engine, swap=[1])
    assert got["board"]["fake"]["state"] == "ok", got["board"]
    assert [e[0] for e in got["events"]].count("create") == 1
    assert "fake: Chrome replaced tab ######1000 with tab ######1500." in site
    assert "fake: Following it to tab ######1500, which Chrome put in its place." in site
