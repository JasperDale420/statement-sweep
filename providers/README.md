# Writing a provider

Each provider is two files. `tools/build.py` makes the rest.

`providers/<id>.meta.json`

| key | meaning |
|---|---|
| `id`, `name` | short id, and the name people know it by |
| `match` | `["https://host/*"]`, every host its pages and PDFs use, and no others |
| `listUrl` | the page holding the document list |
| `pageFile` | `providers/<id>.page.js` |
| `fileName` | e.g. `{date} Chase Statement.pdf`; may use `{date}`, `{title}`, `{id}` |
| `family` | `fetch`, `click` or `print`, how its documents are usually saved |
| `downloadWaitSeconds` | optional, for `click` and `newtab`: how long a site may take to start a download or open its tab; 45 if unset |
| `fileHosts` | optional, for `newtab`: exact hosts outside `match` a press may open its PDF on, such as `mountain-storage.s3.amazonaws.com`; fetched only from there, without cookies |
| `guide` | optional: `{signIn?, waiting?, challenge?}`, each 1 to 3 short steps (under about 70 characters, plain words) for the card drawn in the site's tab while it waits for the person (guide.js): `signIn` for `signed_out` and an off-host sign-in, `waiting` for `waiting`, `challenge` for `challenge`. Without one the card says a general line, or the recipe's own `why` for `waiting`. A `stopped` answer is not a wait and gets no card |

`providers/shared.js` is loaded first, and gives `__sweepPdf.pdfResult(bytes)` and `__sweepLog(text)` (see Logs).

`providers/<id>.page.js` runs inside the provider's own page, in the
extension's isolated world, and sets `globalThis.__sweep`:

- `readList({walk})`, sync or async, answers one of:
  - `{state: "signed_out"}` or `{state: "challenge"}` when the person is needed
  - `{state: "waiting", why: "..."}` when the site needs one thing from the person that is not a sign-in (a parcel lookup), said in `why`
  - `{state: "no_list"}` when this is not the list page yet
  - `{state: "walking"}` when `walk` is true and it pressed, or is waiting on, the site's own link toward the list
  - `{state: "ok", docs: [...], note?: "..."}`, **newest first**, `note` being shown beside the count
  - `{state: "stopped", why: "...", docs: [...]}` when it cannot be sure
- a doc is `{id, date: "YYYY-MM-DD", title?, method, url?}`, `method` being:
  - `fetch`: `fetchPdf(doc)` returns `{ok, base64, size}`, or `{ok: false, why, signedOut?}`
  - `click`: `clickDoc(doc)` presses the site's own download control and returns `{ok}`
  - `newtab`: `clickDoc(doc)` presses a control that opens the PDF in a new tab, or sends this tab to a `fileHosts` address; the engine takes it (capture.js)
  - `print`: `showDoc(doc)` brings a web-page document on screen in this tab, `printReady(doc)` says when it is whole, and the engine prints it with Chrome's debugger, only in a tab it opened; optional `leaveDoc(doc)` goes back to the list (capture.js)

A `click` doc may carry `nameMustMatch`, a regular expression the site's own file name must match.
A provider that cannot save anything yet is kept with `"enabled": false`, and gets no access to its site.

## Rules

- Read and download only. Never submit a form, change a setting, or move money.
- Press only a document's own download or view control.
- Never type a password, answer a check, or work around a sign-in or CAPTCHA.
  Answer `signed_out` or `challenge` and wait for the person.
- Only same-site requests, to the hosts in `match`.
- When something is not what is expected, answer `stopped`. Never guess a date.
- Keep a PDF only if its bytes start `%PDF-`.
- Nothing about the account may be sent anywhere, or logged beyond the short lines below.

## Logs

Each run writes a plain-text log per site (log.js), so what a site did and
why it stopped can be read from disk without the popup:

- `<chosen folder>/<main folder>/<site folder>/Logs/run-YYYYMMDD-HHMMSS.log`, the
  site folder being the one its PDFs are saved in, and
- `<chosen folder>/<main folder>/Logs/run-YYYYMMDD-HHMMSS.log`, one line per site:
  its final state, how many saved and failed, its line on the board, and how long it took.

A line reads `2026-10-12 16:43:32.244 INFO   chase: page: Cards: 1`. The engine
logs each `readList` answer, which tab it used and why, sign-in waits, each
document's method, outcome and size, new tabs and the debugger, and every
error with its stack. The logs are written again every few seconds while a
site runs, so one that hangs has its log so far on disk. The last 30 runs are
kept per Logs folder. With no folder chosen, the latest 2000 lines per site
are kept in `chrome.storage.local` under `log:<id>` (and `log:runs`), for
Settings' Export Logs.

A recipe adds its own line with `globalThis.__sweepLog && globalThis.__sweepLog("...")`:
which layout it saw, what it found, why it stopped. The lines wait in the page
and come back on the next `readList`, `clickDoc` or `nextView` answer as
`log: [...]`, which the engine takes. Keep them short, and in the recipe's own
words: never the page's text beyond a label it already reads, never a cookie,
token or a document's contents. Every run of 5 or more digits is cut to its
last 4, and addresses lose their query and fragment (a `#/` route keeps its
path), but do not rely on that.
