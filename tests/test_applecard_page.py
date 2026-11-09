"""The Apple Card page logic, in a real Chromium, on stand-in pages that keep
the recorded button shape. Every month is invented."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HOME = "https://card.apple.com/"
NAV = '<nav><a href="#">Statements</a><a href="#">Savings</a></nav>'


def button(month, year, id_=""):
    return (f'<ui-button role="button" tabindex="0" id="{id_}" style="display:inline-block" '
            f'aria-label="Download statement of {month} {year} (PDF)"><svg width="16" height="16"></svg></ui-button>')


def row(month, year, id_=""):
    return f"<li><div>{month}</div>{button(month, year, id_)}</li>"


def page(rows, nav=NAV, extra=""):
    return f"{nav}<main><h2>Statements</h2>{extra}<ul>{rows}</ul></main>" + """<script>
    window.pressed = [];
    document.addEventListener('click', (e) => { const b = e.target.closest('ui-button'); if (b) pressed.push(b.id); });
    </script>"""


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        yield t
        b.close()


def load(tab, url, body):
    tab.goto("about:blank")
    tab.unroute("**/*")
    tab.route("**/*", lambda route: route.fulfill(status=200, content_type="text/html", body=f"<!doctype html>{body}"))
    tab.goto(url)
    source = (ROOT / "providers" / "applecard.page.js").read_text().replace("DRAW_WAIT_MS = 30000", "DRAW_WAIT_MS = 300")
    tab.add_script_tag(content=source)


def read(tab):
    return tab.evaluate("__sweep.readList()")


def test_a_sign_in_address_is_known(tab):
    load(tab, "https://card.apple.com/signin", "<p>x</p>")
    assert read(tab) == {"state": "signed_out"}


def test_a_password_field_is_known(tab):
    load(tab, HOME, "<input type=password>")
    assert read(tab) == {"state": "signed_out"}


def test_a_sign_in_frame_with_nothing_else_is_known(tab):
    load(tab, HOME, '<iframe src="https://idmsa.apple.com/appleauth" width=100 height=100></iframe>')
    assert read(tab) == {"state": "signed_out"}


def test_a_frame_on_a_signed_in_page_is_nothing(tab):
    load(tab, HOME, page(row("March", 2031), extra='<iframe src="https://idmsa.apple.com/x" width=10 height=10></iframe>'))
    assert read(tab)["state"] == "ok"


def test_a_security_check_is_known(tab):
    load(tab, HOME, "<p>Enter the code sent to your trusted device.</p>")
    assert read(tab) == {"state": "challenge"}


def test_good_rows_are_dated_at_month_end_newest_first(tab):
    load(tab, HOME, page(row("February", 2028) + row("March", 2028) + row("January", 2028)))
    assert read(tab) == {"state": "ok", "docs": [
        {"id": "card:2028-03-31", "date": "2028-03-31", "method": "click"},
        {"id": "card:2028-02-29", "date": "2028-02-29", "method": "click"},
        {"id": "card:2028-01-31", "date": "2028-01-31", "method": "click"}]}


def test_a_control_of_another_shape_is_not_a_document(tab):
    load(tab, HOME, page(row("March", 2031) + '<button aria-label="Download PDF">x</button><a href="#">Export Transactions</a>'))
    assert [d["id"] for d in read(tab)["docs"]] == ["card:2031-03-31"]


def test_the_front_page_with_no_list_says_how_to_go_on(tab):
    load(tab, HOME, NAV + "<main><h1>Apple Card</h1></main>")
    got = read(tab)
    assert got["state"] == "stopped" and "Statements" in got["why"]


def test_a_page_that_never_draws_stops(tab):
    load(tab, HOME, "<main></main>")
    assert read(tab)["state"] == "stopped"


def test_a_savings_address_stops(tab):
    load(tab, "https://card.apple.com/savings", page(row("March", 2031)))
    got = read(tab)
    assert got["state"] == "stopped" and "Savings" in got["why"]


def test_a_savings_heading_stops(tab):
    load(tab, HOME, page(row("March", 2031)).replace("<h2>Statements</h2>", "<h2>Savings</h2>"))
    assert read(tab)["state"] == "stopped"


def test_the_savings_lists_link_back_stops(tab):
    load(tab, HOME, page(row("March", 2031), extra='<a href="#" aria-current="page">Documents</a>'))
    assert read(tab)["state"] == "stopped"


def test_a_row_that_says_tax_stops(tab):
    load(tab, HOME, page("<li>1099-INT 2030 " + button("March", 2030) + "</li>"))
    assert read(tab)["state"] == "stopped"


def test_two_buttons_for_one_month_stop_and_neither_is_listed(tab):
    load(tab, HOME, page(row("March", 2031) + row("March", 2031) + row("April", 2031)))
    got = read(tab)
    assert got["state"] == "stopped" and [d["id"] for d in got["docs"]] == ["card:2031-04-30"]


def test_the_press_lands_on_its_own_month(tab):
    load(tab, HOME, page(row("March", 2031, "m") + row("April", 2031, "a")))
    assert tab.evaluate("__sweep.clickDoc({id: 'card:2031-03-31'})") == {"ok": True}
    assert tab.evaluate("pressed") == ["m"]


def test_a_doubled_month_is_not_pressed(tab):
    load(tab, HOME, page(row("March", 2031, "a") + row("March", 2031, "b")))
    assert tab.evaluate("__sweep.clickDoc({id: 'card:2031-03-31'})")["ok"] is False
    assert tab.evaluate("pressed") == []


def test_a_bad_id_is_refused(tab):
    load(tab, HOME, page(row("March", 2031)))
    assert tab.evaluate("__sweep.clickDoc({id: 'savings:2031-03-31'})")["ok"] is False
