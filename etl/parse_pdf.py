"""官方 PDF《假日開放黃線停車路段表》→ etl/out/segments_raw.json

每個官方編號輸出一筆，結構：
{
  "id": "TP-HOL-001", "no": 1, "district": "北投", "road": "東華街",
  "parts": [ {"direction", "axis", "side", "fromName", "fromAddr": [...], "toName", "toNameAlt": [...], "toAddr": [...]} ],
  "openWindows": [{"start": "00:00", "end": "24:00"}], "timeRaw": "00~24",
  "note": "", "flags": [...]
}

PDF 的「續行列」（編號欄為空）有四種意思，依序判斷：
1. 整列空白                              → 丟棄
2. 有自己的方向或起點                    → 同一編號的另一段（新 part）
3. 只有起迄點名稱、且以數字開頭           → 上一列名稱斷行，接回去（陽光街 + 345巷）
   只有起迄點名稱、不以數字開頭           → 原表該格被切成兩格，保留為候選（toNameAlt），標 ambiguous_endpoint
4. 只有門牌                              → 另一側的門牌，併入上一段

flags（交給 Phase 2 決定信心）：
  ambiguous_endpoint  起迄點有兩個候選
  missing_endpoint    起點或迄點名稱空白
  no_address          起迄門牌皆無
  complex_range       門牌欄含「至」的分段範圍
  has_note            備註欄有文字（例外範圍，不自動解析）
  multi_part          同一編號有多段
"""

import json
import re
import sys
import unicodedata
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parents[1]
PDF = ROOT / "data" / "source" / "pma-holiday-yellow-line-2021-12-14.pdf"
OUT = ROOT / "etl" / "out" / "segments_raw.json"
SOURCE = "pma_holiday_pdf_2021-12-14"

COLS = ["no", "district", "road", "direction", "fromName", "fromAddr", "toName", "toAddr", "time", "note"]

AXES = {"南往北": "s2n", "北往南": "n2s", "東往西": "e2w", "西往東": "w2e", "雙向": "both"}
SIDES = {"東側": "east", "西側": "west", "南側": "south", "北側": "north", "單號側": "odd", "雙號側": "even"}
NO_ADDR = {"無門牌號碼"}


def clean(s):
    """去掉儲存格內的斷行與空白（中文路名不需要空白），並做 NFC 正規化。
    PDF 文字層會夾帶 CJK 相容表意文字（如「蘭」U+F91F、「隆」U+F9DC），外觀同標準字、碼位不同，
    不轉掉就無法與 OSM 路名比對；NFC 只處理這類標準等價字，不動全形/半形。"""
    if s is None:
        return None
    s = unicodedata.normalize("NFC", re.sub(r"\s+", "", s))
    return s or None


def parse_windows(raw):
    """'00~13\\n20~24' → [{'start':'00:00','end':'13:00'}, ...]；格式不符回 None"""
    if not raw:
        return None
    out = []
    for piece in raw.split("\n"):
        piece = piece.strip()
        if not piece:
            continue
        m = re.fullmatch(r"(\d{1,2})\s*[~\-～－]\s*(\d{1,2})", piece)
        if not m:
            return None
        s, e = int(m[1]), int(m[2])
        if not (0 <= s < e <= 24):
            return None
        out.append({"start": f"{s:02d}:00", "end": f"{e:02d}:00"})
    return out or None


def parse_direction(raw):
    raw = clean(raw) or ""
    raw = raw.replace("向", "往") if raw != "雙向" else raw
    if raw in AXES:
        return {"axis": AXES[raw], "side": None}
    if raw in SIDES:
        return {"axis": None, "side": SIDES[raw]}
    return None


def parse_address(raw):
    raw = clean(raw)
    if raw is None or raw in NO_ADDR:
        return None
    m = re.match(r"^(東側|西側|南側|北側)[：:](.+)$", raw)
    if m:
        return {"side": SIDES[m[1]], "text": m[2]}
    return {"side": None, "text": raw}


