"""Moving the record of what has been saved to another copy of Statement Sweep,
and the History part of the Settings page, in a real Chromium with the
extension's own files."""
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://x.test/"
TYPES = {".js": "text/javascript", ".html": "text/html", ".css": "text/css"}
CHROME = """
window.__store = JSON.parse(sessionStorage.getItem('seed') || '{}');
window.__downloads = [];
const listeners = new Set();
const copy = (v) => JSON.parse(JSON.stringify(v));
Object.defineProperty(window, 'chrome', {value: {storage: {local: {
  get: async (keys) => {
    if (keys == null) return copy(__store);
    const out = {};
    for (const k of typeof keys === 'string' ? [keys] : keys) if (k in __store) out[k] = copy(__store[k]);
    return out;
  },
  set: async (obj) => { Object.assign(__store, copy(obj)); },
}}, downloads: {
  download: async (o) => {
    __downloads.push(o);
    const id = __downloads.length;
    setTimeout(() => listeners.forEach((l) => l({id, state: {current: window.__cancel ? 'interrupted' : 'complete'}})), 0);
    return id;
  },
  onChanged: {addListener: (l) => listeners.add(l), removeListener: (l) => listeners.delete(l)},
}}});
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
        t.goto(BASE)
        yield t
        b.close()


def seed(tab, store, page=""):
    tab.goto(BASE)
    tab.evaluate("s => sessionStorage.setItem('seed', JSON.stringify(s))", store)
    tab.goto(BASE + page)
    if page:
        tab.wait_for_selector("#scope option[value=amex]", state="attached")
        tab.wait_for_function("document.getElementById('historyCount').textContent !== ''")


def store(tab):
    return tab.evaluate("__store")


def history(tab, call, *args):
    return tab.evaluate(f"async (a) => (await import('/history.js')).{call}(...a)", list(args))


def good(**over):
    file = {"format": "statement-sweep-history", "version": 1, "exportedAt": "2026-11-09T10:00:00.000Z",
            "sites": {"amex": ["a1", "a2", "a3"], "chase": ["c1"]}}
    file.update(over)
    return file


def read(tab, file):
    return history(tab, "readHistory", file if isinstance(file, str) else json.dumps(file))


# The module.
def test_export_holds_the_record_settings_and_nothing_else(tab):
    seed(tab, {"seen:amex": ["a1", "a2", "a2"], "seen:chase": ["c1"], "seen:sdge": [], "naming": {"base": "Finance", "folder": "{year}", "file": "", "providers": {"amex": {"file": "x"}}, "stray": 1},
               "off": ["nelnet"], "board": {"x": 1}, "timing": [1]})
    got = tab.evaluate("async () => (await import('/history.js')).exportHistory(new Date('2026-11-09T10:00:00Z'))")
    file = got["file"]
    assert set(file) == {"format", "version", "exportedAt", "sites", "naming", "off"}
    assert file["format"] == "statement-sweep-history" and file["version"] == 1 and file["exportedAt"] == "2026-11-09T10:00:00.000Z"
    assert file["sites"] == {"amex": ["a1", "a2"], "chase": ["c1"]}
    assert file["naming"] == {"base": "Finance", "folder": "{year}", "file": "", "providers": {"amex": {"file": "x"}}}
    assert file["off"] == ["nelnet"]
    assert (got["documents"], got["sites"]) == (3, 2)


def test_export_with_nothing_saved_has_no_settings_keys(tab):
    seed(tab, {})
    file = history(tab, "exportHistory")["file"]
    assert set(file) == {"format", "version", "exportedAt", "sites"} and file["sites"] == {}


def test_an_exported_file_reads_back(tab):
    seed(tab, {"seen:amex": ["a1"], "naming": {"base": "B", "folder": "{provider}", "file": "{date}", "providers": {}}, "off": ["irs"]})
    file = history(tab, "exportHistory")["file"]
    got = read(tab, file)
    assert got["ok"] and got["sites"] == {"amex": ["a1"]} and got["naming"]["file"] == "{date}" and got["off"] == ["irs"]


def test_import_adds_only_new_ids_and_never_removes(tab):
    seed(tab, {"seen:amex": ["a1", "old"], "seen:irs": ["i1"]})
    got = tab.evaluate("""async (text) => {
      const h = await import('/history.js');
      return h.importHistory(h.readHistory(text));
    }""", json.dumps(good()))
    s = store(tab)
    assert s["seen:amex"] == ["a1", "old", "a2", "a3"] and s["seen:chase"] == ["c1"] and s["seen:irs"] == ["i1"]
    assert {x["id"]: (x["added"], x["already"]) for x in got["sites"]} == {"amex": (2, 1), "chase": (1, 0)}
    assert got["added"] == 3 and not got["naming"] and not got["off"]
    assert "naming" not in s and "off" not in s


def test_importing_the_same_file_twice_adds_nothing(tab):
    seed(tab, {})
    again = tab.evaluate("""async (text) => {
      const h = await import('/history.js');
      await h.importHistory(h.readHistory(text));
      return h.importHistory(h.readHistory(text));
    }""", json.dumps(good()))
    assert again["added"] == 0 and store(tab)["seen:amex"] == ["a1", "a2", "a3"]


def test_an_unknown_site_is_reported_and_left_out(tab):
    seed(tab, {})
    got = read(tab, good(sites={"amex": ["a1"], "acmebank": ["z1"]}))
    assert got["ok"] and got["unknown"] == ["acmebank"] and "acmebank" not in got["sites"]
    tab.evaluate("async (t) => { const h = await import('/history.js'); await h.importHistory(h.readHistory(t)); }", json.dumps(good(sites={"acmebank": ["z1"]})))
    assert "seen:acmebank" not in store(tab)


@pytest.mark.parametrize("file,says", [
    ("not json at all", "could not be read"),
    ([1, 2], "not a Statement Sweep history file"),
    (good(format="paperpull-history"), "not a Statement Sweep history file"),
    (good(version=2), "newer Statement Sweep"),
    (good(version=0), "version 0"),
    (good(version="1"), "which version"),
    (good(sites=None), "no list of sites"),
    (good(sites=[["amex", "a"]]), "no list of sites"),
    (good(sites={"amex": "a1"}), "American Express: its record is not a list"),
    (good(sites={"amex": ["a1", 2]}), "American Express: its record has an entry"),
    (good(sites={"amex": ["a1", ""]}), "has an entry"),
    (good(sites={"amex": [{"id": "a"}]}), "has an entry"),
    (good(sites={"amex": ["x" * 2000]}), "has an entry"),
    (good(sites={"chase": [f"c{i}" for i in range(20001)]}), "more than the 20,000"),
    (good(extra=1), "“extra”"),
    (good(exportedAt="yesterday"), "date"),
    (good(naming={"folder": "{nope}"}), "Folder pattern: There is no field called {nope}"),
    (good(naming={"file": "a/b"}), "cannot contain /"),
    (good(naming={"providers": {"amex": {"file": "[x"}}}), "American Express file name pattern"),
    (good(naming={"base": 5}), "main folder is not a pattern"),
    (good(naming="Finance"), "not in the right form"),
    (good(naming={"colour": "red"}), "“colour”"),
    (good(off="amex"), "switched-off sites"),
    (good(dates=["a1"]), "document dates are not in the right form"),
    (good(dates={"amex": ["a1"]}), "American Express: its document dates are not in the right form"),
    (good(dates={"amex": {"a1": "2026-13-01"}}), "not a date (YYYY-MM-DD)"),
    (good(dates={"amex": {"a1": "Oct 28"}}), "not a date"),
    (good(dates={"amex": {"a1": 20261028}}), "not a date"),
    (good(dates={"amex": {"x" * 2000: "2026-10-28"}}), "not a document's id"),
    (good(dates={"chase": {f"c{i}": "2026-10-28" for i in range(20001)}}), "more than the 20,000"),
    (good(tax={"amex": "a1"}), "American Express: its list of tax forms"),
    (good(tax={"amex": [1]}), "list of tax forms"),
    (good(tax=[]), "list of tax forms is not in the right form"),
])
def test_a_malformed_file_is_refused_with_what_is_wrong(tab, file, says):
    got = read(tab, file)
    assert got["ok"] is False and says in got["problem"]


def test_naming_and_off_are_applied_only_when_asked(tab):
    file = json.dumps(good(naming={"base": "Finance", "folder": "{year}", "file": "{date}", "providers": {"amex": {"file": "mine"}, "acmebank": {"file": "z"}}}, off=["irs", "acmebank"]))
    seed(tab, {"naming": {"base": "Mine", "folder": "", "file": "", "providers": {}}})
    tab.evaluate("async (t) => { const h = await import('/history.js'); await h.importHistory(h.readHistory(t)); }", file)
    assert store(tab)["naming"]["base"] == "Mine" and "off" not in store(tab)
    got = tab.evaluate("async (t) => { const h = await import('/history.js'); return h.importHistory(h.readHistory(t), {useSettings: true}); }", file)
    s = store(tab)
    assert got["naming"] and got["off"]
    assert s["naming"] == {"base": "Finance", "folder": "{year}", "file": "{date}", "providers": {"amex": {"file": "mine"}}}
    assert s["off"] == ["irs"]


def test_the_file_name_uses_the_local_date(tab):
    tab.goto(BASE)
    assert tab.evaluate("async () => (await import('/history.js')).fileNameFor(new Date(2026, 10, 9, 23, 59))") == "Statement Sweep History 2026-11-09.json"


# The Settings page.
def choose(tab, file):
    body = file if isinstance(file, str) else json.dumps(file)
    tab.set_input_files("#historyFile", files=[{"name": "history.json", "mimeType": "application/json", "buffer": body.encode()}])


def test_the_page_says_how_much_is_recorded(tab):
    seed(tab, {"seen:amex": ["a1", "a2"], "seen:chase": ["c1"]}, "options.html")
    assert tab.inner_text("#historyCount") == "3 documents from 2 sites"
    seed(tab, {}, "options.html")
    assert tab.inner_text("#historyCount") == "Nothing yet"
    assert tab.locator("#importRow").is_hidden() and tab.inner_text("#historyProblem") == ""


def test_export_asks_where_to_save_with_a_dated_name(tab):
    seed(tab, {"seen:amex": ["a1", "a2"], "seen:chase": ["c1"]}, "options.html")
    tab.click("#exportHistory")
    tab.wait_for_function("document.getElementById('historyStatus').textContent !== ''")
    made = tab.evaluate("__downloads[0]")
    assert made["saveAs"] is True and made["filename"] == tab.evaluate("async () => (await import('/history.js')).fileNameFor()")
    assert made["filename"].startswith("Statement Sweep History 20") and made["filename"].endswith(".json")
    assert made["url"].startswith("data:application/json")
    file = json.loads(tab.evaluate("u => decodeURIComponent(u.slice(u.indexOf(',') + 1))", made["url"]))
    assert file["sites"] == {"amex": ["a1", "a2"], "chase": ["c1"]}
    assert tab.inner_text("#historyStatus") == "Exported 3 documents from 2 sites."
    assert tab.inner_text("#status") == ""


def test_a_cancelled_export_says_nothing(tab):
    seed(tab, {"seen:amex": ["a1"]}, "options.html")
    tab.evaluate("window.__cancel = true")
    tab.click("#exportHistory")
    tab.wait_for_function("__downloads.length === 1")
    tab.wait_for_timeout(100)
    assert tab.inner_text("#historyStatus") == "" and tab.inner_text("#historyProblem") == ""


def test_import_button_opens_the_file_chooser(tab):
    seed(tab, {}, "options.html")
    with tab.expect_file_chooser() as chooser:
        tab.click("#importHistory")
    assert chooser.value.element.get_attribute("accept") == ".json,application/json"


def test_import_shows_what_it_would_add_then_writes_it(tab):
    seed(tab, {"seen:amex": ["a1"]}, "options.html")
    choose(tab, good(sites={"amex": ["a1", "a2"], "chase": ["c1"], "acmebank": ["z"]}))
    tab.wait_for_selector("#importRow", state="visible")
    rows = tab.locator("#importPlan li").all_inner_texts()
    assert [r.replace("\n", " ").replace("\t", " ") for r in rows] == ["American Express 1 new, 1 already here", "Chase 1 new"]
    assert "acmebank" in tab.inner_text("#importNote")
    assert tab.locator("#importSettingsRow").is_hidden()
    assert store(tab)["seen:amex"] == ["a1"] and "seen:chase" not in store(tab)
    tab.click("#importConfirm")
    tab.wait_for_function("document.getElementById('historyStatus').textContent !== ''")
    assert tab.inner_text("#historyStatus") == "Added 2 documents to the record for 2 sites."
    assert store(tab)["seen:amex"] == ["a1", "a2"] and store(tab)["seen:chase"] == ["c1"]
    assert tab.locator("#importRow").is_hidden() and tab.inner_text("#historyCount") == "3 documents from 2 sites"
    assert tab.inner_text("#status") == "" and "naming" not in store(tab)


def test_cancel_writes_nothing(tab):
    seed(tab, {}, "options.html")
    choose(tab, good())
    tab.wait_for_selector("#importRow", state="visible")
    tab.click("#importCancel")
    assert tab.locator("#importRow").is_hidden() and store(tab) == {}


def test_a_bad_file_shows_why_and_offers_nothing(tab):
    seed(tab, {}, "options.html")
    choose(tab, good(version=2))
    tab.wait_for_function("document.getElementById('historyProblem').textContent !== ''")
    assert "newer Statement Sweep" in tab.inner_text("#historyProblem")
    assert tab.get_attribute("#historyProblem", "role") == "alert"
    assert tab.locator("#importRow").is_hidden() and store(tab) == {}
    choose(tab, good())
    tab.wait_for_selector("#importRow", state="visible")
    assert tab.inner_text("#historyProblem") == ""


def test_the_settings_box_is_off_by_default_and_keeps_the_page_as_it_was(tab):
    seed(tab, {"naming": {"base": "Mine", "folder": "{provider}", "file": "", "providers": {}}}, "options.html")
    choose(tab, good(naming={"base": "Finance", "folder": "{year}", "file": "{date}"}, off=["irs"]))
    tab.wait_for_selector("#importRow", state="visible")
    assert tab.locator("#importSettingsRow").is_visible() and not tab.is_checked("#importSettings")
    assert "switched off" in tab.inner_text("#importSettingsHint")
    tab.click("#importConfirm")
    tab.wait_for_function("document.getElementById('historyStatus').textContent !== ''")
    assert store(tab)["naming"]["base"] == "Mine" and "off" not in store(tab)
    assert tab.input_value("#base") == "Mine" and tab.inner_text("#status") == ""


def test_ticking_the_box_uses_and_shows_the_files_settings(tab):
    seed(tab, {"seen:amex": ["a1", "a2", "a3"], "seen:chase": ["c1"]}, "options.html")
    tab.fill("#base", "Unsaved")
    assert tab.inner_text("#status") == "Not saved yet"
    choose(tab, good(naming={"base": "Finance", "folder": "{year}", "file": "{date}"}, off=["irs"]))
    tab.wait_for_selector("#importRow", state="visible")
    assert "Everything in the file is already" in tab.inner_text("#importNote") and "not saved yet" in tab.inner_text("#importSettingsHint")
    assert tab.is_disabled("#importConfirm")
    tab.check("#importSettings")
    assert tab.is_enabled("#importConfirm")
    tab.click("#importConfirm")
    tab.wait_for_function("document.getElementById('status').dataset.kind === 'ok'")
    assert store(tab)["naming"]["base"] == "Finance" and store(tab)["off"] == ["irs"]
    assert tab.input_value("#base") == "Finance" and tab.input_value("#folder") == "{year}" and tab.input_value("#file") == "{date}"
    assert tab.inner_text("#status") == "Folder and file name settings imported and saved"
    assert "switched off" in tab.inner_text("#historyStatus")
    assert tab.inner_text("#preview") == "Finance/2026/2026-10-28.pdf"
    # Nothing is left unsaved, so leaving the page does not ask.
    tab.fill("#base", "Again")
    assert tab.inner_text("#status") == "Not saved yet"


def test_the_controls_are_reachable_by_keyboard(tab):
    seed(tab, {}, "options.html")
    choose(tab, good(naming={"base": "F"}))
    tab.wait_for_selector("#importRow", state="visible")
    assert tab.evaluate("document.activeElement.id") == "importConfirm"
    tab.keyboard.press("Shift+Tab")
    assert tab.evaluate("document.activeElement.id") == "importCancel"
    tab.keyboard.press("Shift+Tab")
    assert tab.evaluate("document.activeElement.id") == "importSettings"
    tab.keyboard.press("Space")
    assert tab.is_checked("#importSettings")


# Each document's date, and which are tax forms (cadence.js), travel too.
def test_export_carries_the_dates_kept_and_those_the_ids_hold(tab):
    seed(tab, {"seen:chase": ["card:2026-10-28", "opaque", "nodate"], "dates:chase": {"opaque": "2026-09-30"},
               "seen:coinbase": ["2026-08", "tax-1099:x"], "tax:coinbase": ["tax-1099:x"], "dates:coinbase": {"tax-1099:x": "2025-12-31"}})
    file = history(tab, "exportHistory")["file"]
    assert file["version"] == 1
    assert file["dates"] == {"chase": {"opaque": "2026-09-30", "card:2026-10-28": "2026-10-28"},
                             "coinbase": {"tax-1099:x": "2025-12-31", "2026-08": "2026-08-31"}}
    assert file["tax"] == {"coinbase": ["tax-1099:x"]}
    got = read(tab, file)
    assert got["ok"] and got["dates"] == file["dates"] and got["tax"] == file["tax"]


def test_import_adds_dates_without_changing_or_removing_any(tab):
    seed(tab, {"seen:amex": ["a1"], "dates:amex": {"a1": "2026-10-01", "kept": "2026-01-31"}, "tax:amex": ["t0"]})
    file = good(dates={"amex": {"a1": "2026-10-05", "a2": "2026-09-01"}, "chase": {"c1": "2026-08-31"}, "acmebank": {"z": "2026-01-01"}},
                tax={"amex": ["t1", "t0"]})
    got = tab.evaluate("async (t) => { const h = await import('/history.js'); return h.importHistory(h.readHistory(t)); }", json.dumps(file))
    s = store(tab)
    assert s["dates:amex"] == {"a1": "2026-10-01", "kept": "2026-01-31", "a2": "2026-09-01"}
    assert s["dates:chase"] == {"c1": "2026-08-31"} and "dates:acmebank" not in s
    assert s["tax:amex"] == ["t0", "t1"]
    assert got["unknown"] == ["acmebank"]
    again = tab.evaluate("async (t) => { const h = await import('/history.js'); await h.importHistory(h.readHistory(t)); return __store; }", json.dumps(file))
    assert again["dates:amex"] == s["dates:amex"] and again["tax:amex"] == s["tax:amex"]


def test_a_file_without_dates_still_reads_and_imports(tab):
    seed(tab, {"dates:amex": {"a1": "2026-10-01"}})
    got = read(tab, good())
    assert got["ok"] and got["dates"] == {} and got["tax"] == {}
    tab.evaluate("async (t) => { const h = await import('/history.js'); await h.importHistory(h.readHistory(t)); }", json.dumps(good()))
    assert store(tab)["dates:amex"] == {"a1": "2026-10-01"}
