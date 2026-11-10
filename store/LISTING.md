# Chrome Web Store listing

Copy these into the Developer Dashboard. `tools/package.py` makes the upload.

**Name:** Statement Sweep

**Summary (132 characters at most):**
Saves your official statements from sites you sign in to. Runs in your own browser and sends nothing anywhere.

**Category:** Productivity > Tools

**Language:** English

**Visibility:** Unlisted

**Description:**

Statement Sweep collects your official statements and tax documents from the banks, brokerages and billers you already use, and saves them to your computer.

Press one button. It goes through each site you choose, in your own browser, and saves what is new. If a site needs you to sign in, its tab comes forward and your password manager works as usual. Once you are in, it carries on by itself.

- Saves official PDFs, from the site itself
- Never saves the same document twice
- Choose your own folders and file names
- Shows what needs you first
- Light and dark mode

Your data stays with you. There is no server, no account and no tracking. It never sees your passwords, and it sends nothing to its developer or anyone else.

Statement Sweep is independent and is not made or endorsed by any bank or site it works with. It is free software under the GNU AGPL v3, based on PaperPull.

**Single purpose:**
Save the user's own statements and account documents, from sites the user signs in to, to the user's computer.

**Permission justifications:**

- `downloads`: Saves each statement to the user's Downloads folder, or passes it through there on its way to a folder the user chose with Chrome's folder picker, under the folder and file name the user chose, and recognizes a download started by the site's own page so that it can be named.
- `scripting`: Runs the steps that read a site's document list, inside that site's tab, when the user starts a sweep.
- `storage`: Remembers which documents were already saved, which sites are selected, and the user's naming settings, on the user's computer.
- `contentSettings`: Chrome holds a page's second automatic download for a prompt. This allows automatic downloads for the one site being swept, and is removed when the sweep ends.
- Host permissions: Each listed host is a site where the extension reads the user's own document list and saves documents from the user's signed-in session. No host is contacted unless the user starts a sweep that includes it.

**Remote code:** No. All code is in the package.

**Data usage:** Nothing is collected or transmitted. Everything stays on the user's computer. Tick the three certifications.

**Privacy policy URL:**
https://github.com/JasperDale420/statement-sweep/blob/main/PRIVACY.md

**Support URL:**
https://github.com/JasperDale420/statement-sweep/issues

**Store images:** `store/screenshot-1.png`, `store/screenshot-2.png` (1280 x 800). The icon is taken from the package.
