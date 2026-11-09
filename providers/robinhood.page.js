// Runs inside Robinhood's own page, where the sign-in already lives. It reads
// the individual investing statements page and presses a statement's own
// download control, and nothing else. This is an account that can trade, so
// a control must read as a download and match nothing on the blocklist.
//
// Derived from PaperPull's apps/robinhood/robinhood_site.py (AGPL-3.0).
(() => {
  const STATEMENTS = "/account/reports-statements/individual";
  const LOGIN = ["/login", "/signin", "/sign-in", "/auth", "/mfa", "/verification", "/challenge"];
  const CHALLENGE = ["enter the code", "verification code", "6-digit", "two-factor", "two-step", "authenticator",
    "confirm your identity", "verify your identity", "we sent a code", "device approval", "approve this login",
    "unusual", "are you a robot", "captcha", "let's verify", "check your email", "check your phone",
    "your session has expired", "log back in"];
  const RATE_LIMIT = ["too many requests", "rate limit", "try again later", "temporarily unavailable",
    "http error 429", "unusual traffic"];
  const ROWS = "table tbody tr, [role='row'], [class*='documentRow'], [class*='DocumentRow'], [class*='row'][class*='document'], [data-testid*='document'], li[class*='document']";
  const CONTROLS = "a[download], a, button, [role=button]";
  const TITLE = /([A-Z][a-z]+ \d{4}[^\n]*Statement|[^\n]*Consolidated[^\n]*1099[^\n]*|[^\n]*Form 1099[^\n]*|[^\n]*\b1099\b[^\n]*|[^\n]*\b1042-?S\b[^\n]*|[^\n]*\b5498\b[^\n]*)/;
  const MORE = /^\s*(show|load|view|see)\s+more\s*$|^\s*view\s+all\s*$|^\s*older\s*$/i;
  const WAIT_MS = 12000;
  const FORBIDDEN = new RegExp("(buy\\b|sell\\b|trade\\b|place\\s+order|review\\s+order|submit\\s+order|"
    + "cancel\\s+order|market\\s+order|limit\\s+order|stop\\s+order|transfer|withdraw|deposit|wire\\b|move\\s+money|send\\b|receive\\b|"
    + "convert|swap\\b|exchange\\b|stake\\b|unstake\\b|earn\\b|lend\\b|exercise|close\\s+position|sell\\s+all|liquidate|"
    + "options?\\b|margin\\b|borrow\\b|gold\\b|subscribe|apply|open\\s+\\w*\\s*account|fund\\b|add\\s+money|link\\s+(bank|account)|"
    + "enable|disable|activate|\\bchange\\s+|\\bedit\\s+|\\bupdate\\s+|set\\s+up|delete|remove|close\\s+account|beneficiar|password|"
    + "generate\\s+report|create\\s+report|generate\\b|confirm|continue|next\\b|agree|accept|authorize)", "i");
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const tidy = (s) => (s || "").replace(/\s+/g, " ").trim();
  const ownLabel = (el) => `${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`.trim();
  const shown = (el) => el.getClientRects().length > 0;
  const onStatements = () => location.hostname === "robinhood.com" && location.pathname.replace(/\/$/, "") === STATEMENTS;

  function signedOut() {
    const url = location.href.toLowerCase();
    return LOGIN.some((m) => url.includes(m)) || Boolean(document.querySelector("input[type='password']"));
  }

  function asking() {
    if (document.querySelectorAll(ROWS).length > 2) return null;
    const text = `${document.title}\n${(document.body ? document.body.innerText : "").slice(0, 1500)}`.toLowerCase();
    if (CHALLENGE.some((m) => text.includes(m))) return "challenge";
    if (RATE_LIMIT.some((m) => text.includes(m))) return "rate";
    return null;
  }

  function real(year, month, day) {
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
      ? d.toISOString().slice(0, 10) : null;
  }

  // A statement's date as its title gives it: an exact day, or a month as that
  // month's last day. A title naming neither has no date.
  function titleDate(title) {
    const name = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
    let m = new RegExp(`${name}\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i").exec(title);
    if (m) return real(+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2]);
    m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(title);
    if (m) return real(+m[3], +m[1], +m[2]);
    m = /\b(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(title);
    if (m) return real(+m[1], +m[2], +m[3]);
    m = new RegExp(`${name}\\s+(\\d{4})`, "i").exec(title);
    if (m) return new Date(Date.UTC(+m[2], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, 0)).toISOString().slice(0, 10);
    return null;
  }

  function cleaned(title) {
    return tidy(title).replace(/\s*Download (PDF|CSV|HTML)\s*/gi, " ").trim();
  }

  // Every statement control on the page, as {el, title, html}, in page order.
  // A statement link's own text is its title; a "Download PDF" button finds
  // the title in the box around it.
  function controls() {
    const out = [];
    for (const el of document.querySelectorAll(CONTROLS)) {
      const own = ownLabel(el);
      if (/download\s*csv/i.test(own)) continue;
      const button = /download\s*(pdf|html)/i.test(own);
      let title = "";
      if (el.hasAttribute("download") && TITLE.test(own)) {
        title = own;
      } else if (button) {
        let node = el;
        for (let i = 0; i < 12 && node; i++) {
          node = node.parentElement;
          const m = ((node && node.innerText) || "").match(TITLE);
          if (m) { title = m[1]; break; }
        }
      } else {
        continue;
      }
      const name = cleaned(title);
      if (name.length >= 4) out.push({ el, title: name, html: /download\s*html/i.test(own) });
    }
    return out;
  }

  // Whether a control may be pressed: it offers a download, it is no CSV, and
  // a control without the download attribute must pass the blocklist.
  function pressable(el) {
    const own = ownLabel(el);
    if (!el.hasAttribute("download") && !/download/i.test(own)) return false;
    if (/csv/i.test(own)) return false;
    return el.hasAttribute("download") || !FORBIDDEN.test(own);
  }

  function moreShowing() {
    return Array.from(document.querySelectorAll("a, button, [role=button]"))
      .some((el) => MORE.test(tidy(el.innerText)) && shown(el));
  }

  async function readList() {
    const until = Date.now() + WAIT_MS;
    for (;;) {
      if (signedOut()) return { state: "signed_out" };
      const check = asking();
      if (check === "challenge") return { state: "challenge" };
      if (check === "rate") return { state: "stopped", why: "Robinhood is asking for a pause. Try again later.", docs: [] };
      if (!onStatements()) return { state: "no_list" };
      if (controls().length > 0) break;
      if (Date.now() >= until) return { state: "stopped", why: "Robinhood's statements page showed no statements.", docs: [] };
      await sleep(300);
    }
    const docs = [];
    const seen = new Set();
    let undated = 0, html = 0, refused = 0;
    for (const { el, title, html: isHtml } of controls()) {
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (isHtml) { html += 1; continue; }
      if (!pressable(el)) { refused += 1; continue; }
      const date = titleDate(title);
      if (!date) { undated += 1; continue; }
      docs.push({ id: title, date, title, method: "click" });
    }
    docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (undated) return { state: "stopped", why: "A statement's title named no date this can read.", docs };
    if (refused) return { state: "stopped", why: "A statement's control did not read as a download.", docs };
    if (html) return { state: "stopped", why: `${html} statement(s) are offered only as a web page, which this cannot save as an official PDF.`, docs };
    if (moreShowing()) return { state: "stopped", why: "Robinhood's list goes on behind View More, and this reads only the statements shown.", docs };
    return { state: "ok", docs };
  }

  function clickDoc(doc) {
    const want = (doc && doc.title) || "";
    if (!want || want !== (doc && doc.id)) return { ok: false, why: "not a statement this listed" };
    if (signedOut() || !onStatements()) return { ok: false, why: "This is not a signed-in statements page." };
    const hits = controls().filter((c) => c.title === want && !c.html && pressable(c.el));
    const hit = hits.find((c) => shown(c.el)) || hits[0];
    if (!hit) return { ok: false, why: "Its control was not there." };
    if (titleDate(hit.title) !== doc.date) return { ok: false, why: "Its date on the page has changed." };
    hit.el.click();
    return { ok: true };
  }

  globalThis.__sweep = { readList, clickDoc };
})();
