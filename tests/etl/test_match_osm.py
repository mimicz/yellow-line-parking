import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))

from match_osm import match_all, parse_place  # noqa: E402

# ---------- 合成路網的小工具 ----------
# 1 格 ≈ 111 m：x 軸為經度（0.0011°），y 軸為緯度（0.001°）

LON0, LAT0 = 121.5, 25.0


def P(x, y):
    return [round(LON0 + x * 0.0011, 7), round(LAT0 + y * 0.001, 7)]


def way(wid, name, pts, highway="secondary"):
    return {"id": wid, "tags": {"name": name, "highway": highway}, "geometry": [P(*p) for p in pts]}


def hline(wid, name, x0, x1, y=0, step=1):
    n = int(round((x1 - x0) / step))
    return way(wid, name, [(x0 + i * step, y) for i in range(n + 1)])


def vcross(wid, name, x, y0=-1, y1=1, extra=()):
    ys = sorted({y0, y1, 0, *extra})
    return way(wid, name, [(x, y) for y in ys], "residential")


def run(ways, road, frm, to, flags=(), alt=()):
    seg = {"id": "T-1", "road": road, "flags": list(flags),
           "parts": [{"fromName": frm, "toName": to, "toNameAlt": list(alt)}]}
    return match_all([seg], ways)["T-1:0"]


def basic_net():
    return [hline(1, "東華街", 0, 4), vcross(2, "明德路", 1), vcross(3, "石牌路", 3)]


# ---------- 名稱解析 ----------

@pytest.mark.parametrize("raw,base,secs,lane,alley,rest", [
    ("東華街", "東華街", None, None, None, ""),
    ("承德路5段", "承德路", {5}, None, None, ""),
    ("承德路五段", "承德路", {5}, None, None, ""),
    ("羅斯福路2-3段", "羅斯福路", {2, 3}, None, None, ""),
    ("市民大道8段", "市民大道", {8}, None, None, ""),
    ("忠孝東路十一段", "忠孝東路", {11}, None, None, ""),
    ("石牌路口", "石牌路", None, None, None, "口"),
    ("致遠二路61巷", "致遠二路", None, "61巷", None, ""),
    ("基隆路三段155巷", "基隆路", {3}, "155巷", None, ""),
    ("華齡街22巷15弄", "華齡街", None, "22巷", "15弄", ""),
    ("德行東路365巷11弄16號旁", "德行東路", None, "365巷", "11弄", "16號旁"),
    ("陽光街345巷口", "陽光街", None, "345巷", None, "口"),
    ("環南2段", "環河南路", {2}, None, None, ""),
    ("基隆路車行地下道", "基隆路", None, None, None, "車行地下道"),
    ("東華橋", "東華橋", None, None, None, ""),
    ("臺北橋", "台北橋", None, None, None, ""),
    ("凱達格蘭大道", "凱達格蘭大道", None, None, None, ""),
])
def test_parse_place(raw, base, secs, lane, alley, rest):
    p = parse_place(raw)
    assert (p.base, p.sections, p.lane, p.alley, p.rest) == (base, secs, lane, alley, rest)


@pytest.mark.parametrize("raw", ["北門", "南港交流道", "忠義國小前", "", None])
def test_parse_place_landmark_is_none(raw):
    assert parse_place(raw) is None


# ---------- 基本比對 ----------

def test_basic_two_intersections_is_high():
    r = run(basic_net(), "東華街", "明德路", "石牌路")
    assert r["confidence"] == "high" and r["reasons"] == []
    assert r["geometry"][0] == P(1, 0) and r["geometry"][-1] == P(3, 0)
    assert 200 < r["lengthM"] < 250
    assert r["osmWayIds"] == [1]
    assert r["ratio"] == pytest.approx(1.0, abs=0.01)


def test_geometry_follows_from_to_order():
    r = run(basic_net(), "東華街", "石牌路", "明德路")
    assert r["geometry"][0] == P(3, 0) and r["geometry"][-1] == P(1, 0)


def test_endpoint_with_kou_suffix():
    r = run(basic_net(), "東華街", "明德路口", "石牌路口")
    assert r["confidence"] == "high"


