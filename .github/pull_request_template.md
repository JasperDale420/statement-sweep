## What this changes

<!-- One or two sentences. Name the sites it touches. -->

## Safety checklist

- [ ] It only reads and downloads (or, for offers, presses only an offer's own Add control). No form, setting, payment or transfer.
- [ ] It never types a password or code, or works around a sign-in or check.
- [ ] No new host in `match` or `fileHosts`, or the reason for each is below.
- [ ] Tests and recipes use invented values only, and `python3 tools/privacy_check.py` passes.
- [ ] A live-site fix comes with a test that fails without it.

## How it was checked

<!-- Tests run, and whether it was tried on the live site (which kind of account). No account details. -->
