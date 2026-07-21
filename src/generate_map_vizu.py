import sys
import math
import json
import argparse
from pathlib import Path

"""
python mapping/generate_map_vizu.py \
  --geojson-dir data/inference/geojson \
  --tif-dir data/inference/enhanced \
  --output mapping/map/density_map_data.json
"""


def bbox_dimensions_km(bbox):
    """Returns (width_km, height_km) of a WGS84 bounding box."""
    lon_min, lat_min, lon_max, lat_max = bbox
    R = 6371.0

    lat_mid = math.radians((lat_min + lat_max) / 2)

    width = (
        R
        * math.cos(lat_mid)
        * abs(math.radians(lon_max - lon_min))
    )

    height = (
        R
        * abs(math.radians(lat_max - lat_min))
    )

    return width, height


def compute_area_km2(bbox):
    """Computes the surface area of a WGS84 (lon/lat, degrees) bounding box in km2."""
    if not bbox:
        return 0.0
    lon_min, lat_min, lon_max, lat_max = bbox
    R = 6371.0  # Earth's radius in km

    lon1, lon2 = math.radians(lon_min), math.radians(lon_max)
    lat1, lat2 = math.radians(lat_min), math.radians(lat_max)

    # Spherical rectangle area formula (valid only for a proper lon/lat box)
    area = (R ** 2) * (lon2 - lon1) * abs(math.sin(lat2) - math.sin(lat1))
    return area


def iter_coords(coords):
    """Recursively yield (lon, lat) pairs from a GeoJSON 'coordinates' structure,
    regardless of geometry type (Point/LineString/Polygon/Multi*)."""
    if not coords:
        return
    # A coordinate pair looks like [lon, lat] or [lon, lat, elevation]
    if isinstance(coords[0], (int, float)):
        yield coords[0], coords[1]
        return
    for c in coords:
        yield from iter_coords(c)


