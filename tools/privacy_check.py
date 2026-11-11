#!/usr/bin/env python3
"""Fails when a tracked file holds something that looks like a person's own
details: a long number nobody has said is invented (written whole, or in
groups split by dashes or spaces), an email address on a real domain, a Social
Security number's shape, or a long base64 run such as an embedded PDF.

Statement Sweep reads bank and brokerage pages, and its tests are stand-ins
for those pages, so the easiest way to leak an account is to paste a real
page into a test. Every long number in the repository must therefore be on
tools/privacy-allow.txt, where a reviewer can see it was made up. Dates
written as YYYYMMDD are allowed without listing. A file it cannot read as
text fails too, unless its kind is a real binary (BINARY below).

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
# Digits in groups joined by one dash or space (a card or account as printed).
# Taken out first: ISO dates, times, a log's 20261012-164332, a UUID (its long
# digit runs are still checked whole) and a CSS colour such as rgb(255 255 255).
# A dot next to the digits makes it a version, such as 1.2 3.
GROUPED = re.compile(r"(?<![0-9A-Za-z.])[0-9]+(?:[- ][0-9]+)+(?![0-9A-Za-z]|\.[0-9])")
NOT_GROUPED = re.compile(
    r"(?<![0-9])(?:19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}(?![0-9])"
    r"|(?<![0-9])[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?(?![0-9])"
    r"|(?<![0-9])(?:19|20)[0-9]{6}-[0-9]{6}(?![0-9])"
    r"|(?<![0-9A-Fa-f])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![0-9A-Fa-f])"
    r"|\b(?:rgba?|hsla?)\([^)]*\)")
# A file pasted in as base64: any long run, and a PDF's own start however short
# ("JVBERi0" is "%PDF-"; the bare word, as code that looks for it, is fine).
BASE64 = re.compile(r"[A-Za-z0-9+/]{200,}={0,2}")
EMBEDDED_PDF = re.compile(r"JVBERi0[A-Za-z0-9+/]")
SSN = re.compile(r"(?<![0-9])[0-9]{3}-[0-9]{2}-[0-9]{4}(?![0-9])")
# Reserved for examples (RFC 2606, RFC 6761), and the noreply addresses commits use.
EMAIL_OK = re.compile(r"(^|\.)(example\.(com|org|net)|test|invalid|example|localhost|users\.noreply\.github\.com)$", re.I)
ADDRESS_OK = {"noreply@anthropic.com"}


def allowed_numbers():
    keep = set()
    for line in ALLOW_FILE.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            keep.add(line)
    return keep


# What tools/snapshot.py writes in place of a real number: nines, then the
# count of numbers it has replaced so far (1 on, so no leading 0; a page
# has fewer than a thousand). An 8-digit one therefore has at least 5 nines.
SNAPSHOT_NUMBER = re.compile(r"9+[1-9][0-9]{0,2}")


def is_date(digits):
    if len(digits) != 8 or not digits.startswith(("19", "20")):
        return False
    try:
        datetime.date(int(digits[:4]), int(digits[4:6]), int(digits[6:]))
        return True
    except ValueError:
        return False


def invented(digits, allow):
    return digits in allow or is_date(digits) or bool(SNAPSHOT_NUMBER.fullmatch(digits))


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
            if not invented(m.group(), allow):
                found.append(f"{name}:{n}: long number {m.group()} is not on tools/privacy-allow.txt")
        for m in GROUPED.finditer(NOT_GROUPED.sub(" _ ", line)):
            groups = re.split(r"[- ]", m.group())
            digits = "".join(groups)
            # Long numbers side by side are each checked whole above.
            if len(digits) >= 8 and not all(len(g) >= 8 for g in groups) and m.group() not in allow and not invented(digits, allow):
                found.append(f"{name}:{n}: grouped number {m.group()} is not on tools/privacy-allow.txt")
        if BASE64.search(line) or EMBEDDED_PDF.search(line):
            found.append(f"{name}:{n}: long base64 run (an embedded file?)")
        for m in EMAIL.finditer(line):
            if not EMAIL_OK.search(m.group(1)) and m.group().lower() not in ADDRESS_OK:
                found.append(f"{name}:{n}: email address on a real domain ({m.group(1)})")
        for m in SSN.finditer(line):
            found.append(f"{name}:{n}: looks like a Social Security number")
    return found


def scan():
    allow = allowed_numbers()
    found = []
    for name, path in tracked_files():
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            found.append(f"{name}: cannot be read as text, so it was not checked")
            continue
        found += problems_in(name, text, allow)
    return found


if __name__ == "__main__":
    problems = scan()
    for p in problems:
        print(p)
    if problems:
        print(f"\n{len(problems)} problem(s). If a number is invented, add it to tools/privacy-allow.txt with a note.")
        sys.exit(1)
    print("Privacy check: nothing personal found.")
