"""The NetBenefits page logic, in a real Chromium, on stand-in pages.

The stand-in site answers the way PaperPull's tests say NetBenefits does: a
token call, a statement POST that answers a statement page or an error
page, a Choose a Plan page, plans chosen by asking for their own address,
and a Statements page that shows the plan the site remembers. Every
request is written down, so a test can say what was never asked as well as
what was. All names and numbers are invented."""
import hashlib
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WPS = "https://workplaceservices.fidelity.com"
NB = "https://nb.fidelity.com"
STATEMENTS = "/mybenefits/savings2/navigation/dc/OnlineStatement"
CHOOSER = "/mybenefits/definedcontributions/navigation/dc/OnlineStatement?planChooser=yes"
TOKEN = "/mybenefits/employerservices/api/txntoken"
MAKE = "/mybenefits/savings2/sod/soddetail"
LINK = "/mybenefits/DefinedContributions/navigation/dc/OnlineStatement?plan=%s&"
FIRST = 2025   # the stand-in plans' statements start in 2025


def quarters(today=None):
    today = today or date.today()
    out, y, q = [], today.year, (today.month - 1) // 3 + 1
    while y >= 2016:
        start = date(y, 3 * q - 2, 1)
        end = date(y + (q == 4), (3 * q) % 12 + 1, 1) - timedelta(days=1)
        if end < today:
            out.append((start.isoformat(), end.isoformat()))
        q -= 1
        if q == 0:
            y, q = y - 1, 4
    return out


def mdy(iso):
    y, m, d = iso.split("-")
    return f"{m}/{d}/{y}"


WANTED = [(s, e) for s, e in quarters() if int(s[:4]) >= FIRST]


def digest(number):
    return hashlib.sha256(f"plan:{number}".encode()).hexdigest()


def doc_for(i, **more):
    s, e = WANTED[i]
    return {"id": f"Statement:{e}:Quarterly Statement", "date": e, "start": s, "method": "print", **more}


class Site:
    """Plans by number: heading, employer, and what its statements say."""

    def __init__(self, plans=None, links=None, remembered=None):
        self.plans = plans or {}
        self.links = links            # Choose a Plan links, (text, href), or None for no page
        self.remembered = remembered  # the plan the Statements page shows
        self.asked = []
        self.posts = []
        self.period = None            # a statement that answers another period
        self.signed_out = False

    def statements_page(self):
        if self.remembered is None:
            return "<h1>Statements</h1><form name=frmRequest></form>"
        p = self.plans[self.remembered]
        return (f"<div id=client-name>{p['employer']}</div><h2>{p['heading']} ({self.remembered})</h2>"
                "<form name=frmRequest></form>")

    def statement(self, rng):
        start, end = rng.split("-")
        if int(start[-4:]) < FIRST:
            return "<title>NetBenefits Online Statement error page</title><p>No statement.</p>"
        names = self.plans[self.remembered]["says"] if self.remembered else ""
        period = self.period or f"{start} to {end}"
        cell = "" if self.remembered else '<table><tr><td class="Header">SOMECO RETIREMENT SAVINGS<BR>PLAN</td></tr></table>'
        return (f"<title>NetBenefits Statement Details</title>{cell}<p>{names}</p>"
                f"<p>Statement Period: {period}</p><img src='/logo.png'>"
                "<button class=no-print onclick='window.print()'>Download or Print This Statement</button>")

    def route(self, r):
        url = r.request.url
        parts = urlsplit(url)
        if parts.path == "/favicon.ico":
            return r.abort()
        self.asked.append((r.request.method, url))
        path = parts.path + (f"?{parts.query}" if parts.query else "")
        if not url.startswith(WPS + "/"):
            return r.abort()
        if self.signed_out and parts.path != STATEMENTS:
            return self.html(r, "<input type=password>")
        if parts.path == TOKEN:
            return r.fulfill(status=200, content_type="application/json", body='{"txnTokenValue":"tok-123","success":true}')
        if parts.path == MAKE and r.request.method == "POST":
            body = parse_qs(r.request.post_data or "", keep_blank_values=True)
            self.posts.append((self.remembered, body))
            return self.html(r, self.statement(body["dateRange"][0]))
        if path == CHOOSER:
            if self.links is None:
                return r.fulfill(status=404, content_type="text/html", body="<p>Not found</p>")
            items = "".join(f'<a href="{h}">{t}</a>' for t, h in self.links)
            return self.html(r, f"<h1>Choose a Plan</h1>{items}")
        if parts.path.lower() == "/mybenefits/definedcontributions/navigation/dc/onlinestatement":
            number = parse_qs(parts.query).get("plan", [""])[0]
            if not self.plans.get(number, {}).get("sticky"):
                self.remembered = number
            return self.html(r, "<p>Select a plan</p>")
        if parts.path == STATEMENTS:
            return self.html(r, self.statements_page())
        if parts.path == "/logo.png":
            return r.fulfill(status=200, content_type="image/png", body=b"\x89PNG\r\n\x1a\n")
        return self.html(r, "<h1>Home</h1>")

    @staticmethod
    def html(r, body):
        r.fulfill(status=200, content_type="text/html", body=f"<!doctype html><body>{body}</body>")


