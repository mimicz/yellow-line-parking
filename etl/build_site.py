"""組出要部署到 GitHub Pages 的靜態網站 → _site/

只放 index.html 實際用到的檔案：從 index.html 的 <script type="module"> 出發，順著 JS 的相對 import 與
fetchJson('…') 抓的資料檔收集。**不會**公開 editor.html、校正用資料（segments_review.geojson、
data/manual/）、OSM 快取、官方 PDF、ETL 與測試。

部署前會檢查公開資料的安全底線：show=false 的路段不得有幾何、show=true 必須有幾何且信心為 high／manual。
不替使用者刪檔：目的地有多餘的檔案就拒絕，請自行清空後重建。

用法（在 repo 根目錄）：
    python etl/build_site.py            # → _site/
    python etl/build_site.py <目錄>
"""

import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENTRY = "index.html"
SHOWN_CONFIDENCE = ("high", "manual")
# 有 scheme（http:、data:、mailto:、javascript:…）、協定相對（//）、頁內錨點（#）的都不是要複製的本地檔案
NOT_LOCAL_RE = re.compile(r"^(?:[a-z][a-z0-9+.\-]*:|//|#)", re.I)


def check_public_data(data):
    """公開的 segments.geojson 不得含未確認的幾何（結構上杜絕「畫錯卻顯示為可停」）"""
    if not isinstance(data.get("meta"), dict):
        raise ValueError("segments.geojson 缺少 meta（已收錄筆數、來源版本、免責原文）")
    for f in data.get("features", []):
        p = f["properties"]
        name = f"{p.get('id')}:{p.get('partIndex')}"
        if not isinstance(p.get("show"), bool):
            raise ValueError(f"{name}：show 必須是布林值，得到 {p.get('show')!r}")
        g = f.get("geometry")
        if not p["show"]:
            if g is not None:
                raise ValueError(f"{name}：show=false 的路段不得有幾何")
            continue
        if g is None:
            raise ValueError(f"{name}：show=true 但沒有幾何")
        if p.get("confidence") not in SHOWN_CONFIDENCE:
            raise ValueError(f"{name}：信心為 {p.get('confidence')}，不得顯示")
        if g.get("type") != "LineString" or len(g.get("coordinates", [])) < 2:
            raise ValueError(f"{name}：幾何必須是至少 2 點的 LineString")


def _imports(js_text):
    return re.findall(r"""(?:from\s+|import\s+)['"](\.{1,2}/[^'"]+)['"]""", js_text)


def collect(root=ROOT):
    """index.html 需要的檔案（相對 root 的 POSIX 路徑，已排序）"""
    root = Path(root)
    html = (root / ENTRY).read_text(encoding="utf-8")
    files = {ENTRY}
    queue = []
    for ref in re.findall(r'<script[^>]*src="([^"]+)"', html) + re.findall(r'<link[^>]*href="([^"]+)"', html):
        if not NOT_LOCAL_RE.match(ref):
            files.add(ref)
            if ref.endswith(".js"):
                queue.append(ref)
    while queue:
        cur = queue.pop()
        text = (root / cur).read_text(encoding="utf-8")
        for ref in _imports(text):
            path = (Path(cur).parent / ref).as_posix()
            norm = Path(path).as_posix()
            parts = []
            for seg in norm.split("/"):
                if seg == "..":
                    parts.pop()
                elif seg != ".":
                    parts.append(seg)
            norm = "/".join(parts)
            if norm not in files:
                files.add(norm)
                queue.append(norm)
        for ref in re.findall(r"""fetchJson\(\s*['"]([^'"]+)['"]""", text):
            files.add(ref)
    return sorted(files)


def build(dest, root=ROOT):
    root, dest = Path(root), Path(dest)
    files = collect(root)
    check_public_data(json.loads((root / "data" / "segments.geojson").read_text(encoding="utf-8")))

    if dest.exists():
        expected = {*files, ".nojekyll"}
        extra = sorted(p.relative_to(dest).as_posix() for p in dest.rglob("*") if p.is_file()
                       and p.relative_to(dest).as_posix() not in expected)
        if extra:
            raise SystemExit(f"{dest} 內有不屬於網站的檔案：{'、'.join(extra)}。請自行清空後重建（腳本不替你刪檔）。")
    for rel in files:
        out = dest / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / rel, out)
    (dest / ".nojekyll").write_text("", encoding="utf-8")    # 不經 Jekyll 處理
    return files


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except AttributeError:
            pass
    dest = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "_site"
    files = build(dest, ROOT)
    size = sum((dest / f).stat().st_size for f in files)
    print(f"已建置 {dest}：{len(files)} 個檔案，{size // 1024} KB")
    for f in files:
        print(f"  {f}")


if __name__ == "__main__":
    main()
