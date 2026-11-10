"""The guide card (guide.js) and the engine's side of it (background.js).

The card is run in a real isolated world (made over the DevTools protocol, as
Chrome makes one for an extension), over a page whose own styles try to hide
and restyle it. Then the engine, with a stand-in for Chrome's extension APIs
and a stand-in recipe that waits for a sign-in: it draws the card, hears only
the card in the tab it waits on, looks again at once on Check now, and ends
the site with "Skipped." on Skip this site. Every name and number is invented."""
import json
import re
import time
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://x.test/"
GUIDE = (ROOT / "guide.js").read_text()

# A page that tries to reach the card: hides its element, restyles every
# button and blows up every font.
HOSTILE = """<!doctype html><title>Fake Bank</title>
<style>
  statement-sweep-guide { display: none !important; opacity: 0 !important; }
  button { background: red !important; color: lime !important; }
  * { font-size: 40px !important; }
</style><h1>Sign in to Fake Bank</h1>"""


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


# -- the card, in an isolated world ------------------------------------------

class World:
    """An isolated world in the page, like an extension's, with a stand-in
    chrome.runtime that keeps what was sent, and each shadow root guide.js
    makes kept aside so the test can find its buttons."""

    def __init__(self, page):
        self.page = page
        self.cdp = page.context.new_cdp_session(page)
        frame = self.cdp.send("Page.getFrameTree")["frameTree"]["frame"]["id"]
        self.ctx = self.cdp.send("Page.createIsolatedWorld", {"frameId": frame, "worldName": "Statement Sweep"})["executionContextId"]
        self.run("""window.__sent = []; window.__roots = [];
          window.chrome = { runtime: { sendMessage: async (m) => { __sent.push(m); } } };
          const attach = Element.prototype.attachShadow;
          Element.prototype.attachShadow = function (o) { const r = attach.call(this, o); __roots.push(r); return r; };
          true""")
        self.run(GUIDE + ";true")

    def run(self, expr):
        r = self.cdp.send("Runtime.evaluate", {"expression": expr, "contextId": self.ctx, "returnByValue": True, "awaitPromise": True})
        assert "exceptionDetails" not in r, r["exceptionDetails"]
        return r["result"].get("value")

    def show(self, **card):
        return self.run(f"globalThis.__sweepGuide.show({json.dumps(card)})")

    def click(self, selector):
        box = self.run(f"(() => {{ const r = __roots.at(-1).querySelector({json.dumps(selector)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }})()")
        self.page.mouse.click(*box)


@pytest.fixture
def world(browser):
    context = browser.new_context(viewport={"width": 1000, "height": 700})
    page = context.new_page()
    page.route(BASE + "**", lambda route: route.fulfill(status=200, content_type="text/html", body=HOSTILE))
    page.goto(BASE)
    yield World(page)
    context.close()


CARD = {"site": "fake", "name": "Fake Bank", "steps": ["Sign in to Fake Bank here.", "Statement Sweep goes on by itself once you're in."]}


def test_the_card_shows_its_steps_bottom_right_whatever_the_page_styles(world):
    assert world.show(**CARD) == "shown"
    assert world.show(**CARD) == "kept"
    got = world.run("""(() => {
      const root = __roots.at(-1), host = document.querySelector('statement-sweep-guide');
      const r = host.getBoundingClientRect(), check = root.querySelector('.primary');
      return {
        label: root.querySelector('.label').textContent, site: root.querySelector('.site').textContent,
        steps: [...root.querySelectorAll('li')].map((li) => li.textContent),
        buttons: [...root.querySelectorAll('button')].map((b) => b.textContent || b.getAttribute('aria-label')),
        right: innerWidth - r.right, bottom: innerHeight - r.bottom, shown: getComputedStyle(host).display, z: getComputedStyle(host).zIndex,
        checkBg: getComputedStyle(check).backgroundColor, font: getComputedStyle(root.querySelector('li')).fontSize,
      };
    })()""")
    assert got["label"] == "Statement Sweep" and got["site"] == "Fake Bank"
    assert got["steps"] == CARD["steps"]
    assert got["buttons"] == ["Hide this card on this page", "Check now", "Skip this site"]
    assert (got["right"], got["bottom"], got["shown"], got["z"]) == (16, 16, "block", "2147483647")
    # The page's own styles do not reach it.
    assert got["checkBg"] == "rgb(0, 113, 227)" and got["font"] == "13px"


