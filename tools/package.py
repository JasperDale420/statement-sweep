#!/usr/bin/env python3
"""Make the Chrome Web Store upload: only what the extension runs, and only the
recipes of the providers that are switched on."""
import json, pathlib, zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
FILES = ["manifest.json", "background.js", "naming.js", "folders.js", "options.html", "options.js", "popup.html", "popup.js", "ui.css",
         "LICENSE", "NOTICE.md", "PRIVACY.md", "providers/index.js", "providers/shared.js"]

manifest = json.loads((ROOT / "manifest.json").read_text())
assert not any("127.0.0.1" in h or h.startswith("http://") for h in manifest["host_permissions"]), "a test build's site list"
metas = [m for m in (json.loads(p.read_text()) for p in sorted((ROOT / "providers").glob("*.meta.json"))) if m.get("enabled", True)]
icons = sorted(p.relative_to(ROOT).as_posix() for p in (ROOT / "icons").glob("*.png"))
names = FILES + icons + [m["pageFile"] for m in metas]

out = ROOT / "dist" / f"statement-sweep-{manifest['version']}.zip"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for name in names:
        z.write(ROOT / name, name)
print(out.relative_to(ROOT), f"{len(names)} files, {out.stat().st_size / 1024:.0f} KB, {len(metas)} providers")
