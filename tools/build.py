#!/usr/bin/env python3
"""Make providers/index.js and manifest.json's site list from providers/*.meta.json."""
import json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
metas = [m for m in (json.loads(p.read_text()) for p in sorted((ROOT / "providers").glob("*.meta.json"))) if m.get("enabled", True)]
NEED = {"id", "name", "match", "listUrl", "pageFile", "fileName", "family"}
hosts = set()
for m in metas:
    missing = NEED - set(m)
    assert not missing, (m.get("id"), missing)
    assert (ROOT / m["pageFile"]).is_file(), m["pageFile"]
    assert all(h.startswith("https://") and h.endswith("/*") for h in m["match"]), m["id"]
    hosts.update(m["match"])
    # Exact hosts a press may open a PDF on (capture.js), fetched only from there.
    for h in m.get("fileHosts", []):
        assert re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", h), (m["id"], h)
        hosts.add(f"https://{h}/*")
    # Card offers (offers.js): an offers recipe, which kind of card it is for,
    # and an offers page on the site's own exact hosts. A site whose sign-in
    # it shares with another (Chase and Chase Business) must say which kind.
    o = m.get("offers")
    if o is not None:
        assert isinstance(o, dict) and set(o) <= {"file", "url", "cards"}, (m["id"], "offers keys", o)
        assert re.fullmatch(r"providers/[a-z0-9]+\.offers\.js", o.get("file", "")) and (ROOT / o["file"]).is_file(), (m["id"], o)
        assert o.get("cards", "") in ("", "personal", "business"), (m["id"], "offers cards", o.get("cards"))
        if "url" in o:
            assert any(o["url"].startswith(h[:-1]) for h in m["match"] if "*." not in h), (m["id"], o["url"])
    # How many days after its own date a site usually posts a document
    # (cadence.js postingLag), until the extension has learned its own.
    if "postsAfterDays" in m:
        assert isinstance(m["postsAfterDays"], int) and 0 <= m["postsAfterDays"] <= 45, (m["id"], "postsAfterDays")
    # A file the engine puts in the page's own world before a save (world MAIN).
    if "mainFile" in m:
        assert re.fullmatch(r"providers/[a-z0-9]+\.main\.js", m["mainFile"]) and (ROOT / m["mainFile"]).is_file(), (m["id"], m["mainFile"])
    # The guide card's steps (guide.js): one to three short plain lines per wait.
    guide = m.get("guide", {})
    assert isinstance(guide, dict) and set(guide) <= {"signIn", "waiting", "challenge"}, (m["id"], "guide keys", guide)
    for kind, steps in guide.items():
        assert isinstance(steps, list) and 1 <= len(steps) <= 3, (m["id"], "guide", kind, "1 to 3 steps")
        for s in steps:
            assert isinstance(s, str) and s.strip() and len(s) <= 80 and "<" not in s, (m["id"], "guide", kind, s)
# Sites that share one sign-in and one offers recipe must each say which kind
# of card is theirs, and no two the same kind, so a card is never added to twice.
shared = {}
for m in metas:
    if m.get("offers"):
        shared.setdefault(m["offers"]["file"], []).append(m)
for file, ms in shared.items():
    if len(ms) > 1:
        kinds = [m["offers"].get("cards", "") for m in ms]
        assert all(kinds) and len(set(kinds)) == len(kinds), (file, "offers cards must differ", kinds)
(ROOT / "providers" / "index.js").write_text(
    "// Made by tools/build.py from providers/*.meta.json. Change those.\n"
    "export const PROVIDERS = " + json.dumps(metas, indent=2) + ";\n")
manifest = json.loads((ROOT / "manifest.json").read_text())
manifest["host_permissions"] = sorted(hosts)
# Add This Site asks for one more https site at a time, only when you add it
# (sites.js). Kept here so a rebuilt manifest never loses it.
manifest["optional_host_permissions"] = ["https://*/*"]
if len(sys.argv) > 1 and sys.argv[1] == "--test":
    manifest["host_permissions"].append("http://127.0.0.1/*")
(ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(len(metas), "providers,", len(hosts), "sites")