class Plain(Site):
    """One fixed page wherever the tab goes."""

    def __init__(self, body):
        super().__init__()
        self.body = body

    def route(self, r):
        self.asked.append((r.request.method, r.request.url))
        self.html(r, self.body)


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture
def tab(browser):
    context = browser.new_context()
    t = context.new_page()
    yield t
    context.close()


def recipe(tab):
    tab.wait_for_load_state("load")
    tab.add_script_tag(content=(ROOT / "providers" / "netbenefits.page.js").read_text())


def serve(tab, site, url=WPS + STATEMENTS):
    tab.unroute("**/*")
    tab.route("**/*", site.route)
    tab.goto(url)
    recipe(tab)
    return site


def read(tab, walk=True):
    return tab.evaluate("(w) => __sweep.readList({walk: w})", walk)


def walk_to(tab):
    """The read that chooses a plan answers walking and loads the Statements address."""
    with tab.expect_navigation():
        assert read(tab) == {"state": "walking"}
    recipe(tab)


def show(tab, doc):
    with tab.expect_navigation():
        assert tab.evaluate("(d) => __sweep.showDoc(d)", doc) == {"ok": True}
    recipe(tab)


def ready(tab, doc):
    return tab.evaluate("(d) => __sweep.printReady(d)", doc)


# -- where the tab is ----------------------------------------------------------

def test_a_sign_in_page_is_known(tab):
    serve(tab, Plain("<input type=password>"), NB + "/public/nb/default/login")
    assert read(tab) == {"state": "signed_out"}


def test_a_security_check_is_known(tab):
    serve(tab, Plain("<p>Verify your identity</p>"))
    assert read(tab) == {"state": "challenge"}


def test_throttling_stops(tab):
    serve(tab, Plain("<p>Too many requests</p>"))
    assert read(tab)["state"] == "stopped"


def test_the_sign_in_site_when_signed_in_is_not_the_list(tab):
    serve(tab, Plain("<h1>Home</h1>"), NB + "/public/nb/default/home")
    assert read(tab) == {"state": "no_list"}


def test_a_tab_of_yours_is_never_asked_for_a_statement(tab):
    site = serve(tab, Site(links=[("SOMECO PLAN", LINK % "111")]))
    got = read(tab, walk=False)
    assert got["state"] == "stopped" and got["docs"] == [] and "tab it opened" in got["why"]
    assert site.asked == [("GET", WPS + STATEMENTS)]


def test_it_offers_print_and_nothing_else(tab):
    serve(tab, Plain("<h1>Statements</h1>"))
    assert sorted(tab.evaluate("Object.keys(__sweep)")) == ["leaveDoc", "nextView", "printReady", "readList", "showDoc"]


# -- a sign-in with one plan ---------------------------------------------------

def test_one_plan_lists_each_finished_quarter_it_makes_newest_first(tab):
    site = serve(tab, Site(links=[("SOMECO PLAN", LINK % "111")]))
    got = read(tab)
    assert got == {"state": "ok", "docs": [
        doc_for(i, title="Quarterly Statement - Someco Retirement Savings Plan") for i in range(len(WANTED))]}
    # One request per quarter, stopping at the first refused after a statement.
    assert len(site.posts) == len(WANTED) + 1
    assert site.posts[0][1] == {"txntoken": ["tok-123"], "sodReqIndicator": ["HACK"],
                                "dateRange": [f"{mdy(WANTED[0][0])}-{mdy(WANTED[0][1])}"],
                                "ytdDateRange": [""], "sodPreview": ["N"], "consentReq": ["N"]}
    # Nothing but the page, the plan list, the token and the statement request.
    assert {u for _, u in site.asked} <= {WPS + STATEMENTS, WPS + CHOOSER, WPS + TOKEN, WPS + MAKE}
    assert tab.url == WPS + STATEMENTS