def test_section_digits_match_chinese_numerals():
    ways = [hline(1, "承德路五段", 0, 4), vcross(2, "中正路", 1), vcross(3, "士商路", 3)]
    r = run(ways, "承德路5段", "中正路", "士商路")
    assert r["confidence"] == "high"


def test_section_alias_huannan():
    ways = [hline(1, "環河南路二段", 0, 4), vcross(2, "中正路", 1), vcross(3, "士商路", 3)]
    assert run(ways, "環南2段", "中正路", "士商路")["confidence"] == "high"


def test_compat_ideograph_in_osm_name_still_matches():
    ways = [hline(1, "凱達格蘭大道", 0, 4), vcross(2, "中正路", 1), vcross(3, "士商路", 3)]
    assert run(ways, "凱達格蘭大道", "中正路", "士商路")["confidence"] == "high"


def test_lane_endpoint_matches_lane_way_by_full_name():
    ways = [hline(1, "天母東路", 0, 4), vcross(2, "中山北路", 1), vcross(3, "天母東路105巷", 3)]
    r = run(ways, "天母東路", "中山北路", "天母東路105巷口")
    assert r["confidence"] == "high"


def test_endpoint_is_other_section_of_same_road():
    ways = [hline(1, "承德路四段", 0, 3), hline(2, "承德路五段", 3, 6), vcross(3, "中正路", 5)]
    r = run(ways, "承德路5段", "承德路4段", "中正路")
    assert r["confidence"] == "high"
    assert r["geometry"][0] == P(3, 0) and r["geometry"][-1] == P(5, 0)


def test_cross_street_that_is_not_drivable_is_ignored():
    ways = [hline(1, "東華街", 0, 4), vcross(2, "明德路", 1), way(3, "石牌路", [(3, -1), (3, 0), (3, 1)], "footway")]
    r = run(ways, "東華街", "明德路", "石牌路")
    assert r["confidence"] == "needs_manual" and "no_intersection" in r["reasons"][0]


# ---------- 無法自動求幾何 → needs_manual（geometry 必為 None）----------

@pytest.mark.parametrize("frm,to,alt,reason", [
    ("北門", "石牌路", (), "endpoint_landmark"),
    ("明德路", "忠義國小前", (), "endpoint_landmark"),
    (None, "石牌路", (), "missing_endpoint"),
    ("明德路", None, (), "missing_endpoint"),
    ("明德路", "東華街365巷11弄16號旁", (), "endpoint_not_intersection"),
    ("明德路", "石牌路", ("中正路",), "ambiguous_endpoint"),
    ("東華街", "石牌路", (), "endpoint_address_only"),   # 起迄點寫成路名本身：位置由門牌決定，無法定位
    ("明德路", "不存在路", (), "no_intersection"),
])
def test_needs_manual_cases(frm, to, alt, reason):
    r = run(basic_net(), "東華街", frm, to, alt=alt)
    assert r["confidence"] == "needs_manual"
    assert r["geometry"] is None
    assert reason in r["reasons"][0]


def test_unknown_main_road_is_needs_manual():
    r = run(basic_net(), "沒有這條路", "明德路", "石牌路")
    assert r["confidence"] == "needs_manual" and r["reasons"][0] == "no_main_road_way"
    assert r["geometry"] is None


def test_same_junction_both_ends_is_needs_manual():
    ways = [hline(1, "東華街", 0, 4), vcross(2, "明德路", 1), vcross(3, "中正路", 1)]
    r = run(ways, "東華街", "明德路", "中正路")
    assert r["confidence"] == "needs_manual" and r["reasons"][0] == "same_endpoint"


# ---------- 多個候選交點 ----------

def test_ambiguous_equidistant_candidates_is_needs_manual():
    # 明德路與主路相交兩次（x=1、x=9），甲路在中間 x=5：兩邊一樣遠，無法判斷
    ways = [hline(1, "東華街", 0, 10), vcross(2, "明德路", 1), vcross(3, "明德路", 9), vcross(4, "甲路", 5)]
    r = run(ways, "東華街", "甲路", "明德路")
    assert r["confidence"] == "needs_manual" and r["reasons"][0] == "ambiguous_candidates"
    assert r["geometry"] is None


