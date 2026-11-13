"""
Find standing water and breeding containers in a KMC drone survey.

Input: a georeferenced orthomosaic (GeoTIFF) stitched from a drone flight (any CRS).
Steps:
  1. Cut the mosaic into overlapping tiles (default 1024 px; ~30 m square at 3 cm/pixel).
  2. Skip blank or near-uniform tiles (nodata edges, open sky, water bodies already known).
  3. Detect, per tile, with one of:
       --detector vision  AI vision through the platform's analyze-image Edge Function, so drone tiles,
                          field photos and citizen photos share one prompt, one model and one result shape.
       --detector yolo    a YOLO model fine-tuned on KMC tiles that ward teams have confirmed or rejected
                          (Phase 2: faster and cheaper per km² once ~2,000 labelled tiles exist).
  4. Geolocate each positive tile (its centre) and write a water spot (source 'Drone AI') to Supabase.
     The ward is assigned in the database from the location.

Usage:
  python pipelines/drone/analyze_orthomosaic.py mosaic.tif --mission B-VII-2026-11-11 --dry-run --out tiles/
  python pipelines/drone/analyze_orthomosaic.py mosaic.tif --mission B-VII-2026-11-11 --detector vision

Env (not needed for --dry-run): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
Published detection results to compare against: Dar es Salaam (PLOS NTD 2026) found ~75% of water
tanks and ~72% of tyres from drone imagery with a trained model.
"""
import argparse
import csv
import datetime as dt
import io
import os
import uuid
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import transform as warp_transform
from rasterio.windows import Window


def tiles(src, size: int, overlap: int):
    step = size - overlap
    for row in range(0, max(1, src.height - overlap), step):
        for col in range(0, max(1, src.width - overlap), step):
            w = Window(col, row, min(size, src.width - col), min(size, src.height - row))
            if w.width < size // 4 or w.height < size // 4:
                continue
            yield w


def tile_rgb(src, window) -> np.ndarray | None:
    bands = [1, 2, 3] if src.count >= 3 else [1, 1, 1]
    arr = src.read(bands, window=window, masked=True)
    if np.ma.getmaskarray(arr).mean() > 0.5:
        return None  # mostly nodata
    data = np.ma.filled(arr, 0).astype(np.float32)
    if data.std() < 4:
        return None  # uniform tile (sky, nodata, water body)
    lo, hi = np.percentile(data, 1), np.percentile(data, 99)
    data = np.clip((data - lo) / max(hi - lo, 1) * 255, 0, 255).astype(np.uint8)
    return np.transpose(data, (1, 2, 0))


def centre_lnglat(src, window):
    x, y = src.xy(window.row_off + window.height / 2, window.col_off + window.width / 2)
    if src.crs and src.crs.to_epsg() != 4326:
        xs, ys = warp_transform(src.crs, "EPSG:4326", [x], [y])
        return xs[0], ys[0]
    return x, y


def to_jpeg(rgb: np.ndarray) -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="JPEG", quality=88)
    return buf.getvalue()


# ---------- detectors ----------

def detect_vision(jpeg: bytes, mission: str):
    import requests
    url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    path = f"drone/{mission}/{uuid.uuid4()}.jpg"
    h = {"apikey": key, "Authorization": f"Bearer {key}"}
    requests.post(f"{url}/storage/v1/object/detection-photos/{path}", headers={**h, "Content-Type": "image/jpeg"}, data=jpeg, timeout=60).raise_for_status()
    r = requests.post(f"{url}/functions/v1/analyze-image", headers={**h, "Content-Type": "application/json"},
                      json={"photoPath": path, "source": "Drone image", "note": f"Orthomosaic tile from mission {mission}, viewed from above"}, timeout=120)
    r.raise_for_status()
    out = r.json()
    return out["result"], out.get("model", "vision"), path


