#!/usr/bin/env python3
"""Turns a page saved from a live site into a stand-in a test can load.

    python3 tools/snapshot.py saved.html tests/fixtures/<site>/<name>.html \\
        [--name "Real Name=Alex Sample" ...]

A page saved from your own account holds your account. This keeps the
structure a recipe reads (tags, classes, roles, test ids, labels, dates) and
replaces what is yours:

- every run of 3 or more digits that is not a year or part of a date, by an
  invented run of the same length, the same one each time it repeats, so two
  accounts stay two accounts;
- amounts, by $80.00;
- email addresses, by someone@example.com;
- long tokens (16 or more letters and digits, such as ids in addresses), by
  TOKENAAAB and on, the same each time;
- every --name given, by its stand-in.

Scripts, frames, styles from other hosts, inline handlers and form values are
dropped. It cannot know your name or street unless you give them, so read
the result before committing it. tools/privacy_check.py runs on it in CI.
"""
import argparse
import html
import re
import sys
from html.parser import HTMLParser

DROP_WITH_CONTENT = {"script", "noscript", "iframe", "object", "embed", "template"}
DROP_TAG = {"link", "meta", "base"}
VOID = {"area", "br", "col", "hr", "img", "input", "source", "track", "wbr"}
DROP_ATTR = re.compile(r"^(on[a-z]+|nonce|integrity|srcset|value|data-reactid|autocomplete)$", re.I)

MONTH = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
DATES = re.compile(
    r"(?:(?:19|20)\d{2}-\d{2}-\d{2})"                       # 2026-10-26
    r"|(?:\d{1,2}/\d{1,2}/(?:19|20)?\d{2})"                 # 10/26/2026
    rf"|(?:{MONTH}\.?\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+(?:19|20)\d{{2}})"  # October 26, 2026
    rf"|(?:\d{{1,2}}\s+{MONTH}\.?\s+(?:19|20)\d{{2}})",     # 26 Oct 2026
    re.I)
AMOUNT = re.compile(r"-?\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|-?\$\s?\d+(?:\.\d{2})?")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
TOKEN = re.compile(r"(?<![A-Za-z0-9])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{16,}={0,2}")
DIGITS = re.compile(r"(?<!\d)\d{3,}(?!\d)")
YEAR = re.compile(r"(?:19|20)\d{2}")


class Redactor:
    def __init__(self, names=()):
        self.names = sorted(names, key=lambda p: -len(p[0]))
        self.numbers, self.tokens = {}, {}

    def number(self, digits):
        if len(digits) == 4 and YEAR.fullmatch(digits):
            return digits
        if digits not in self.numbers:
            n = len(self.numbers) + 1
            # Begins with 9s, so it reads as invented; unique per original.
            tail = str(n)
            self.numbers[digits] = "9" * (len(digits) - len(tail)) + tail if len(digits) > len(tail) else tail[-len(digits):]
        return self.numbers[digits]

    def token(self, t):
        if t not in self.tokens:
            # Letters only, so the digit pass cannot touch it: TOKENAAAB, TOKENAAAC…
            n, word = len(self.tokens) + 1, ""
            for _ in range(4):
                n, k = divmod(n, 26)
                word = chr(65 + k) + word
            self.tokens[t] = f"TOKEN{word}"
        return self.tokens[t]

    def text(self, s):
        for real, fake in self.names:
            s = re.sub(re.escape(real), fake, s, flags=re.I)
        s = EMAIL.sub("someone@example.com", s)
        s = AMOUNT.sub("$80.00", s)
        s = TOKEN.sub(lambda m: m.group() if DATES.fullmatch(m.group()) else self.token(m.group()), s)
        # Dates are kept whole; digits elsewhere are replaced.
        out, last = [], 0
        for m in DATES.finditer(s):
            out.append(DIGITS.sub(lambda d: self.number(d.group()), s[last:m.start()]))
            out.append(m.group())
            last = m.end()
        out.append(DIGITS.sub(lambda d: self.number(d.group()), s[last:]))
        return "".join(out)


class Rewriter(HTMLParser):
    def __init__(self, redactor):
        super().__init__(convert_charrefs=True)
        self.r, self.out, self.skipping = redactor, [], []

    def handle_starttag(self, tag, attrs):
        if self.skipping:
            if tag == self.skipping[-1] and tag not in VOID:
                self.skipping.append(tag)
            return
        if tag in DROP_WITH_CONTENT:
            self.skipping.append(tag)
            return
        if tag in DROP_TAG:
            return
        kept = []
        for k, v in attrs:
            if DROP_ATTR.match(k):
                continue
            if k in ("href", "src", "action") and v and re.match(r"(?i)\s*javascript:(?!void\(0\))", v):
                v = "javascript:void(0)"
            if k == "style" and v and "url(" in v:
                v = re.sub(r"url\([^)]*\)", "none", v)
            kept.append(f' {k}="{html.escape(self.r.text(v), quote=True)}"' if v is not None else f" {k}")
        self.out.append(f"<{tag}{''.join(kept)}>")

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if self.skipping:
            if tag == self.skipping[-1]:
                self.skipping.pop()
            return
        if tag not in DROP_TAG and tag not in VOID:
            self.out.append(f"</{tag}>")

    def handle_data(self, data):
        if not self.skipping:
            self.out.append(html.escape(self.r.text(data), quote=False))

    def handle_comment(self, data):
        pass

    def handle_decl(self, decl):
        self.out.append(f"<!{decl}>")


def redact_html(source, names=()):
    w = Rewriter(Redactor(names))
    w.feed(source)
    w.close()
    return "".join(w.out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("source")
    ap.add_argument("target")
    ap.add_argument("--name", action="append", default=[], metavar="REAL=STAND-IN",
                    help="a name, street or other word of yours, and what to write instead")
    a = ap.parse_args(argv)
    names = []
    for pair in a.name:
        real, sep, fake = pair.partition("=")
        if not sep or not real.strip():
            ap.error(f"--name needs REAL=STAND-IN, got {pair!r}")
        names.append((real.strip(), fake.strip() or "Alex Sample"))
    with open(a.source, encoding="utf-8", errors="replace") as f:
        result = redact_html(f.read(), names)
    with open(a.target, "w", encoding="utf-8") as f:
        f.write(result)
    print(f"Wrote {a.target}. Read it before committing: this cannot find a name or address you did not give with --name.")


if __name__ == "__main__":
    sys.exit(main())