def test_clear_shortest_candidate_is_low():
    # 甲路在 x=2：到 x=1 只有 1 格、到 x=9 有 7 格，差距 ≥ 2 倍 → 取最短但降為 low
    ways = [hline(1, "東華街", 0, 10), vcross(2, "明德路", 1), vcross(3, "明德路", 9), vcross(4, "甲路", 2)]
    r = run(ways, "東華街", "甲路", "明德路")
    assert r["confidence"] == "low" and "chosen_shortest" in r["reasons"]
    assert r["geometry"][0] == P(2, 0) and r["geometry"][-1] == P(1, 0)


def test_bare_lane_endpoint_inherits_main_road():
    # PDF 只寫「370巷」：指主路自己的 370 巷（OSM 名稱含段號）
    ways = [hline(1, "忠孝東路六段", 0, 4), vcross(2, "中正路", 1), vcross(3, "忠孝東路六段370巷", 3)]
    for lane in ("370巷", "370巷口"):
        r = run(ways, "忠孝東路6段", "中正路", lane)
        assert r["confidence"] == "high", lane
        assert r["geometry"][-1] == P(3, 0)


def test_wide_intersection_is_low():
    # 橫街的兩條車道各在 x=1、x=1.4（約 44 m）與主路相交：同一走廊內的寬路口，取較近者並降為 low
    main = way(1, "東華街", [(0, 0), (1, 0), (1.4, 0), *[(x, 0) for x in range(2, 11)]])
    ways = [main, vcross(2, "明德路", 1), vcross(3, "明德路", 1.4), vcross(4, "甲路", 5)]
    r = run(ways, "東華街", "甲路", "明德路")
    assert r["confidence"] == "low" and "wide_intersection" in r["reasons"]
    assert r["geometry"][-1] == P(1.4, 0)


def test_dual_carriageway_far_apart_cross_points_is_low():
    # 分隔雙線相距約 89 m，橫街各只碰到其中一條 → 仍是同一走廊（dual），不是多個候選
    ways = [
        hline(1, "忠孝東路", 0, 4, y=0), hline(2, "忠孝東路", 4, 0, y=0.8, step=-1),
        way(3, "明德路", [(1, -1), (1, 0)], "residential"), way(4, "明德路", [(1, 0.8), (1, 2)], "residential"),
        way(5, "石牌路", [(3, -1), (3, 0)], "residential"), way(6, "石牌路", [(3, 0.8), (3, 2)], "residential"),
    ]
    r = run(ways, "忠孝東路", "明德路", "石牌路")
    assert r["confidence"] == "low" and "dual_carriageway" in r["reasons"]


def test_two_far_apart_same_name_roads_are_not_a_corridor():
    # 同名主路在 556 m 外還有一條，兩邊都有同名橫街：位置無法區分 → needs_manual，不可當成雙線道
    ways = [
        hline(1, "東華街", 0, 10, y=0), hline(2, "東華街", 0, 10, y=5),
        vcross(3, "明德路", 1), vcross(4, "石牌路", 3),
        way(5, "明德路", [(1, 4), (1, 5), (1, 6)], "residential"), way(6, "石牌路", [(3, 4), (3, 5), (3, 6)], "residential"),
    ]
    r = run(ways, "東華街", "明德路", "石牌路")
    assert r["confidence"] == "needs_manual" and r["reasons"][0] == "ambiguous_candidates"


def test_dual_carriageway_is_low():
    # 分隔雙線：兩條同名單向道相距約 11 m，橫街各與兩條相交
    ways = [
        hline(1, "忠孝東路", 0, 4, y=0), hline(2, "忠孝東路", 4, 0, y=0.1, step=-1),
        vcross(3, "明德路", 1, extra=(0.1,)), vcross(4, "石牌路", 3, extra=(0.1,)),
    ]
    r = run(ways, "忠孝東路", "明德路", "石牌路")
    assert r["confidence"] == "low" and "dual_carriageway" in r["reasons"]
    assert r["geometry"] is not None


# ---------- 形狀合理性 ----------

def winding_net(top):
    return [way(1, "東華街", [(0, 0), (0, top), (2, top), (2, 0)]),
            way(2, "甲路", [(-1, 0), (0, 0)], "residential"), way(3, "乙路", [(2, 0), (3, 0)], "residential")]


