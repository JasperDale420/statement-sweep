"""The popup's card offers: the offers line under a site's statements, the
link to Card Offers with where a site's offers stand, and the footer. In a
real Chromium with the extension's own files and Chrome's storage stood in
for, as test_popup.py does. Every offer and count is invented."""
import pytest
from playwright.sync_api import sync_playwright
import test_popup as base

TODAY = "2026-11-09"


def details(*offers):
    return {"at": 1, "cards": {"1111": {"label": "Card ·· 1111", "at": 1, "offers": [
        {"id": f"1111:o{i}", "merchant": f"Shop {i}", "title": "Earn 5% back", "expires": exp, "status": status, **({"on": on} if on else {})}
        for i, (status, on, exp) in enumerate(offers)]}}}


ADDED_TODAY = ("added", TODAY, None)
ADDED_BEFORE = ("added", "2026-11-01", None)
WAITING = ("waiting", None, "2026-12-01")
NEEDS = ("needs_you", None, None)
ENDED = ("waiting", None, "2026-01-01")


@pytest.fixture(scope="module")
def tab():
    with sync_playwright() as p:
        b = p.chromium.launch()
        t = b.new_page()
        t.add_init_script(base.CHROME)
        t.route(base.BASE + "**", serve)
        yield t
        b.close()


def serve(route):
    path = base.ROOT / route.request.url[len(base.BASE):].split("?")[0]
    if path.is_file():
        route.fulfill(status=200, content_type=base.TYPES.get(path.suffix, "text/plain"), body=path.read_text())
    else:
        route.fulfill(status=200, content_type="text/html", body="<!doctype html><title>x</title>")


def pill(tab, name):
    return tab.locator(f"li:has(button[aria-label='Run {name}']) a.pill")


def test_each_site_with_offers_has_a_link_saying_where_they_stand(tab):
    local = {"offersOn": ["amex", "chase"],
             "offerDetails:amex": details(ADDED_TODAY, ADDED_TODAY, ADDED_BEFORE, WAITING, WAITING, ENDED),
             "offerDetails:chase": details(NEEDS, NEEDS, WAITING)}
    base.show(tab, local=local, today=f"{TODAY}T12:00:00")
    # Only the three sites that have offers.
    assert tab.locator("a.pill").count() == 3
    amex = pill(tab, "American Express")
    # An offer past its end is not counted.
    assert amex.inner_text() == "2 offers added today · 2 waiting"
    assert amex.get_attribute("data-kind") == "on"
    assert amex.get_attribute("href") == "offers.html#amex" and amex.get_attribute("target") == "_blank"
    chase = pill(tab, "Chase")
    assert chase.inner_text() == "2 offers need you" and chase.get_attribute("data-kind") == "need"
    off = pill(tab, "Chase Business")
    assert off.inner_text() == "Turn on card offers…" and off.get_attribute("data-kind") == "off"
    assert off.get_attribute("href") == "offers.html#chasebusiness"
    assert off.get_attribute("aria-label") == "Turn on card offers, Chase Business. Opens Card Offers."


def test_the_link_counts_what_waits_or_says_it_is_on(tab):
    local = {"offersOn": ["amex", "chase", "chasebusiness"], "offerDetails:amex": details(WAITING),
             "offerDetails:chase": details(ADDED_BEFORE), "offerDetails:chasebusiness": details(NEEDS)}
    base.show(tab, local=local, today=f"{TODAY}T12:00:00")
    assert pill(tab, "American Express").inner_text() == "1 offer waiting"
    assert pill(tab, "Chase").inner_text() == "Card offers all added"
    assert pill(tab, "Chase Business").inner_text() == "1 offer needs you"


def test_the_footer_says_how_many_sites_have_offers_on(tab):
    base.show(tab, local={"offersOn": ["amex", "chase"]})
    assert tab.is_visible("#offersFoot")
    assert tab.inner_text("#offersOnCount") == "Card offers on for 2 sites"
    assert tab.get_attribute("#offersLink", "href") == "offers.html" and tab.inner_text("#offersLink") == "Card Offers"
    base.show(tab, local={"offersOn": ["amex"]})
    assert tab.inner_text("#offersOnCount") == "Card offers on for 1 site"
    base.show(tab)
    assert tab.inner_text("#offersOnCount") == "Card offers are off"
    assert pill(tab, "American Express").inner_text() == "Turn on card offers…"


def test_offers_never_change_the_header_or_the_ticks(tab):
    board = {"amex": base.st("ok", "2 new."), "chase": base.st("ok", "Nothing new.")}
    base.show(tab, board)
    plain = (tab.inner_text("#summary"), tab.get_attribute("#summary", "data-kind"), tab.locator("input[type=checkbox]:checked").count(), base.headings(tab))
    with_offers = dict(board, amex=dict(board["amex"], offers={"kind": "capped", "text": "25 offers added · 7 wait for the next sync"}),
                       chase=dict(board["chase"], offers={"kind": "stopped", "text": "Offers stopped: Chase asked you to confirm it is you. 3 added before that."}))
    base.show(tab, with_offers, local={"offersOn": ["amex", "chase"], "offerDetails:chase": details(NEEDS, NEEDS, NEEDS)})
    assert (tab.inner_text("#summary"), tab.get_attribute("#summary", "data-kind"), tab.locator("input[type=checkbox]:checked").count(), base.headings(tab)) == plain
    assert plain[0] == "2 new documents"


def test_the_offers_line_is_its_own_and_only_it_turns_orange(tab):
    board = {"chase": dict(base.st("ok", "1 new."), offers={"kind": "stopped", "text": "Offers stopped: Chase asked you to confirm it is you. 3 added before that."}),
             "amex": dict(base.st("working", "1 new."), offers={"kind": "adding", "text": "Adding offers · 4 of 10 on Card ·· 1004"}),
             "chasebusiness": dict(base.st("ok", "1 did not save and is tried again next time."), offers={"kind": "waiting", "text": "Card offers wait until every statement here has saved."})}
    base.show(tab, board)
    chase = tab.locator("li:has(button[aria-label='Run Chase']) .offers-line")
    assert chase.inner_text() == "Offers stopped: Chase asked you to confirm it is you. 3 added before that."
    assert chase.get_attribute("data-kind") == "stopped"
    # The site stays done: its statements saved.
    assert "Chase" in base.names_under(tab, "ok") and tab.locator("section[data-state=bad]").count() == 0
    assert tab.locator("li:has(button[aria-label='Run Chase']) .say").inner_text() == "1 new."
    # Orange, light-dark(#b34700, ...) in ui.css, while the statements' words stay grey.
    assert chase.evaluate("(el) => getComputedStyle(el).color") == "rgb(179, 71, 0)"
    assert tab.locator("li:has(button[aria-label='Run Chase']) .say").evaluate("(el) => getComputedStyle(el).color") != "rgb(179, 71, 0)"
    amex = tab.locator("li:has(button[aria-label='Run American Express']) .offers-line")
    assert amex.inner_text() == "Adding offers · 4 of 10 on Card ·· 1004" and amex.get_attribute("data-kind") == "adding"
    wait = tab.locator("li:has(button[aria-label='Run Chase Business']) .offers-line")
    assert wait.get_attribute("data-kind") == "waiting"
