# Statement Sweep

A Chrome extension that saves your own official statements from sites you
sign in to. It uses your browser and your password manager, opens no extra
browsers, stores no passwords, and sends nothing anywhere.

Inspired by and based on [PaperPull](https://github.com/rheeloaded/paperpull).
Credit for the idea and the site-by-site work behind these recipes belongs to
its authors. Statement Sweep is an independent project, not made or endorsed by
PaperPull or TNE Enterprises LLC. See [NOTICE.md](NOTICE.md).

17 sites are switched on. Each is a recipe in `providers/`; see
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

Nothing leaves your browser. See the [privacy policy](PRIVACY.md).

## Develop

`python3 tools/build.py` regenerates the site list. `pytest tests` needs
Playwright. `python3 tools/package.py` makes the Chrome Web Store upload.
