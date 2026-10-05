import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))

from fetch_osm import base_road_name, batches, build_query, collect_names, merge  # noqa: E402


@pytest.mark.parametrize("raw,expected", [
    ("東華街", "東華街"),
    ("承德路5段", "承德路"),
    ("杭州南路二段", "杭州南路"),
    ("羅斯福路2-3段", "羅斯福路"),
    ("德行東路365巷11弄", "德行東路"),
    ("辛亥路5段47巷", "辛亥路"),
    ("市民大道8段", "市民大道"),
    ("凱達格蘭大道", "凱達格蘭大道"),
    ("環南2段", "環河南路"),
    ("東華橋", "東華橋"),
    ("石牌路口", "石牌路"),
    ("陽光街345巷口", "陽光街"),
    ("370巷", None),       # 只有巷號，沒有路名
    ("北門", None),         # 地標
    ("泰北高中門口", None),
    ("南港交流道", None),
    (None, None),
])
def test_base_road_name(raw, expected):
    assert base_road_name(raw) == expected


def test_collect_names_from_road_and_endpoints():
    segs = [
        {"road": "承德路5段", "parts": [{"fromName": "中正路", "toName": "士商路", "toNameAlt": []}]},
        {"road": "瑞光路", "parts": [{"fromName": "陽光街", "toName": "江南街117巷8弄", "toNameAlt": ["江南街"]}]},
        {"road": "忠孝東路6段", "parts": [{"fromName": "370巷", "toName": "昆陽街", "toNameAlt": []}]},
    ]
    assert collect_names(segs) == ["中正路", "士商路", "忠孝東路", "承德路", "昆陽街", "江南街", "瑞光路", "陽光街"]


def test_batches():
    assert batches(list("abcde"), 2) == [["a", "b"], ["c", "d"], ["e"]]


def test_build_query_contains_names_and_bbox():
    q = build_query(["承德路", "中正路"], (24.96, 121.45, 25.21, 121.67))
    assert '"name"~"^(承德路|中正路)"' in q
    assert "(24.96,121.45,25.21,121.67)" in q
    assert "out tags geom" in q


def test_merge_dedups_and_compacts():
    resp1 = {"elements": [
        {"type": "way", "id": 1, "tags": {"name": "承德路五段", "highway": "primary", "surface": "asphalt"},
         "geometry": [{"lat": 25.0912345678, "lon": 121.5212345678}, {"lat": 25.092, "lon": 121.522}]},
    ]}
    resp2 = {"elements": [
        {"type": "way", "id": 1, "tags": {"name": "承德路五段", "highway": "primary"},
         "geometry": [{"lat": 25.0912345678, "lon": 121.5212345678}, {"lat": 25.092, "lon": 121.522}]},
        {"type": "way", "id": 2, "tags": {"name": "中正路", "highway": "secondary", "oneway": "yes"},
         "geometry": [{"lat": 25.1, "lon": 121.5}, {"lat": 25.101, "lon": 121.501}]},
        {"type": "node", "id": 9},
    ]}
    out = merge([resp1, resp2])
    assert [w["id"] for w in out] == [1, 2]
    assert out[0]["tags"] == {"name": "承德路五段", "highway": "primary"}  # 只留需要的 tag
    assert out[0]["geometry"][0] == [121.5212346, 25.0912346]            # [lng, lat]，7 位小數
    assert out[1]["tags"]["oneway"] == "yes"


def test_fetch_group_splits_on_failure_and_caches(tmp_path, monkeypatch):
    import fetch_osm
    monkeypatch.setattr(fetch_osm.time, "sleep", lambda s: None)
    calls = []

    def fake(query):
        n = query.split('"^(')[1].split(')"')[0].split("|")
        calls.append(n)
        if len(n) > 2:  # 模擬伺服器忙：大於 2 個路名就逾時
            raise fetch_osm.FetchFailed("504")
        return {"elements": [{"type": "way", "id": hash(x) % 1000, "tags": {"name": x},
                              "geometry": [{"lat": 25, "lon": 121.5}]} for x in n]}

    names = ["甲路", "乙路", "丙路", "丁路", "戊路"]
    out = fetch_osm.fetch_group(names, fake, tmp_path)
    got = sorted(el["tags"]["name"] for r in out for el in r["elements"])
    assert got == sorted(names)
    assert len(list(tmp_path.glob("*.json"))) == 3  # 甲乙、丙、丁戊 各一份快取

    # 重跑：拆過的批次直接走子批次，全部讀快取，完全不打網路
    calls.clear()
    out2 = fetch_osm.fetch_group(names, fake, tmp_path)
    assert sorted(el["tags"]["name"] for r in out2 for el in r["elements"]) == sorted(names)
    assert calls == []


def test_fetch_group_single_name_failure_exits(tmp_path, monkeypatch):
    import fetch_osm

    def always_fail(query):
        raise fetch_osm.FetchFailed("504")

    with pytest.raises(SystemExit, match="甲路"):
        fetch_osm.fetch_group(["甲路"], always_fail, tmp_path)
