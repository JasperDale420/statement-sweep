// Made by tools/build.py from providers/*.meta.json. Change those.
export const PROVIDERS = [
  {
    "id": "alpaca",
    "name": "Alpaca",
    "match": [
      "https://app.alpaca.markets/*"
    ],
    "listUrl": "https://app.alpaca.markets/account/documents",
    "pageFile": "providers/alpaca.page.js",
    "fileName": "{date} Alpaca {title}.pdf",
    "family": "click",
    "downloadWaitSeconds": 60
  },
  {
    "id": "amex",
    "name": "American Express",
    "match": [
      "https://global.americanexpress.com/*",
      "https://www.americanexpress.com/*"
    ],
    "listUrl": "https://global.americanexpress.com/activity/statements",
    "pageFile": "providers/amex.page.js",
    "fileName": "{date} American Express {title}.pdf",
    "family": "click",
    "downloadWaitSeconds": 90
  },
  {
    "id": "applecard",
    "name": "Apple Card",
    "match": [
      "https://card.apple.com/*"
    ],
    "listUrl": "https://card.apple.com/",
    "pageFile": "providers/applecard.page.js",
    "fileName": "{date} Apple Card Statement.pdf",
    "family": "click"
  },
  {
    "id": "chase",
    "name": "Chase",
    "match": [
      "https://secure.chase.com/*"
    ],
    "listUrl": "https://secure.chase.com/web/auth/dashboard#/dashboard/documents/myDocs/index",
    "pageFile": "providers/chase.page.js",
    "fileName": "{date} Chase {title} Statement.pdf",
    "family": "click"
  },
  {
    "id": "chasebusiness",
    "name": "Chase Business",
    "match": [
      "https://secure.chase.com/*"
    ],
    "listUrl": "https://secure.chase.com/web/auth/dashboard#/dashboard/documents/myDocs/index",
    "pageFile": "providers/chasebusiness.page.js",
    "fileName": "{date} Chase {title} Statement.pdf",
    "family": "click",
    "downloadWaitSeconds": 60
  },
  {
    "id": "coinbase",
    "name": "Coinbase",
    "match": [
      "https://accounts.coinbase.com/*",
      "https://www.coinbase.com/*"
    ],
    "listUrl": "https://accounts.coinbase.com/statements",
    "pageFile": "providers/coinbase.page.js",
    "fileName": "{date} Coinbase Monthly Statement.pdf",
    "family": "click",
    "downloadWaitSeconds": 90
  },
  {
    "id": "fidelity",
    "name": "Fidelity",
    "match": [
      "https://digitalservices.fidelity.com/*",
      "https://digital.fidelity.com/*"
    ],
    "listUrl": "https://digitalservices.fidelity.com/navigate/ent-documentcenter/statements?poe=fidcom",
    "pageFile": "providers/fidelity.page.js",
    "fileName": "{date} Fidelity {title}.pdf",
    "family": "fetch"
  },
  {
    "id": "firsthorizon",
    "name": "First Horizon Bank",
    "match": [
      "https://digital.firsthorizon.com/*"
    ],
    "listUrl": "https://digital.firsthorizon.com/#accounts/documents",
    "pageFile": "providers/firsthorizon.page.js",
    "fileName": "{date} First Horizon Bank Statement.pdf",
    "family": "click",
    "downloadWaitSeconds": 60
  },
  {
    "id": "ibkr",
    "name": "Interactive Brokers",
    "match": [
      "https://www.interactivebrokers.com/*",
      "https://www.interactivebrokers.co.uk/*",
      "https://www.interactivebrokers.ie/*"
    ],
    "listUrl": "https://www.interactivebrokers.com/AccountManagement/AmAuthentication?action=RM_STATEMENTS&service=AM.LOGIN&webaccess=true",
    "pageFile": "providers/ibkr.page.js",
    "fileName": "{date} Interactive Brokers {title}.pdf",
    "family": "click",
    "downloadWaitSeconds": 90
  },
  {
    "id": "irs",
    "name": "IRS",
    "match": [
      "https://sa.www4.irs.gov/*"
    ],
    "listUrl": "https://sa.www4.irs.gov/ola/tax_records/transcripts",
    "pageFile": "providers/irs.page.js",
    "fileName": "{date} IRS {title}.pdf",
    "family": "fetch"
  },
  {
    "id": "nelnet",
    "name": "Nelnet",
    "match": [
      "https://nelnet.studentaid.gov/*",
      "https://auth.nelnet.studentaid.gov/*"
    ],
    "listUrl": "https://nelnet.studentaid.gov/documents/inbox-statements",
    "pageFile": "providers/nelnet.page.js",
    "fileName": "{date} Nelnet {title}.pdf",
    "family": "click"
  },
  {
    "id": "optum",
    "name": "Optum Bank",
    "match": [
      "https://account.optumbank.com/*",
      "https://www.optumbank.com/*"
    ],
    "listUrl": "https://account.optumbank.com/account/help/forms",
    "pageFile": "providers/optum.page.js",
    "fileName": "{date} Optum Bank {title}.pdf",
    "family": "fetch"
  },
  {
    "id": "paypal",
    "name": "PayPal",
    "match": [
      "https://www.paypal.com/*"
    ],
    "listUrl": "https://www.paypal.com/myaccount/statements/monthly",
    "pageFile": "providers/paypal.page.js",
    "fileName": "{date} PayPal Monthly Statement.pdf",
    "family": "fetch"
  },
  {
    "id": "sdge",
    "name": "SDG&E",
    "match": [
      "https://myenergycenter.com/*"
    ],
    "listUrl": "https://myenergycenter.com/portal/BillingHistory/index",
    "pageFile": "providers/sdge.page.js",
    "fileName": "{date} SDG&E Utility Bill.pdf",
    "family": "fetch"
  },
  {
    "id": "shelbycounty",
    "name": "Shelby County Trustee",
    "match": [
      "https://apps2.shelbycountytrustee.com/*"
    ],
    "listUrl": "https://apps2.shelbycountytrustee.com/Parcel",
    "pageFile": "providers/shelbycounty.page.js",
    "fileName": "{date} Shelby County Trustee {title}.pdf",
    "family": "fetch"
  },
  {
    "id": "simmons",
    "name": "Simmons Bank",
    "match": [
      "https://login.simmonsbank.com/*"
    ],
    "listUrl": "https://login.simmonsbank.com/documents",
    "pageFile": "providers/simmons.page.js",
    "fileName": "{date} Simmons Bank {title}.pdf",
    "family": "fetch"
  },
  {
    "id": "wealthfront",
    "name": "Wealthfront",
    "match": [
      "https://www.wealthfront.com/*"
    ],
    "listUrl": "https://www.wealthfront.com/documents",
    "pageFile": "providers/wealthfront.page.js",
    "fileName": "{date} Wealthfront {title}.pdf",
    "family": "fetch"
  }
];
