"""Every browser the tests start answers only what a test routes. A request no
route takes (a typo'd address, a site's own script, Chrome's own traffic) finds
no host instead of reaching the internet, so a test never depends on, or
sends anything to, a real site."""
from playwright.sync_api import BrowserType

OFFLINE = "--host-resolver-rules=MAP * ~NOTFOUND"
_launch = BrowserType.launch


def _offline_launch(self, *a, args=None, **kw):
    # Chrome takes the last copy of a switch, so a test that maps hosts itself
    # (to a local server it runs, all of them) keeps its own rules.
    args = list(args or [])
    if not any(str(x).startswith("--host-resolver-rules") for x in args):
        args.append(OFFLINE)
    return _launch(self, *a, args=args, **kw)


BrowserType.launch = _offline_launch
