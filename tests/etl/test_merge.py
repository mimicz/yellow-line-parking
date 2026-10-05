import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))

from merge import build_collections, load_overrides, serialize  # noqa: E402

LINE = [[121.50, 25.00], [121.51, 25.00]]
OTHER = [[121.52, 25.01], [121.53, 25.01], [121.54, 25.02]]


def seg(sid, no, parts=1, **kw):
    return {
        "id": sid, "no": no, "district": "中正", "road": "東華街",
        "parts": [{"direction": "南往北", "axis": "s2n", "side": None, "fromName": "甲路", "toName": "乙路",
                   "toNameAlt": [], "fromAddr": [], "toAddr": []} for _ in range(parts)],
        "timeRaw": "00~24", "openWindows": [{"start": "00:00", "end": "24:00"}],
        "note": "", "flags": [], "source": "pma_holiday_pdf_2021-12-14", **kw,
    }


def match(conf, geometry=None, reasons=()):
    return {"confidence": conf, "reasons": list(reasons), "geometry": geometry, "osmWayIds": [7] if geometry else [],
            "lengthM": 100.0 if geometry else None, "straightM": 100.0 if geometry else None,
            "ratio": 1.0 if geometry else None}


def sample():
    segs = [seg("TP-HOL-001", 1), seg("TP-HOL-002", 2), seg("TP-HOL-003", 3), seg("TP-HOL-004", 4, parts=2)]
    matches = {
        "TP-HOL-001:0": match("high", LINE),
        "TP-HOL-002:0": match("low", LINE, ["winding"]),
        "TP-HOL-003:0": match("needs_manual", None, ["endpoint_landmark:from"]),
        "TP-HOL-004:0": match("high", LINE),
        "TP-HOL-004:1": match("low", LINE, ["dual_carriageway"]),
    }
    return segs, matches


def feats(fc):
    return {f"{f['properties']['id']}:{f['properties']['partIndex']}": f for f in fc["features"]}


# ---------- 顯示規則 ----------

def test_only_high_is_shown_and_public_geometry_is_stripped_for_the_rest():
    pub, rev = build_collections(*sample(), {})
    p, r = feats(pub), feats(rev)
    assert p["TP-HOL-001:0"]["properties"]["show"] is True
    assert p["TP-HOL-001:0"]["geometry"] == {"type": "LineString", "coordinates": LINE}
    for k in ("TP-HOL-002:0", "TP-HOL-003:0", "TP-HOL-004:1"):
        assert p[k]["properties"]["show"] is False
        assert p[k]["geometry"] is None, k          # 公開檔：未確認者一律沒有座標
    # 校正頁用的檔：low 保留候選幾何，needs_manual 仍為 None
    assert r["TP-HOL-002:0"]["geometry"]["coordinates"] == LINE
    assert r["TP-HOL-003:0"]["geometry"] is None


def test_properties_carry_what_the_app_needs():
    pub, _ = build_collections(*sample(), {})
    pr = feats(pub)["TP-HOL-004:1"]["properties"]
    assert pr["id"] == "TP-HOL-004" and pr["no"] == 4 and pr["partIndex"] == 1 and pr["nParts"] == 2
    assert pr["district"] == "中正" and pr["road"] == "東華街" and pr["direction"] == "南往北"
    assert pr["openWindows"] == [{"start": "00:00", "end": "24:00"}] and pr["timeRaw"] == "00~24"
    assert pr["confidence"] == "low" and pr["reasons"] == ["dual_carriageway"]


def test_meta_counts_ids_only_when_every_part_is_shown():
    pub, _ = build_collections(*sample(), {})
    m = pub["meta"]
    assert m["totalIds"] == 4 and m["totalParts"] == 5
    assert m["shownIds"] == 1          # 只有 001；004 有一段未確認，整筆不算
    assert m["shownParts"] == 2
    assert m["sourceDate"] == "2021-12-14"
    assert "現場標誌" in m["disclaimer"]


