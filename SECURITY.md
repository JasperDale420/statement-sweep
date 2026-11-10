# Security

Statement Sweep runs in people's financial accounts, so a security problem is
taken seriously and fixed first.

## Reporting

Please report privately, through GitHub's **Report a vulnerability** button
on this repository's Security tab. Do not open a public issue, and do not
include anyone's statements, account numbers or sign-in details.

Say what an attacker could do, which version (`manifest.json`) and site it
affects, and how to see it happen. You will hear back within a week.

## In scope

- A recipe pressing, submitting or fetching anything beyond a document's own
  download or view control, or an offer's own Add control.
- Data about an account leaving the browser, or reaching a host outside the
  site's `match` and `fileHosts`.
- A page on a site being able to drive the extension, read what it saved, or
  read another site's data.
- Logs or the history export holding more than the masked lines they promise.

## Out of scope

- A site changing its pages so a recipe stops saving. That is a bug: use the
  **A site broke** issue form.
- Problems that need someone already in control of your computer or Chrome
  profile.
