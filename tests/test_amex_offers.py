"""The Amex offers page logic (amex.offers.js), in a real Chromium, on stand-in
pages. Every merchant, offer, card number and date is invented."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OFFERS = "https://global.americanexpress.com/offers/eligible"
STATEMENTS = "https://global.americanexpress.com/activity/statements"


def tile(merchant, words, expires="12/31/2026", control="Add to Card", extra=""):
    return (f'<div class="tile"><img alt="{merchant} logo"><h3>{merchant}</h3><p>{words}</p>'
            f'<p>Expires {expires}</p><button class="cta">{control}</button>{extra}</div>')


def switcher(on, others=()):
    opts = "".join(f'<li data-testid="simple_switcher_product_option_{i}" hidden><span data-testid="simple_switcher_display_number">-{d}</span></li>'
                   for i, d in enumerate([on, *others]))
    return (f'<div data-testid="simple_switcher_combobox"><div data-testid="simple_switcher_selected_option_display">'
            f'<span data-testid="simple_switcher_display_name">Invented Card</span>'
            f'<span data-testid="simple_switcher_display_number">-{on}</span></div></div><ul id="opts">{opts}</ul>')


# Pressing Add to Card turns it into "Added to Card" a moment later, as Amex
# does; a page may say `window.dialogOnAdd` to open a dialog instead.
SCRIPT = """<script>
window.pressed = [];
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-testid=simple_switcher_combobox]')) {
    document.querySelectorAll('#opts li').forEach((li) => { li.hidden = false; });
  }
  const el = e.target.closest('button, a, li, [role=button]');
  if (!el) return;
  if (el.tagName === 'A') e.preventDefault();
  pressed.push((el.getAttribute('aria-label') || el.textContent).trim());
  if (el.textContent.trim() === 'Add to Card') {
    if (window.dialogOnAdd) {
      const d = document.createElement('div'); d.setAttribute('role', 'dialog');
      d.innerHTML = '<p>Please review this offer.</p><button>Accept terms</button><button>Close</button>';
      d.querySelector('button:last-child').onclick = () => d.remove();
      document.body.append(d);
    } else if (!window.neverAdds) {
      setTimeout(() => { el.textContent = 'Added to Card'; }, 80);
    }
  }
  if (el.matches('#opts li') && window.cards) {
    const digits = el.textContent.replace(/\\D/g, '');
    setTimeout(() => {
      document.querySelector('[data-testid=simple_switcher_selected_option_display] [data-testid=simple_switcher_display_number]').textContent = '-' + digits;
      document.querySelectorAll('#opts li').forEach((li) => { li.hidden = true; });
      document.getElementById('list').innerHTML = window.cards[digits];
    }, 80);
  }
});
</script>"""


def page(body, cards="11111", others=()):
    return f"<header><a href='/offers'>Offers</a></header>{switcher(cards, others) if cards else ''}<main id='list'>{body}</main>{SCRIPT}"


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
    kit = (ROOT / "providers" / "offers-kit.js").read_text()
    source = (ROOT / "providers" / "amex.offers.js").read_text() \
        .replace("LIST_WAIT_MS = 12000", "LIST_WAIT_MS = 300").replace("WALK_WAIT_MS = 30000", "WALK_WAIT_MS = 300") \
        .replace("ADD_WAIT_MS = 10000", "ADD_WAIT_MS = 800").replace("CARD_WAIT_MS = 15000", "CARD_WAIT_MS = 800") \
        .replace("SWITCHER_WAIT_MS = 5000", "SWITCHER_WAIT_MS = 500")
    tab.add_script_tag(content=kit)
    tab.add_script_tag(content=source)


def read(tab, walk=True):
    return tab.evaluate("(w) => __offers.readOffers({walk: w})", walk)


def add(tab, offer):
    return tab.evaluate("(o) => __offers.addOne(o)", offer)


def test_offers_are_read_with_merchant_words_and_expiry(tab):
    load(tab, OFFERS, page(tile("Example Coffee", "Spend $20 or more, earn $5 back") + tile("Invented Books", "Earn 10% back, up to $15", "1/5/27")))
    got = read(tab)
    assert got["state"] == "ok" and got["card"] == "11111" and "more" not in got
    first, second = got["offers"]
    assert first["merchant"] == "Example Coffee" and first["title"] == "Spend $20 or more, earn $5 back"
    assert first["expires"] == "2026-12-31" and first["added"] is False and first["id"].startswith("11111:")
    assert second["expires"] == "2027-01-05"
    assert first["id"] != second["id"]


def test_ids_do_not_change_between_reads(tab):
    load(tab, OFFERS, page(tile("Example Coffee", "Spend $20, earn $5 back")))
    assert read(tab)["offers"][0]["id"] == read(tab)["offers"][0]["id"]


def test_an_offer_already_added_is_read_as_added_and_the_added_count_is_read(tab):
    body = '<nav><a href="/offers/enrolled">Added to Card (23)</a></nav>' + tile("Example Coffee", "Earn $5 back", control="Added to Card")
    load(tab, OFFERS, page(body))
    got = read(tab)
    assert [o["added"] for o in got["offers"]] == [True]
    assert got["onCards"] == 23


def test_add_presses_only_that_offers_add_to_card(tab):
    load(tab, OFFERS, page(tile("Example Coffee", "Earn $5 back") + tile("Invented Books", "Earn 10% back")))
    offer = read(tab)["offers"][1]
    assert add(tab, offer) == {"ok": True}
    assert tab.evaluate("pressed") == ["Add to Card"]
    assert tab.evaluate("document.querySelectorAll('button')[1].textContent") == "Added to Card"
    assert tab.evaluate("document.querySelectorAll('button')[0].textContent") == "Add to Card"


def test_controls_that_enrol_apply_or_buy_are_never_offers(tab):
    body = "".join(tile(f"Shop {i}", "Earn $5 back", control=c) for i, c in enumerate(
        ["Enroll", "Add to Card & Enroll", "Apply Now", "Buy Now", "Activate Card", "Upgrade", "Accept Terms", "Add Authorized User"]))
    load(tab, OFFERS, page(body))
    got = read(tab)
    assert got["state"] == "stopped" and "no offers" in got["why"]
    assert tab.evaluate("pressed") == []


def test_a_header_link_named_add_to_card_is_not_an_offer(tab):
    load(tab, OFFERS, "<header><button>Add to Card</button></header>" + page(tile("Example Coffee", "Earn $5 back")))
    assert len(read(tab)["offers"]) == 1


def test_a_dialog_after_the_press_is_closed_and_the_offer_left_for_you(tab):
    load(tab, OFFERS, page(tile("Example Coffee", "Earn $5 back")))
    tab.evaluate("window.dialogOnAdd = true")
    got = add(tab, read(tab)["offers"][0])
    assert got["ok"] is False and got["left"] is True
    assert tab.evaluate("pressed") == ["Add to Card", "Close"]
    assert tab.evaluate("document.querySelector('[role=dialog]')") is None


def test_an_offer_amex_never_marks_added_is_a_failure(tab):
    load(tab, OFFERS, page(tile("Example Coffee", "Earn $5 back")))
    tab.evaluate("window.neverAdds = true")
    got = add(tab, read(tab)["offers"][0])
    assert got == {"ok": False, "why": "Amex did not show the offer as added."}


def test_an_offer_for_another_card_is_not_pressed(tab):
    load(tab, OFFERS, page(tile("Example Coffee", "Earn $5 back")))
    offer = dict(read(tab)["offers"][0], card="22222")
    assert add(tab, offer)["ok"] is False
    assert tab.evaluate("pressed") == []


def test_an_offer_no_longer_drawn_is_not_pressed(tab):
    load(tab, OFFERS, page(tile("Example Coffee", "Earn $5 back")))
    assert add(tab, {"id": "11111:gone", "card": "11111"}) == {"ok": False, "why": "That offer is no longer on the page."}


def test_a_page_that_says_it_has_no_offers_is_empty(tab):
    load(tab, OFFERS, page("<p>There are no offers available right now. Check back soon for new offers.</p>"))
    got = read(tab)
    assert got["state"] == "ok" and got["offers"] == []


def test_sign_in_and_checks_are_known(tab):
    load(tab, OFFERS, page("<input type=password>"))
    assert read(tab) == {"state": "signed_out"}
    load(tab, OFFERS, page("<p>Enter the code we sent to your phone.</p>"))
    assert read(tab) == {"state": "challenge"}
    load(tab, "https://www.americanexpress.com/en-us/account/login", "<h1>Log in</h1>")
    assert read(tab) == {"state": "signed_out"}


def test_a_sign_out_during_an_add_is_said(tab):
    load(tab, OFFERS, page(tile("Example Coffee", "Earn $5 back")))
    offer = read(tab)["offers"][0]
    tab.evaluate("document.body.insertAdjacentHTML('beforeend', '<p>Your session has expired</p>')")
    assert add(tab, offer) == {"ok": False, "state": "signed_out"}
    assert tab.evaluate("pressed") == []


def test_from_statements_the_offers_link_is_pressed_once(tab):
    load(tab, STATEMENTS, page(""))
    assert read(tab) == {"state": "walking"}
    assert tab.evaluate("pressed") == ["Offers"]
    assert read(tab) == {"state": "walking"}
    assert tab.evaluate("pressed") == ["Offers"]


def test_a_link_to_another_host_is_not_pressed(tab):
    load(tab, STATEMENTS, "<a href='https://example.com/offers'>Offers</a>" + SCRIPT)
    assert read(tab)["state"] == "walking"
    assert tab.evaluate("pressed") == []
    tab.wait_for_timeout(350)
    got = read(tab)
    assert got["state"] == "stopped" and "Open Offers" in got["why"]


def test_without_walking_another_page_is_no_list(tab):
    load(tab, STATEMENTS, page(""))
    assert read(tab, walk=False) == {"state": "no_list"}
    assert tab.evaluate("pressed") == []


def test_the_added_list_presses_available(tab):
    load(tab, "https://global.americanexpress.com/offers/enrolled", page("<a href='/offers/eligible'>Available Offers</a>"))
    assert read(tab) == {"state": "walking"}
    assert tab.evaluate("pressed") == ["Available Offers"]


def test_a_switcher_whose_card_cannot_be_read_stops(tab):
    body = '<div data-testid="simple_switcher_combobox">Invented Card</div><main>' + tile("Example Coffee", "Earn $5 back") + "</main>" + SCRIPT
    load(tab, OFFERS, body)
    got = read(tab)
    assert got["state"] == "stopped" and "card on show" in got["why"]


def test_each_card_in_the_switcher_in_turn(tab):
    cards = {"11111": tile("Example Coffee", "Earn $5 back"), "22222": tile("Invented Books", "Earn 10% back")}
    load(tab, OFFERS, page(cards["11111"], "11111", ["22222"]))
    tab.evaluate("(c) => { window.cards = c; }", cards)
    first = read(tab)
    assert first["more"] is True and first["offers"][0]["merchant"] == "Example Coffee"
    assert tab.evaluate("__offers.nextCard()") == {"moved": True}
    second = read(tab)
    assert second["card"] == "22222" and second["offers"][0]["merchant"] == "Invented Books"
    assert second["offers"][0]["id"].startswith("22222:")
    assert tab.evaluate("__offers.nextCard()") == {"moved": False}


def test_a_check_during_an_add_presses_nothing(tab):
    load(tab, OFFERS, page(tile("Example Coffee", "Earn $5 back")))
    offer = read(tab)["offers"][0]
    tab.evaluate("document.body.insertAdjacentHTML('beforeend', '<p>Let us confirm it is you. Enter the code we sent.</p>')")
    assert add(tab, offer) == {"ok": False, "state": "challenge"}
    assert tab.evaluate("pressed") == []


def test_a_page_asking_for_a_pause_stops_the_offers_without_a_press(tab):
    load(tab, OFFERS, page(tile("Example Coffee", "Earn $5 back")))
    offer = read(tab)["offers"][0]
    tab.evaluate("document.body.insertAdjacentHTML('afterbegin', '<p>Too many requests. Try again later.</p>')")
    got = add(tab, offer)
    assert got["ok"] is False and got["stop"] is True and "pause" in got["why"]
    assert tab.evaluate("pressed") == []
