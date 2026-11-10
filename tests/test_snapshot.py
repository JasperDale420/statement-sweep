"""tools/snapshot.py keeps what a recipe reads and replaces what is a
person's own. Every value here is invented."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "tools" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


snap, pc = load("snapshot"), load("privacy_check")
PAGE = """<!doctype html><html><head><script>track('4815162342')</script>
<link rel="stylesheet" href="https://cdn.elsewhere.test/a.css"><meta name="x" content="y"></head>
<body><nav role="navigation" data-testid="menu"><a href="/statements?acct=48151623&amp;tok=Ab3dEf6hIj9kLm2nOp">Statements</a></nav>
<div class="row" onclick="steal()">Statement October 26, 2026 Account ending 4242 Balance $1,234.56</div>
<div class="row">Statement 10/26/2026 for Jordan Realname, jordan@mail.example.org, acct 48151623</div>
<input name="q" value="4815162342"><iframe src="https://ads.test/"></iframe>
<p>Card 4815162342 and again 4815162342; other 1617181920.</p></body></html>"""


def test_structure_and_dates_are_kept():
    out = snap.redact_html(PAGE)
    assert 'role="navigation"' in out and 'data-testid="menu"' in out and 'class="row"' in out
    assert "October 26, 2026" in out and "10/26/2026" in out and ">Statements<" in out


def test_numbers_amounts_and_emails_are_replaced():
    out = snap.redact_html(PAGE)
    for real in ("4815162342", "48151623", "4242", "1,234.56", "jordan@", "1617181920"):
        assert real not in out, real
    assert "$80.00" in out and "someone@example.com" in out


def test_a_repeated_number_gets_the_same_stand_in_and_two_stay_two():
    out = snap.redact_html("<p>4815162342 4815162342 1617181920</p>")
    a, b, c = out[3:-4].split()
    assert a == b != c


def test_scripts_frames_handlers_values_and_outside_styles_are_dropped():
    out = snap.redact_html(PAGE)
    for gone in ("<script", "track(", "<iframe", "onclick", "steal", "value=", "cdn.elsewhere", "<meta"):
        assert gone not in out, gone


def test_tokens_and_given_names_are_replaced():
    out = snap.redact_html(PAGE, [("Jordan Realname", "Alex Sample")])
    assert "Ab3dEf6hIj9kLm2nOp" not in out and "TOKENAAAB" in out
    assert "Realname" not in out and "Alex Sample" in out


def test_the_result_passes_the_privacy_check():
    assert pc.problems_in("fixture.html", snap.redact_html(PAGE, [("Jordan Realname", "Alex Sample")]), set()) == []
