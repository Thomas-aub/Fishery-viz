#!/usr/bin/env python3
"""
One-off helper to download and prepare the admin-1 (region/province) boundary
layer used by the D3 visualization (light gray borders).

This is NOT required to run the visualization: without it, the map still
renders correctly with only country borders (black). Run this script once if
you also want region borders (light gray) for Madagascar, Tanzania and
Mozambique.

Usage:
    python fetch_regions.py

Requires internet access to geoBoundaries.org (no API key needed).
Writes: ./map/regions.geojson
"""

import json
import urllib.request

# =============================================================================
# CONFIG
# =============================================================================

COUNTRIES = ["MDG", "TZA", "MOZ"]  # ISO3 codes: Madagascar, Tanzania, Mozambique
RELEASE_TYPE = "gbOpen"  # one of gbOpen, gbHumanitarian, gbAuthoritative
ADM_LEVEL = "ADM1"
OUT_PATH = "./map/regions.geojson"

# =============================================================================

API_TEMPLATE = "https://www.geoboundaries.org/api/current/{release}/{iso3}/{adm}/"


def fetch_json(url):
    with urllib.request.urlopen(url) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    all_features = []

    for iso3 in COUNTRIES:
        api_url = API_TEMPLATE.format(release=RELEASE_TYPE, iso3=iso3, adm=ADM_LEVEL)
        print(f"[info] Querying metadata for {iso3}...")
        meta = fetch_json(api_url)
        geojson_url = meta["simplifiedGeometryGeoJSON"]

        print(f"[info] Downloading {geojson_url}")
        geojson_url = geojson_url.replace(
            "https://github.com/wmgeolab/geoBoundaries/raw/",
            "https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/",
        )
        geo = fetch_json(geojson_url)
        features = geo.get("features", [])
        print(f"[info] {iso3}: {len(features)} region(s)")
        all_features.extend(features)

    out_fc = {"type": "FeatureCollection", "features": all_features}

    import os
    os.makedirs(os.path.dirname(OUT_PATH) or ".", exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out_fc, f, ensure_ascii=False)

    print(f"[ok] Wrote {OUT_PATH} ({len(all_features)} regions total)")
    print("[ok] Now set REGIONS_ENABLED = true in map.js to display this layer.")


if __name__ == "__main__":
    main()