def test_mildly_winding_route_is_low():
    r = run(winding_net(1), "東華街", "甲路", "乙路")   # 路徑 4 格 / 直線 2 格 ≈ 2.0
    assert r["confidence"] == "low" and "winding" in r["reasons"]
    assert r["geometry"] is not None


def test_very_winding_route_is_needs_manual():
    r = run(winding_net(3), "東華街", "甲路", "乙路")   # 路徑 8 格 / 直線 2 格 ≈ 4
    assert r["confidence"] == "needs_manual" and r["reasons"][0] == "route_too_winding"
    assert r["geometry"] is None


def test_too_short_is_low():
    ways = [way(1, "東華街", [(0, 0), (1, 0), (1.25, 0), (3, 0)]), vcross(2, "明德路", 1), vcross(3, "石牌路", 1.25)]
    r = run(ways, "東華街", "明德路", "石牌路")
    assert r["confidence"] == "low" and "length_out_of_range" in r["reasons"]


def test_too_long_is_low():
    ways = [hline(1, "東華街", 0, 40), vcross(2, "明德路", 1), vcross(3, "石牌路", 36)]
    r = run(ways, "東華街", "明德路", "石牌路")
    assert r["confidence"] == "low" and "length_out_of_range" in r["reasons"]


def test_section_fallback_is_low():
    ways = [hline(1, "承德路", 0, 4), vcross(2, "中正路", 1), vcross(3, "士商路", 3)]
    r = run(ways, "承德路5段", "中正路", "士商路")
    assert r["confidence"] == "low" and "section_fallback" in r["reasons"]


@pytest.mark.parametrize("flag", ["complex_range", "has_note"])
def test_exception_flags_cap_at_low(flag):
    r = run(basic_net(), "東華街", "明德路", "石牌路", flags=[flag])
    assert r["confidence"] == "low" and f"flag:{flag}" in r["reasons"]
    assert r["geometry"] is not None


def test_multi_part_results_are_independent():
    seg = {"id": "T-2", "road": "東華街", "flags": ["multi_part"], "parts": [
        {"fromName": "明德路", "toName": "石牌路", "toNameAlt": []},
        {"fromName": "北門", "toName": "石牌路", "toNameAlt": []},
    ]}
    res = match_all([seg], basic_net())
    assert res["T-2:0"]["confidence"] == "high"
    assert res["T-2:1"]["confidence"] == "needs_manual" and res["T-2:1"]["geometry"] is None


# ---------- 整合：真實 PDF × OSM 快取（不連網路）----------

@pytest.fixture(scope="module")
def real():
    from parse_pdf import PDF, parse_pdf
    osm = json.loads((ROOT / "data" / "source" / "osm" / "taipei_roads.json").read_text(encoding="utf-8"))
    segs = parse_pdf(PDF)
    return segs, match_all(segs, osm["ways"])


def test_real_every_part_has_a_result(real):
    segs, res = real
    assert set(res) == {f"{s['id']}:{i}" for s in segs for i in range(len(s["parts"]))}
    assert len(res) == 101


def test_real_invariants(real):
    _, res = real
    south, west, north, east = 24.96, 121.45, 25.21, 121.67
    for key, r in res.items():
        assert r["confidence"] in ("high", "low", "needs_manual"), key
        if r["confidence"] == "needs_manual":
            assert r["geometry"] is None and r["reasons"], key
            continue
        assert len(r["geometry"]) >= 2, key
        assert all(south <= lat <= north and west <= lng <= east for lng, lat in r["geometry"]), key
        if r["confidence"] == "high":
            assert r["reasons"] == [] and r["ratio"] <= 1.5 and 30 <= r["lengthM"] <= 3000, key


def test_real_match_is_deterministic(real):
    segs, res = real
    from parse_pdf import PDF, parse_pdf
    osm = json.loads((ROOT / "data" / "source" / "osm" / "taipei_roads.json").read_text(encoding="utf-8"))
    again = match_all(parse_pdf(PDF), osm["ways"])
    assert json.dumps(again, sort_keys=True) == json.dumps(res, sort_keys=True)
