# Contributing

Thank you for helping. Statement Sweep runs inside people's bank, card,
brokerage and tax accounts, so the rules below are about keeping those
accounts safe first and code style second. A pull request that breaks one of
the safety rules is not merged, however useful it is.

## The safety rules

1. **Read and download only.** A recipe never submits a form, changes a
   setting, accepts terms, or moves money. It presses only a document's own
   download or view control, or, for card offers, an offer's own Add control.
2. **The person signs in, never the code.** A recipe never types a password
   or a code, answers a security check, or works around a sign-in or CAPTCHA.
   It answers `signed_out` or `challenge` and waits.
3. **When unsure, stop.** If a page is not what the recipe expects, it answers
   `stopped` with a reason. It never guesses a date, an account or a button.
4. **Same-site only.** Requests go only to the hosts in the site's `match`, or
   its exact `fileHosts`. Nothing about an account is sent anywhere.
5. **Every new host needs a reason.** A change to `match` or `fileHosts`
   widens what the extension may read. Say in the pull request which page
   needs the host and why a narrower one will not do.
6. **Nothing personal in the repository.** Tests and recipes use invented
   values only: no real account or card numbers, names, addresses, amounts,
   parcel numbers or merchant lists, and never a page saved from your own
   account without redacting it (see [Snapshots](#snapshots)).
   `tools/privacy_check.py` runs in CI and fails on any long number not
   listed in `tools/privacy-allow.txt`. If yours is invented, list it there.
7. **Log what you saw, not what it said.** A recipe's `__sweepLog` lines say
   which layout it found and why it stopped, in the recipe's own words, never
   the page's text, a cookie, a token or a document's contents.

## Setting up

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
python -m playwright install chromium
```

Load the folder at `chrome://extensions` with Developer mode on and **Load
unpacked**.

## Before you open a pull request

```bash
python3 tools/build.py          # after any change to a *.meta.json
python3 tools/privacy_check.py  # nothing personal
python -m pytest -n auto --dist loadfile
```

CI runs the same three on every pull request, and `main` accepts only pull
requests whose checks pass.

## Changing or adding a site

- Read [providers/README.md](providers/README.md) for the recipe contract.
- Every recipe has a test file, `tests/test_<id>_page.py`, that runs it in a
  real Chromium against stand-in pages. A fix for a live site comes with a
  test that fails without it, built from what the live page showed.
- Each recipe's refusal rules are tested: pay, transfer, autopay and settings
  controls are never pressed (`tests/test_guards.py`).
- Say in the pull request whether you ran it against the live site, and on
  which kind of account. Do not paste the log's account lines.

## Snapshots

`tools/snapshot.py` turns a page you saved from a live site into a stand-in
for tests, replacing digits, names, emails and amounts with invented ones and
dropping scripts and tracking. Read the result before committing it: the
tool helps, and you are still the one who checks.

## Style

- Plain JavaScript modules, no build step and no dependencies.
- Comments say why, in plain words. Names say what.
- Keep user-facing text short and plain, in sentence case for notes and Title
  Case for buttons, as the popup and Settings do.

## Reporting a site that broke

Use the **A site broke** issue form. Attach the site's log from Settings →
Export Logs, which masks long numbers, and never a statement.

## Security

Report a security problem privately, as [SECURITY.md](SECURITY.md) says, not
in an issue.

## License

Statement Sweep is AGPL-3.0, and based on PaperPull (see
[NOTICE.md](NOTICE.md)). By contributing you agree your work is shared under
the same license.
