#!/usr/bin/env python3
"""Make the Chrome Web Store upload: only what the extension runs, and only the
recipes of the providers that are switched on. It refuses to run while a
packaged file differs from what is committed, or while providers/index.js or
manifest.json is not what tools/build.py makes, so the upload is always a
commit anyone can read."""
import json, pathlib, shutil, subprocess, sys, tempfile, zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
FILES = ["manifest.json", "background.js", "capture.js", "naming.js", "cadence.js", "folders.js", "log.js", "guide.js", "options.html", "options.js", "sites-settings.js", "history.js", "popup.html", "popup.js", "ui.css",
         "LICENSE", "NOTICE.md", "PRIVACY.md", "providers/index.js", "providers/shared.js",
         "offers.js", "offers-settings.js", "offers.html", "offers-page.js", "providers/offers-kit.js", "progress.js",
         # Add This Site: the site list, the popup's link, the picker, Settings' part and the one recipe for added sites.
         "sites.js", "add-site.js", "picker.js", "added-settings.js", "providers/added.page.js"]

manifest = json.loads((ROOT / "manifest.json").read_text())
assert not any("127.0.0.1" in h or h.startswith("http://") for h in manifest["host_permissions"]), "a test build's site list"
metas = [m for m in (json.loads(p.read_text()) for p in sorted((ROOT / "providers").glob("*.meta.json"))) if m.get("enabled", True)]
icons = sorted(p.relative_to(ROOT).as_posix() for p in (ROOT / "icons").glob("*.png"))
# Chase and Chase Business share one offers file, which is zipped once.
offers = sorted({m["offers"]["file"] for m in metas if m.get("offers")})
names = FILES + icons + [m["pageFile"] for m in metas] + [m["mainFile"] for m in metas if m.get("mainFile")] + offers

changed = subprocess.run(["git", "status", "--porcelain", "--", *names], cwd=ROOT, capture_output=True, text=True, check=True).stdout
if changed:
    sys.exit("Not packaged: these files differ from what is committed. Commit them first.\n" + changed)
# Build in a copy, so a stale site list is said, not quietly fixed here.
with tempfile.TemporaryDirectory() as tmp:
    copy = pathlib.Path(tmp)
    shutil.copytree(ROOT / "providers", copy / "providers")
    (copy / "tools").mkdir()
    shutil.copy2(ROOT / "tools" / "build.py", copy / "tools" / "build.py")
    shutil.copy2(ROOT / "manifest.json", copy / "manifest.json")
    built = subprocess.run([sys.executable, "tools/build.py"], cwd=copy, capture_output=True, text=True)
    if built.returncode:
        sys.exit("Not packaged: tools/build.py failed.\n" + built.stderr)
    stale = [n for n in ("providers/index.js", "manifest.json") if (copy / n).read_bytes() != (ROOT / n).read_bytes()]
if stale:
    sys.exit(f"Not packaged: {' and '.join(stale)} out of date. Run python3 tools/build.py and commit the result.")

out = ROOT / "dist" / f"statement-sweep-{manifest['version']}.zip"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for name in names:
        z.write(ROOT / name, name)
print(out.relative_to(ROOT), f"{len(names)} files, {out.stat().st_size / 1024:.0f} KB, {len(metas)} providers")
