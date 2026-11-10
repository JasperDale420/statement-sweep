"""An added site in the engine (background.js), end to end, with test_log.py's
stand-in for Chrome's extension APIs and the real recipe for added sites
(providers/added.page.js) on a stand-in statements list. It is listed with
the built-in sites, saves and logs like them, keeps how its last sync went
for Settings, and on "Only new ones from now on" saves nothing the first
time. Then the engine's side of Add Site: what it keeps, and from whom.
Every number and name is invented."""
import json
import re
import pytest
from test_log import BASE, ENGINE, LINE, page_with

ORIGIN = BASE.rstrip("/")
PDF = "%PDF-1.4 invented\n%%EOF"
# The stand-in list: the engine's stand-in tab is this very page.
LIST = """<table><thead><tr><th>Statement Date</th><th>Document</th></tr></thead><tbody>
<tr><td>Oct 31, 2026</td><td><a href="/files/99990002.pdf">Download</a></td></tr>
<tr><td>Sep 30, 2026</td><td><a href="/files/99990001.pdf">Download</a></td></tr>
</tbody></table><button data-danger>Pay Now</button>"""
CONFIG = {
    "v": 1, "id": "added-acme", "name": "Acme", "origin": ORIGIN, "listUrl": ORIGIN + "/", "listPath": "/",
    "match": [ORIGIN + "/*"], "row": {"tag": "tr", "classes": []}, "path": [["td", 2], ["a", 1]],
    "href": "/files/{id}.pdf", "text": "Download", "date": {"from": "column", "column": 0, "header": "Statement Date"},
    "method": "fetch", "firstSync": "all", "created": "2026-11-10",
}
# No built-in site but one, so only the added one runs; and a way to give or
# take back Chrome's access to it.
INDEX = "export const PROVIDERS = [];\n"
MORE = """
chrome.permissions = { contains: async ({ origins }) => !window.__revoked && origins.every((o) => o === 'https://x.test/*') };
chrome.storage.local.remove = async (keys) => { for (const k of [].concat(keys)) delete __local[k]; };
window.__on = on;
"""

START = """async ({ local, list }) => {
  Object.assign(__local, local);
  document.body.innerHTML = list;
  window.__pressed = [];
  for (const b of document.querySelectorAll('[data-danger]')) b.addEventListener('click', () => __pressed.push(b.textContent));
  const f = await import('/folders.js');
  const root = await navigator.storage.getDirectory();
  await f.setFolder('destination', await root.getDirectoryHandle('Chosen', { create: true }));
  await import('/background.js');
  await new Promise((r) => setTimeout(r, 50));
  __fire.message({ type: 'sweep', only: 'added-acme' });
  const until = Date.now() + 25000;
  for (;;) {
    const out = {};
    async function walk(d, p) { for await (const [n, h] of d.entries()) {
      if (h.kind === 'directory') await walk(h, p + n + '/');
      else { try { out[p + n] = await (await h.getFile()).text(); } catch (e) { if (!['NotFoundError', 'NotReadableError'].includes(e.name)) throw e; } } } }
    await walk(root, '');
    const summary = Object.keys(out).find((p) => /^Chosen\\/Statement Sweep\\/Logs\\/run-\\d{8}-\\d{6}\\.log$/.test(p));
    if ((summary && out[summary].includes('Run ended')) || Date.now() > until) return { files: out, board: __session.board, local: __local, pressed: __pressed };
    await new Promise((r) => setTimeout(r, 200));
  }
}"""


@pytest.fixture
def engine(browser):
    t = page_with(browser, ENGINE + MORE, {"providers/index.js": INDEX, "files/99990001.pdf": PDF, "files/99990002.pdf": PDF})
    yield t
    t.context_.close()


@pytest.fixture(scope="module")
def browser():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


def sweep(engine, config=CONFIG, local=None, page=LIST):
    got = engine.evaluate(START, {"local": {"addedSites": [config], **(local or {})}, "list": page})
    site = next((v for k, v in got["files"].items() if re.match(r"Chosen/Statement Sweep/Acme/Logs/run-\d{8}-\d{6}\.log$", k)), "")
    return got, site


