# 台北市假日黃線停車地圖

手機網頁工具：取得 GPS 位置，標示附近「假日開放黃線停車」的路段，並判斷當下是否處於可停狀態。

> 本工具僅供參考，實際開放黃線假日停車路段仍以**現場標誌標示範圍**為準。
> （此句為官方表頭原文，需常駐於 App 頁面）

## 現況

**Phase 0～4 已完成**；下一步是**用 `editor.html` 實際校正資料**（人工作業，校正完重跑 `merge.py` 即可，不必改程式），以及 Phase 5（GitHub Pages 部署）。目前自動比對可顯示 **32 / 99** 筆編號（34 / 101 段），其餘待人工校正；`index.html` 已可用，只會顯示這些已確認的路段。

| Phase | 狀態 | 產出 |
|---|---|---|
| 0 核心純函式 | 完成 | `src/holidays.js`、`src/rules.js`（兩態）、`src/geo.js`；`data/holidays.json`（2026–2027） |
| 1 PDF 解析 | 完成 | `etl/parse_pdf.py` → `etl/out/segments_raw.json`（99 筆、101 段） |
| 2 OSM 比對 | 完成 | `etl/match_osm.py`（比對＋信心分級）、`etl/merge.py` → `data/segments.geojson`（App 用）、`data/segments_review.geojson`（校正頁用） |
| 3 editor.html | 完成 | `editor.html` + `src/editor/`（純函式有 Vitest 測試；UI 已在瀏覽器實測）→ 產出 `data/manual/overrides.json` |
| 4 index.html | 完成 | `index.html` + `src/main.js`、`src/view.js`、`src/locate.js`（純函式有 Vitest 測試；UI 已在瀏覽器實測，**尚未在真手機實測 GPS**） |
| 5 GitHub Pages 部署 | **完成，已上線** | <https://mimicz.github.io/yellow-line-parking/>；`etl/build_site.py`、`.github/workflows/pages.yml`（推到 `main` 自動測試並部署）。PWA 延後 |

```bash
npm install && pip install -r etl/requirements.txt
npm test                          # Vitest
python -m pytest tests/etl        # pytest
python etl/build_holidays.py 2026 2027   # 重建 data/holidays.json
python etl/parse_pdf.py                  # 重建 etl/out/segments_raw.json，並列出需人工注意的筆數
python etl/fetch_osm.py                  # 下載 OSM 道路 → data/source/osm/taipei_roads.json（需連 Overpass，本機跑）
python etl/match_osm.py                  # 比對並印出 high / low / needs_manual 分級與原因（只讀快取）
python etl/merge.py                      # 產生 data/segments.geojson 與 data/segments_review.geojson
```

### Phase 2 信心分級與顯示規則

| 等級 | 意義 | 顯示為可停？ |
|---|---|---|
| `high` | 兩端點各唯一路口、路徑連通、繞路比 ≤ 1.5、長度 30 m～3 km、無例外旗標 | 是 |
| `low` | 有候選幾何但有疑慮：分隔雙線、寬路口、繞路比 1.5～2.5、長度異常、`complex_range`／`has_note`、選了最短候選、段號靠退路 | **否**，須在校正頁確認後才成為 `manual` |
| `needs_manual` | 地標／門牌端點、OSM 查無橫街或未連通、候選無法區分、繞路比 > 2.5 | **否**，`geometry` 為 `null` |
| `manual` | 人工在校正頁確認或重畫（`data/manual/overrides.json`） | 是 |

- 顯示規則只在 `merge.py` 決定（`show`）；`segments.geojson` 對 `show=false` 的 Feature 一律 `geometry: null`，不可能被畫出來。
- PDF 起迄點寫成路名本身（如「八德路 → 八德路」）時，位置其實由門牌欄決定，沒有地理編碼就無法定位，一律 `needs_manual`；**不可**當成「道路端點」推論，會畫錯。
### 部署（GitHub Pages）

```powershell
python etl/build_site.py        # → _site/（本機預覽：python -m http.server 8001 --directory _site）
```

