#!/usr/bin/env python3
"""Fetch the KCD Roleplay realm data and print a small prices.json for the site.

Keeps only what the calculator needs: the market (realm) prices and the auction houses'
figures of every good. Usage: python3 tools/fetch_prices.py [world] > prices.json
"""
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone

WORLD = sys.argv[1] if len(sys.argv) > 1 else "ru"
URL = f"https://account.kcdroleplay.com/api/ucp/realm?world={WORLD}"


def fetch():
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(URL, headers={"User-Agent": "kcdrp-smith price mirror (GitHub Actions)"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:  # network hiccup: wait and retry
            last = e
            time.sleep(5 * (attempt + 1))
    raise SystemExit(f"fetch failed: {last}")


def main():
    d = fetch()
    market = {e["id"]: {"price": e.get("price"), "buy": e.get("buy")} for e in d.get("market", [])}
    auction = {}
    for a in d.get("auction", {}).get("items", []):
        item = a.get("item", "")
        if not item.startswith("good:"):
            continue
        auction[item[5:]] = {k: a.get(k) for k in ("name", "low", "avg", "instant", "qty", "sold")}
    if not market or not auction:
        raise SystemExit("unexpected answer: no market or auction")
    out = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "world": WORLD,
        "source": URL,
        "market": market,
        "auction": auction,
    }
    json.dump(out, sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
