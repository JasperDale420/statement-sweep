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
    "offers": {
      "file": "providers/amex.offers.js"
    },
    "downloadWaitSeconds": 90,
    "postsAfterDays": 1
  },
  {
    "id": "apple",
    "name": "Apple",
    "match": [
      "https://www.apple.com/*",
      "https://*.store.apple.com/*"
    ],
    "listUrl": "https://www.apple.com/shop/order/list",
    "pageFile": "providers/apple.page.js",
    "fileName": "{date} Apple {title} Invoice.pdf",
    "family": "print",
    "guide": {
      "signIn": [
        "Sign in with your Apple Account here.",
        "Choose Trust when Apple asks, so you aren't asked for a code every time.",
        "Statement Sweep goes on by itself once you're in."
      ]
    }
  },
  {
    "id": "applecard",
    "name": "Apple Card",
    "match": [
      "https://card.apple.com/*"
    ],
    "listUrl": "https://card.apple.com/",
    "pageFile": "providers/applecard.page.js",
    "fileName": "{date} Apple Card {title}.pdf",
    "family": "click",
    "guide": {
      "signIn": [
        "Sign in with your Apple Account here.",
        "Choose Trust when Apple asks, so you aren't asked for a code every time.",
        "Statement Sweep goes on by itself once you're in."
      ]
    },
    "postsAfterDays": 1
  },
  {
    "id": "bilt",
    "name": "Bilt Card",
    "match": [
      "https://www.bilt.com/*"
    ],
    "listUrl": "https://www.bilt.com/wallet",
    "pageFile": "providers/bilt.page.js",
    "fileName": "{date} Bilt Card Statement.pdf",
    "family": "click",
    "fileHosts": [
      "statements.cardless.com"
    ],
    "postsAfterDays": 1
  },
  {
    "id": "chase",
    "name": "Chase",
    "match": [
      "https://secure.chase.com/*"
    ],
    "listUrl": "https://secure.chase.com/web/auth/dashboard#/dashboard/documents/myDocs/index;mode=documents",
    "pageFile": "providers/chase.page.js",
    "fileName": "{date} Chase {title} Statement.pdf",
    "family": "click",
    "offers": {
      "file": "providers/chase.offers.js",
      "url": "https://secure.chase.com/web/auth/dashboard#/dashboard/merchantOffers/offer-hub",
      "cards": "personal"
    },
    "guide": {
      "signIn": [
        "Sign in to Chase here.",
        "Statement Sweep finds your statements by itself once you're in."
      ]
    },
    "postsAfterDays": 1
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
    "offers": {
      "file": "providers/chase.offers.js",
      "url": "https://secure.chase.com/web/auth/dashboard#/dashboard/merchantOffers/offer-hub",
      "cards": "business"
    },
    "downloadWaitSeconds": 60
  },
  {
    "id": "coinbase",
    "name": "Coinbase",
    "match": [
      "https://accounts.coinbase.com/*",
      "https://www.coinbase.com/*",
      "https://tax-center-forms-production.s3.amazonaws.com/*"
    ],
    "fileHosts": [
      "statements.cardless.com"
    ],
    "listUrl": "https://accounts.coinbase.com/statements",
    "pageFile": "providers/coinbase.page.js",
    "fileName": "{date} Coinbase {title}.pdf",
    "family": "click",
    "downloadWaitSeconds": 90,
    "postsAfterDays": 1
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
    "family": "fetch",
    "postsAfterDays": 4
  },
  {
    "id": "firsthorizon",
    "name": "First Horizon Bank",
    "match": [
      "https://digital.firsthorizon.com/*"
    ],
    "listUrl": "https://digital.firsthorizon.com/#accounts/documents",
    "pageFile": "providers/firsthorizon.page.js",
    "fileName": "{date} First Horizon Bank {title}.pdf",
    "family": "click",
    "downloadWaitSeconds": 60,
    "postsAfterDays": 1
  },
  {
    "id": "ibkr",
    "name": "Interactive Brokers",
    "match": [
      "https://*.interactivebrokers.com/*",
      "https://*.interactivebrokers.co.uk/*",
      "https://*.interactivebrokers.ie/*"
    ],
    "listUrl": "https://www.interactivebrokers.com/AccountManagement/AmAuthentication?action=RM_STATEMENTS&service=AM.LOGIN&webaccess=true",
    "pageFile": "providers/ibkr.page.js",
    "fileName": "{date} Interactive Brokers {title}.pdf",
    "family": "click",
    "downloadWaitSeconds": 90,
    "guide": {
      "signIn": [
        "Sign in to Interactive Brokers here, with your usual second step.",
        "Statement Sweep goes on by itself once you're in."
      ]
    },
    "postsAfterDays": 3
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
      "https://nelnet.studentaid.gov/*"
    ],
    "listUrl": "https://nelnet.studentaid.gov/documents/inbox-statements",
    "pageFile": "providers/nelnet.page.js",
    "fileName": "{date} Nelnet {title}.pdf",
    "family": "click"
  },
  {
    "id": "netbenefits",
    "name": "Fidelity NetBenefits",
    "match": [
      "https://workplaceservices.fidelity.com/*",
      "https://nb.fidelity.com/*"
    ],
    "listUrl": "https://workplaceservices.fidelity.com/mybenefits/savings2/navigation/dc/OnlineStatement",
    "pageFile": "providers/netbenefits.page.js",
    "fileName": "{date} NetBenefits {title}.pdf",
    "family": "print",
    "guide": {
      "signIn": [
        "Sign in to NetBenefits here.",
        "Statement Sweep goes on by itself once you're in."
      ]
    },
    "postsAfterDays": 18
  },
  {
    "id": "optum",
    "name": "Optum Bank",
    "match": [
      "https://account.optumbank.com/*"
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
    "family": "fetch",
    "postsAfterDays": 15
  },
  {
    "id": "robinhood",
    "name": "Robinhood",
    "match": [
      "https://robinhood.com/*"
    ],
    "listUrl": "https://robinhood.com/account/reports-statements/individual",
    "pageFile": "providers/robinhood.page.js",
    "fileName": "{date} Robinhood {title}.pdf",
    "family": "click",
    "fileHosts": [
      "mountain-storage.s3.amazonaws.com"
    ],
    "postsAfterDays": 5
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
    "family": "fetch",
    "postsAfterDays": 0
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
    "family": "fetch",
    "guide": {
      "waiting": [
        "Search by owner, address or parcel number.",
        "Open your parcel.",
        "Statement Sweep remembers it and does this by itself next time."
      ]
    },
    "mainFile": "providers/shelbycounty.main.js"
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
    "id": "spectrum",
    "name": "Spectrum",
    "match": [
      "https://www.spectrum.net/*"
    ],
    "listUrl": "https://www.spectrum.net/billing/statements",
    "pageFile": "providers/spectrum.page.js",
    "fileName": "{date} Spectrum {title}.pdf",
    "family": "click"
  },
  {
    "id": "statefarm",
    "name": "State Farm",
    "match": [
      "https://edocuments.statefarm.com/*"
    ],
    "listUrl": "https://edocuments.statefarm.com/DocumentCenterUI/",
    "pageFile": "providers/statefarm.page.js",
    "fileName": "{date} State Farm {title}.pdf",
    "family": "fetch",
    "downloadWaitSeconds": 60,
    "fileHosts": [
      "documentinformationservice-prod-custdocmgmtweb.apps.gdrosa.redk8s.statefarm.com"
    ]
  },
  {
    "id": "treasurydirect",
    "name": "TreasuryDirect",
    "match": [
      "https://www.treasurydirect.gov/*",
      "https://treasurydirect.gov/*"
    ],
    "listUrl": "https://www.treasurydirect.gov/RS/UN-Display.do",
    "pageFile": "providers/treasurydirect.page.js",
    "fileName": "{date} TreasuryDirect {title}.pdf",
    "family": "print",
    "guide": {
      "signIn": [
        "Sign in to TreasuryDirect here.",
        "Stay on your Account Summary. Statement Sweep carries on in this tab."
      ]
    }
  },
  {
    "id": "trinet",
    "name": "TriNet",
    "match": [
      "https://trinet.hrpassport.com/*"
    ],
    "listUrl": "https://trinet.hrpassport.com/ui-hr-portal-money/#/paychecks-and-statements",
    "pageFile": "providers/trinet.page.js",
    "fileName": "{date} TriNet {title}.pdf",
    "family": "fetch",
    "guide": {
      "signIn": [
        "Sign in to TriNet in this tab.",
        "Statement Sweep carries on once you are in."
      ]
    }
  },
  {
    "id": "venmo",
    "name": "Venmo",
    "match": [
      "https://account.venmo.com/*"
    ],
    "listUrl": "https://account.venmo.com/statement",
    "pageFile": "providers/venmo.page.js",
    "fileName": "{date} Venmo {title}.pdf",
    "family": "print",
    "postsAfterDays": 8
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
