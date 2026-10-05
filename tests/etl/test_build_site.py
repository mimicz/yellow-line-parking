import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "etl"))

from build_site import build, check_public_data, collect  # noqa: E402

REQUIRED = {
    "index.html", "src/main.js", "src/view.js", "src/rules.js", "src/holidays.js", "src/geo.js", "src/locate.js",
    "data/segments.geojson", "data/holidays.json",
}


def test_collect_is_exactly_the_runtime_files():
    files = set(collect(ROOT))
    assert REQUIRED <= files
    # 校正頁、校正用資料、OSM 快取、官方 PDF、ETL、測試都不該被公開
    bad = [f for f in files if f.startswith(("src/editor", "etl/", "tests/", "docs/", "data/source", "data/manual"))
           or f in ("editor.html", "data/segments_review.geojson")]
    assert bad == []
    assert files == REQUIRED, files ^ REQUIRED


def test_collect_ignores_data_uris_and_external_links(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "data").mkdir()
    (tmp_path / "index.html").write_text(
        '<link rel="icon" href="data:image/svg+xml,%3Csvg%3E">'
        '<link rel="stylesheet" href="https://unpkg.com/x.css">'
        '<a href="mailto:a@b.c">m</a><a href="#top">t</a><a href="javascript:void(0)">j</a>'
        '<script src="https://unpkg.com/x.js"></script><script src="//cdn/x.js"></script>'
        '<script type="module" src="src/main.js"></script>', encoding="utf-8")
    (tmp_path / "src" / "main.js").write_text(
        "import { a } from './a.js';\nconst d = await fetchJson('data/x.json');\n", encoding="utf-8")
    (tmp_path / "src" / "a.js").write_text("export const a = 1;\nimport './b.js';", encoding="utf-8")
    (tmp_path / "src" / "b.js").write_text("export const b = 1;", encoding="utf-8")
    assert collect(tmp_path) == ["data/x.json", "index.html", "src/a.js", "src/b.js", "src/main.js"]


def test_built_site_is_self_contained(tmp_path):
    dest = tmp_path / "_site"
    build(dest, ROOT)
    html = (dest / "index.html").read_text(encoding="utf-8")
    assert (dest / ".nojekyll").exists()
    # index.html 引用的本地資源都在
    for ref in re.findall(r'(?:src|href)="([^":]+)"', html):
        if not ref.startswith(("http", "#", "//")):
            assert (dest / ref).exists(), ref
    # 每個 JS 的相對 import 都解析得到
    for js in dest.rglob("*.js"):
        for ref in re.findall(r"""from\s+['"](\.[^'"]+)['"]""", js.read_text(encoding="utf-8")):
            assert (js.parent / ref).resolve().exists(), (js.name, ref)
    # main.js 要抓的資料檔都在
    main = (dest / "src" / "main.js").read_text(encoding="utf-8")
    for ref in re.findall(r"""fetchJson\(\s*'([^']+)'""", main) + re.findall(r"""\[\s*fetchJson\('([^']+)'\)""", main):
        assert (dest / ref).exists(), ref


def test_built_site_is_small(tmp_path):
    build(tmp_path / "_site", ROOT)
    total = sum(p.stat().st_size for p in (tmp_path / "_site").rglob("*") if p.is_file())
    assert total < 1_000_000, total


def test_build_refuses_a_dirty_destination(tmp_path):
    dest = tmp_path / "_site"
    dest.mkdir()
    (dest / "stale.txt").write_text("舊檔", encoding="utf-8")
    with pytest.raises(SystemExit, match="stale.txt"):
        build(dest, ROOT)           # 不替使用者刪檔：有多餘檔案就拒絕


def test_build_is_repeatable_into_its_own_output(tmp_path):
    dest = tmp_path / "_site"
    build(dest, ROOT)
    build(dest, ROOT)               # 重建（覆蓋同名檔）不應失敗


GOOD = {"type": "FeatureCollection", "meta": {"totalIds": 1}, "features": [
    {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[121.5, 25.0], [121.51, 25.0]]},
     "properties": {"id": "TP-HOL-001", "partIndex": 0, "show": True, "confidence": "high"}},
    {"type": "Feature", "geometry": None, "properties": {"id": "TP-HOL-002", "partIndex": 0, "show": False, "confidence": "needs_manual"}},
]}


def test_public_data_check_accepts_good_data():
    check_public_data(GOOD)


@pytest.mark.parametrize("mutate,msg", [
    (lambda d: d["features"][1].update(geometry=GOOD["features"][0]["geometry"]), "show=false"),
    (lambda d: d["features"][0]["properties"].update(show="true"), "show"),
    (lambda d: d["features"][0].update(geometry=None), "沒有幾何"),
    (lambda d: d["features"][0]["properties"].update(confidence="low"), "low"),
    (lambda d: d.pop("meta"), "meta"),
])
def test_public_data_check_rejects_unsafe_data(mutate, msg):
    data = json.loads(json.dumps(GOOD))
    mutate(data)
    with pytest.raises(ValueError, match=msg):
        check_public_data(data)


def test_real_public_data_passes_the_check():
    check_public_data(json.loads((ROOT / "data" / "segments.geojson").read_text(encoding="utf-8")))
