# Statement Sweep Privacy Policy

Effective November 10, 2026.

Statement Sweep saves your own statements from sites you sign in to, using
your own browser. **It sends nothing to its developer or to anyone else.** There
is no server, no account, no analytics and no advertising.

## What it reads

When you press Run, it reads the document list on the site you chose, inside
your browser tab, and asks that site for your documents the way the site's own
page would. It only does this on the sites listed in the extension, and only
when you start a sweep.

It never reads, stores or fills in your passwords. You sign in yourself, or
your password manager does.

**Sites you add, only when you add them.** On a site that is not built in,
Add This Site asks Chrome to let Statement Sweep read that one site, and
Chrome asks you first. Then, on that page, you click one statement link, and
Statement Sweep reads the page to find the other links like it and their
dates. From then on it reads that site as it reads a built-in one: only its
links like the one you picked, on that site only, and it never presses a
button or sends a form there. Removing the site in Settings gives the access
back.

While a site waits for you to sign in or finish a step, a small Statement Sweep
card is drawn in that site's tab saying what to do; it reads nothing from the
page and fills nothing in.

**Card offers, only if you turn them on.** In Settings you can turn on adding
card offers, one site at a time (American Express, Chase and Chase Business).
Each is off unless you turn it on. Then, after that site's statements are
saved, the sweep opens the site's own offers page in the same tab and presses
each offer's own add control, as you would. It never presses anything that
buys, applies, enrolls you in a product, upgrades or accepts terms. It adds
every offer not yet added (at most 500 a site each sync, or the 10 or 25 you
choose), a few seconds apart, and stops at once if the
site signs you out or asks you to confirm something. Chase personal cards and
Chase business cards are kept apart: each is added to only by its own site.

## What it keeps, on your computer only

- The documents it saves, in your Downloads folder or a folder you choose.
- A list of which documents it has already saved, so they are not saved twice.
  This holds each document's date and an identifier for it, which for some
  sites includes an account number, and notes which documents are tax forms.
- From those dates, how often each site sends a document, so it can say which
  sites are due and run only those. About once a day, and when your browser
  starts, it works this out again from what is stored and shows the number of
  sites due on its toolbar button. That check reads only the stored dates: it
  opens no site and sends nothing.
- If you turn on card offers: which offers it has added, which the site
  already showed as added, and which it left for you, each as a short
  identifier made from the card's last 4 digits and the offer's words, so it
  does not press them again. The offers' names are read in the page and not
  kept.
- For each site you added: its name, its address with no account details,
  the shape of the statement link you picked (its place in its row, its
  address with every number and id taken out, and its words only if they hold
  no digits), where its dates are, what to do on its first sync, and how its
  last sync went. Never the page's text, an account number or a full address.
- Your choices: which sites are ticked, which sites have card offers turned
  on, and your folder and file name patterns.
- The latest status of each site, and how long each step took, until you close
  your browser.
- A log of each sweep: what each site did and why it stopped, so a site that
  does not save can be fixed. It is written to a Logs folder in the folder you
  chose, or, with no folder chosen, the latest lines are kept in the browser's
  storage until you export them from Settings. It holds the extension's own
  short notes, page addresses without anything after a `?` or `#`, and
  numbers, with every number of 5 or more digits cut to its last 4 (such as
  #####1234). It never holds a page's text, your cookies, or what is in a
  document. Old logs are removed after 30 runs per site.

All of this stays in your browser's storage and the folders above. Removing
the extension deletes everything except the documents you saved.

## Why it asks for its permissions

- **Access to the listed sites:** to read your document list and save documents
  from your own signed-in session on those sites.
- **Access to a site you add (optional):** asked for one site at a time, only
  when you press Add This Site on it, and Chrome asks you first. It is used
  as for a listed site, and given back when you remove the site in Settings.
  Statement Sweep has no access to any other site.
- **Active tab:** to see which site you are on when you press Add This Site,
  and draw the picker there. Only when you open the extension on that tab.
- **Scripting:** to run that site's reading steps inside its page.
- **Downloads:** to save documents and give them the names you chose.
- **Storage:** to remember the items listed above.
- **Alarms:** to do the daily check of which sites are due.
- **Content settings:** to let the site you are sweeping download more than one
  file in a row, and open a document in a new window when that is how the
  site hands it over. Both are set only for that site during a sweep and
  removed when the sweep ends.
- **Debugger:** to save a document that a site shows only as a web page, such
  as a Venmo month or an Apple Store invoice, as a PDF. Chrome's own print
  makes the PDF. It is used only in a tab the sweep opened itself, only while
  that one page is printed, and is let go straight after. Chrome shows a bar
  saying Statement Sweep is debugging the browser while it does this. If you
  press Cancel on that bar, the sweep stops that site. It reads nothing else
  through it, and the page is never changed or sent anywhere.
- **Web navigation:** to tell which tab opened a new one, so that only a tab
  a site's own statement button opened from the sweep's tab is taken and
  closed. It is listened to only while that one press is waited on. Nothing
  about your browsing is kept.
- **The file hosts listed with a site** (such as
  mountain-storage.s3.amazonaws.com for Robinhood, or statements.cardless.com
  for Bilt and the Coinbase One Card): some sites open a statement on a file
  host of their own instead of downloading it. The sweep then fetches that
  one address, from that host only, without your cookies, and closes the tab
  the site opened.

## Changes and contact

Changes to this policy are published in this file and visible in its history.
Questions can be raised at
<https://github.com/JasperDale420/statement-sweep/issues>.

Statement Sweep is not made or endorsed by any bank or site it works with.
