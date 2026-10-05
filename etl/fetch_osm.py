"""向 OSM Overpass API 下載比對所需的道路幾何 → data/source/osm/taipei_roads.json

雲端開發環境連不到 Overpass，所以這支腳本在本機跑一次，把結果 commit 進 repo；
之後的比對（Phase 2）與測試都只讀這份快取，不再連網路。

做法：從 99 筆路段的「路段名、起點、迄點」取出基本路名（去掉段、巷、弄、口），
以前綴比對查詢台北市範圍內所有同名道路，例如「承德路」會同時抓到「承德路五段」與其巷弄。
PDF 寫「5段」、OSM 寫「五段」的差異留給比對階段處理。

用法（在 repo 根目錄）：
    python etl/fetch_osm.py            # 下載；中斷後重跑會從快取續傳
    python etl/fetch_osm.py --dry-run  # 只列出要查的路名與批次，不連網

需要 pdfplumber（讀 PDF 取路名）；連網只用標準函式庫。
"""

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "source" / "osm" / "taipei_roads.json"
CACHE = ROOT / "etl" / "out" / "osm_cache"

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
# 台北市外框（南, 西, 北, 東），會含一點新北市，比對階段再以距離篩選
TAIPEI_BBOX = (24.96, 121.45, 25.21, 121.67)
BATCH_SIZE = 12
KEEP_TAGS = ("name", "highway", "oneway", "alt_name", "old_name", "bridge", "tunnel")
USER_AGENT = "yellow-line-parking-etl/0.1 (https://github.com/mimicz/yellow-line-parking)"

ROAD_RE = re.compile(r"^(.+?(?:大道|路|街|橋))")
SECTION_RE = re.compile(r"^(.+?)[0-9０-９一二三四五六七八九十]+(?:-[0-9]+)?段")
# PDF 用簡稱、OSM 用全名的路
ALIASES = {"環南": "環河南路"}


def base_road_name(name):
    """'承德路5段' → '承德路'；'環南2段' → '環南'；只有巷號或地標 → None"""
    if not name:
        return None
    m = ROAD_RE.match(name)
    if m:
        return m[1]
    m = SECTION_RE.match(name)
    if m:
        return ALIASES.get(m[1], m[1])
    return None


def collect_names(segs):
    names = set()
    for s in segs:
        names.add(base_road_name(s["road"]))
        for p in s["parts"]:
            for n in [p["fromName"], p["toName"], *p.get("toNameAlt", [])]:
                names.add(base_road_name(n))
    names.discard(None)
    return sorted(names)


def batches(items, size):
    return [items[i:i + size] for i in range(0, len(items), size)]


def build_query(names, bbox=TAIPEI_BBOX):
    alt = "|".join(re.escape(n) for n in names)
    s, w, n, e = bbox
    return (
        "[out:json][timeout:180];\n"
        f'way["highway"]["name"~"^({alt})"]({s},{w},{n},{e});\n'
        "out tags geom;"
    )


def merge(responses):
    ways = {}
    for resp in responses:
        for el in resp.get("elements", []):
            if el.get("type") != "way" or "geometry" not in el:
                continue
            ways[el["id"]] = {
                "id": el["id"],
                "tags": {k: v for k, v in el.get("tags", {}).items() if k in KEEP_TAGS},
                "geometry": [[round(g["lon"], 7), round(g["lat"], 7)] for g in el["geometry"]],
            }
    return [ways[k] for k in sorted(ways)]


def _post(endpoint, query):
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    req = urllib.request.Request(endpoint, data=data, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=240) as r:
        return json.loads(r.read().decode("utf-8"))


class FetchFailed(Exception):
    pass


def fetch(query, attempts=4):
    """依序試各 endpoint；429/5xx/逾時則退避重試，用完次數拋 FetchFailed"""
    wait = 15
    last = None
    for attempt in range(attempts):
        endpoint = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            resp = _post(endpoint, query)
            if resp.get("remark") and "error" in resp["remark"].lower():
                raise RuntimeError(resp["remark"])
            return resp
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, RuntimeError) as e:
            last = e
            print(f"    {endpoint} 失敗（{e}），{wait} 秒後重試")
            time.sleep(wait)
            wait = min(wait * 2, 120)
    raise FetchFailed(last)


def _cache_file(cache_dir, names):
    return Path(cache_dir) / (hashlib.sha1("|".join(names).encode("utf-8")).hexdigest()[:16] + ".json")


def fetch_group(names, fetcher, cache_dir, indent="  "):
    """查一批路名；失敗就對半拆開重查（伺服器忙時小查詢較容易成功）。
    每個成功的批次各自快取，重跑時已完成的部分直接讀快取。回傳 response 清單。"""
    f = _cache_file(cache_dir, names)
    split_marker = f.with_suffix(".split")
    mid = len(names) // 2

    def split():
        return (fetch_group(names[:mid], fetcher, cache_dir, indent + "  ")
                + fetch_group(names[mid:], fetcher, cache_dir, indent + "  "))

    if split_marker.exists():  # 上次已拆開過，直接查子批次
        return split()
    if f.exists():
        print(f"{indent}已有快取：{'、'.join(names)}")
        return [json.loads(f.read_text(encoding="utf-8"))]
    print(f"{indent}查詢：{'、'.join(names)}")
    try:
        resp = fetcher(build_query(names))
    except FetchFailed as e:
        if len(names) == 1:
            raise SystemExit(f"「{names[0]}」連續失敗（{e}）。稍後重跑即可從快取續傳。")
        print(f"{indent}→ 拆成 {mid} + {len(names) - mid} 個路名重查")
        split_marker.write_text("", encoding="utf-8")
        return split()
    f.write_text(json.dumps(resp, ensure_ascii=False), encoding="utf-8")
    print(f"{indent}  取得 {len(resp.get('elements', []))} 條 way")
    time.sleep(2)  # 對公共服務客氣一點
    return [resp]


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except AttributeError:
            pass

    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from parse_pdf import PDF, parse_pdf

    names = collect_names(parse_pdf(PDF))
    groups = batches(names, BATCH_SIZE)
    print(f"共 {len(names)} 個路名，分 {len(groups)} 批查詢")
    if args.dry_run:
        for i, g in enumerate(groups, 1):
            print(f"  批次 {i}: {'、'.join(g)}")
        return

    CACHE.mkdir(parents=True, exist_ok=True)
    responses = []
    for i, g in enumerate(groups, 1):
        print(f"批次 {i}/{len(groups)}")
        responses += fetch_group(g, fetch, CACHE)

    ways = merge(responses)
    found = {base_road_name(w["tags"].get("name")) for w in ways}
    missing = [n for n in names if n not in found]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "source": "OpenStreetMap contributors, via Overpass API (ODbL)",
        "fetchedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bbox": TAIPEI_BBOX,
        "names": names,
        "missing": missing,
        "ways": ways,
    }, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")

    size_kb = OUT.stat().st_size // 1024
    print(f"\n寫出 {OUT.relative_to(ROOT)}：{len(ways)} 條 way，{size_kb} KB")
    if missing:
        print(f"OSM 查無這 {len(missing)} 個名稱（比對階段會以人工校正處理）：{'、'.join(missing)}")
    print("\n下一步：git add data/source/osm && git commit -m \"OSM 道路快取\" && git push")


if __name__ == "__main__":
    main()
