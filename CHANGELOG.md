# Changelog

What changed for people using Statement Sweep, newest first. The version is
`manifest.json`'s.

## Unreleased

- While syncing, each site has a progress bar and the whole sync has one,
  with "about" totals from past syncs until a site's list is read. Stop
  ends the sync and keeps what was saved, and sites keep one order while
  it runs.
- Card offers for American Express, Chase and Chase Business, off until
  turned on per site in Settings.
- New-tab and print-to-PDF saving, per-site run logs, and an on-screen guide
  for sites that need you first.
- TreasuryDirect, Interactive Brokers and Apple Card carry on in the tab you
  signed in to.
- Shelby County remembers your parcel. Spectrum saves both statements of a
  month with two, one from each account. Fixes for Chase, IBKR, State Farm
  and others against the live sites.
- The popup ticks only the sites that need updating. Possible gaps can be
  dismissed, and sites switched off in Settings.
- A site checked with nothing new waits a few days before it is flagged
  again, and each site learns how long after their date its statements post.
- CI runs every test, the site-list check and a privacy check on each pull
  request. Contributor rules, a security policy and issue forms.

## 0.3.0 · 2026-11-09

- Save to any folder you choose, and a harder sweep.
- Chrome Web Store assets.

## 0.2.0 · 2026-11-09

- Twenty-six recipes, and a sweep that walks accounts and years.
- American Express goes through each card.
- Settings for folders and file names. The popup and Settings follow Apple's
  interface guidelines.

## 0.1.0 · 2026-11-08

- First release: save official statements from inside your own browser,
  with recipes based on PaperPull.
