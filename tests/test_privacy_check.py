"""The privacy check in CI (tools/privacy_check.py) catches what a pasted real
page would bring in. Every value here is invented."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("privacy_check", ROOT / "tools" / "privacy_check.py")
pc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pc)


def test_the_repository_passes():
    assert pc.scan() == []


def test_an_unlisted_account_number_is_caught():
    got = pc.problems_in("t.py", 'ACCOUNT = "4815162342"', set())
    assert len(got) == 1 and "4815162342" in got[0]


def test_a_listed_number_and_a_date_pass():
    assert pc.problems_in("t.py", 'X = "4815162342"; D = "20261110"', {"4815162342"}) == []


def test_an_impossible_date_is_not_waved_through():
    assert pc.problems_in("t.py", "20261340", set())


def test_a_real_domain_email_is_caught_and_a_reserved_one_passes():
    assert pc.problems_in("t.py", "someone@gmail.com", set())
    assert pc.problems_in("t.py", "someone@example.com secret@bank.test", set()) == []


def test_a_social_security_shape_is_caught():
    assert pc.problems_in("t.py", "ssn 078-05-1120", set())


def test_short_numbers_and_numbers_inside_words_are_ignored():
    assert pc.problems_in("t.py", "x9786 1234567 DOCD-AA18 abc123456789", set()) == []


def test_a_number_in_groups_is_caught_whole():
    for text in ("acct 4815-1623-4200", "card 4815 1623 4200 1108", "call 481 516 2342"):
        got = pc.problems_in("t.py", text, set())
        assert len(got) == 1 and "grouped number" in got[0], text
    assert pc.problems_in("t.py", "card 4815 1623 4200 1108", {"4815 1623 4200 1108"}) == []


def test_dates_times_versions_colours_and_short_groups_are_not_grouped_numbers():
    text = ("on 2026-11-10 at 09:30:15, 2026-10-31 2026-09-30, v0.4.0 1.2.3 12 34 5, "
            "run-20261012-164332.log rgb(255 255 255 / .1) 0a1b2c3d-1234-4234-8234-0123456789ab")
    assert pc.problems_in("t.py", text, {"0123456789"}) == []


def test_a_long_base64_run_and_an_embedded_pdf_are_caught():
    assert pc.problems_in("t.py", "x = '" + "QUJD" * 60 + "'", set())
    assert pc.problems_in("t.py", 'pdf = "JVBERi0xLjQK"', set())
    assert pc.problems_in("t.py", 'if data.startswith("JVBERi0"): pass', set()) == []


def test_only_noreply_addresses_pass_on_real_domains():
    assert pc.problems_in("t.py", "Co-Authored-By: Claude <noreply@anthropic.com>", set()) == []
    assert pc.problems_in("t.py", "1+someone@users.noreply.github.com", set()) == []
    assert pc.problems_in("t.py", "someone@anthropic.com", set())


def test_only_what_the_snapshot_tool_writes_passes_as_its_number():
    assert pc.problems_in("t.py", "99999991 99999912 99999123 99999999", set()) == []
    for real in ("99991234", "99990001", "999912345"):
        assert pc.problems_in("t.py", real, set()), real


def test_a_text_file_that_cannot_be_read_fails(tmp_path, monkeypatch):
    (tmp_path / "page.html").write_bytes(b"<p>\xff\xfe account</p>")
    (tmp_path / "logo.png").write_bytes(b"\x89PNG\xff\xfe")
    monkeypatch.setattr(pc, "tracked_files", lambda: iter([("page.html", tmp_path / "page.html")]))
    assert pc.scan() == ["page.html: cannot be read as text, so it was not checked"]
    assert ".png" in pc.BINARY