def test_an_added_site_syncs_and_logs_like_the_others(engine):
    got, site = sweep(engine)
    assert got["board"]["added-acme"]["state"] == "ok", got["board"]
    assert got["board"]["added-acme"]["text"] == "2 new."
    assert got["files"]["Chosen/Statement Sweep/Acme/2026-10-31 Acme Statement.pdf"] == PDF
    assert got["files"]["Chosen/Statement Sweep/Acme/2026-09-30 Acme Statement.pdf"] == PDF
    assert got["local"]["seen:added-acme"] == ["2026-10-31", "2026-09-30"]
    assert got["local"]["dates:added-acme"] == {"2026-10-31": "2026-10-31", "2026-09-30": "2026-09-30"}
    assert got["local"]["addedLast:added-acme"]["ok"] is True and got["local"]["addedLast:added-acme"]["found"] == 2
    assert got["pressed"] == []
    lines = [l for l in site.split("\n") if l and not l.startswith("    ")]
    assert all(LINE.match(l.replace("added-acme", "added_acme")) for l in lines), lines
    assert "added-acme: page: Added site: 2 like the one picked, 2 dated from the column." in site
    assert "added-acme: Document 2026-10-31 by fetch: saved" in site
    # Its bar ran like any site's.
    assert got["board"]["added-acme"]["progress"]["done"] == 2


def test_only_new_ones_saves_nothing_the_first_time(engine):
    got, _ = sweep(engine, {**CONFIG, "firstSync": "new"})
    assert got["board"]["added-acme"]["state"] == "ok"
    assert got["board"]["added-acme"]["text"].startswith("Nothing new. 2 already there are left as they are")
    assert not any(k.endswith(".pdf") for k in got["files"])
    assert got["local"]["seen:added-acme"] == ["2026-10-31", "2026-09-30"]
    assert got["local"]["primed:added-acme"] == ["2026-10-31", "2026-09-30"]


def test_only_new_ones_saves_what_is_new_after_the_first_time(engine):
    got, _ = sweep(engine, {**CONFIG, "firstSync": "new"}, {"seen:added-acme": ["2026-09-30"], "primed:added-acme": ["2026-09-30"]})
    assert got["board"]["added-acme"]["text"] == "1 new."
    assert [k for k in got["files"] if k.endswith(".pdf")] == ["Chosen/Statement Sweep/Acme/2026-10-31 Acme Statement.pdf"]


def test_a_page_that_changed_stops_and_is_kept_for_settings(engine):
    got, site = sweep(engine, page=LIST.replace("/files/", "/other/"))
    assert got["board"]["added-acme"]["state"] == "bad"
    assert "No links like the one you picked were found" in got["board"]["added-acme"]["text"]
    last = got["local"]["addedLast:added-acme"]
    assert (last["ok"], last["noMatch"], last["found"]) == (False, True, 0)


def test_an_added_site_chrome_no_longer_allows_is_not_read(engine):
    engine.evaluate("window.__revoked = true")
    got, _ = sweep(engine)
    assert got["board"]["added-acme"]["state"] == "bad"
    assert got["board"]["added-acme"]["text"] == "Statement Sweep can no longer read x.test. Press Pick Again in Settings to allow it again."
    assert "seen:added-acme" not in got["local"]


# -- Add Site, the engine's side ------------------------------------------------------------

ADD = """async ({ config, sender, stored }) => {
  Object.assign(__local, stored || {});
  await import('/background.js');
  return new Promise((resolve) => {
    let answered = false;
    for (const f of __on.message.set) {
      const keep = f({ type: 'addSite', config }, sender, (a) => { answered = true; resolve({ answer: a, local: __local }); });
      if (keep === true) break;
    }
    setTimeout(() => { if (!answered) resolve({ answer: null, local: __local }); }, 3000);
  });
}"""
PICKED = {k: CONFIG[k] for k in ("row", "path", "href", "text", "date", "method")} | {"name": "Acme", "firstSync": "new", "listUrl": "/statements", "listPath": "/statements"}
FROM_TAB = {"id": "self", "frameId": 0, "tab": {"id": 5, "url": ORIGIN + "/statements?acct=99990001"}}


