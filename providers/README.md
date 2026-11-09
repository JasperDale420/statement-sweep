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
| `downloadWaitSeconds` | optional, for `click`: how long a site may take to start a download; 45 if unset |

`providers/shared.js` is loaded first, and gives `__sweepPdf.pdfResult(bytes)`.

`providers/<id>.page.js` runs inside the provider's own page, in the
extension's isolated world, and sets `globalThis.__sweep`:

- `readList({walk})`, sync or async, answers one of:
  - `{state: "signed_out"}` or `{state: "challenge"}` when the person is needed
  - `{state: "no_list"}` when this is not the list page yet
  - `{state: "walking"}` when `walk` is true and it pressed, or is waiting on, the site's own link toward the list
  - `{state: "ok", docs: [...], note?: "..."}`, **newest first**, `note` being shown beside the count
  - `{state: "stopped", why: "...", docs: [...]}` when it cannot be sure
- a doc is `{id, date: "YYYY-MM-DD", title?, method, url?}`, `method` being:
  - `fetch`: `fetchPdf(doc)` returns `{ok, base64, size}`, or `{ok: false, why, signedOut?}`
  - `click`: `clickDoc(doc)` presses the site's own download control and returns `{ok}`
  - `print`: not built. It would need Chrome's debugger permission, and the file would not be an official one

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
- Nothing about the account may be sent anywhere or logged.