def test_no_choose_a_plan_page_is_one_plan_too(tab):
    serve(tab, Site(links=None))
    got = read(tab)
    assert got["state"] == "ok" and len(got["docs"]) == len(WANTED)


def test_a_statement_for_another_period_than_asked_stops_the_list(tab):
    site = Site(links=None)
    site.period = "01/01/2020 to 03/31/2020"
    serve(tab, site)
    got = read(tab)
    assert got["state"] == "stopped" and "another quarter" in got["why"]


def test_a_signed_out_session_stops_and_says_so(tab):
    site = serve(tab, Site(links=None))
    site.signed_out = True
    got = read(tab)
    assert got["state"] == "stopped" and "Sign in again" in got["why"]
    assert site.posts == []


def test_one_statement_is_posted_into_this_tab_printed_and_left(tab):
    site = serve(tab, Site(links=None))
    doc = read(tab)["docs"][1]
    site.posts.clear()
    show(tab, doc)
    assert urlsplit(tab.url).path == MAKE
    assert len(site.posts) == 1
    assert site.posts[0][1]["dateRange"] == [f"{mdy(doc['start'])}-{mdy(doc['date'])}"]
    assert site.posts[0][1]["txntoken"] == ["tok-123"]
    assert ready(tab, doc) == {"ready": True}
    # Asked for this quarter, so another quarter's doc is refused on it.
    assert ready(tab, doc_for(0))["ok"] is False
    with tab.expect_navigation():
        assert tab.evaluate("(d) => __sweep.leaveDoc(d)", doc) == {"ok": True}
    assert tab.url == WPS + STATEMENTS
    recipe(tab)
    assert tab.evaluate("(d) => __sweep.leaveDoc(d)", doc) == {"ok": True, "stayed": True}


def test_print_ready_waits_on_the_statements_page_and_refuses_a_page_not_asked_for(tab):
    site = serve(tab, Site(links=None))
    assert ready(tab, doc_for(0))["ready"] is False
    serve(tab, site, WPS + MAKE)   # the statement address, not asked for by this
    assert ready(tab, doc_for(0)) == {"ok": False, "why": "The statement on screen is not the one this asked for."}


def test_print_ready_refuses_another_period_and_the_error_page(tab):
    site = serve(tab, Site(links=None))
    site.period = "01/01/2020 to 03/31/2020"
    show(tab, doc_for(0))
    got = ready(tab, doc_for(0))
    assert got["ok"] is False and "another quarter" in got["why"]
    serve(tab, site)
    old = {"id": "Statement:2024-12-31:Quarterly Statement", "date": "2024-12-31", "start": "2024-10-01", "method": "print"}
    show(tab, old)
    assert ready(tab, old) == {"ok": False, "why": "NetBenefits made no statement for this quarter."}


def test_show_doc_refuses_what_it_did_not_list(tab):
    site = serve(tab, Site(links=None))
    e = WANTED[0][1]
    for doc in ({"id": "Statement:2026-02-15:Quarterly Statement", "date": "2026-02-15"},
                {"id": "x", "date": e},
                {"id": f"Statement:{e}:Quarterly Statement", "date": e, "start": "2026-01-15"},
                {"id": "Statement:2099-12-31:Quarterly Statement", "date": "2099-12-31"},
                {"id": f"Statement:{digest('1')}:{e}:Quarterly Statement", "date": e, "plan": digest("1")}):
        assert tab.evaluate("(d) => __sweep.showDoc(d)", doc)["ok"] is False
    assert site.posts == []


# -- a sign-in with several plans ------------------------------------------------

PLANS = {
    "41403": {"heading": "ABC 403(B) PLAN", "employer": "ABC COLLEGE", "says": "ABC 403(B) | ABC 457(B) | ABC COLLEGE"},
    "41457": {"heading": "ABC 457(B) PLAN", "employer": "ABC COLLEGE", "says": "ABC 403(B) | ABC 457(B) | ABC COLLEGE"},
    "52401": {"heading": "NORTH-STAR MEDICAL GROUP", "employer": "NORTH-STAR", "says": "NORTH-STAR MEDICAL GROUP"},
}
LINKS = [("ABC 403(B) PLAN", LINK % "41403"), ("ABC 457(B) PLAN", LINK % "41457"),
         ("NORTH-STAR MEDICAL GROUP", LINK % "52401")]


