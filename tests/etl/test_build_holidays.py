import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))

from build_holidays import build, load_year  # noqa: E402


def _days(year, overrides):
    """產生一整年的 TaiwanCalendar 格式資料；overrides = {"YYYYMMDD": (isHoliday, desc)}"""
    from datetime import date, timedelta

    d = date(year, 1, 1)
    out = []
    while d.year == year:
        key = d.strftime("%Y%m%d")
        hol, desc = overrides.get(key, (d.weekday() >= 5, ""))
        out.append({"date": key, "week": "一二三四五六日"[d.weekday()], "isHoliday": hol, "description": desc})
        d += timedelta(days=1)
    return out


def test_only_exceptions_are_kept():
    # 2026-10-09 週五放假、2026-10-17 週六補班（虛構）
    raw = {2026: _days(2026, {"20261009": (True, "補假"), "20261017": (False, "補行上班")})}
    t = build(raw)
    assert t["years"] == [2026]
    assert t["offDays"] == {"2026-10-09": "補假"}
    assert t["workDays"] == {"2026-10-17": "補行上班"}


def test_missing_description_gets_default_label():
    raw = {2026: _days(2026, {"20261009": (True, ""), "20261017": (False, "")})}
    t = build(raw)
    assert t["offDays"]["2026-10-09"] == "放假"
    assert t["workDays"]["2026-10-17"] == "補行上班"


def test_incomplete_year_is_rejected():
    days = _days(2026, {})[:-1]  # 少了 12/31
    with pytest.raises(ValueError, match="365"):
        build({2026: days})


def test_wrong_year_in_file_is_rejected():
    with pytest.raises(ValueError, match="2027"):
        build({2027: _days(2026, {})})


def test_real_source_files():
    raw = {y: load_year(ROOT / "data" / "source" / "holidays" / f"{y}.json") for y in (2026, 2027)}
    t = build(raw)
    assert t["years"] == [2026, 2027]
    assert t["offDays"]["2026-01-01"] == "開國紀念日"
    assert t["offDays"]["2026-10-09"] == "補假"
    assert "2026-10-10" not in t["offDays"]  # 國慶日適逢週六，本來就是假日，不必列


def test_committed_output_matches_source():
    """data/holidays.json 必須是由原始檔重新產出的結果，避免手改"""
    raw = {y: load_year(ROOT / "data" / "source" / "holidays" / f"{y}.json") for y in (2026, 2027)}
    committed = json.loads((ROOT / "data" / "holidays.json").read_text(encoding="utf-8"))
    built = build(raw)
    for k in ("years", "offDays", "workDays"):
        assert committed[k] == built[k]
