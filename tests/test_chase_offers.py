"""The Chase Offers page logic (chase.offers.js), in a real Chromium, on
stand-in pages. Every merchant, offer, card and number is invented."""
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HUB = "https://secure.chase.com/web/auth/dashboard#/dashboard/merchantOffers/offer-hub?accountId=900000001234"
DASH = "https://secure.chase.com/web/auth/dashboard#/dashboard/overview"
PERSONAL = "SAPPHIRE PREFERRED (...1234)"
OTHER = "FREEDOM UNLIMITED (...5678)"
INK = "INK BUSINESS CASH (...9876)"


def tile(merchant, words, control="Add offer", added=False, label=None):
    inner = (f'<span role="img" aria-label="Success Added"></span>' if added
             else f'<button aria-label="{label or control}">+</button>')
    return f'<div data-cy="commerce-tile"><span>{merchant}</span><span>{words}</span><span>12 days left</span>{inner}</div>'


def switcher(on, others=()):
    if not on:
        return ""
    opts = "".join(f'<div role="option" hidden>{c}</div>' for c in [on, *others])
    return f'<button aria-haspopup="listbox" id="switch">{on}</button><div id="opts">{opts}</div>'


# Pressing an add control marks its tile added a moment later, as Chase does,
# or, with `window.detailOnAdd`, opens the offer's own page with a Back.
SCRIPT = """<script>
window.pressed = [];
document.addEventListener('click', (e) => {
  const el = e.target.closest('button, a, [role=option], [role=button], [role=tab]');
  if (!el) return;
  if (el.tagName === 'A') e.preventDefault();
  pressed.push((el.getAttribute('aria-label') || el.textContent).trim());
  const tile = el.closest('[data-cy=commerce-tile]');
  if (tile && el.tagName === 'BUTTON') {
    if (window.detailOnAdd) {
      window.saved = document.getElementById('list').innerHTML;
      location.hash = '#/dashboard/merchantOffers/offer-activated';
      document.getElementById('list').innerHTML = '<p>Added to card</p><button>Back to offers</button>';
      document.querySelector('#list button').onclick = () => {
        location.hash = '#/dashboard/merchantOffers/offer-hub?accountId=900000001234';
        document.getElementById('list').innerHTML = window.saved;
        document.querySelector('#list [data-cy=commerce-tile] button').outerHTML = '<span role="img" aria-label="Success Added"></span>';
      };
    } else {
      setTimeout(() => { el.outerHTML = '<span role="img" aria-label="Success Added"></span>'; }, 80);
    }
  }
  if (el.id === 'switch') document.querySelectorAll('#opts [role=option]').forEach((o) => { o.hidden = !o.hidden; });
  if (el.getAttribute('role') === 'option' && window.cards) {
    const label = el.textContent.trim();
    setTimeout(() => {
      document.getElementById('switch').textContent = label;
      document.querySelectorAll('#opts [role=option]').forEach((o) => { o.hidden = true; });
      document.getElementById('list').innerHTML = window.cards[label];
    }, 80);
  }
});
</script>"""


def page(body, card=PERSONAL, others=()):
    return f"<header><a href='#/dashboard/overview'>Home</a></header>{switcher(card, others)}<main id='list'>{body}</main>{SCRIPT}"


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
    source = (ROOT / "providers" / "chase.offers.js").read_text() \
        .replace("LIST_WAIT_MS = 15000", "LIST_WAIT_MS = 300").replace("ADD_WAIT_MS = 10000", "ADD_WAIT_MS = 800") \
        .replace("BACK_WAIT_MS = 10000", "BACK_WAIT_MS = 800").replace("CARD_WAIT_MS = 15000", "CARD_WAIT_MS = 800") \
        .replace("SWITCHER_WAIT_MS = 5000", "SWITCHER_WAIT_MS = 500")
    tab.add_script_tag(content=kit)
    tab.add_script_tag(content=source)


def read(tab, cards="personal", walk=True):
    return tab.evaluate("([w, c]) => __offers.readOffers({walk: w, cards: c})", [walk, cards])


def add(tab, offer):
    return tab.evaluate("(o) => __offers.addOne(o)", offer)


def test_offers_are_read_per_card(tab):
    load(tab, HUB, page(tile("Example Grocer", "10% cash back") + tile("Invented Hardware", "$15 cash back", added=True)))
    got = read(tab)
    assert got["state"] == "ok" and got["card"] == "1234" and got["more"] is True
    first, second = got["offers"]
    assert first["merchant"] == "Example Grocer" and first["title"] == "10% cash back" and first["added"] is False
    assert first["id"].startswith("1234:")
    assert second["merchant"] == "Invented Hardware" and second["added"] is True


