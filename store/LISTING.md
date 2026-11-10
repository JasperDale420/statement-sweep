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

- Saves official PDFs, from the site itself, and prints a page as a PDF where a site has none
- Never saves the same document twice
- Choose your own folders and file names
- Shows what needs you first
- If you turn it on, adds the card offers American Express and Chase show you to your own card as it syncs
- Light and dark mode

Your data stays with you. There is no server, no account and no tracking. It never sees your passwords, and it sends nothing to its developer or anyone else.

Statement Sweep is independent and is not made or endorsed by any bank or site it works with. It is free software under the GNU AGPL v3, based on PaperPull.

**Single purpose:**
Save the user's own statements and account documents, from sites the user signs in to, to the user's computer; and, only if the user turns it on, add the card offers those sites show to the user's own card while it is there.

**Permission justifications:**

- `downloads`: Saves each statement to the user's Downloads folder, or passes it through there on its way to a folder the user chose with Chrome's folder picker, under the folder and file name the user chose, and recognizes a download started by the site's own page so that it can be named.
- `scripting`: Runs the steps that read a site's document list, inside that site's tab, when the user starts a sweep. When the user has turned on card offers for a site, it also presses that site's own add control for each offer, on that site's offers page, at most 25 a sync.
- `storage`: Remembers which documents were already saved, which sites are selected, and the user's naming settings, on the user's computer. When the user has not chosen a folder, it also keeps the latest lines of the sweep's own run log there (no page text, long numbers cut to their last 4 digits), which the user can export from Settings.
- `debugger`: Some sites show a document only as a web page, with no PDF (a Venmo monthly statement, an Apple Store invoice, a TreasuryDirect holdings page). The extension attaches Chrome's debugger to the one tab the sweep itself opened, only while it runs Page.printToPDF on that page, and detaches straight after. It is never attached to a tab the user opened, never used to read or change a page, and the user can stop it at any time with Cancel on Chrome's debugging bar, which stops that site.
- `webNavigation`: Some sites open a statement in a new tab instead of downloading it. While the extension waits on one such press, it listens for which tab opened a new tab, so that it takes and closes only the tab opened by the sweep's own tab, never one the user opened. Nothing is recorded.
- `contentSettings`: Chrome holds a page's second automatic download for a prompt, and blocks a document a site opens in a new window when no person pressed. This allows automatic downloads and that window for the one site being swept, and both are removed when the sweep ends.
- Host permissions: A few listed hosts are a site's own file store (mountain-storage.s3.amazonaws.com for Robinhood, statements.cardless.com for Bilt and the Coinbase One Card). The site opens a statement there in a new tab, and the extension fetches that one address and closes the tab. Each other listed host is a site where the extension reads the user's own document list and saves documents from the user's signed-in session. No host is contacted unless the user starts a sweep that includes it.

**Remote code:** No. All code is in the package.

**Data usage:** Nothing is collected or transmitted. Everything stays on the user's computer. Tick the three certifications.

**Privacy policy URL:**
https://github.com/JasperDale420/statement-sweep/blob/main/PRIVACY.md

**Support URL:**
https://github.com/JasperDale420/statement-sweep/issues

**Store images:** `store/screenshot-1.png`, `store/screenshot-2.png` (1280 x 800). The icon is taken from the package.
