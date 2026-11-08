// Adding a provider means one entry here and one page file beside it.
export const PROVIDERS = [{
  id: "sdge",
  name: "SDG&E",
  match: "https://myenergycenter.com/*",
  listUrl: "https://myenergycenter.com/portal/BillingHistory/index",
  pageFile: "providers/sdge.page.js",
  fileName: (bill) => `${bill.date} SDG&E Utility Bill.pdf`,
}];