def test_the_page_cannot_see_into_the_card_or_call_it(world):
    world.show(**CARD)
    assert world.page.evaluate("""() => {
      const host = document.querySelector('statement-sweep-guide');
      return [host.shadowRoot, typeof globalThis.__sweepGuide, host.textContent];
    }""") == [None, "undefined", ""]


def test_its_buttons_send_the_right_messages_and_only_for_a_real_press(world):
    world.show(**CARD)
    # A script's click is not a person's.
    world.run("__roots.at(-1).querySelector('.primary').click(), true")
    assert world.run("__sent") == []
    world.click(".primary")
    assert world.run("__sent") == [{"type": "guide", "action": "check", "site": "fake"}]
    assert world.run("__roots.at(-1).querySelector('.primary').textContent") == "Checking…"
    world.click(".secondary")
    assert world.run("__sent")[-1] == {"type": "guide", "action": "skip", "site": "fake"}
    assert world.page.locator("statement-sweep-guide").count() == 0


def test_the_close_button_hides_it_for_this_page_and_hide_takes_it_away(world):
    world.show(**CARD)
    world.click(".close")
    assert world.page.locator("statement-sweep-guide").count() == 0
    assert world.show(**CARD) == "closed"
    assert world.run("__sent") == []
    assert world.show(site="other", name="Other Bank", steps=["Search by owner, address or parcel number."]) == "shown"
    assert world.run("__roots.at(-1).querySelector('ol').className") == "steps one"
    assert world.run("globalThis.__sweepGuide.hide('other')") is True
    assert world.run("globalThis.__sweepGuide.hide('other')") is False


def test_a_favicon_the_page_will_not_load_leaves_just_the_name(world):
    world.show(**CARD, icon="https://x.test/missing.png")
    world.page.wait_for_timeout(300)
    assert world.run("[__roots.at(-1).querySelectorAll('img').length, __roots.at(-1).querySelector('.site').textContent]") == [0, "Fake Bank"]


def test_dark_mode_and_reduced_motion(browser):
    context = browser.new_context(color_scheme="dark", reduced_motion="reduce")
    page = context.new_page()
    page.route(BASE + "**", lambda route: route.fulfill(status=200, content_type="text/html", body=HOSTILE))
    page.goto(BASE)
    w = World(page)
    w.show(**CARD)
    got = w.run("(() => { const c = __roots.at(-1).querySelector('.card'); const s = getComputedStyle(c); return [s.backgroundColor, s.color, s.animationName]; })()")
    assert got == ["rgb(44, 44, 46)", "rgb(245, 245, 247)", "none"]
    context.close()


# -- the engine ---------------------------------------------------------------

PROVIDER = {"id": "fake", "name": "Fake Bank", "match": ["https://bank.test/*"], "listUrl": "https://bank.test/docs",
            "pageFile": "providers/fake.page.js", "fileName": "{date} Fake {title}.pdf", "family": "fetch",
            "guide": {"signIn": ["Sign in to Fake Bank here.", "Statement Sweep goes on by itself once you're in."]}}
INDEX = "export const PROVIDERS = " + json.dumps([PROVIDER]) + ";\n"
# Signed out until the test says otherwise; every read is timed.
RECIPE = """(() => {
  const readList = () => { __readsAt.push(Date.now());
    return window.__signedIn ? { state: 'ok', docs: [{ id: 'f1', date: '2026-10-28', title: 'Statement', method: 'fetch' }] } : { state: 'signed_out' }; };
  const fetchPdf = () => ({ ok: true, base64: btoa('%PDF-1.4 invented\\n%%EOF'), size: 20 });
  globalThis.__sweep = { readList, fetchPdf };
})();"""

