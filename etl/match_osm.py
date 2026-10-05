"""官方 99 筆路段 × OSM 道路快取 → 每個 part 的 polyline 與信心等級

只讀 data/source/osm/taipei_roads.json，不連網路。

做法：
1. 路名正規化（NFKC、台/臺、段號 5段=五段、簡稱 環南→環河南路、巷/弄），OSM 與 PDF 用同一套。
2. 主路 = 與 PDF「路段名」同名的可行車 way；以共用頂點建圖。
3. 起迄點 = 主路與橫街（或巷弄）共用的頂點；20 m 內的頂點視為同一路口（分隔雙線道）。
4. polyline = 主路圖上兩路口間的最短路徑。
5. 信心等級（任一硬條件不符 → needs_manual；有軟性疑慮 → low；否則 high）：

   needs_manual（geometry 一律為 None，不可能被畫出來）
     road_unparsable / no_main_road_way / ambiguous_endpoint / missing_endpoint /
     endpoint_landmark / endpoint_not_intersection / endpoint_address_only /
     no_intersection / same_endpoint / no_route /
     ambiguous_candidates（走廊外還有其他候選、最短者未達次短者的一半）/ route_too_winding（繞路比 > 2.5）
   low（有幾何，但需人工確認後才可顯示）
     flag:complex_range / flag:has_note / section_fallback / chosen_shortest /
     dual_carriageway（分隔雙線）/ wide_intersection（同走廊內多個交點）/
     winding（繞路比 1.5～2.5）/ length_out_of_range（< 30 m 或 > 3 km）

   endpoint_address_only：PDF 起迄點寫成路名本身（如「八德路 → 八德路」），位置其實由門牌欄決定，
   沒有地理編碼就無法定位。切勿當成「道路端點」推論——會畫錯。
   high：以上皆無

用法（在 repo 根目錄）：
    python etl/match_osm.py     # 比對並印出分級摘要，寫出 etl/out/matches.json
"""

import heapq
import json
import math
import re
import sys
import unicodedata
from collections import defaultdict, namedtuple
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OSM = ROOT / "data" / "source" / "osm" / "taipei_roads.json"
OUT = ROOT / "etl" / "out" / "matches.json"

DRIVABLE = {
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link", "unclassified",
    "residential", "living_street", "service",
}
# PDF 用簡稱、OSM 用全名的路（與 fetch_osm.ALIASES 同步）
ALIASES = {"環南": "環河南路"}

CLUSTER_RADIUS_M = 20      # 此距離內的交點視為同一路口
CORRIDOR_M = 120           # 起迄兩端都在此距離內的候選視為同一走廊（寬路口、橫街分別碰到雙線的兩側）
RATIO_LOW = 1.5            # 路徑長 / 直線距離：超過 → low
RATIO_MANUAL = 2.5         # 超過 → needs_manual
LEN_MIN_M = 30
LEN_MAX_M = 3000
CANDIDATE_MARGIN = 2.0     # 次短候選須 ≥ 最短 × 此值，才敢取最短

Place = namedtuple("Place", "base sections lane alley rest")

PLACE_RE = re.compile(
    r"^(?P<base>.+?(?:大道|路|街|橋))"
    r"(?:(?P<sec>[0-9一二三四五六七八九十]+(?:-[0-9]+)?)段)?"
    r"(?:(?P<lane>[0-9]+(?:-[0-9]+)?)巷)?"
    r"(?:(?P<alley>[0-9]+(?:-[0-9]+)?)弄)?"
    r"(?P<rest>.*)$"
)
CN_DIGITS = dict(zip("一二三四五六七八九", range(1, 10)))


def normalize_name(s):
    s = unicodedata.normalize("NFKC", s)
    return re.sub(r"\s+", "", s).replace("臺", "台")


def _cn_to_int(s):
    if "十" in s:
        a, _, b = s.partition("十")
        return (CN_DIGITS[a] if a else 1) * 10 + (CN_DIGITS[b] if b else 0)
    return CN_DIGITS[s]