def test_each_plan_is_a_view_known_by_its_digest_and_a_combined_statement_is_listed_once(tab):
    site = serve(tab, Site(plans=PLANS, links=LINKS, remembered="52401"))
    views = []
    for i in range(3):
        walk_to(tab)
        views.append(read(tab))
        if i < 2:
            assert tab.evaluate("__sweep.nextView()") == {"moved": True}
    assert tab.evaluate("__sweep.nextView()") == {"moved": False}
    first, second, third = views
    s, e = WANTED[0]
    assert first["more"] is True and len(first["docs"]) == len(WANTED)
    assert first["docs"][0] == {"id": f"Statement:{digest('41403')}:{e}:Quarterly Statement", "date": e,
                                "start": s, "title": "Quarterly Statement - ABC College Plans",
                                "method": "print", "plan": digest("41403")}
    # The 457(b)'s request gives the very same combined statement: listed once.
    assert second["docs"] == [] and "combined statement" in second["note"]
    assert [d["title"] for d in third["docs"]] == ["Quarterly Statement - North-Star Medical Group"] * len(WANTED)
    # No plan number in any id, title or note.
    for v in views:
        for text in [v.get("note", "")] + [d["id"] + d["title"] for d in v["docs"]]:
            assert not any(n in text for n in PLANS)
    # Each plan's statements were made while the site had that plan chosen.
    assert {plan for plan, _ in site.posts} == set(PLANS)


def test_a_plan_statement_is_made_only_while_the_page_shows_that_plan(tab):
    site = serve(tab, Site(plans=PLANS, links=LINKS, remembered="52401"))
    walk_to(tab)
    doc = read(tab)["docs"][0]
    site.posts.clear()
    show(tab, doc)
    assert ready(tab, doc) == {"ready": True}
    with tab.expect_navigation():
        tab.evaluate("(d) => __sweep.leaveDoc(d)", doc)
    # The site now remembers another plan.
    site.remembered = "52401"
    tab.reload()
    recipe(tab)
    got = tab.evaluate("(d) => __sweep.showDoc(d)", doc)
    assert got["ok"] is False and "not showing ABC 403(b) Plan" in got["why"]
    assert len(site.posts) == 1


def test_a_statement_that_does_not_name_its_plan_is_not_printed(tab):
    site = serve(tab, Site(plans=PLANS, links=LINKS, remembered="52401"))
    walk_to(tab)
    doc = read(tab)["docs"][0]
    site.plans = {**PLANS, "41403": {**PLANS["41403"], "says": "SOME OTHER PLAN"}}
    show(tab, doc)
    assert ready(tab, doc) == {"ok": False, "why": "The statement on screen does not name its plan, so it was not saved."}


def test_a_plan_that_will_not_open_is_left_for_you(tab):
    plans = {**PLANS, "41403": {**PLANS["41403"], "sticky": True}}
    site = serve(tab, Site(plans=plans, links=LINKS, remembered="52401"))
    walk_to(tab)
    got = read(tab)
    assert got["docs"] == [] and got["more"] is True
    assert got["note"] == "ABC 403(b) Plan was not swept: its Statements page did not open. Open it in NetBenefits yourself."
    assert site.posts == []


def test_a_plan_link_off_the_statements_page_is_never_asked(tab):
    links = [("ABC 403(B) PLAN", LINK % "41403"), ("RETAIL PLAN", "https://digital.fidelity.com/plan?plan=9"),
             ("ABC 457(B) PLAN", LINK % "41457")]
    site = serve(tab, Site(plans=PLANS, links=links, remembered="52401"))
    walk_to(tab)
    read(tab)
    assert tab.evaluate("__sweep.nextView()") == {"moved": True}
    got = read(tab)
    assert got["docs"] == [] and "leaves the NetBenefits statements page" in got["note"]
    assert not any("digital.fidelity.com" in u for _, u in site.asked)


def test_a_choose_a_plan_page_that_cannot_be_told_stops(tab):
    site = serve(tab, Site(links=[("SOMECO PLAN", LINK % "111"), ("ODD", "/elsewhere?plan=2")]))
    got = read(tab)
    assert got["state"] == "stopped" and "cannot tell how many plans" in got["why"]
    assert site.posts == []
