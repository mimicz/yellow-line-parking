"""辦公日曆表 → data/holidays.json

來源：中華民國政府行政機關辦公日曆表（行政院人事行政總處，https://data.gov.tw/dataset/14718），
經 ruyut/TaiwanCalendar 轉為 UTF-8 JSON。原始檔存於 data/source/holidays/{year}.json。

輸出只保留「例外日」：
- offDays：週一到週五卻放假的日子
- workDays：週六日卻要上班的日子（補班日）
其餘日子依「週六日 = 假日」推得。

用法：python etl/build_holidays.py 2026 2027
新年度公告後：把新年度的 JSON 放進 data/source/holidays/，加上年份重跑。
"""

import json
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "data" / "source" / "holidays"
OUT = ROOT / "data" / "holidays.json"


def load_year(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _check_year(year, days):
    expected = (date(year + 1, 1, 1) - date(year, 1, 1)).days
    if len(days) != expected:
        raise ValueError(f"{year} 年應有 {expected} 天，實際 {len(days)} 天")
    d = date(year, 1, 1)
    for row in days:
        if row["date"] != d.strftime("%Y%m%d"):
            raise ValueError(f"{year} 年資料日期不連續或年份不符：預期 {d:%Y%m%d}，實際 {row['date']}")
        d += timedelta(days=1)


def build(raw_by_year):
    off, work = {}, {}
    for year in sorted(raw_by_year):
        days = raw_by_year[year]
        _check_year(year, days)
        for row in days:
            d = date(int(row["date"][:4]), int(row["date"][4:6]), int(row["date"][6:]))
            weekend = d.weekday() >= 5
            desc = (row.get("description") or "").strip()
            if row["isHoliday"] and not weekend:
                off[d.isoformat()] = desc or "放假"
            elif not row["isHoliday"] and weekend:
                work[d.isoformat()] = desc or "補行上班"
    return {
        "source": "中華民國政府行政機關辦公日曆表（行政院人事行政總處），經 ruyut/TaiwanCalendar 整理",
        "sourceUrl": "https://data.gov.tw/dataset/14718",
        "years": sorted(raw_by_year),
        "offDays": off,
        "workDays": work,
    }


def main(years):
    raw = {y: load_year(SRC_DIR / f"{y}.json") for y in years}
    table = build(raw)
    OUT.write_text(json.dumps(table, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"寫出 {OUT.relative_to(ROOT)}：年份 {table['years']}，"
          f"平日放假 {len(table['offDays'])} 天，週末補班 {len(table['workDays'])} 天")


if __name__ == "__main__":
    main([int(y) for y in sys.argv[1:]] or [2026, 2027])
