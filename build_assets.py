#!/usr/bin/env python3
"""Emit content-hashed copies of the widget JS, plus a Vite-style manifest.

Why this exists: browsers cache plugin ES modules for `max-age=14400`, and the
module URL the frontend builds is `origin + pathname` -- it drops any query
string, which is why a `?v=` cache-buster both failed and broke loading. The
only reliable cache-buster is a different filename.

InvenTree supports exactly this. `plugin_static_file()` calls
`hashed_file_lookup()`, which reads `<static>/.vite/manifest.json` and, when an
entry matches the requested filename, serves the hashed file instead. So a new
release produces new URLs and no stale copy can be served -- by the browser or
by Cloudflare.

Run before committing a release:  python3 build_assets.py
"""

import hashlib
import json
import re
import shutil
from pathlib import Path

STATIC = Path(__file__).parent / "ltrj_dashboard" / "static"
MANIFEST = STATIC / ".vite" / "manifest.json"
HASHED = re.compile(r"^(.+)-[0-9a-f]{8}\.js$")
IMPORT = re.compile(r"""(from\s+['"]\./)([A-Za-z0-9_]+)(\.js['"])""")


def sources():
    """The hand-written modules -- everything that is not a build output."""
    return sorted(p for p in STATIC.glob("*.js") if not HASHED.match(p.name))


def local_deps(text):
    return {m.group(2) for m in IMPORT.finditer(text)}


def main():
    # Start clean, so a renamed or deleted module cannot leave a stale artifact
    # behind that the manifest no longer references.
    for p in STATIC.glob("*.js"):
        if HASHED.match(p.name):
            p.unlink()
    if MANIFEST.parent.exists():
        shutil.rmtree(MANIFEST.parent)

    text = {p.stem: p.read_text(encoding="utf-8") for p in sources()}
    hashed = {}

    # Resolve in dependency order: a module's hash depends on the hashed names
    # of what it imports, so importees must be emitted first.
    pending = dict(text)
    while pending:
        ready = [n for n, t in pending.items() if local_deps(t) <= hashed.keys()]
        if not ready:
            raise SystemExit(f"Import cycle or missing module among: {sorted(pending)}")
        for name in sorted(ready):
            body = IMPORT.sub(lambda m: m.group(1) + hashed[m.group(2)] + m.group(3), pending.pop(name))
            digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:8]
            out = f"{name}-{digest}.js"
            (STATIC / out).write_text(body, encoding="utf-8")
            hashed[name] = Path(out).stem

    manifest = {
        f"{name}.js": {"file": f"{stem}.js", "src": f"{name}.js", "isEntry": True}
        for name, stem in sorted(hashed.items())
    }
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    for name, stem in sorted(hashed.items()):
        print(f"  {name}.js -> {stem}.js")
    print(f"  manifest: {MANIFEST.relative_to(Path(__file__).parent)} ({len(manifest)} entries)")


if __name__ == "__main__":
    main()
