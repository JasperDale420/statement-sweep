"""capture.js, the new-tab and print ways of saving, in a real Chromium with
the extension's own module and a stand-in for Chrome's extension APIs."""
import base64
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "https://x.test/"
STORE = "https://mountain-storage.s3.amazonaws.com/"
PDF = b"%PDF-1.4 invented test document\n%%EOF"
PROVIDER = {"id": "site", "name": "Example Bank", "match": ["https://x.test/*"],
            "fileHosts": ["mountain-storage.s3.amazonaws.com"]}
DOC = {"id": "2026-09", "date": "2026-09-30", "title": "Statement"}

CHROME = """
window.__log = [];
const listeners = () => { const set = new Set(); return { set, addListener: (f) => set.add(f), removeListener: (f) => set.delete(f) }; };
const created = listeners(), updated = listeners(), detached = listeners(), targets = listeners();
window.__fire = {
  created: (tab) => created.set.forEach((f) => f(tab)),
  updated: (id, info) => updated.set.forEach((f) => f(id, info, {})),
  detached: (tabId, reason) => detached.set.forEach((f) => f({ tabId }, reason)),
  target: (d) => targets.set.forEach((f) => f(d)),
};
window.__tab = { id: 1, url: "https://x.test/list" };
window.__print = { data: null, attachError: null, cancel: false };
window.__useNav = false;
const fake = {
  tabs: {
    onCreated: created, onUpdated: updated,
    get: async (id) => (id === 1 ? { ...__tab } : { id, url: "about:blank" }),
    remove: async (id) => { __log.push(["remove", id]); },
    update: async (id, o) => { __log.push(["update", id, o.url]); },
  },
  scripting: { executeScript: async ({ target, func, args }) => { __log.push(["script", target.tabId]); return [{ result: await func(...args) }]; } },
  debugger: {
    onDetach: detached,
    attach: async (target) => { if (__print.attachError) throw new Error(__print.attachError); __log.push(["attach", target.tabId]); },
    detach: async (target) => { __log.push(["detach", target.tabId]); },
    sendCommand: async (target, method, params) => {
      __log.push(["command", method, params.printBackground]);
      if (__print.cancel) { __fire.detached(target.tabId, "canceled_by_user"); throw new Error("Detached"); }
      return { data: __print.data };
    },
  },
};
Object.defineProperty(fake, "webNavigation", { get: () => (__useNav ? { onCreatedNavigationTarget: targets } : undefined) });
Object.defineProperty(window, "chrome", { value: fake });
"""

SETUP = """async ({ ours }) => {
  const { makeCapture } = await import('/capture.js');
  const onHost = (u, p) => { try { return p.match.some((m) => new URL(m.replace('/*', '/')).hostname === new URL(u).hostname); } catch (e) { return false; } };
  window.__capture = makeCapture({
    inPage: async (tabId, provider, func, args) => { __log.push(['inPage', func.name || 'fn']); return func(...args); },
    loaded: async () => ({}),
    tabChange: (tabId, ms) => new Promise((r) => setTimeout(r, 10)),
    onHost,
    isOurs: async (id) => ours,
    waits: { open: 600, url: 400, ready: 600, settle: 0 },
  });
}"""


@pytest.fixture()
def tab():
    def serve(route):
        path = ROOT / route.request.url[len(BASE):].split("?")[0]
        if path.is_file():
            route.fulfill(status=200, content_type="text/javascript", body=path.read_text())
        else:
            route.fulfill(status=200, content_type="text/html", body="<!doctype html><title>x</title>")
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        t.hits = []

        def store(route):
            t.hits.append(route.request.url)
            body = b"<html>not a pdf</html>" if "notpdf" in route.request.url else PDF
            route.fulfill(status=200, headers={"access-control-allow-origin": "*"}, body=body)
        t.add_init_script(CHROME)
        t.route(BASE + "**", serve)
        t.route("https://*.amazonaws.com/**", store)
        t.goto(BASE)
        yield t
        b.close()


def setup(tab, recipe, ours=True):
    tab.evaluate(f"globalThis.__sweep = {recipe}")
    tab.evaluate(SETUP, {"ours": ours})


def new_tab(tab, doc=DOC):
    return tab.evaluate("(d) => __capture.newTab(1, %s, d)" % PROVIDER_JS, doc)


def print_doc(tab, doc=DOC):
    return tab.evaluate("(d) => __capture.print(1, %s, d)" % PROVIDER_JS, doc)


PROVIDER_JS = __import__("json").dumps(PROVIDER)
log = lambda tab: tab.evaluate("__log")