@pytest.fixture
def bare(browser):
    t = page_with(browser, ENGINE + MORE, {"providers/index.js": INDEX})
    yield t
    t.context_.close()


def test_add_site_keeps_only_the_checked_pattern(bare):
    got = bare.evaluate(ADD, {"config": {**PICKED, "note": "page words", "accounts": ["99990001"]}, "sender": FROM_TAB})
    assert got["answer"] == {"ok": True, "id": "added-acme", "name": "Acme"}
    [kept] = got["local"]["addedSites"]
    assert kept == {
        "v": 1, "id": "added-acme", "name": "Acme", "origin": ORIGIN, "listUrl": ORIGIN + "/statements", "listPath": "/statements",
        "match": [ORIGIN + "/*"], "row": CONFIG["row"], "path": CONFIG["path"], "href": CONFIG["href"], "text": "Download",
        "date": CONFIG["date"], "method": "fetch", "firstSync": "new", "created": kept["created"],
    }
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", kept["created"])
    assert "9999" not in json.dumps(kept)


def test_picking_again_replaces_the_sites_pattern_and_keeps_its_id(bare):
    before = {**CONFIG, "id": "added-acme-bank", "name": "Acme Bank", "created": "2026-01-02"}
    got = bare.evaluate(ADD, {"config": {**PICKED, "name": "Acme Bank Again"}, "sender": FROM_TAB,
                             "stored": {"addedSites": [before], "addedLast:added-acme-bank": {"ok": False, "noMatch": True}}})
    assert got["answer"]["ok"] and got["answer"]["id"] == "added-acme-bank"
    [kept] = got["local"]["addedSites"]
    assert (kept["id"], kept["name"], kept["created"], kept["listUrl"]) == ("added-acme-bank", "Acme Bank Again", "2026-01-02", ORIGIN + "/statements")
    assert "addedLast:added-acme-bank" not in got["local"]


def test_a_second_site_with_the_same_name_gets_its_own_id(bare):
    other = {**CONFIG, "origin": "https://other.example.test", "match": ["https://other.example.test/*"], "listUrl": "https://other.example.test/"}
    got = bare.evaluate(ADD, {"config": PICKED, "sender": FROM_TAB, "stored": {"addedSites": [other]}})
    assert got["answer"]["id"] == "added-acme-2"
    assert [c["id"] for c in got["local"]["addedSites"]] == ["added-acme", "added-acme-2"]


@pytest.mark.parametrize("why,sender,config", [
    ("another origin", {**FROM_TAB, "tab": {"id": 5, "url": "https://other.example.test/statements"}}, {**PICKED}),
    ("a frame", {**FROM_TAB, "frameId": 3}, PICKED),
    ("another extension", {**FROM_TAB, "id": "someone-else"}, PICKED),
    ("no tab", {"id": "self", "frameId": 0}, PICKED),
    ("not https", {**FROM_TAB, "tab": {"id": 5, "url": "http://x.test/statements"}}, PICKED),
    ("no name", FROM_TAB, {**PICKED, "name": "  "}),
    ("a list on another site", FROM_TAB, {**PICKED, "listUrl": "https://other.example.test/x"}),
    ("a script address", FROM_TAB, {**PICKED, "href": "javascript:pay()"}),
])
def test_add_site_is_refused_unless_it_is_whole_and_from_the_sites_own_tab(bare, why, sender, config):
    got = bare.evaluate(ADD, {"config": config, "sender": sender})
    assert got["answer"]["ok"] is False, why
    assert "addedSites" not in got["local"]


def test_add_site_is_refused_without_chromes_access(bare):
    bare.evaluate("window.__revoked = true")
    got = bare.evaluate(ADD, {"config": PICKED, "sender": FROM_TAB})
    assert got["answer"] == {"ok": False, "why": "Statement Sweep isn't allowed to read x.test. Press Add This Site again and allow it."}
