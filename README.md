# Statement Sweep

[![CI](https://github.com/JasperDale420/statement-sweep/actions/workflows/ci.yml/badge.svg)](https://github.com/JasperDale420/statement-sweep/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

A Chrome extension that saves your own official statements from sites you
sign in to. It uses your browser and your password manager, opens no extra
browsers, stores no passwords, and sends nothing anywhere.

Inspired by and based on [PaperPull](https://github.com/rheeloaded/paperpull).
Credit for the idea and the site-by-site work behind these recipes belongs to
its authors. Statement Sweep is an independent project, not made or endorsed by
PaperPull or TNE Enterprises LLC. See [NOTICE.md](NOTICE.md).

25 sites are switched on. Each is a recipe in `providers/`; see
[providers/README.md](providers/README.md) to write one.

## Try it

1. Open `chrome://extensions`, turn on **Developer mode**, press **Load
   unpacked**, and choose this folder.
2. Press the extension's icon, then **Get New Documents**, or the play button
   beside one site.
3. If a site needs you to sign in, its tab comes forward. It carries on by
   itself.

Files land in Downloads under `Statement Sweep/`. **Settings**, the sliders
button in the popup, changes the folders and file names, or sends everything
to any folder you choose.

## Card offers

For American Express, Chase and Chase Business, Statement Sweep can also add
your card offers after it saves that site's statements. It is off until you
turn it on for a site in Settings. It presses only each offer's own add
control, at most 25 a site per sync and a few seconds apart, and stops at any
sign-out or security check. It never adds an offer twice.

Nothing leaves your browser. See the [privacy policy](PRIVACY.md).

## Develop

```bash
pip install -r requirements-dev.txt && python -m playwright install chromium
python3 tools/build.py          # regenerate the site list after editing a *.meta.json
python3 tools/privacy_check.py  # nothing personal in the repository
python -m pytest -n auto --dist loadfile
python3 tools/package.py        # the Chrome Web Store upload
```

Each site is tested in a real Chromium against stand-in pages. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request: its safety
rules come first. Security problems go privately, as [SECURITY.md](SECURITY.md)
says. Changes are listed in [CHANGELOG.md](CHANGELOG.md).