def opens(url, opener=1, new_id=7):
    return "{clickDoc: (d) => { setTimeout(() => __fire.created({id: %d, openerTabId: %d, pendingUrl: %r}), 50); return {ok: true}; }}" % (new_id, opener, url)


def pdf_of(got):
    assert got["ok"] is True, got
    return base64.b64decode(got["base64"])


def test_a_pdf_opened_on_a_file_host_is_fetched_and_its_tab_closed(tab):
    setup(tab, opens(STORE + "statement.pdf?X-Amz-Signature=invented"))
    assert pdf_of(new_tab(tab)) == PDF
    assert tab.hits == [STORE + "statement.pdf?X-Amz-Signature=invented"]
    assert ["remove", 7] in log(tab)


def test_a_tab_that_opens_blank_and_then_moves_to_the_pdf_is_followed(tab):
    setup(tab, "{clickDoc: () => { setTimeout(() => { __fire.created({id: 7, openerTabId: 1, pendingUrl: 'about:blank'}); "
               "setTimeout(() => __fire.updated(7, {url: '%sa.pdf'}), 50); }, 20); return {ok: true}; }}" % STORE)
    assert pdf_of(new_tab(tab)) == PDF


def test_a_blob_of_the_site_is_read_by_the_sites_own_tab(tab):
    setup(tab, "{clickDoc: () => { const u = URL.createObjectURL(new Blob(['%PDF-1.7 blob'], {type: 'application/pdf'})); "
               "setTimeout(() => __fire.created({id: 8, openerTabId: 1, pendingUrl: u}), 20); return {ok: true}; }}")
    assert pdf_of(new_tab(tab)) == b"%PDF-1.7 blob"
    assert ["script", 1] in log(tab) and ["remove", 8] in log(tab)


def test_a_host_on_neither_list_is_never_asked(tab):
    setup(tab, opens("https://someone-else.s3.amazonaws.com/statement.pdf"))
    got = new_tab(tab)
    assert got["ok"] is False and "host" in got["why"]
    assert tab.hits == [] and ["remove", 7] in log(tab)


def test_plain_http_and_a_blob_of_another_site_are_refused(tab):
    for url in ["http://mountain-storage.s3.amazonaws.com/a.pdf", "blob:https://elsewhere.test/1234"]:
        setup(tab, opens(url))
        assert new_tab(tab)["ok"] is False
    assert tab.hits == []


def test_a_file_that_is_not_a_pdf_is_refused(tab):
    setup(tab, opens(STORE + "notpdf"))
    got = new_tab(tab)
    assert got == {"ok": False, "why": "The site sent something that is not a PDF."}


def test_nothing_opening_times_out_as_a_plain_failure(tab):
    setup(tab, "{clickDoc: () => ({ok: true})}")
    got = new_tab(tab)
    assert got == {"ok": False, "why": "The site did not open the document in time."}


def test_a_tab_opened_by_another_tab_is_not_taken(tab):
    setup(tab, opens(STORE + "a.pdf", opener=2))
    assert new_tab(tab)["ok"] is False and tab.hits == []
    assert ["remove", 7] not in log(tab)


def test_two_tabs_from_one_press_are_both_closed_and_nothing_taken(tab):
    setup(tab, "{clickDoc: () => { setTimeout(() => { __fire.created({id: 7, openerTabId: 1, pendingUrl: ''}); "
               "__fire.created({id: 9, openerTabId: 1, pendingUrl: ''}); }, 20); return {ok: true}; }}")
    got = new_tab(tab)
    assert got["ok"] is False and "more than one tab" in got["why"]
    assert ["remove", 7] in log(tab) and ["remove", 9] in log(tab)


def test_this_tab_moving_to_a_file_host_is_fetched_and_sent_back(tab):
    setup(tab, "{clickDoc: () => { setTimeout(() => __fire.updated(1, {url: '%scard.pdf'}), 20); return {ok: true}; }}" % STORE)
    assert pdf_of(new_tab(tab)) == PDF
    assert ["update", 1, "https://x.test/list"] in log(tab)


def test_this_tab_moving_within_the_site_is_not_taken(tab):
    setup(tab, "{clickDoc: () => { setTimeout(() => __fire.updated(1, {url: 'https://x.test/other'}), 20); return {ok: true}; }}")
    assert new_tab(tab)["ok"] is False and not [e for e in log(tab) if e[0] == "update"]


