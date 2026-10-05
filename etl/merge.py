"""官方資料 + 比對結果 + 人工校正 → data/segments.geojson（App 用）與 data/segments_review.geojson（校正頁用）

每個 part 一個 Feature。顯示規則集中在這裡（`show`），App 只依 `show` 與 geometry 判斷：
  show = confidence 為 high（自動，且通過 match_osm 全部硬條件）或 manual（人工確認／重畫）
  low、needs_manual 一律 show=false

兩個檔的差別：
  segments.geojson         公開檔。show=false 的 Feature 一律 geometry=null，結構上不可能被畫成可停
  segments_review.geojson  校正頁用。low 保留候選幾何供目視確認；needs_manual 仍為 null

人工校正 data/manual/overrides.json（校正頁輸出；檔案不存在視為沒有）：
  {"TP-HOL-005:0": {"geometry": [[lng, lat], ...]},   # 重畫 → manual
   "TP-HOL-002:0": {"confirmed": true}}                 # 確認自動幾何 → manual（needs_manual 不可只確認）

用法（在 repo 根目錄）：
    python etl/merge.py
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OVERRIDES = ROOT / "data" / "manual" / "overrides.json"
PUBLIC = ROOT / "data" / "segments.geojson"
REVIEW = ROOT / "data" / "segments_review.geojson"

# 與 fetch_osm.TAIPEI_BBOX 一致（南, 西, 北, 東）
BBOX = (24.96, 121.45, 25.21, 121.67)
DISCLAIMER = "本表僅供參考，實際開放黃線假日停車路段仍以現場標誌標示範圍為準"
SHOWN = ("high", "manual")


def load_overrides(path=OVERRIDES):
    path = Path(path)
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _check_geometry(key, geometry):
    if not isinstance(geometry, list) or len(geometry) < 2:
        raise ValueError(f"override {key}：geometry 至少 2 點")
    south, west, north, east = BBOX
    for pt in geometry:
        if not (isinstance(pt, (list, tuple)) and len(pt) == 2
                and west <= pt[0] <= east and south <= pt[1] <= north):
            raise ValueError(f"override {key}：座標 {pt} 超出台北範圍（須為 [經度, 緯度]）")


def _apply_override(key, match, ov):
    from match_osm import dist_m

    m = dict(match)
    if "geometry" in ov:
        _check_geometry(key, ov["geometry"])
        g = [list(p) for p in ov["geometry"]]
        m.update(geometry=g, osmWayIds=[], lengthM=round(sum(dist_m(a, b) for a, b in zip(g, g[1:])), 1),
                 straightM=None, ratio=None)
        tag = "manual_override"
    elif ov.get("confirmed") is True:
        if not match["geometry"]:
            raise ValueError(f"override {key}：沒有自動幾何，不能只確認，請提供 geometry")
        tag = "manual_confirmed"
    else:
        raise ValueError(f"override {key}：需要 geometry，或 confirmed: true")
    m["confidence"] = "manual"
    m["reasons"] = [*match["reasons"], tag]
    return m


def build_collections(segs, matches, overrides):
    """回傳 (公開 FeatureCollection, 校正用 FeatureCollection)"""
    for key in overrides:
        if key not in matches:
            raise ValueError(f"override {key}：對應的路段不存在")

    pub_f, rev_f = [], []
    shown_ids = shown_parts = 0
    for seg in segs:
        n = len(seg["parts"])
        seg_shown = 0
        for i, part in enumerate(seg["parts"]):
            key = f"{seg['id']}:{i}"
            m = matches[key]
            if key in overrides:
                m = _apply_override(key, m, overrides[key])
            show = m["confidence"] in SHOWN
            seg_shown += show
            props = {
                "id": seg["id"], "no": seg["no"], "district": seg["district"], "road": seg["road"],
                "partIndex": i, "nParts": n,
                "direction": part["direction"], "axis": part["axis"], "side": part["side"],
                "fromName": part["fromName"], "toName": part["toName"],
                "timeRaw": seg["timeRaw"], "openWindows": seg["openWindows"], "note": seg["note"],
                "flags": seg["flags"], "source": seg["source"],
                "confidence": m["confidence"], "show": show, "reasons": m["reasons"],
                "osmWayIds": m["osmWayIds"], "lengthM": m["lengthM"],
            }
            geom = None if m["geometry"] is None else {"type": "LineString", "coordinates": m["geometry"]}
            rev_f.append({"type": "Feature", "properties": props, "geometry": geom})
            pub_f.append({"type": "Feature", "properties": props, "geometry": geom if show else None})
        shown_parts += seg_shown
        shown_ids += seg_shown == n

    date = re.search(r"\d{4}-\d{2}-\d{2}", segs[0]["source"])[0]
    meta = {
        "source": segs[0]["source"], "sourceDate": date, "disclaimer": DISCLAIMER,
        "totalIds": len(segs), "shownIds": shown_ids,
        "totalParts": len(pub_f), "shownParts": shown_parts,
    }
    return ({"type": "FeatureCollection", "meta": meta, "features": pub_f},
            {"type": "FeatureCollection", "meta": meta, "features": rev_f})


def serialize(fc):
    """一個 Feature 一行，git diff 看得出哪筆變了；內容完全由輸入決定（無時間戳）"""
    def dump(x):
        return json.dumps(x, ensure_ascii=False, separators=(",", ":"))

    return ('{"type":"FeatureCollection","meta":' + dump(fc["meta"]) + ',"features":[\n'
            + ",\n".join(dump(f) for f in fc["features"]) + "\n]}\n")


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except AttributeError:
            pass
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from match_osm import match_all
    from parse_pdf import PDF, parse_pdf

    osm = json.loads((ROOT / "data" / "source" / "osm" / "taipei_roads.json").read_text(encoding="utf-8"))
    segs = parse_pdf(PDF)
    pub, rev = build_collections(segs, match_all(segs, osm["ways"]), load_overrides())
    PUBLIC.write_text(serialize(pub), encoding="utf-8", newline="\n")
    REVIEW.write_text(serialize(rev), encoding="utf-8", newline="\n")

    m = pub["meta"]
    print(f"寫出 {PUBLIC.relative_to(ROOT)}、{REVIEW.relative_to(ROOT)}")
    print(f"可顯示 {m['shownIds']} / {m['totalIds']} 筆編號（{m['shownParts']} / {m['totalParts']} 段）")


if __name__ == "__main__":
    main()
