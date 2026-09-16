#!/usr/bin/env python3
"""Snapshot the live InvenTree API into fixture.js for the panel harness.

    INVENTREE_URL=https://... INVENTREE_TOKEN=inv-... python3 fetch_fixture.py

fixture.js is gitignored: it is a copy of the parts database and pricing.
"""
import json
import os
import sys
import urllib.request
from pathlib import Path

BASE = os.environ.get("INVENTREE_URL", "").rstrip("/")
TOKEN = os.environ.get("INVENTREE_TOKEN", "")
if not BASE or not TOKEN:
    sys.exit("Set INVENTREE_URL and INVENTREE_TOKEN.")

# Cloudflare rejects urllib's default User-Agent with a bare 403.
HEADERS = {"Authorization": f"Token {TOKEN}", "User-Agent": "Mozilla/5.0"}


def get_all(path):
    out, offset = [], 0
    while True:
        url = f"{BASE}/api{path}?limit=500&offset={offset}"
        data = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=60))
        if isinstance(data, list):
            return data
        out += data["results"]
        offset += len(data["results"])
        if not data["results"] or offset >= data["count"]:
            return out


fixture = {f"/api{p}": get_all(p) for p in ("/company/", "/company/part/", "/company/price-break/", "/part/", "/bom/")}
fixture["/api/currency/exchange/"] = json.load(urllib.request.urlopen(
    urllib.request.Request(f"{BASE}/api/currency/exchange/", headers=HEADERS), timeout=60))

out = Path(__file__).with_name("fixture.js")
out.write_text("export default " + json.dumps(fixture) + ";\n", encoding="utf-8")
print(f"wrote {out.name}: " + ", ".join(f"{k.split('/api')[1]}={len(v)}" for k, v in fixture.items() if isinstance(v, list)))