def _parse_sections(tok):
    """'5'→{5}；'五'→{5}；'2-3'→{2,3}"""
    if re.fullmatch(r"\d+-\d+", tok):
        a, b = (int(x) for x in tok.split("-"))
        return frozenset(range(a, b + 1)) if a <= b else None
    try:
        return frozenset({int(tok) if tok.isdigit() else _cn_to_int(tok)})
    except KeyError:
        return None


def parse_place(name):
    """路名／路口名 → Place(base, sections, lane, alley, rest)；地標、空白回 None"""
    if not name:
        return None
    s = normalize_name(name)
    for short, full in ALIASES.items():
        if s.startswith(short) and not s.startswith(full):
            s = full + s[len(short):]
    m = PLACE_RE.match(s)
    if not m:
        return None
    sections = None
    if m["sec"]:
        sections = _parse_sections(m["sec"])
        if sections is None:
            return None
    return Place(
        m["base"], sections,
        f"{m['lane']}巷" if m["lane"] else None,
        f"{m['alley']}弄" if m["alley"] else None,
        m["rest"],
    )


# ---------- 幾何 ----------

def dist_m(a, b):
    """兩個 (lng, lat) 的距離（公尺，haversine）"""
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dphi, dl = p2 - p1, math.radians(b[0] - a[0])
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def build_graph(ways):
    adj = defaultdict(list)
    for w in ways:
        g = [tuple(c) for c in w["geometry"]]
        for a, b in zip(g, g[1:]):
            if a == b:
                continue
            d = dist_m(a, b)
            adj[a].append((b, d, w["id"]))
            adj[b].append((a, d, w["id"]))
    return adj


def label_components(adj):
    comp = {}
    cid = -1
    for start in sorted(adj):
        if start in comp:
            continue
        cid += 1
        stack = [start]
        comp[start] = cid
        while stack:
            n = stack.pop()
            for m, _, _ in adj[n]:
                if m not in comp:
                    comp[m] = cid
                    stack.append(m)
    return comp


def dijkstra(adj, src):
    dist, prev = {src: 0.0}, {}
    heap = [(0.0, src)]
    while heap:
        d, n = heapq.heappop(heap)
        if d > dist[n]:
            continue
        for m, w, wid in adj[n]:
            nd = d + w
            if nd < dist.get(m, math.inf):
                dist[m] = nd
                prev[m] = (n, wid)
                heapq.heappush(heap, (nd, m))
    return dist, prev


