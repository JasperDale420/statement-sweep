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