def detect_yolo(rgb: np.ndarray, model):
    res = model.predict(rgb, verbose=False)[0]
    names = res.names
    objs = {}
    for c, conf in zip(res.boxes.cls.tolist(), res.boxes.conf.tolist()):
        if conf >= 0.35:
            objs[names[int(c)]] = objs.get(names[int(c)], 0) + 1
    if not objs:
        return {"standingWater": False}, "yolo", None
    best = max(res.boxes.conf.tolist())
    kind = "Discarded tyres" if "tyre" in objs else "Rooftop water" if "rooftop_water" in objs else "Water-holding containers"
    return {"standingWater": True, "confidence": round(best, 2), "kind": kind, "aedesRisk": "High",
            "objects": [{"label": k, "count": v, "holdsWater": "unclear"} for k, v in objs.items()],
            "summary": ", ".join(f"{v} {k}" for k, v in objs.items()), "recommendedAction": "Inspect and remove water", "larvaeVisible": "unclear", "reasons": []}, "yolo", None


def save_detection(lng, lat, result, model, photo_path, mission):
    import requests
    url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    row = {
        "ward_no": 0, "lat": lat, "lng": lng, "source": "Drone AI", "sensor": f"Drone mission {mission}",
        "kind": result["kind"], "water_since": mission[-10:] if mission[-10:-6].isdigit() else dt.date.today().isoformat(),
        "confidence": result.get("confidence", 0.6), "status": "New", "aedes_risk": result.get("aedesRisk", "Medium"),
        "ai": {k: result.get(k) for k in ("summary", "objects", "larvaeVisible", "recommendedAction", "reasons")} | {"model": model},
        "photo_path": photo_path,
    }
    row = {k: v for k, v in row.items() if v is not None}
    requests.post(f"{url}/rest/v1/water_detections", headers={"apikey": key, "Authorization": f"Bearer {key}",
                  "Content-Type": "application/json", "Prefer": "return=minimal"}, json=row, timeout=60).raise_for_status()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mosaic")
    ap.add_argument("--mission", required=True, help="e.g. B-VII-2026-11-11 (ends with the flight date)")
    ap.add_argument("--tile", type=int, default=1024)
    ap.add_argument("--overlap", type=int, default=96)
    ap.add_argument("--detector", choices=["vision", "yolo"], default="vision")
    ap.add_argument("--weights", help="YOLO weights (.pt) for --detector yolo")
    ap.add_argument("--min-confidence", type=float, default=0.5)
    ap.add_argument("--dry-run", action="store_true", help="only cut tiles and write an index; no AI calls, no uploads")
    ap.add_argument("--out", default="tiles")
    args = ap.parse_args()

    model = None
    if args.detector == "yolo" and not args.dry_run:
        from ultralytics import YOLO  # pip install ultralytics
        model = YOLO(args.weights)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    kept = skipped = found = 0
    with rasterio.open(args.mosaic) as src, open(out_dir / "index.csv", "w", newline="") as idx:
        writer = csv.writer(idx)
        writer.writerow(["tile", "lng", "lat", "standing_water", "kind", "confidence"])
        for n, w in enumerate(tiles(src, args.tile, args.overlap)):
            rgb = tile_rgb(src, w)
            if rgb is None:
                skipped += 1
                continue
            kept += 1
            lng, lat = centre_lnglat(src, w)
            name = f"tile_{n:05d}.jpg"
            if args.dry_run:
                (out_dir / name).write_bytes(to_jpeg(rgb))
                writer.writerow([name, f"{lng:.6f}", f"{lat:.6f}", "", "", ""])
                continue
            result, used, photo = detect_vision(to_jpeg(rgb), args.mission) if args.detector == "vision" else detect_yolo(rgb, model)
            sw = bool(result.get("standingWater"))
            writer.writerow([name, f"{lng:.6f}", f"{lat:.6f}", sw, result.get("kind", ""), result.get("confidence", "")])
            if sw and result.get("confidence", 0) >= args.min_confidence:
                save_detection(lng, lat, result, used, photo, args.mission)
                found += 1
    print(f"tiles analysed: {kept}, skipped (blank/uniform): {skipped}, water spots saved: {found}")


if __name__ == "__main__":
    main()