# ---------- 人工校正 ----------

def test_override_with_geometry_replaces_and_is_shown():
    segs, matches = sample()
    pub, _ = build_collections(segs, matches, {"TP-HOL-003:0": {"geometry": OTHER}})
    f = feats(pub)["TP-HOL-003:0"]
    assert f["properties"]["confidence"] == "manual" and f["properties"]["show"] is True
    assert f["geometry"]["coordinates"] == OTHER
    assert "manual_override" in f["properties"]["reasons"]


def test_override_confirm_keeps_auto_geometry():
    segs, matches = sample()
    pub, _ = build_collections(segs, matches, {"TP-HOL-002:0": {"confirmed": True}})
    f = feats(pub)["TP-HOL-002:0"]
    assert f["properties"]["confidence"] == "manual" and f["properties"]["show"] is True
    assert f["geometry"]["coordinates"] == LINE
    assert "manual_confirmed" in f["properties"]["reasons"]


@pytest.mark.parametrize("key,ov,msg", [
    ("TP-HOL-999:0", {"geometry": OTHER}, "不存在"),
    ("TP-HOL-003:0", {"confirmed": True}, "沒有自動幾何"),
    ("TP-HOL-002:0", {}, "confirmed"),
    ("TP-HOL-002:0", {"geometry": [[121.5, 25.0]]}, "至少 2 點"),
    ("TP-HOL-002:0", {"geometry": [[121.5, 25.0], [121.5, 31.0]]}, "範圍"),
    ("TP-HOL-002:0", {"geometry": [[25.0, 121.5], [25.1, 121.5]]}, "範圍"),   # 經緯度顛倒
])
def test_invalid_overrides_are_rejected(key, ov, msg):
    segs, matches = sample()
    with pytest.raises(ValueError, match=msg):
        build_collections(segs, matches, {key: ov})


def test_load_overrides_missing_file_is_empty(tmp_path):
    assert load_overrides(tmp_path / "nope.json") == {}


def test_load_overrides_reads_json(tmp_path):
    f = tmp_path / "o.json"
    f.write_text(json.dumps({"TP-HOL-002:0": {"confirmed": True}}), encoding="utf-8")
    assert load_overrides(f) == {"TP-HOL-002:0": {"confirmed": True}}


def test_serialize_is_deterministic_and_valid_json():
    pub, _ = build_collections(*sample(), {})
    text = serialize(pub)
    assert text == serialize(pub) and text.endswith("\n")
    assert json.loads(text) == pub


# ---------- 整合：真實資料 ----------

@pytest.fixture(scope="module")
def real():
    from match_osm import match_all
    from parse_pdf import PDF, parse_pdf
    osm = json.loads((ROOT / "data" / "source" / "osm" / "taipei_roads.json").read_text(encoding="utf-8"))
    segs = parse_pdf(PDF)
    ov = load_overrides(ROOT / "data" / "manual" / "overrides.json")
    return build_collections(segs, match_all(segs, osm["ways"]), ov)


def test_real_public_geometry_only_where_shown(real):
    pub, rev = real
    assert len(pub["features"]) == len(rev["features"]) == 101
    assert pub["meta"]["totalIds"] == 99
    for f in pub["features"]:
        pr = f["properties"]
        assert (f["geometry"] is not None) == pr["show"], pr["id"]
        assert pr["show"] == (pr["confidence"] in ("high", "manual")), pr["id"]


def test_real_committed_geojson_is_fresh(real):
    pub, rev = real
    assert (ROOT / "data" / "segments.geojson").read_text(encoding="utf-8") == serialize(pub), \
        "data/segments.geojson 已過期，請重跑 python etl/merge.py"
    assert (ROOT / "data" / "segments_review.geojson").read_text(encoding="utf-8") == serialize(rev), \
        "data/segments_review.geojson 已過期，請重跑 python etl/merge.py"
