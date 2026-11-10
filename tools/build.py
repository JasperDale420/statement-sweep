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
(ROOT / "providers" / "index.js").write_text(
    "// Made by tools/build.py from providers/*.meta.json. Change those.\n"
    "export const PROVIDERS = " + json.dumps(metas, indent=2) + ";\n")
manifest = json.loads((ROOT / "manifest.json").read_text())
manifest["host_permissions"] = sorted(hosts)
if len(sys.argv) > 1 and sys.argv[1] == "--test":
    manifest["host_permissions"].append("http://127.0.0.1/*")
(ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(len(metas), "providers,", len(hosts), "sites")
