"""Every browser the tests start answers only what a test routes. A request no
route takes (a typo'd address, a site's own script, Chrome's own traffic) finds
no host instead of reaching the internet, so a test never depends on, or
sends anything to, a real site."""
from playwright.sync_api import BrowserType

OFFLINE = "--host-resolver-rules=MAP * ~NOTFOUND"
_launch = BrowserType.launch


def _offline_launch(self, *a, args=None, **kw):
    return _launch(self, *a, args=[*(args or []), OFFLINE], **kw)


BrowserType.launch = _offline_launch