def test_add_offer_named_with_its_merchant_counts(tab):
    load(tab, HUB, page(tile("Example Grocer", "10% cash back", label="Add offer, Example Grocer")))
    assert [o["added"] for o in read(tab)["offers"]] == [False]


def test_add_presses_only_that_tiles_add_control(tab):
    load(tab, HUB, page(tile("Example Grocer", "10% cash back") + tile("Invented Hardware", "$15 cash back")))
    offer = read(tab)["offers"][1]
    assert add(tab, offer) == {"ok": True}
    assert tab.evaluate("pressed") == ["Add offer"]
    assert tab.evaluate("document.querySelectorAll('[data-cy=commerce-tile] button').length") == 1


def test_controls_that_say_more_than_add_are_never_offers(tab):
    body = "".join(tile(f"Shop {i}", "5% cash back", control=c) for i, c in enumerate(
        ["Activate offer", "Add offer and accept terms", "Apply now", "Add authorized user", "Enroll", "Buy now", "Add to card and pay"]))
    load(tab, HUB, page(body))
    got = read(tab)
    assert got["state"] == "stopped"
    assert tab.evaluate("pressed") == []


def test_a_bare_plus_outside_a_tile_is_not_an_offer(tab):
    load(tab, HUB, page('<div><span>Example Grocer</span><button>+</button></div><p>No offers available.</p>'))
    got = read(tab)
    assert got["state"] == "ok" and got["offers"] == []


def test_an_offer_page_opened_by_the_press_is_left_by_its_own_back(tab):
    load(tab, HUB, page(tile("Example Grocer", "10% cash back")))
    offer = read(tab)["offers"][0]
    tab.evaluate("window.detailOnAdd = true")
    assert add(tab, offer) == {"ok": True}
    assert tab.evaluate("pressed") == ["Add offer", "Back to offers"]
    assert "offer-hub" in tab.evaluate("location.hash")


def test_a_business_card_is_passed_over_by_chase_personal(tab):
    load(tab, HUB, page(tile("Example Grocer", "10% cash back"), card=INK))
    got = read(tab, cards="personal")
    assert got["offers"] == [] and got["passed"] is True and got["more"] is True


def test_chase_business_reads_its_ink_card_and_passes_a_personal_one(tab):
    load(tab, HUB, page(tile("Example Grocer", "10% cash back"), card=INK))
    got = read(tab, cards="business")
    assert got["card"] == "9876" and len(got["offers"]) == 1
    load(tab, HUB, page(tile("Example Grocer", "10% cash back"), card=PERSONAL))
    assert read(tab, cards="business")["passed"] is True


def test_each_card_in_turn_through_the_switcher(tab):
    cards = {PERSONAL: tile("Example Grocer", "10% cash back"), OTHER: tile("Invented Hardware", "$15 cash back")}
    load(tab, HUB, page(cards[PERSONAL], PERSONAL, [OTHER]))
    tab.evaluate("(c) => { window.cards = c; }", cards)
    assert read(tab)["card"] == "1234"
    assert tab.evaluate("__offers.nextCard()") == {"moved": True}
    second = read(tab)
    assert second["card"] == "5678" and second["offers"][0]["merchant"] == "Invented Hardware"
    assert tab.evaluate("__offers.nextCard()") == {"moved": False}


def test_an_offer_for_another_card_is_not_pressed(tab):
    load(tab, HUB, page(tile("Example Grocer", "10% cash back")))
    offer = dict(read(tab)["offers"][0], card="5678")
    assert add(tab, offer)["ok"] is False
    assert tab.evaluate("pressed") == []


def test_off_the_hub_its_own_link_is_pressed_once_or_it_is_no_list(tab):
    load(tab, DASH, page("<a href='#/dashboard/merchantOffers/offer-hub'>Chase Offers</a>", card=""))
    assert read(tab, walk=False) == {"state": "no_list"}
    assert read(tab) == {"state": "walking"}
    assert tab.evaluate("pressed") == ["Chase Offers"]
    assert read(tab) == {"state": "no_list"}


def test_a_link_off_chase_is_not_pressed(tab):
    load(tab, DASH, "<a href='https://example.com/offers'>Chase Offers</a>" + SCRIPT)
    assert read(tab) == {"state": "no_list"}
    assert tab.evaluate("pressed") == []


def test_all_offers_and_more_are_pressed_before_reading(tab):
    body = '<button role="tab" aria-selected="false">All offers</button>' + tile("Example Grocer", "10% cash back") + "<button>Show more</button>"
    load(tab, HUB, page(body))
    assert read(tab) == {"state": "walking"}
    assert read(tab) == {"state": "walking"}
    assert tab.evaluate("pressed") == ["All offers", "Show more"]


