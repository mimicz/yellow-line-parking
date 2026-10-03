# 台北市假日黃線停車地圖

手機網頁工具：取得 GPS 位置，標示附近「假日開放黃線停車」的路段，並判斷當下是否處於可停狀態。

> 本工具僅供參考，實際開放黃線假日停車路段仍以**現場標誌標示範圍**為準。
> （此句為官方表頭原文，需常駐於 App 頁面）

## 現況

**Phase 0、Phase 1 已完成**；下一步是 Phase 2（OSM 路網比對取得幾何）。

| Phase | 狀態 | 產出 |
|---|---|---|
| 0 核心純函式 | 完成 | `src/holidays.js`、`src/rules.js`（兩態）、`src/geo.js`；`data/holidays.json`（2026–2027） |
| 1 PDF 解析 | 完成 | `etl/parse_pdf.py` → `etl/out/segments_raw.json`（99 筆、101 段） |
| 2 OSM 比對 | 未開始 | |
| 3 editor.html | 未開始 | |
| 4 index.html | 未開始 | |
| 5 GitHub Pages 部署 | 未開始 | PWA 延後 |

```bash
npm install && pip install -r etl/requirements.txt
npm test                          # Vitest
python -m pytest tests/etl        # pytest
python etl/build_holidays.py 2026 2027   # 重建 data/holidays.json
python etl/parse_pdf.py                  # 重建 etl/out/segments_raw.json，並列出需人工注意的筆數
```

每年政府公告新年度辦公日曆表後，要把該年 JSON（[ruyut/TaiwanCalendar](https://github.com/ruyut/TaiwanCalendar)）放進 `data/source/holidays/` 並重跑 `build_holidays.py`；未涵蓋的年份 App 一律判為不可停。

- 規劃書（完整設計）：`docs/2026-10-03-yellow-line-parking-design.md`
- **Scope 已於 2026-10-03 縮小**，請以 `docs/SCOPE-2026-10-03-narrowed.md` 為準（規劃書中超出此範圍的內容已失效）
- 官方原始資料：`data/source/pma-holiday-yellow-line-2021-12-14.pdf`

## 官方資料摘要（已驗證）

臺北市停車管理工程處《假日開放黃線停車路段表》，PDF 由 Excel 2016 產出，建立日期 2021-12-14。

- 3 頁、**99 筆**路段，涵蓋 12 行政區
- 固定 10 欄：`編號 / 行政區 / 路段名 / 方向 / 起點 / 門牌號碼 / 迄點 / 門牌號碼 / 假日開放時間 / 備註`
- `pdfplumber.extract_tables()` 實測可乾淨抽出（第 1 頁 = 44 列 x 10 欄），合併儲存格為 `null`，可依欄 forward-fill 還原
- **沒有任何座標或 GIS 資訊**：起迄點只有路口名或門牌
- 96/99 筆為假日全天 `00~24`；例外 3 筆：`#8` 福林路 `00~13` + `20~24`、`#87` 三民路96巷 `08~18`、`#93` 萬美街 `08~18`

## 已確認的技術決策

| 項目 | 決定 |
|---|---|
| 平台 | 手機網頁（純前端靜態網站，無後端） |
| 地圖 | Leaflet + OpenStreetMap tiles（免費、無 API 金鑰） |
| 部署 | GitHub Pages（自帶 HTTPS，Geolocation API 可用） |
| 範圍 | 全台北市（即此 99 筆） |
| 座標取得 | OSM Overpass API 比對路網求路口交點切出 polyline；低信心者人工校正 |
| 假日定義 | 週六、週日、**國定假日**、調整放假日；補班日不算假日（取保守側） |
| 資料時效 | 先用 2021-12-14 版，App 上誠實標示來源與版本日期 |

## 已決議（2026-10-03）

| 議題 | 決議 | 影響 |
|---|---|---|
| 人工校正頁 `editor.html` | **照原規劃做** | 保留 Phase 3；目標 99 筆都畫上地圖，`low` 與 `needs_manual` 逐筆目視校正 |
| PWA（加到主畫面 + 離線快取） | **延後**，先上線再說 | 第一版不做 Phase 5 的 PWA 部分（`manifest.webmanifest`、`sw.js`），只做 GitHub Pages 部署 |
| 官方資料是否有新版 | **不查**，直接用 2021-12-14 版 | 頁面標示資料來源與版本日期 |

## 環境前提（已驗證於原開發機）

git 2.52 / gh 2.88 / node v24.11.1 / npm 11.6.2 / python 3.12.10
Python 套件：`pdfplumber`、`pypdf`、`pdfminer` 已安裝（**無** PyMuPDF）；`pdftoppm` 未安裝，不可依賴 PDF 轉圖