# Chrome's extension APIs, as far as background.js uses them here. Files
# (the recipe, guide.js) are run in the test page itself.
ENGINE = """
window.__local = {}; window.__session = {}; window.__events = []; window.__readsAt = []; window.__signedIn = false;
window.__tabs = new Map(); let nextId = 2075551000;
const listeners = () => { const set = new Set(); return { set, addListener: (f) => set.add(f), removeListener: (f) => set.delete(f), hasListener: (f) => set.has(f) }; };
const on = { message: listeners(), removed: listeners(), replaced: listeners(), updated: listeners(), created: listeners(), dl: listeners(), name: listeners(), startup: listeners(), installed: listeners(), detach: listeners() };
const tabOf = (id) => { const t = __tabs.get(id); if (!t) throw new Error(`No tab with id: ${id}.`); return { ...t }; };
const setting = { set: async () => {}, clear: async () => {} };
const store = (o) => ({
  get: async (k) => { if (k === null) return JSON.parse(JSON.stringify(o)); const out = {}; for (const key of [].concat(k)) if (key in o) out[key] = JSON.parse(JSON.stringify(o[key])); return out; },
  set: async (v) => { Object.assign(o, JSON.parse(JSON.stringify(v))); },
});
window.__fire = (m, sender) => on.message.set.forEach((f) => f(m, sender, () => {}));
const runFiles = async (files) => { for (const f of files) (0, eval)(await (await fetch('/' + f)).text()); };
Object.defineProperty(window, 'chrome', { value: {
  runtime: { id: 'self', onMessage: on.message, onStartup: on.startup, onInstalled: on.installed, sendMessage: async () => {}, getPlatformInfo: () => {} },
  action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {}, setTitle: async () => {} },
  storage: { local: store(__local), session: store(__session) },
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
    if (files) { await runFiles(files); return [{ result: undefined }]; }
    return [{ result: await func(...(args || [])) }];
  } },
} });
"""

START = """async () => {
  const f = await import('/folders.js');
  const root = await navigator.storage.getDirectory();
  await f.setFolder('destination', await root.getDirectoryHandle('Chosen', { create: true }));
  await import('/background.js');
  __fire({ type: 'sweep', only: 'fake' }, {});
  return true;
}"""

LOGS = """async () => {
  const out = {};
  async function walk(d, p) { for await (const [n, h] of d.entries()) {
    if (h.kind === 'directory') await walk(h, p + n + '/');
    else out[p + n] = await (await h.getFile()).text(); } }
  await walk(await navigator.storage.getDirectory(), '');
  return Object.entries(out).filter(([k]) => /Fake Bank\\/Logs\\/run-/.test(k)).map(([, v]) => v).join('');
}"""


@pytest.fixture
def engine(browser):
    context = browser.new_context()
    t = context.new_page()
    t.add_init_script(ENGINE)
    routes = {"providers/index.js": INDEX, "providers/fake.page.js": RECIPE}

    def serve(route):
        name = route.request.url[len(BASE):].split("?")[0]
        if name in routes:
            return route.fulfill(status=200, content_type="text/javascript", body=routes[name])
        path = ROOT / name
        if path.is_file():
            return route.fulfill(status=200, content_type="text/javascript", body=path.read_text())
        route.fulfill(status=200, content_type="text/html", body="<!doctype html><title>x</title>")
    t.route(BASE + "**", serve)
    t.goto(BASE)
    t.evaluate(START)
    yield t
    context.close()


def until(engine, expr, seconds=10):
    end = time.time() + seconds
    while time.time() < end:
        got = engine.evaluate(expr)
        if got:
            return got
        time.sleep(0.05)
    raise AssertionError(f"never: {expr}")


def log_of(engine, *wanted, seconds=12):
    """The site's run log, once it holds every one of `wanted` (patterns)."""
    end = time.time() + seconds
    while True:
        text = engine.evaluate(LOGS)
        if all(re.search(w, text) for w in wanted) or time.time() > end:
            return text
        time.sleep(0.2)


