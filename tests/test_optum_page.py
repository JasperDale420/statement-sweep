"""The Optum Bank page logic, in a real Chromium, on stand-in pages."""
import base64
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOST = "https://account.optumbank.com"
FORMS = "/account/help/forms"
PID = "12345678"
LATEST = f'<a href="/account/products/{PID}/statements/900001.pdf">Download latest statement</a>'


def link(date, i="900001", pid=PID):
    return f'<a href="/account/products/{pid}/statements/{i}.pdf">{date}</a>'


TAX = f'<a href="/account/products/{PID}/tax_documents/777.pdf">Rendered EOY 5498-SA Notices-2025</a>'


def options(*pairs):
    inner = "".join(f'<option value="{v}">{t}</option>' for t, v in pairs)
    return f'<select name="document_id"><option value="">Select a statement</option>{inner}</select>'


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, path, body, products=None, pdf=None):
    """products: {pid: html or a route.fulfill dict}. pdf: a route.fulfill dict for documents."""
    asked = []

    def route(r):
        url = r.request.url
        rel = url.split("account.optumbank.com", 1)[-1]
        if rel.endswith("/statements") and products is not None:
            asked.append(rel)
            answer = products[rel.split("/")[3]]
            if isinstance(answer, dict):
                r.fulfill(**answer)
            else:
                r.fulfill(status=200, content_type="text/html", body=f"<!doctype html><body>{answer}</body>")
        elif rel.endswith(".pdf") and pdf:
            asked.append(rel)
            r.fulfill(**pdf)
        else:
            r.fulfill(status=200, content_type="text/html", body=f"<!doctype html><body>{body}</body>")

    tab.unroute("**/*")
    tab.route("**/*", route)
    tab.goto(path if path.startswith("http") else HOST + path)
    tab.add_script_tag(content=(ROOT / "providers" / "shared.js").read_text())
    tab.add_script_tag(content=(ROOT / "providers" / "optum.page.js").read_text())
    return asked


def read(tab):
    return tab.evaluate("__sweep.readList()")


@pytest.mark.parametrize("path,body", [
    ("/login", "<p>sign in</p>"), (FORMS, "<input type=password>"), ("https://www.optumbank.com/", "<p>Welcome</p>")])
def test_a_sign_in_is_known(tab, path, body):
    load(tab, path, body)
    assert read(tab) == {"state": "signed_out"}


@pytest.mark.parametrize("words", ["Enter the code", "Check your phone", "Your session has expired"])
def test_a_security_check_is_known(tab, words):
    load(tab, FORMS, f"<p>{words}</p>")
    assert read(tab) == {"state": "challenge"}


def test_throttling_stops(tab):
    load(tab, FORMS, "<p>Too many requests</p>")
    assert read(tab)["state"] == "stopped"


def test_another_page_is_not_the_list(tab):
    load(tab, "/account/overview", LATEST)
    assert read(tab) == {"state": "no_list"}


def test_a_good_list_reads_links_options_and_tax_forms_newest_first(tab):
    page = (link("2026-08-31") + link("2026-07-31", "900002") + TAX
            + options(("2026-08-31", f"/account/products/{PID}/statements/900001.pdf"),
                      ("2026-06-30", f"/account/products/{PID}/statements/900003.pdf")))
    asked = load(tab, FORMS, LATEST, products={PID: page})
    got = read(tab)
    assert got["state"] == "ok"
    assert [(d["id"], d["date"], d["title"]) for d in got["docs"]] == [
        (f"{PID}-statements-900001", "2026-08-31", "HSA Statement"),
        (f"{PID}-statements-900002", "2026-07-31", "HSA Statement"),
        (f"{PID}-statements-900003", "2026-06-30", "HSA Statement"),
        (f"{PID}-tax_documents-777", "2025-12-31", "Rendered EOY 5498-SA Notices-2025"),
    ]
    assert asked == [f"/account/products/{PID}/statements"]
    assert got["docs"][0]["url"] == f"/account/products/{PID}/statements/900001.pdf"


def test_a_tax_form_takes_the_last_year_its_title_names(tab):
    load(tab, FORMS, LATEST, products={PID: f'<a href="/account/products/{PID}/tax_documents/1.pdf">2019 and 2020 forms</a>'})
    assert read(tab)["docs"][0]["date"] == "2020-12-31"


def test_the_forms_page_drawn_late_is_waited_for(tab):
    late = f"<script>setTimeout(() => {{ document.body.innerHTML = '{LATEST}'; }}, 400)</script>"
    load(tab, FORMS, late, products={PID: link("2026-08-31")})
    assert read(tab)["state"] == "ok"


