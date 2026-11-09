#!/usr/bin/env python3
"""Make providers/index.js and manifest.json's site list from providers/*.meta.json."""
import json, pathlib, sys

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
(ROOT / "providers" / "index.js").write_text(
    "// Made by tools/build.py from providers/*.meta.json. Change those.\n"
    "export const PROVIDERS = " + json.dumps(metas, indent=2) + ";\n")
manifest = json.loads((ROOT / "manifest.json").read_text())
manifest["host_permissions"] = sorted(hosts)
if len(sys.argv) > 1 and sys.argv[1] == "--test":
    manifest["host_permissions"].append("http://127.0.0.1/*")
(ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(len(metas), "providers,", len(hosts), "sites")
