#!/usr/bin/env python3
"""Fails when a tracked file holds something that looks like a person's own
details: a long number nobody has said is invented, an email address on a
real domain, or a Social Security number's shape.

Statement Sweep reads bank and brokerage pages, and its tests are stand-ins
for those pages, so the easiest way to leak an account is to paste a real
page into a test. Every long number in the repository must therefore be on
tools/privacy-allow.txt, where a reviewer can see it was made up. Dates
written as YYYYMMDD are allowed without listing.

Run: python3 tools/privacy_check.py   (exit 1 and a list when anything is found)
"""
import datetime
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
ALLOW_FILE = ROOT / "tools" / "privacy-allow.txt"
# The allowlist itself, and the check's own test, which holds bait on purpose.
SKIP = {"tools/privacy-allow.txt", "tests/test_privacy_check.py", "tests/test_snapshot.py"}
BINARY = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".zip", ".woff", ".woff2"}

LONG_NUMBER = re.compile(r"(?<![0-9A-Za-z])[0-9]{8,}(?![0-9])")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)")
SSN = re.compile(r"(?<![0-9])[0-9]{3}-[0-9]{2}-[0-9]{4}(?![0-9])")
# Reserved for examples (RFC 2606, RFC 6761), and the noreply address commits use.
EMAIL_OK = re.compile(r"(^|\.)(example\.(com|org|net)|test|invalid|example|localhost|users\.noreply\.github\.com|anthropic\.com)$", re.I)


def allowed_numbers():
    keep = set()
    for line in ALLOW_FILE.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            keep.add(line)
    return keep


# What tools/snapshot.py writes in place of a real number: nines, then a count.
SNAPSHOT_NUMBER = re.compile(r"9{4,}[0-9]{1,4}")


def is_date(digits):
    if len(digits) != 8 or not digits.startswith(("19", "20")):
        return False
    try:
        datetime.date(int(digits[:4]), int(digits[4:6]), int(digits[6:]))
        return True
    except ValueError:
        return False


def tracked_files():
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout
    for name in out.decode().split("\0"):
        path = ROOT / name
        if name and path.suffix.lower() not in BINARY and path.is_file() and name not in SKIP:
            yield name, path


def problems_in(name, text, allow):
    found = []
    for n, line in enumerate(text.splitlines(), 1):
        for m in LONG_NUMBER.finditer(line):
            if m.group() not in allow and not is_date(m.group()) and not SNAPSHOT_NUMBER.fullmatch(m.group()):
                found.append(f"{name}:{n}: long number {m.group()} is not on tools/privacy-allow.txt")
        for m in EMAIL.finditer(line):
            if not EMAIL_OK.search(m.group(1)):
                found.append(f"{name}:{n}: email address on a real domain ({m.group(1)})")
        for m in SSN.finditer(line):
            found.append(f"{name}:{n}: looks like a Social Security number")
    return found


def scan():
    allow = allowed_numbers()
    found = []
    for name, path in tracked_files():
        try:
            found += problems_in(name, path.read_text(), allow)
        except UnicodeDecodeError:
            continue
    return found


if __name__ == "__main__":
    problems = scan()
    for p in problems:
        print(p)
    if problems:
        print(f"\n{len(problems)} problem(s). If a number is invented, add it to tools/privacy-allow.txt with a note.")
        sys.exit(1)
    print("Privacy check: nothing personal found.")