def cluster_nodes(nodes):
    """單一連結分群：互相 ≤ CLUSTER_RADIUS_M 的節點歸同一群"""
    nodes = sorted(nodes)
    parent = list(range(len(nodes)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            if dist_m(nodes[i], nodes[j]) <= CLUSTER_RADIUS_M:
                parent[find(j)] = find(i)
    groups = defaultdict(list)
    for i, n in enumerate(nodes):
        groups[find(i)].append(n)
    return sorted(groups.values(), key=lambda g: g[0])


# ---------- 路網索引 ----------

class RoadIndex:
    def __init__(self, ways):
        self.by_base = defaultdict(list)
        for w in sorted(ways, key=lambda w: w["id"]):
            if w["tags"].get("highway") not in DRIVABLE or len(w["geometry"]) < 2:
                continue
            p = parse_place(w["tags"].get("name"))
            if p is None or p.rest:     # 「基隆路車行地下道」「…入口匝道」等不是路本身
                continue
            self.by_base[p.base].append((p, w))

    def select(self, spec, allow_fallback=False):
        """符合 spec 的 way；回傳 (ways, 是否用了「OSM 沒標段號」的退路)"""
        cands = [(p, w) for p, w in self.by_base.get(spec.base, ())
                 if p.lane == spec.lane and p.alley == spec.alley]
        if spec.sections is None:
            return [w for _, w in cands], False
        hit = [w for p, w in cands if p.sections and p.sections & spec.sections]
        if hit or not allow_fallback:
            return hit, False
        fb = [w for p, w in cands if p.sections is None]
        return fb, bool(fb)


BARE_LANE_RE = re.compile(r"^([0-9]+(?:-[0-9]+)?)巷(?:([0-9]+(?:-[0-9]+)?)弄)?(.*)$")


def _bare_lane(name, main_spec):
    m = BARE_LANE_RE.match(normalize_name(name))
    if not m or main_spec.lane:     # 主路本身已是巷弄時，「N巷」語意不明，交給人工
        return None
    return Place(main_spec.base, main_spec.sections, f"{m[1]}巷", f"{m[2]}弄" if m[2] else None, m[3])


def _same_road(e, m):
    return ((e.base, e.lane, e.alley) == (m.base, m.lane, m.alley)
            and (e.sections is None or bool(m.sections and e.sections & m.sections)))


def _result(confidence, reasons, geometry=None, way_ids=(), length=None, straight=None, ratio=None):
    return {
        "confidence": confidence,
        "reasons": list(reasons),
        "geometry": geometry,
        "osmWayIds": list(way_ids),
        "lengthM": None if length is None else round(length, 1),
        "straightM": None if straight is None else round(straight, 1),
        "ratio": None if ratio is None else round(ratio, 2),
    }


def _manual(reason):
    return _result("needs_manual", [reason])


class _Main:
    """一條主路的 way 集合與路網圖（同一路多個路段共用）"""

    def __init__(self, ways):
        self.ways = ways
        self.ids = {w["id"] for w in ways}
        self.adj = build_graph(ways)
        self.comp = label_components(self.adj)


def _resolve_endpoint(name, main_spec, main, index):
    """回傳 (路口分群 list, None) 或 (None, 失敗代碼)"""
    if not name:
        return None, "missing_endpoint"
    spec = parse_place(name)
    if spec is None:
        spec = _bare_lane(name, main_spec)      # 只寫「370巷」：指主路自己的巷
    if spec is None:
        return None, "endpoint_landmark"
    if spec.rest not in ("", "口"):
        return None, "endpoint_not_intersection"      # 巷內某號、巷中等：不是路口
    if _same_road(spec, main_spec):
        return None, "endpoint_address_only"          # 起迄點寫成路名本身：位置由門牌欄決定，無法定位
    xways, _ = index.select(spec)
    xnodes = {tuple(c) for w in xways if w["id"] not in main.ids for c in w["geometry"]}
    junctions = [n for n in main.adj if n in xnodes]
    if not junctions:
        return None, "no_intersection"
    return cluster_nodes(junctions), None


def _near(cluster_a, cluster_b):
    return any(dist_m(a, b) <= CLUSTER_RADIUS_M for a in cluster_a for b in cluster_b)


def _path(prev, src, dst):
    nodes, way_ids = [dst], []
    while nodes[-1] != src:
        n, wid = prev[nodes[-1]]
        if not way_ids or way_ids[-1] != wid:
            way_ids.append(wid)
        nodes.append(n)
    nodes.reverse()
    way_ids.reverse()
    return nodes, list(dict.fromkeys(way_ids))


def _match_part(seg, part, index, mains):
    if part.get("toNameAlt"):
        return _manual("ambiguous_endpoint")
    main_spec = parse_place(seg["road"])
    if main_spec is None:
        return _manual("road_unparsable")
    soft = []
    key = (main_spec.base, main_spec.sections, main_spec.lane, main_spec.alley)
    if key not in mains:
        ways, fallback = index.select(main_spec, allow_fallback=True)
        mains[key] = (_Main(ways), fallback) if ways else None
    if mains[key] is None:
        return _manual("no_main_road_way")
    main, fallback = mains[key]
    if fallback:
        soft.append("section_fallback")

    ends = {}
    for side, name in (("from", part.get("fromName")), ("to", part.get("toName"))):
        clusters, err = _resolve_endpoint(name, main_spec, main, index)
        if err:
            return _manual(f"{err}:{side}")
        ends[side] = clusters
    F, T = ends["from"], ends["to"]

    # 每個 (起點路口, 迄點路口, 連通分量) 取最短路徑
    options = {}
    for i, cf in enumerate(F):
        for nf in cf:
            dist, prev = dijkstra(main.adj, nf)
            for j, ct in enumerate(T):
                if _near(cf, ct):
                    continue
                for nt in ct:
                    if nt in dist:
                        k = (i, j, main.comp[nf])
                        if k not in options or dist[nt] < options[k][0]:
                            options[k] = (dist[nt], nf, nt, prev)
    if not any(not _near(cf, ct) for cf in F for ct in T):
        return _manual("same_endpoint")
    if not options:
        return _manual("no_route")

    ranked = sorted(options.items(), key=lambda kv: (kv[1][0], kv[0]))
    (_, _, bc), (length, nf, nt, prev) = ranked[0]
    # 其餘候選：起迄兩端都落在最短者 CORRIDOR_M 內 → 同一走廊（寬路口／分隔雙線），否則是真正的另一處
    rivals, wide, dual = [], False, False
    for (_, _, c), (d, f2, t2, _) in ranked[1:]:
        if dist_m(f2, nf) <= CORRIDOR_M and dist_m(t2, nt) <= CORRIDOR_M:
            dual, wide = dual or c != bc, wide or c == bc
        else:
            rivals.append(d)
    if rivals:
        if min(rivals) < CANDIDATE_MARGIN * length:
            return _manual("ambiguous_candidates")
        soft.append("chosen_shortest")
    if wide:
        soft.append("wide_intersection")
    if dual:
        soft.append("dual_carriageway")

    straight = dist_m(nf, nt)
    ratio = length / max(straight, 1.0)
    if ratio > RATIO_MANUAL:
        return _manual("route_too_winding")
    if ratio > RATIO_LOW:
        soft.append("winding")
    if not LEN_MIN_M <= length <= LEN_MAX_M:
        soft.append("length_out_of_range")
    soft += [f"flag:{f}" for f in ("complex_range", "has_note") if f in seg.get("flags", ())]

    nodes, way_ids = _path(prev, nf, nt)
    return _result("low" if soft else "high", soft, [list(n) for n in nodes], way_ids, length, straight, ratio)


def match_all(segs, ways):
    """segs：parse_pdf 的輸出；ways：taipei_roads.json 的 ways。回傳 {'TP-HOL-001:0': 結果}"""
    index = RoadIndex(ways)
    mains = {}
    out = {}
    for seg in segs:
        for i, part in enumerate(seg["parts"]):
            out[f"{seg['id']}:{i}"] = _match_part(seg, part, index, mains)
    return out


def main():
    from collections import Counter

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except AttributeError:
            pass
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from parse_pdf import PDF, parse_pdf

    osm = json.loads(OSM.read_text(encoding="utf-8"))
    segs = parse_pdf(PDF)
    res = match_all(segs, osm["ways"])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")

    by_key = {f"{s['id']}:{i}": (s, p) for s in segs for i, p in enumerate(s["parts"])}
    conf = Counter(r["confidence"] for r in res.values())
    print(f"共 {len(res)} 段：" + "、".join(f"{k} {conf[k]}" for k in ("high", "low", "needs_manual")))
    reasons = Counter(x.split(":")[0] for r in res.values() for x in r["reasons"])
    print("原因統計：" + "、".join(f"{k} {v}" for k, v in reasons.most_common()))
    for level in ("low", "needs_manual"):
        print(f"\n== {level} ==")
        for k, r in res.items():
            if r["confidence"] != level:
                continue
            s, p = by_key[k]
            extra = "" if r["lengthM"] is None else f"  長{r['lengthM']}m 繞路比{r['ratio']}"
            print(f"{k:14} {s['road']}：{p['fromName']} → {p['toName']}  {','.join(r['reasons'])}{extra}")


if __name__ == "__main__":
    main()
