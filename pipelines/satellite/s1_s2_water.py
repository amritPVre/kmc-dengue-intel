"""
Standing-water detection over Kolkata from satellites, pushed to the platform's water_detections.

Sources (all free):
  * Sentinel-1C/1D C-band radar (Copernicus): every 6 days, day and night, through monsoon cloud.
    Water is dark to radar; the pipeline flags pixels that are dark now AND clearly darker than the
    same orbit in the dry season (change detection), then vectorises patches of 300 m² or more.
  * Sentinel-2 optical (Copernicus): every 5 days when cloud allows; NDWI/MNDWI water index.
  * NISAR L-band (NASA-ISRO): listed for Phase 2 — better under vegetation; see nisar_scenes().

What satellites can and cannot see: open waterlogging, flooded vacant plots and construction pits
(tens of m² and up). They cannot see water in tyres, buckets or roof tanks — drones and photos cover
those. Dense built-up areas confuse radar (double bounce, shadows), so detections there carry lower
confidence and always go to a ward team for confirmation.

Runs on Google Earth Engine (free for government and non-commercial use; KMC or the state needs a
Cloud project registered with Earth Engine).

Usage:
  python pipelines/satellite/s1_s2_water.py --since 2026-11-01            # new passes → Supabase
  python pipelines/satellite/s1_s2_water.py --since 2025-09-20 --until 2025-09-30 --dry-run
  python pipelines/satellite/s1_s2_water.py --susceptibility --years 2023 2024 2025 2026

Validate before relying on it: run --dry-run on the 22–23 September 2025 cloudburst (KMC gauges
recorded 240–295 mm) and compare patches with KMC's waterlogging records for those days.

Env: EE_PROJECT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
Status: written against the Earth Engine Python API; NOT yet executed against live imagery.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path

import ee
import requests

ROOT = Path(__file__).resolve().parents[2]
WARDS_GEOJSON = ROOT / "data-raw" / "wards-seed.geojson"

# Thresholds (tune on the validation event)
S1_WATER_DB = -16.0        # VV backscatter below this is water-like
S1_DROP_DB = -3.0          # and at least this much darker than the dry-season reference
MIN_PIXELS = 3             # 3 × 100 m² = 300 m² minimum patch
NDWI_WATER = 0.15
MAX_CLOUD_PCT = 35


def init():
    ee.Initialize(project=os.environ["EE_PROJECT"])


def kmc_wards() -> ee.FeatureCollection:
    gj = json.loads(WARDS_GEOJSON.read_text())
    feats = [ee.Feature(ee.Geometry(f["geometry"]), {"ward": int(f["properties"]["WARD"])}) for f in gj["features"]]
    return ee.FeatureCollection(feats)


def masks(aoi):
    """Permanent water (ponds, canals, river) and built-up land, used to exclude / down-weight."""
    gsw = ee.Image("JRC/GSW1_4/GlobalSurfaceWater").select("occurrence").unmask(0)
    permanent = gsw.gt(50)
    built = ee.ImageCollection("ESA/WorldCover/v200").first().eq(50)
    return permanent.clip(aoi), built.clip(aoi)


def s1_collection(aoi, start, end):
    return (ee.ImageCollection("COPERNICUS/S1_GRD")
            .filterBounds(aoi).filterDate(start, end)
            .filter(ee.Filter.eq("instrumentMode", "IW"))
            .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VV"))
            .select("VV"))


def s1_reference(aoi, orbit, year):
    """Dry-season (Jan–Apr) median for the same relative orbit: what 'normal' looks like."""
    ref = (s1_collection(aoi, f"{year}-01-01", f"{year}-04-30")
           .filter(ee.Filter.eq("relativeOrbitNumber_start", orbit)).median())
    return ref.focal_median(30, "circle", "meters")


def s1_water_patches(img: ee.Image, aoi, permanent, built):
    date = ee.Date(img.get("system:time_start")).format("YYYY-MM-dd").getInfo()
    orbit = img.get("relativeOrbitNumber_start").getInfo()
    platform = img.get("platform_number").getInfo()  # 'C' or 'D'
    post = img.focal_median(30, "circle", "meters")
    ref = s1_reference(aoi, orbit, int(date[:4]))
    drop = post.subtract(ref).rename("drop")
    water = post.lt(S1_WATER_DB).And(drop.lt(S1_DROP_DB)).And(permanent.Not())
    water = water.updateMask(water.connectedPixelCount(100, True).gte(MIN_PIXELS)).selfMask().rename("water")
    vectors = (water.toInt().addBands(drop).addBands(built.rename("built"))
               .reduceToVectors(geometry=aoi, scale=10, geometryType="polygon", eightConnected=True,
                                labelProperty="label", reducer=ee.Reducer.mean(), maxPixels=1e10, bestEffort=True))
    vectors = vectors.map(lambda f: f.set({"area_m2": f.geometry().area(1), "centroid": f.geometry().centroid(1).coordinates()}))
    out = []
    for f in vectors.getInfo()["features"]:
        p = f["properties"]
        lng, lat = p["centroid"]
        conf = min(0.95, max(0.5, 0.5 + (-p.get("drop", -3) - 3) / 10))
        if p.get("built", 0) > 0.5:
            conf *= 0.8  # urban radar is less reliable
        out.append({"lat": lat, "lng": lng, "area_m2": round(p["area_m2"], 1), "confidence": round(conf, 2),
                    "footprint": f["geometry"], "kind": "Street / open waterlogging" if p.get("built", 0) > 0.5 else "Vacant plot pooling"})
    return {"sensor": "Sentinel-1", "platform": f"Sentinel-1{platform}", "date": date, "patches": out}


def s2_water_patches(img: ee.Image, aoi, permanent):
    date = ee.Date(img.get("system:time_start")).format("YYYY-MM-dd").getInfo()
    scl = img.select("SCL")
    clear = scl.neq(3).And(scl.neq(8)).And(scl.neq(9)).And(scl.neq(10))  # shadow, cloud medium/high, cirrus
    cloud_pct = (1 - clear.reduceRegion(ee.Reducer.mean(), aoi, 20, maxPixels=1e9).get("SCL").getInfo()) * 100
    if cloud_pct > MAX_CLOUD_PCT:
        return {"sensor": "Sentinel-2", "platform": img.get("SPACECRAFT_NAME").getInfo(), "date": date, "cloud": round(cloud_pct, 1), "patches": None}
    ndwi = img.normalizedDifference(["B3", "B8"])
    mndwi = img.normalizedDifference(["B3", "B11"])
    water = ndwi.gt(NDWI_WATER).And(mndwi.gt(0)).And(clear).And(permanent.Not())
    water = water.updateMask(water.connectedPixelCount(100, True).gte(MIN_PIXELS)).selfMask()
    vectors = (water.toInt().addBands(ndwi).reduceToVectors(geometry=aoi, scale=10, geometryType="polygon",
               eightConnected=True, reducer=ee.Reducer.mean(), maxPixels=1e10, bestEffort=True))
    vectors = vectors.map(lambda f: f.set({"area_m2": f.geometry().area(1), "centroid": f.geometry().centroid(1).coordinates()}))
    out = []
    for f in vectors.getInfo()["features"]:
        p = f["properties"]
        lng, lat = p["centroid"]
        out.append({"lat": lat, "lng": lng, "area_m2": round(p["area_m2"], 1), "footprint": f["geometry"],
                    "confidence": round(min(0.9, 0.5 + p.get("nd", 0.2)), 2), "kind": "Vacant plot pooling"})
    return {"sensor": "Sentinel-2", "platform": img.get("SPACECRAFT_NAME").getInfo(), "date": date, "cloud": round(cloud_pct, 1), "patches": out}


def nisar_scenes(since: str):
    """Phase 2: list NISAR L-band products over Kolkata (asf_search). Detection to be added once
    calibrated GCOV products are validated for dense urban India."""
    import asf_search as asf  # pip install asf_search
    wkt = "POLYGON((88.23 22.44, 88.43 22.44, 88.43 22.64, 88.23 22.64, 88.23 22.44))"
    return asf.search(platform="NISAR", intersectsWith=wkt, start=since)


# ---------- Supabase ----------

def _headers():
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json", "Prefer": "return=minimal"}


def push(pass_info: dict, ward_of_point, dry_run: bool):
    patches = pass_info["patches"]
    status = "Too cloudy" if patches is None else "Processed"
    rows = []
    for p in patches or []:
        rows.append({
            "ward_no": ward_of_point(p["lng"], p["lat"]) or 0, "lat": p["lat"], "lng": p["lng"], "area_m2": p["area_m2"],
            "source": "Satellite radar" if pass_info["sensor"] == "Sentinel-1" else "Satellite optical",
            "sensor": pass_info["platform"], "kind": p["kind"], "water_since": pass_info["date"],
            "confidence": p["confidence"], "status": "New", "aedes_risk": "Medium",
        })
    rows = [r for r in rows if r["ward_no"]]
    print(f"{pass_info['sensor']} {pass_info['platform']} {pass_info['date']}: {status}, {len(rows)} patches in KMC")
    if dry_run:
        return rows
    url = os.environ["SUPABASE_URL"].rstrip("/")
    requests.post(f"{url}/rest/v1/satellite_passes", headers={**_headers(), "Prefer": "resolution=merge-duplicates"},
                  json={"sensor": pass_info["sensor"], "platform": pass_info["platform"], "pass_date": pass_info["date"],
                        "cloud_pct": pass_info.get("cloud"), "detections": len(rows), "status": status}, timeout=60).raise_for_status()
    if rows:
        # the database trigger re-assigns ward_no from lat/lng; water_since of patches that persist from an earlier
        # pass is carried forward by the merge_persisting_water() step below
        requests.post(f"{url}/rest/v1/water_detections", headers=_headers(), json=rows, timeout=120).raise_for_status()
        requests.post(f"{url}/rest/v1/rpc/merge_persisting_water", headers=_headers(), json={"p_radius_m": 30}, timeout=60)
    return rows


def ward_lookup():
    from shapely.geometry import Point, shape  # pip install shapely
    gj = json.loads(WARDS_GEOJSON.read_text())
    polys = [(int(f["properties"]["WARD"]), shape(f["geometry"])) for f in gj["features"]]
    def ward_of(lng, lat):
        pt = Point(lng, lat)
        for w, g in polys:
            if g.contains(pt):
                return w
        return None
    return ward_of


def susceptibility(years):
    """Wet frequency per ward over the monsoon passes of the given years → ward_susceptibility."""
    wards = kmc_wards()
    aoi = wards.geometry().bounds()
    permanent, _ = masks(aoi)
    wet_sum, n_sum = None, None
    for y in years:
        col = s1_collection(aoi, f"{y}-06-01", f"{y}-10-31")
        ref = s1_collection(aoi, f"{y}-01-01", f"{y}-04-30").median().focal_median(30, "circle", "meters")
        wet = col.map(lambda i: i.focal_median(30, "circle", "meters").lt(S1_WATER_DB)
                      .And(i.focal_median(30, "circle", "meters").subtract(ref).lt(S1_DROP_DB)).And(permanent.Not()))
        wet_sum = wet.sum() if wet_sum is None else wet_sum.add(wet.sum())
        n_sum = col.size() if n_sum is None else n_sum.add(col.size())
    freq = wet_sum.divide(ee.Image.constant(n_sum)).rename("freq")
    # top-decile pixels in each ward drive its score (pockets matter, not the ward average)
    stats = freq.reduceRegions(wards, ee.Reducer.percentile([90]), 10).getInfo()
    rows = [{"ward_no": f["properties"]["ward"], "susceptibility": round(min(1, (f["properties"].get("p90") or 0) * 4), 3)} for f in stats["features"]]
    print(json.dumps(rows[:5], indent=1), "…")
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default=(dt.date.today() - dt.timedelta(days=7)).isoformat())
    ap.add_argument("--until", default=dt.date.today().isoformat())
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--susceptibility", action="store_true")
    ap.add_argument("--years", nargs="*", type=int, default=[2023, 2024, 2025, 2026])
    args = ap.parse_args()
    init()
    if args.susceptibility:
        susceptibility(args.years)
        return
    wards = kmc_wards()
    aoi = wards.geometry().bounds()
    permanent, built = masks(aoi)
    ward_of = ward_lookup()
    s1 = s1_collection(aoi, args.since, args.until).sort("system:time_start")
    n1 = s1.size().getInfo()
    l1 = s1.toList(n1)
    for k in range(n1):
        push(s1_water_patches(ee.Image(l1.get(k)), aoi, permanent, built), ward_of, args.dry_run)
    s2 = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(aoi).filterDate(args.since, args.until).sort("system:time_start")
    n2 = s2.size().getInfo()
    l2 = s2.toList(n2)
    for k in range(n2):
        push(s2_water_patches(ee.Image(l2.get(k)), aoi, permanent), ward_of, args.dry_run)


if __name__ == "__main__":
    main()