def test_sign_in_frame_and_checks_are_known(tab):
    load(tab, HUB, "<iframe name='logonbox' src='about:blank' style='width:300px;height:300px'></iframe>")
    assert read(tab) == {"state": "signed_out"}
    load(tab, HUB, page("<p>Enter the code we sent to your phone.</p>"))
    assert read(tab) == {"state": "challenge"}


def test_a_dialog_after_the_press_is_closed_and_the_offer_left(tab):
    load(tab, HUB, page(tile("Example Grocer", "10% cash back")))
    offer = read(tab)["offers"][0]
    tab.evaluate("""document.querySelector('[data-cy=commerce-tile] button').addEventListener('click', (e) => {
      e.stopImmediatePropagation();
      const d = document.createElement('div'); d.setAttribute('role', 'dialog');
      d.innerHTML = '<p>Review the terms.</p><button>I agree</button><button>Close</button>';
      d.querySelector('button:last-child').onclick = () => d.remove();
      document.body.append(d);
    })""")
    got = add(tab, offer)
    assert got["ok"] is False and got["left"] is True
    assert tab.evaluate("pressed") == ["Close"]


def test_a_card_whose_kind_cannot_be_read_is_never_added_to(tab):
    # No switcher and no card name: it could be either kind.
    load(tab, HUB, page(tile("Example Grocer", "10% cash back"), card=""))
    for kind in ("personal", "business"):
        got = read(tab, cards=kind)
        assert got["state"] == "stopped" and "personal or business" in got["why"]
    assert tab.evaluate("pressed") == []


def test_each_offer_carries_its_kind_and_is_checked_again_before_the_press(tab):
    load(tab, HUB, page(tile("Example Grocer", "10% cash back"), card=PERSONAL))
    offer = read(tab, cards="personal")["offers"][0]
    assert offer["kind"] == "personal"
    # The same last digits on a business card on show: refused, and the offers stop.
    tab.evaluate("(l) => { document.getElementById('switch').textContent = l; }", "INK BUSINESS CASH (...1234)")
    got = add(tab, offer)
    assert got["ok"] is False and got["stop"] is True
    assert tab.evaluate("pressed") == []


def test_a_personal_and_a_business_card_in_one_sign_in_are_each_read_by_their_own_site(tab):
    cards = {PERSONAL: tile("Example Grocer", "10% cash back"), INK: tile("Invented Hardware", "$15 cash back")}
    for kind, want in (("personal", ["1234"]), ("business", ["9876"])):
        load(tab, HUB, page(cards[PERSONAL], PERSONAL, [INK]))
        tab.evaluate("(c) => { window.cards = c; }", cards)
        added_to = []
        for _ in range(3):
            got = read(tab, cards=kind)
            if got["offers"]:
                added_to.append(got["card"])
                assert all(o["kind"] == kind for o in got["offers"])
            if tab.evaluate("__offers.nextCard()") == {"moved": False}:
                break
        assert added_to == want


def test_a_check_during_an_add_presses_nothing(tab):
    load(tab, HUB, page(tile("Example Grocer", "10% cash back")))
    offer = read(tab)["offers"][0]
    tab.evaluate("document.body.insertAdjacentHTML('afterbegin', '<p>Enter the code we sent to your phone.</p>')")
    assert add(tab, offer) == {"ok": False, "state": "challenge"}
    assert tab.evaluate("pressed") == []


def test_a_page_asking_for_a_pause_stops_the_offers_without_a_press(tab):
    load(tab, HUB, page(tile("Example Grocer", "10% cash back")))
    offer = read(tab)["offers"][0]
    tab.evaluate("document.body.insertAdjacentHTML('afterbegin', '<p>Too many requests. Try again later.</p>')")
    got = add(tab, offer)
    assert got["ok"] is False and got["stop"] is True
    assert tab.evaluate("pressed") == []


def test_days_left_are_read_as_an_end_date_counted_from_today(tab):
    load(tab, HUB, page(tile("Example Grocer", "10% cash back")))
    got = read(tab)
    want = tab.evaluate("(() => { const d = new Date(); d.setDate(d.getDate() + 12); return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); })()")
    assert got["offers"][0]["expires"] == want


def test_the_cards_product_name_is_read_but_never_a_cardholders(tab):
    load(tab, HUB, page(tile("Example Grocer", "10% cash back")))
    assert read(tab)["cardName"] == "SAPPHIRE PREFERRED"
    load(tab, HUB, page(tile("Example Grocer", "10% cash back"), card="J. INVENTED (...4321)"))
    got = read(tab, cards="business")
    assert got["state"] == "ok" and got["card"] == "4321" and "cardName" not in got