def _rows(pdf_path):
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables():
                for row in table:
                    if len(row) != len(COLS):
                        raise ValueError(f"第 {page.page_number} 頁欄數 {len(row)}，預期 {len(COLS)}")
                    r = dict(zip(COLS, row))
                    if clean(r["no"]) == "編號":
                        continue
                    yield r


def _new_part(r):
    d = parse_direction(r["direction"])
    return {
        "direction": clean(r["direction"]),
        "axis": d and d["axis"],
        "side": d and d["side"],
        "fromName": clean(r["fromName"]),
        "fromAddr": [a for a in [parse_address(r["fromAddr"])] if a],
        "toName": clean(r["toName"]),
        "toNameAlt": [],
        "toAddr": [a for a in [parse_address(r["toAddr"])] if a],
    }


def _join_name(part, key, frag, seg):
    if frag[0].isdigit() and part[key]:
        part[key] += frag
    elif key == "toName":
        part["toNameAlt"].append(frag)
        seg["flags"].add("ambiguous_endpoint")
    else:
        part[key] = (part[key] or "") + frag
        seg["flags"].add("ambiguous_endpoint")


def parse_pdf(pdf_path=PDF):
    segs = []
    for r in _rows(pdf_path):
        no = clean(r["no"])
        if no:
            seg = {
                "id": f"TP-HOL-{int(no):03d}",
                "no": int(no),
                "district": clean(r["district"]),
                "road": clean(r["road"]),
                "parts": [_new_part(r)],
                "timeRaw": (r["time"] or "").strip(),
                "note": clean(r["note"]) or "",
                "flags": set(),
                "source": SOURCE,
            }
            segs.append(seg)
            continue

        if not segs:
            raise ValueError("第一列就是續行列，無法 forward-fill")
        seg = segs[-1]
        if not any(clean(v) for v in r.values()):
            continue  # 1. 空白列
        if clean(r["direction"]) or clean(r["fromName"]):
            seg["parts"].append(_new_part(r))  # 2. 另一段
            seg["flags"].add("multi_part")
        else:
            part = seg["parts"][-1]
            for key in ("fromName", "toName"):  # 3. 名稱斷行或候選
                frag = clean(r[key])
                if frag:
                    _join_name(part, key, frag, seg)
            for key in ("fromAddr", "toAddr"):  # 4. 另一側門牌
                a = parse_address(r[key])
                if a:
                    part[key].append(a)
        t = (r["time"] or "").strip()
        if t and parse_windows(t) != parse_windows(seg["timeRaw"]):
            raise ValueError(f"#{seg['no']} 續行列時段 {t!r} 與首列 {seg['timeRaw']!r} 不同")
        note = clean(r["note"])
        if note:
            seg["note"] = (seg["note"] + note) if seg["note"] else note

    for seg in segs:
        seg["openWindows"] = parse_windows(seg["timeRaw"])
        if seg["openWindows"] is None:
            raise ValueError(f"#{seg['no']} 時段無法解析：{seg['timeRaw']!r}")
        for p in seg["parts"]:
            if p["axis"] is None and p["side"] is None:
                raise ValueError(f"#{seg['no']} 方向無法解析：{p['direction']!r}")
            if not p["fromName"] or not p["toName"]:
                seg["flags"].add("missing_endpoint")
            if not p["fromAddr"] and not p["toAddr"]:
                seg["flags"].add("no_address")
            if any("至" in a["text"] for a in p["fromAddr"] + p["toAddr"]):
                seg["flags"].add("complex_range")
        if seg["note"]:
            seg["flags"].add("has_note")
        seg["flags"] = sorted(seg["flags"])
    return segs


def main():
    segs = parse_pdf(PDF)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(segs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    flagged = {}
    for s in segs:
        for f in s["flags"]:
            flagged.setdefault(f, []).append(s["no"])
    print(f"寫出 {OUT.relative_to(ROOT)}：{len(segs)} 筆，{sum(len(s['parts']) for s in segs)} 段")
    for f, nos in sorted(flagged.items()):
        print(f"  {f:<20} {len(nos):>3} 筆：{nos}")


if __name__ == "__main__":
    sys.exit(main())