def test_a_menu_link_to_a_product_overview_names_no_product(tab):
    menu = f'<a href="/account/products/{PID}">Overview</a><a href="/account/products/{PID}/statements">Statements</a>'
    asked = load(tab, FORMS, menu, products={PID: link("2026-08-31")})
    assert read(tab)["state"] == "ok" and asked == [f"/account/products/{PID}/statements"]


def test_two_products_are_both_read(tab):
    body = LATEST + '<a href="/account/products/999/statements">Other</a>'
    load(tab, FORMS, body, products={PID: link("2026-08-31"), "999": link("2026-09-30", "5", "999")})
    assert [d["id"] for d in read(tab)["docs"]] == ["999-statements-5", f"{PID}-statements-900001"]


@pytest.mark.parametrize("page", [
    link("2026-02-30"),                                         # not a calendar date
    link("Aug 31, 2026"),                                       # not the shape the site uses
    link("2026-08-31") + link("2026-08-31", "900009"),          # two statements, one date
    link("2026-08-31", pid="999"),                              # another product's document
    f'<a href="https://evil.test/account/products/{PID}/statements/1.pdf">2026-08-31</a>',
    options(("2026-05-31", "https://evil.test/x.pdf")),         # an option that is not a path
    options(("2026-05-31", "")),                                # a dated option with no path
    f'<a href="/account/products/{PID}/tax_documents/2.pdf">Form with no year</a>',
    "<p>Nothing here</p>",                                      # says nothing
])
def test_a_page_this_cannot_read_stops(tab, page):
    load(tab, FORMS, LATEST, products={PID: page})
    assert read(tab)["state"] == "stopped"


def test_what_was_read_before_a_stop_is_kept(tab):
    body = LATEST + '<a href="/account/products/999/statements">Other</a>'
    load(tab, FORMS, body, products={PID: link("2026-08-31"), "999": link("2026-02-30", "5", "999")})
    got = read(tab)
    assert got["state"] == "stopped" and [d["date"] for d in got["docs"]] == ["2026-08-31"]


def test_no_product_links_stops(tab):
    # The real wait is fifteen seconds. The page is read as it stands first.
    load(tab, FORMS, "<p>Forms</p>")
    tab.evaluate("(() => { const n = Date.now; const t0 = n(); Date.now = () => t0 + (n() - t0) * 1000; })()")
    assert read(tab)["state"] == "stopped"


def test_a_page_that_says_it_has_none_is_empty(tab):
    load(tab, FORMS, LATEST, products={PID: "<p>You have no statements yet.</p>"})
    assert read(tab) == {"state": "ok", "docs": []}


def test_help_text_is_not_saying_there_are_none(tab):
    load(tab, FORMS, LATEST, products={PID: "<p>if there are no statements, wait.</p>"})
    assert read(tab)["state"] == "stopped"


@pytest.mark.parametrize("answer", [dict(status=401, body=""), dict(status=200, content_type="text/html", body="<input type=password>")])
def test_a_signed_out_answer_on_a_product_is_a_sign_in(tab, answer):
    load(tab, FORMS, LATEST, products={PID: answer})
    assert read(tab) == {"state": "signed_out"}


def test_a_server_error_stops(tab):
    load(tab, FORMS, LATEST, products={PID: dict(status=500, body="")})
    assert read(tab)["state"] == "stopped"


DOC = f"{{url: '/account/products/{PID}/statements/900001.pdf'}}"


def test_an_official_pdf_comes_back_whole(tab):
    data = b"%PDF-1.7 " + bytes(range(256)) * 400
    load(tab, FORMS, LATEST, pdf=dict(status=200, content_type="application/pdf", body=data))
    got = tab.evaluate(f"__sweep.fetchPdf({DOC})")
    assert got["ok"] and base64.b64decode(got["base64"]) == data


def test_html_labelled_as_a_statement_is_not_kept(tab):
    load(tab, FORMS, LATEST, pdf=dict(status=200, content_type="application/pdf", body=b"<html>sign in</html>"))
    assert tab.evaluate(f"__sweep.fetchPdf({DOC})")["ok"] is False


def test_a_redirect_on_download_reads_as_signed_out(tab):
    load(tab, FORMS, LATEST, pdf=dict(status=302, headers={"Location": "/login"}, body=""))
    got = tab.evaluate(f"__sweep.fetchPdf({DOC})")
    assert got["ok"] is False and got["signedOut"] is True


@pytest.mark.parametrize("url", ["/account/help/forms", "https://evil.test/a/1.pdf",
                                 "/account/products/1/statements/1.pdf?x=1", "/../x.pdf", ""])
def test_a_bad_address_is_refused_unasked(tab, url):
    asked = load(tab, FORMS, LATEST, pdf=dict(status=200, content_type="application/pdf", body=b"%PDF-1"))
    assert tab.evaluate("(u) => __sweep.fetchPdf({url: u})", url)["ok"] is False and asked == []