def test_a_press_that_fails_waits_for_nothing(tab):
    setup(tab, "{clickDoc: () => ({ok: false, why: 'Its control was not there.'})}")
    assert new_tab(tab) == {"ok": False, "why": "Its control was not there."}


PRINTING = """{
  tries: 0,
  showDoc: (d) => { __log.push(['show', d.id]); return {ok: true}; },
  printReady: (d) => (++__sweep.tries < 3 ? {ready: false, why: 'Still drawing.'} : {ready: true}),
  leaveDoc: (d) => { __log.push(['leave', d.id]); return {ok: true}; },
}"""


def test_a_page_is_printed_once_ready_with_the_debugger_attached_only_meanwhile(tab):
    setup(tab, PRINTING)
    tab.evaluate("__print.data = %r" % base64.b64encode(PDF).decode())
    assert pdf_of(print_doc(tab)) == PDF
    steps = [e for e in log(tab) if e[0] in ("show", "attach", "command", "detach", "leave")]
    assert steps == [["show", "2026-09"], ["attach", 1], ["command", "Page.printToPDF", True], ["detach", 1], ["leave", "2026-09"]]
    assert tab.evaluate("__sweep.tries") == 3


def test_a_tab_the_sweep_did_not_open_is_never_printed(tab):
    setup(tab, PRINTING, ours=False)
    got = print_doc(tab)
    assert got["ok"] is False and "tab it opened itself" in got["why"]
    assert not [e for e in log(tab) if e[0] in ("show", "attach")]


def test_cancelling_the_debugging_bar_stops_the_site(tab):
    setup(tab, PRINTING)
    tab.evaluate("__print.cancel = true")
    got = print_doc(tab)
    assert got["ok"] is False and got["stop"] is True and "debugging bar" in got["why"]
    assert ["detach", 1] not in log(tab) and ["leave", "2026-09"] in log(tab)


def test_a_page_that_is_not_the_document_is_not_printed(tab):
    setup(tab, "{showDoc: () => ({ok: true}), printReady: () => ({ok: false, why: 'This is another month.'})}")
    assert print_doc(tab) == {"ok": False, "why": "This is another month."}
    assert not [e for e in log(tab) if e[0] == "attach"]


def test_a_page_that_never_gets_ready_times_out(tab):
    setup(tab, "{showDoc: () => ({ok: true}), printReady: () => ({ready: false, why: 'Still drawing.'})}")
    assert print_doc(tab) == {"ok": False, "why": "Still drawing."}


def test_devtools_already_attached_is_said(tab):
    setup(tab, PRINTING)
    tab.evaluate("__print.attachError = 'Another debugger is already attached to the tab with id: 1.'")
    got = print_doc(tab)
    assert got["ok"] is False and "DevTools" in got["why"]


def test_a_print_that_is_not_a_pdf_is_refused_and_detached(tab):
    setup(tab, PRINTING)
    tab.evaluate("__print.data = btoa('<html>')")
    assert print_doc(tab) == {"ok": False, "why": "Chrome's print did not make a PDF."}
    assert ["detach", 1] in log(tab)


def test_a_tab_that_left_the_site_is_not_printed(tab):
    setup(tab, PRINTING)
    tab.evaluate("__tab.url = 'https://elsewhere.test/'")
    got = print_doc(tab)
    assert got["ok"] is False and "left" in got["why"]
    assert not [e for e in log(tab) if e[0] == "attach"]


def test_with_webnavigation_the_tab_is_known_by_its_source_not_its_opener(tab):
    # Chrome names the tab in front as the opener of a tab a background tab opened.
    tab.evaluate("__useNav = true")
    setup(tab, "{clickDoc: () => { setTimeout(() => { __fire.created({id: 7, openerTabId: 5, pendingUrl: ''}); "
               "__fire.target({sourceTabId: 1, tabId: 7, url: '%sa.pdf'}); }, 20); return {ok: true}; }}" % STORE)
    assert pdf_of(new_tab(tab)) == PDF and ["remove", 7] in log(tab)


def test_with_webnavigation_a_tab_another_tab_opened_is_left_alone(tab):
    tab.evaluate("__useNav = true")
    setup(tab, "{clickDoc: () => { setTimeout(() => { __fire.created({id: 7, openerTabId: 1, pendingUrl: '%sa.pdf'}); "
               "__fire.target({sourceTabId: 4, tabId: 7, url: '%sa.pdf'}); }, 20); return {ok: true}; }}" % (STORE, STORE))
    assert new_tab(tab)["ok"] is False and tab.hits == [] and ["remove", 7] not in log(tab)