def waiting_tab(engine):
    until(engine, "(__session.board || {}).fake && __session.board.fake.state === 'needs_you'")
    until(engine, "document.querySelectorAll('statement-sweep-guide').length === 1")
    return engine.evaluate("[...__tabs.keys()][0]")


def board(engine, seconds=10):
    return until(engine, "['ok', 'bad'].includes(((__session.board || {}).fake || {}).state) && __session.board.fake", seconds)


def card_message(engine, action, sender):
    engine.evaluate("([m, s]) => __fire(m, s)", [{"type": "guide", "action": action, "site": "fake"}, sender])


def gap_after_message(engine, action, sender):
    """How long after the message the next read came, in ms, with the message
    sent just after a read, so a whole pause is left to cut."""
    until(engine, "__readsAt.length >= 2")
    n = engine.evaluate("(async () => { const n = __readsAt.length; while (__readsAt.length === n) await new Promise((r) => setTimeout(r, 5)); return __readsAt.length; })()")
    sent = engine.evaluate("([m, s]) => { __fire(m, s); return Date.now(); }", [{"type": "guide", "action": action, "site": "fake"}, sender])
    return engine.evaluate(f"(async () => {{ while (__readsAt.length <= {n}) await new Promise((r) => setTimeout(r, 5)); return __readsAt[{n}] - {sent}; }})()")


def test_the_card_is_drawn_while_the_site_waits_and_goes_when_it_signs_in(engine):
    waiting_tab(engine)
    engine.evaluate("__signedIn = true")
    got = board(engine)
    assert (got["state"], got["text"]) == ("ok", "1 new.")
    assert engine.locator("statement-sweep-guide").count() == 0
    shown, removed = r"fake: Guide card shown in tab #+\d{4} \(signed_out\)\.", r"fake: Guide card removed from tab #+\d{4}: the site answered ok\."
    logs = log_of(engine, shown, removed)
    assert re.search(shown, logs) and re.search(removed, logs)


def test_check_now_cuts_the_wait_short(engine):
    tab = waiting_tab(engine)
    # Without a press, the next read is a whole pause away.
    assert gap_after_message(engine, "nothing", {"id": "self", "tab": {"id": tab}, "frameId": 0}) > 1500
    assert gap_after_message(engine, "check", {"id": "self", "tab": {"id": tab}, "frameId": 0}) < 600
    engine.evaluate("__signedIn = true")
    assert board(engine)["state"] == "ok"
    assert "fake: Check now pressed on the guide card: looking again." in log_of(engine, "Check now pressed")


def test_skip_ends_the_site_with_skipped_and_leaves_its_tab(engine):
    tab = waiting_tab(engine)
    card_message(engine, "skip", {"id": "self", "tab": {"id": tab}, "frameId": 0})
    got = board(engine)
    assert (got["state"], got["text"]) == ("bad", "Skipped.")
    assert ["remove", tab] not in engine.evaluate("__events")
    assert engine.locator("statement-sweep-guide").count() == 0
    assert "fake: Skip this site pressed on the guide card: its wait ends for this run." in log_of(engine, "Skip this site pressed")


def test_messages_not_from_the_card_in_the_waiting_tab_are_ignored(engine):
    tab = waiting_tab(engine)
    for sender in ({"id": "self", "tab": {"id": tab + 1}, "frameId": 0},  # another tab
                   {"id": "other-extension", "tab": {"id": tab}, "frameId": 0},  # not this extension
                   {"id": "self"},  # the popup, which has no tab
                   {"id": "self", "tab": {"id": tab}, "frameId": 3}):  # a frame in the page
        card_message(engine, "skip", sender)
    engine.evaluate("([m, s]) => __fire(m, s)", [{"type": "guide", "action": "skip", "site": "nobody"}, {"id": "self", "tab": {"id": tab}, "frameId": 0}])
    time.sleep(2.5)
    assert engine.evaluate("__session.board.fake.state") == "needs_you"
    engine.evaluate("__signedIn = true")
    assert board(engine)["state"] == "ok"
    assert log_of(engine, "Run ended|board: ok").count("A guide message (skip) was ignored") == 4