- 公開的網站只含 `index.html` 實際用到的 9 個檔案（約 100 KB）：`index.html`、`src/` 的執行期模組、`data/segments.geojson`、`data/holidays.json`。**不含** `editor.html`、`segments_review.geojson`、OSM 快取、官方 PDF、ETL 與測試。
- 建置腳本會先檢查公開資料：`show=false` 的路段不得有幾何、`show=true` 必須有幾何且信心為 high／manual，否則拒絕建置。目的地有多餘檔案時也會拒絕（不替你刪檔）。
- `.github/workflows/pages.yml`：推到 `main` 時先跑全部測試（JS＋pytest），通過才建置並部署；也可在 Actions 頁手動執行。
- 已啟用：倉庫 Settings → Pages → Source 為 **GitHub Actions**。網址 <https://mimicz.github.io/yellow-line-parking/>（資源一律用相對路徑，放在子路徑下可正常運作）。
- 倉庫與網站皆為公開。每次校正完資料，重跑 `python etl/merge.py` 並 commit，推到 `main` 即自動測試並重新部署（約 2～3 分鐘）。`editor.html` 與校正用資料**不會**部署，只能在本機用 `python -m http.server` 開啟。
- 本機 git 身分：此專案的 commit 作者設為 GitHub 帳號 `mimicz`（只設在本專案，不影響全域設定）。

### 查詢頁（index.html）

同樣在 repo 根目錄 `python -m http.server 8000`，開 <http://localhost:8000/index.html>。

- 只讀 `data/segments.geojson` 與 `data/holidays.json`；**只有 `show=true` 的路段才會上圖或被判為可停**，其餘（位置未確認）一律不顯示，並在頁面底部誠實列出「尚未收錄的路段」與「已收錄 N / 99 筆」。
- 官方免責原文與「非開放時段僅可臨停 3 分鐘、人不離車」常駐頁首。
- 「定位我的位置」用瀏覽器 Geolocation（只在 HTTPS 或 localhost 可用）；被拒絕、不支援、逾時時引導改用「在地圖上指定位置」。誤差 > 50 m 會提示。
- 兩態判斷：今天算假日 AND 當下在開放時段內 = **可停**（顯示可停到幾點，連假會接續計算）；其餘為**不可停**並說明原因。假日表未涵蓋的年份一律不可停。
- 附近範圍 300 公尺／500 公尺／1 公里；範圍內無收錄資料時明說「此區域無收錄資料，不代表附近沒有可停的黃線」。
- 「查詢其他時間」可模擬任一台北時間（例如查假日 14:00），頁面會明顯標示目前不是「現在」。
- 純函式在 `src/view.js`、`src/locate.js`（有測試）；`src/main.js` 只負責畫面與事件。

### 人工校正流程（editor.html）

```powershell
python -m http.server 8000
```

瀏覽器開 <http://localhost:8000/editor.html>（需在 repo 根目錄啟動；`file://` 讀不到資料檔）。

- 清單預設「待處理」（low、needs_manual），可改看高信心做抽查。選一筆後地圖會顯示候選幾何（高綠、低橘）、OSM 路網輔助線（灰），詳情面板列出起迄**門牌**與自動比對失敗原因。
- **確認**（候選幾何正確）、**重畫**（點地圖描線）、**無法確認，不收錄**（看過但無法定位，維持不顯示）、**復原為待處理**；每筆可加備註。
- 描線有兩種模式：**沿路連線**（點起迄路口，中間自動沿 OSM 路網連接；點擊吸附最近頂點）與**自由描線**（吸附到路網線上最近點，附近沒有線就取點擊位置）。可「復原一點」、「清除」；沒有拖曳頂點功能。
- 進度與「目前可顯示 N / 99 筆」即時計算（規則與 `merge.py` 相同）。處理紀錄自動存在瀏覽器 localStorage。
- 做完或中途要存檔：按**匯出 overrides.json**，覆蓋 `data/manual/overrides.json`，然後：

```powershell
python etl/merge.py
python -m pytest tests/etl
npm test
git add data
git commit -m "人工校正：…"
```

- 匯出前會先驗證（座標範圍、至少 2 點、動作擇一）；**匯入**可載入既有的 `overrides.json` 繼續處理。「重設」會捨棄本機暫存、改用 repo 版本。
- 快捷鍵：`j` / `k` 上下一筆、`c` 確認、`Enter` 完成描線、`Esc` 取消描線。
- 資料格式（與 `merge.py` 一致，三種動作擇一，可附 `note`）：`{"TP-HOL-005:0": {"geometry": [[lng,lat],…]}}`、`{"…": {"confirmed": true}}`、`{"…": {"excluded": true, "note": "…"}}`。

- `data/segments*.geojson` 是 commit 的產物，測試會檢查它是否過期；改了 PDF 解析、OSM 快取或比對規則後，要重跑 `python etl/merge.py`。
雲端開發環境連不到 Overpass API，所以 `fetch_osm.py` 在本機跑一次並 commit 結果；Phase 2 比對與測試只讀這份快取。

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