def get_geojson_detections(gj_path):
    """Returns (count, class_ids, detections_bbox_or_None) for a per-image
    detections GeoJSON. detections_bbox is ONLY the extent of the detected
    objects themselves -- it is NOT a substitute for the real image footprint
    and must only be used as a last-resort fallback when no raster is
    available for that image (it will under-estimate area and inflate
    density for any image where detections don't cover the full tile)."""
    try:
        with open(gj_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        print(f"[err] Could not read {gj_path}: {e}", file=sys.stderr)
        return 0, set(), None

    features = data.get('features', [])
    count = len(features)
    class_ids = set()
    lons, lats = [], []

    for feature in features:
        props = feature.get('properties', {}) or {}
        if 'class_id' in props:
            class_ids.add(props['class_id'])
        geom = feature.get('geometry') or {}
        for lon, lat in iter_coords(geom.get('coordinates', [])):
            lons.append(lon)
            lats.append(lat)

    if not lons or not lats:
        return count, class_ids, None

    bbox = [min(lons), min(lats), max(lons), max(lats)]
    return count, class_ids, bbox


def get_tif_bbox(tif_path):
    """Extracts the true geographic footprint (bbox) of a raster tile, in
    WGS84 lon/lat degrees. This is the correct basis for area/density -- it
    reflects the whole tile, not just the part of it that has detections.
    Reprojects to EPSG:4326 if the raster's native CRS is something else
    (e.g. a UTM projection in meters, which is the common case for
    Pleiades/PNEO ORT products -- treating those meter bounds as if they
    were degrees is a common source of silently wrong density values)."""
    try:
        import rasterio
        from rasterio.warp import transform_bounds
        with rasterio.open(tif_path) as src:
            bounds = src.bounds
            if src.crs is not None and src.crs.to_epsg() != 4326:
                bounds = transform_bounds(src.crs, "EPSG:4326", *bounds)
            return [bounds[0], bounds[1], bounds[2], bounds[3]]
    except ImportError:
        print("[warn] rasterio not installed. Cannot extract bbox from TIF.", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[err] Could not extract bbox from {tif_path}: {e}", file=sys.stderr)
        return None


def main():
    print("yoooo")
    parser = argparse.ArgumentParser(description="Generate map visualization JSON with area and density.")
    parser.add_argument("--geojson-dir", type=str, required=True, help="Directory with GeoJSON detection files.")
    parser.add_argument("--tif-dir", type=str,
                         help="Directory with the original TIF tiles. Strongly recommended: this is what "
                              "makes area_km2 / density_km2 reflect the true image footprint instead of "
                              "just the extent covered by detections.")
    parser.add_argument("--output", type=str, default="density_map_data.json", help="Output JSON file.")
    args = parser.parse_args()

    geojson_dir = Path(args.geojson_dir)
    tif_dir = Path(args.tif_dir) if args.tif_dir else None

    if not geojson_dir.exists():
        print(f"[err] GeoJSON directory {geojson_dir} does not exist.", file=sys.stderr)
        sys.exit(1)
    if tif_dir is None or not tif_dir.exists():
        print(
            "[warn] No --tif-dir given (or it doesn't exist). Falling back to the extent of the "
            "detections themselves for area/density, which UNDER-estimates the true image footprint "
            "and INFLATES density_km2 whenever detections don't cover the whole tile. Pass --tif-dir "
            "for correct results.",
            file=sys.stderr,
        )

    geojson_files = {p.stem: p for p in geojson_dir.glob("*.geojson")}
    tif_files = {p.stem: p for p in tif_dir.glob("*.tif")} if tif_dir and tif_dir.exists() else {}

    all_stems = sorted(set(geojson_files) | set(tif_files))
    records = []
    all_class_ids = set()

    for stem in all_stems:
        # --- ADD THESE LINES TO SKIP THE OUTLIER ---
        if stem == "IMG_PNEO3_STD_202408050700065_PANSHARP_ORT_PWOI_000373576_15_1_F_1_PS_R4C2":
            print(f"[info] Skipping outlier: {stem}")
            continue
        # -------------------------------------------
        count, class_ids, detections_bbox = (0, set(), None)
        if stem in geojson_files:
            count, class_ids, detections_bbox = get_geojson_detections(geojson_files[stem])
        all_class_ids |= class_ids

        bbox = None
        bbox_source = None
        if stem in tif_files:
            bbox = get_tif_bbox(tif_files[stem])
            if bbox is not None:
                bbox_source = "raster"
        if bbox is None and detections_bbox is not None:
            bbox = detections_bbox
            bbox_source = "detections-approx"
            print(f"[warn] {stem}: no raster footprint available, using detections extent as an approximation.",
                  file=sys.stderr)

        if bbox is None:
            print(f"[warn] No extent could be determined for {stem} (no raster and no detections). Skipping.",
                  file=sys.stderr)
            continue

        area_km2 = compute_area_km2(bbox)
        width_km, height_km = bbox_dimensions_km(bbox)

        # Skip images smaller than 1 km × 1 km
        if width_km < 1.0 or height_km < 1.0:
            continue

        density_km2 = (count / area_km2) if area_km2 > 0 else 0.0

        records.append({
            "name": stem,
            "bbox": list(bbox),  # [lon_min, lat_min, lon_max, lat_max], WGS84
            "bbox_source": bbox_source,  # "raster" (correct) or "detections-approx" (fallback)
            "count": count,
            "area_km2": area_km2,
            "density_km2": density_km2,
        })

    total_objects = sum(r["count"] for r in records)
    for r in records:
        r["total_objects"] = total_objects  # grand total, same value on every record

    counts = [r["count"] for r in records]
    out = {
        "classes_used": sorted(all_class_ids),
        "count_min": min(counts) if counts else 0,
        "count_max": max(counts) if counts else 0,
        "images": records,
    }

    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2)

    approx_count = sum(1 for r in records if r["bbox_source"] == "detections-approx")
    print(f"[info] Successfully generated {args.output} with {len(records)} map records "
          f"({approx_count} used the detections-extent fallback instead of a raster footprint).")


if __name__ == "__main__":
    main()