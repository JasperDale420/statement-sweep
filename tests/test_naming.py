"""Where documents are saved and what they are called, and the Settings page
that sets it, in a real Chromium with the extension's own files."""
import json
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://x.test/"
TYPES = {".js": "text/javascript", ".html": "text/html", ".css": "text/css"}
AMEX = {"id": "amex", "name": "American Express", "fileName": "{date} American Express {title}.pdf"}
SDGE = {"id": "sdge", "name": "SDG&E", "fileName": "{date} SDG&E Utility Bill.pdf"}
DOC = {"id": "x", "date": "2026-10-28", "title": "Monthly Statement"}
CHROME = """
window.__store = {};
Object.defineProperty(window, 'chrome', {value: {storage: {local: {
  get: async (key) => (key in __store ? {[key]: __store[key]} : {}),
  set: async (obj) => { Object.assign(__store, JSON.parse(JSON.stringify(obj))); },
}}}});
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


def path(tab, naming, provider=AMEX, doc=DOC):
    return tab.evaluate("async ([n, p, d]) => (await import('/naming.js')).pathFor(n, p, d)", [naming, provider, doc])


def problem(tab, pattern, is_file=False):
    return tab.evaluate("async ([p, f]) => (await import('/naming.js')).checkPattern(p, {isFile: f})", [pattern, is_file])


def test_with_no_settings_files_go_exactly_where_they_always_have(tab):
    assert path(tab, None) == "Statement Sweep/American Express/2026-10-28 American Express Monthly Statement.pdf"
    assert path(tab, None, SDGE) == "Statement Sweep/SDGE/2026-10-28 SDG&E Utility Bill.pdf"


def test_a_folder_and_file_pattern_are_used(tab):
    naming = {"base": "Finance", "folder": "{provider}/{year}", "file": "{date:yyyymmdd} {provider}[ - {title}]"}
    assert path(tab, naming) == "Finance/American Express/2026/20261028 American Express - Monthly Statement.pdf"


def test_a_date_format_can_use_words(tab):
    assert path(tab, {"file": "{date:mmm yyyy} {date:mmmm} {month}-{day}"}).endswith("/Oct 2026 October 10-28.pdf")


def test_an_optional_part_with_no_value_is_left_out(tab):
    doc = {"id": "x", "date": "2026-10-28"}
    assert path(tab, {"file": "{date}[ - {title}]"}, doc=doc).endswith("/2026-10-28.pdf")


def test_a_value_cannot_make_a_folder_or_break_the_name(tab):
    doc = {"id": "x", "date": "2026-10-28", "title": 'Fees/Other: "Q3"*'}
    got = path(tab, {"file": "{title}"}, doc=doc)
    assert got == 'Statement Sweep/American Express/Fees-Other- -Q3--.pdf'


def test_a_pattern_cannot_climb_out_of_downloads(tab):
    got = path(tab, {"base": "../../secret", "folder": "..", "file": "x"})
    assert ".." not in got and got == "secret/x.pdf"


def test_pdf_is_added_once(tab):
    assert path(tab, {"file": "{date}.pdf"}).endswith("/2026-10-28.pdf")
    assert path(tab, {"file": "{date}"}).endswith("/2026-10-28.pdf")


def test_an_empty_folder_pattern_saves_in_the_main_folder(tab):
    assert path(tab, {"folder": "", "file": "x"}) == "Statement Sweep/x.pdf"


def test_a_providers_own_pattern_wins_and_a_blank_one_inherits(tab):
    naming = {"folder": "All", "file": "general", "providers": {"amex": {"file": "mine"}, "sdge": {"folder": "Bills", "file": ""}}}
    assert path(tab, naming) == "Statement Sweep/All/mine.pdf"
    assert path(tab, naming, SDGE) == "Statement Sweep/Bills/general.pdf"


def test_a_very_long_name_is_cut_and_keeps_pdf(tab):
    got = path(tab, {"file": "x" * 400})
    assert got.endswith(".pdf") and len(got.split("/")[-1]) == 124


@pytest.mark.parametrize("pattern,says", [("{nope}", "{nope}"), ("{date", "closing"), ("date}", "opening"), ("[{title}", "closing"), ("x]", "opening"), ("[[x]]", "inside"),
                                          ("{title:yyyy}", "Only {date}"), ("{date:zz}", "no date parts")])
def test_a_bad_pattern_says_what_is_wrong(tab, pattern, says):
    assert says in problem(tab, pattern)


def test_a_file_pattern_cannot_hold_a_folder(tab):
    assert "cannot contain /" in problem(tab, "a/b", True)
    assert problem(tab, "a/b") == ""


# The Settings page.
def settings(tab, stored=None):
    tab.goto(BASE)
    tab.evaluate("s => { sessionStorage.setItem('n', JSON.stringify(s)); }", stored)
    tab.add_init_script("if (sessionStorage.getItem('n') && sessionStorage.getItem('n') !== 'null') window.__store.naming = JSON.parse(sessionStorage.getItem('n'));")
    tab.goto(BASE + "options.html")
    tab.wait_for_selector("#scope option[value=amex]", state="attached")


def test_the_page_opens_on_the_defaults_with_an_example(tab):
    settings(tab)
    assert tab.input_value("#base") == "Statement Sweep" and tab.input_value("#folder") == "{provider}"
    assert tab.inner_text("#preview") == "Statement Sweep/American Express/2026-10-28 American Express Monthly Statement.pdf"


def test_the_example_follows_what_is_typed_and_save_stores_it(tab):
    settings(tab)
    tab.fill("#base", "Finance")
    tab.fill("#file", "{date} {provider}")
    assert tab.inner_text("#preview") == "Finance/American Express/2026-10-28 American Express.pdf"
    assert tab.inner_text("#status") == "Not saved yet"
    tab.click("#save")
    tab.wait_for_function("document.getElementById('status').textContent === 'Saved'")
    stored = tab.evaluate("__store.naming")
    assert stored["base"] == "Finance" and stored["file"] == "{date} {provider}"


def test_a_bad_pattern_shows_why_and_cannot_be_saved(tab):
    settings(tab)
    tab.fill("#folder", "{nope}")
    assert "{nope}" in tab.inner_text("#problem")
    assert tab.is_disabled("#save") and tab.inner_text("#preview") == ""
    assert tab.evaluate("__store.naming") is None


def test_one_sites_pattern_is_kept_apart_from_the_others(tab):
    settings(tab)
    tab.select_option("#scope", "amex")
    assert tab.input_value("#folder") == ""
    tab.fill("#file", "amex only")
    assert tab.inner_text("#preview").endswith("/amex only.pdf")
    tab.select_option("#scope", "sdge")
    assert tab.input_value("#file") == ""
    assert tab.inner_text("#preview").endswith("SDG&E Utility Bill.pdf")
    tab.click("#save")
    tab.wait_for_function("document.getElementById('status').textContent === 'Saved'")
    assert tab.evaluate("__store.naming.providers.amex.file") == "amex only" and tab.evaluate("__store.naming.file") == ""


def test_a_bad_pattern_on_another_site_still_blocks_save(tab):
    settings(tab)
    tab.select_option("#scope", "amex")
    tab.fill("#file", "{nope}")
    tab.select_option("#scope", "")
    assert "American Express" in tab.inner_text("#problem") and tab.is_disabled("#save")


def test_a_preset_fills_the_pattern_and_the_menu_follows_typing(tab):
    settings(tab)
    assert tab.input_value("#folderPreset") == "{provider}"
    tab.select_option("#folderPreset", label="By Site and Year")
    assert tab.input_value("#folder") == "{provider}/{year}"
    assert "/American Express/2026/" in tab.inner_text("#preview")
    tab.fill("#folder", "Mine/{year}")
    assert tab.locator("#folderPreset option:checked").inner_text() == "Custom"


def test_one_site_can_go_back_to_the_general_pattern(tab):
    settings(tab)
    tab.select_option("#scope", "amex")
    assert tab.locator("#filePreset option:checked").inner_text() == "Same as All Sites"
    tab.select_option("#filePreset", label="Site, Date, Title")
    assert tab.input_value("#file") == "{provider} {date}[ {title}]"
    tab.select_option("#filePreset", label="Same as All Sites")
    assert tab.input_value("#file") == ""


def test_an_insert_button_adds_a_field_at_the_caret(tab):
    settings(tab)
    tab.fill("#file", "ab")
    tab.evaluate("document.getElementById('file').setSelectionRange(1, 1)")
    tab.click(".chip[data-insert='{year}']")
    assert tab.input_value("#file") == "a{year}b"
    assert tab.evaluate("document.activeElement.id") == "file"


def test_an_insert_button_goes_to_the_folder_pattern_when_that_was_last_used(tab):
    settings(tab)
    tab.fill("#folder", "x/")
    tab.click(".chip[data-insert='{provider}']")
    assert tab.input_value("#folder") == "x/{provider}"


def test_saved_settings_come_back_and_restore_needs_save(tab):
    settings(tab, {"base": "Saved", "folder": "F", "file": "G", "providers": {}})
    assert tab.input_value("#base") == "Saved" and tab.input_value("#file") == "G"
    tab.click("#reset")
    assert tab.input_value("#base") == "Statement Sweep" and "Press Save" in tab.inner_text("#status")
    assert tab.evaluate("__store.naming.base") == "Saved"
