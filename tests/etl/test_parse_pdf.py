import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))

from parse_pdf import (  # noqa: E402
    PDF,
    clean,
    parse_address,
    parse_direction,
    parse_pdf,
    parse_windows,
)


# ---------- 單元：欄位正規化 ----------

@pytest.mark.parametrize("raw,expected", [
    ("00~24", [{"start": "00:00", "end": "24:00"}]),
    ("00-24", [{"start": "00:00", "end": "24:00"}]),
    ("0-24", [{"start": "00:00", "end": "24:00"}]),
    ("08~18", [{"start": "08:00", "end": "18:00"}]),
    ("00~13\n20~24", [{"start": "00:00", "end": "13:00"}, {"start": "20:00", "end": "24:00"}]),
    ("00～24", [{"start": "00:00", "end": "24:00"}]),  # 全形波浪
    ("00－24", [{"start": "00:00", "end": "24:00"}]),  # 全形連字號
])
def test_parse_windows(raw, expected):
    assert parse_windows(raw) == expected


@pytest.mark.parametrize("raw", ["", None, "全天", "25~26", "18~08"])
def test_parse_windows_invalid(raw):
    assert parse_windows(raw) is None


@pytest.mark.parametrize("raw,axis,side", [
    ("南往北", "s2n", None),
    ("北往南", "n2s", None),
    ("東往西", "e2w", None),
    ("西往東", "w2e", None),
    ("西向東", "w2e", None),
    ("雙向", "both", None),
    ("北側", None, "north"),
    ("雙號側", None, "even"),
    ("單號側", None, "odd"),
])
def test_parse_direction(raw, axis, side):
    assert parse_direction(raw) == {"axis": axis, "side": side}


def test_parse_direction_unknown():
    assert parse_direction("斜向") is None


@pytest.mark.parametrize("raw,expected", [
    ("無門牌號碼", None),
    ("", None),
    (None, None),
    ("東華街2段418號", {"side": None, "text": "東華街2段418號"}),
    ("西側：重慶北路2段178-1號", {"side": "west", "text": "重慶北路2段178-1號"}),
    ("南側：長安東路2-1號", {"side": "south", "text": "長安東路2-1號"}),
    ("北側:昆明街至69號", {"side": "north", "text": "昆明街至69號"}),
])
def test_parse_address(raw, expected):
    assert parse_address(raw) == expected


def test_clean_removes_line_breaks_and_spaces():
    assert clean("德行東路365巷11弄\n16號旁") == "德行東路365巷11弄16號旁"
    assert clean("羅斯福路2-3 段") == "羅斯福路2-3段"
    assert clean("") is None
    assert clean(None) is None


def test_clean_normalizes_cjk_compatibility_ideographs():
    # PDF 文字層的「蘭」「隆」是相容表意文字（U+F91F、U+F9DC），外觀同標準字但碼位不同，
    # 會讓 Overpass 與 OSM 名稱比對落空；clean 須轉成標準字
    assert clean("凱達格蘭大道") == "凱達格蘭大道"
    assert clean("基隆路") == "基隆路"


# ---------- 整合：以實際 PDF 為 fixture ----------

@pytest.fixture(scope="module")
def segs():
    return {s["no"]: s for s in parse_pdf(PDF)}


def test_total_99_contiguous(segs):
    assert sorted(segs) == list(range(1, 100))


def test_ids_and_districts(segs):
    assert segs[8]["id"] == "TP-HOL-008"
    assert len({s["district"] for s in segs.values()}) == 12
    assert all(s["district"] and s["road"] for s in segs.values())


def test_forward_fill_multi_part(segs):
    # #1 東華街：兩段，第二段起點明德路
    s = segs[1]
    assert s["road"] == "東華街" and s["district"] == "北投"
    assert [p["fromName"] for p in s["parts"]] == ["東華橋", "明德路"]
    assert [p["toName"] for p in s["parts"]] == ["明德路", "石牌路口"]


def test_multi_part_different_direction(segs):
    assert [p["axis"] for p in segs[57]["parts"]] == ["s2n", "n2s"]


def test_special_windows(segs):
    assert segs[8]["openWindows"] == [{"start": "00:00", "end": "13:00"}, {"start": "20:00", "end": "24:00"}]
    assert segs[87]["openWindows"] == [{"start": "08:00", "end": "18:00"}]
    assert segs[93]["openWindows"] == [{"start": "08:00", "end": "18:00"}]
    others = [n for n, s in segs.items() if s["openWindows"] != [{"start": "00:00", "end": "24:00"}]]
    assert sorted(others) == [8, 87, 93]


def test_side_addresses_merged(segs):
    p = segs[16]["parts"]
    assert len(p) == 1
    assert p[0]["fromAddr"] == [
        {"side": "west", "text": "重慶北路2段178-1號"},
        {"side": "east", "text": "重慶北路2段173-1號"},
    ]
    assert p[0]["toAddr"][1] == {"side": "east", "text": "重慶北路2段195-1號"}


def test_wrapped_endpoint_name_joined(segs):
    assert segs[31]["parts"][0]["toName"] == "陽光街345巷"
    assert segs[60]["parts"][0]["toName"] == "詔安街37巷"
    assert "ambiguous_endpoint" not in segs[31]["flags"]


def test_split_endpoint_kept_as_alternatives(segs):
    p = segs[33]["parts"][0]
    assert p["toName"] == "江南街117巷8弄"
    assert p["toNameAlt"] == ["江南街"]
    assert "ambiguous_endpoint" in segs[33]["flags"]


def test_empty_row_dropped(segs):
    assert len(segs[34]["parts"]) == 1


def test_missing_addresses_flagged_not_crashing(segs):
    for n in (97, 98):
        p = segs[n]["parts"][0]
        assert p["fromAddr"] == [] and p["toAddr"] == []
        assert "no_address" in segs[n]["flags"]


def test_missing_to_name_flagged(segs):
    assert segs[58]["parts"][0]["toName"] is None
    assert "missing_endpoint" in segs[58]["flags"]


def test_note_kept_verbatim(segs):
    assert segs[61]["note"] == "北側自寶慶路24號前至博愛路除外"
    assert "has_note" in segs[61]["flags"]


def test_complex_range_flagged(segs):
    # #50 永福街：門牌欄含「至」的分段範圍，交給人工
    assert "complex_range" in segs[50]["flags"]
    assert len(segs[50]["parts"][0]["toAddr"]) == 4


def test_names_have_no_whitespace(segs):
    for s in segs.values():
        assert " " not in s["road"]
        for p in s["parts"]:
            for k in ("fromName", "toName"):
                assert p[k] is None or not any(c.isspace() for c in p[k])


def test_no_compatibility_ideographs_in_output(segs):
    import json
    import unicodedata
    text = json.dumps(list(segs.values()), ensure_ascii=False)
    bad = sorted({f"U+{ord(c):04X}" for c in text if unicodedata.normalize("NFC", c) != c})
    assert bad == []


def test_every_part_has_direction(segs):
    for s in segs.values():
        for p in s["parts"]:
            assert p["axis"] or p["side"], (s["no"], p)
