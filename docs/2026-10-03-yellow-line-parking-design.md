# 台北市黃線停車地圖（yellow-line-parking）— 實作規劃

## Context

使用者想要一個手機可用的地圖工具：開啟後取得自己的 GPS 位置，判斷**附近哪裡可以停黃線**。
專案目錄 `D:\claude_code_projects\yellow-line-parking` 目前為空、非 git repo，屬全新專案。

### 關鍵法規前提（決定整個資料模型）

- **紅實線**：禁止臨時停車（任何時候都不能停、不能臨停）。
- **黃實線**：禁止停車，但**允許臨時停車**（3 分鐘內、人不離車、上下客貨）。
- 黃線「可以停車」的唯一依據是**現場標誌所標示的開放時段**；在開放時段之外一律僅可臨停。

因此本專案的核心資料是 **「路段 × 方向/側別 × 開放時段」**，不是「黃線幾何在哪」。

**保守原則（硬性要求）**：只有幾何、沒有可信時段資料的路段，一律顯示為「禁停」而非「可停」。寧可少報一個車位，不可害使用者被開單。

### 預期成果

一個部署在 GitHub Pages 的純前端 PWA：手機開啟 → 定位 → 地圖標示附近黃線路段，依**當下時間 + 台灣假日表**將每段標成四態，並全頁常駐免責提示（沿用官方表頭原文）：

> 本表僅供參考，實際開放黃線假日停車路段仍以現場標誌標示範圍為準

## 已確認的決策

| 項目 | 決定 |
|---|---|
| 平台 | 手機網頁 PWA（純前端靜態網站，無後端） |
| 地圖 | Leaflet + OpenStreetMap tiles（免費、無 API 金鑰） |
| 部署 | GitHub Pages（自帶 HTTPS，Geolocation API 可用） |
| 地理範圍 | 全台北市 |
| 判斷邏輯 | 時段判斷 + 台灣假日表；**不**做到期通知 |
| 資料策略 | 官方 PDF 自動解析為主；座標用 OSM 路網比對，失敗者人工補 |
| 座標取得 | OSM 路網自動比對求路口交點 → 切 polyline；低信心者落到 editor 人工校正 |
| 資料時效 | 先用 2021-12-14 版做出來，App 上誠實標示來源與版本日期 |

### 環境前提（已驗證）

- git 2.52 / gh 2.88（已登入 GitHub 帳號 `mimicz`，scopes 含 `repo`、`workflow`）→ GitHub Pages 部署可行
- node v24.11.1 / npm 11.6.2 / python 3.12.10
- Python 套件：`pdfplumber`、`pypdf`、`pdfminer` 皆已安裝（**無** PyMuPDF）
- `pdftoppm` 未安裝 → 不可依賴 PDF 轉圖；文字／表格抽取走 pdfplumber

## 資料來源

### 主要來源（已取得並驗證）

**《假日開放黃線停車路段表》** — 臺北市（停車管理工程處）
`https://www-ws.gov.taipei/001/Upload/456/relfile/18543/123453/255d96c9-c2d0-4794-b8eb-8dabcf8d985c.pdf`

- 3 頁、**99 筆**路段，涵蓋 12 行政區（北投、士林、大同、中山、內湖、南港、萬華、中正、大安、松山、信義、文山）
- PDF 由 Excel 2016 產出，建立日期 **2021-12-14**
- 固定 10 欄：`編號 / 行政區 / 路段名 / 方向 / 起點 / 門牌號碼 / 迄點 / 門牌號碼 / 假日開放時間 / 備註`
- `pdfplumber.extract_tables()` 已實測可乾淨抽出（page 1 = 44 rows × 10 cols），合併儲存格為 `null`

**已知的資料品質問題（ETL 必須處理）：**

| 問題 | 實例 | 處理方式 |
|---|---|---|
| 合併儲存格 | `#1` 東華街拆兩列，編號/行政區/路段名為 `null` | 依欄 forward-fill |
| 時段格式不一致 | `00~24` / `00-24` / `0-24` / `08~18` / `00~13`+`20~24`（同格換行） | 正規化為 `[{start,end}]`；全形波浪與半形連字號都吃 |
| 方向欄語意混用 | `南往北`/`北往南`/`東往西`/`西往東`/`雙向`/`北側`/`南側`/`東側`/`西側`/`單號側`/`雙號側` | 正規化為 `{axis, side}` 兩個欄位 |
| 門牌欄分側書寫 | `西側：重慶北路2段178-1號` + `東側：重慶北路2段173-1號` 同格 | 拆成兩筆 feature（一側一筆） |
| 門牌缺漏 | `#97`、`#98` 辛亥路5段起迄門牌皆空白 | 允許 null，標 `needs_manual` |
| `無門牌號碼` | 大量出現 | 視為 null，改用起迄「路口名」定位 |
| 備註含例外範圍 | `#61` 寶慶路「北側自寶慶路24號前至博愛路除外」 | 原文保留於 `note`，UI 顯示；**不**嘗試自動解析 |

**此表只涵蓋「假日」。** 96/99 筆為假日全天 `00~24`，例外僅 3 筆（`#8` 福林路 `00~13`+`20~24`、`#87` 三民路96巷 `08~18`、`#93` 萬美街 `08~18`）。平日夜間開放的路段應為另一份文件，研究 agent 仍在查；資料模型已預留 `restrictionType` 以便日後併入，不影響本次實作。

### 座標來源

OpenStreetMap 台北市路網，透過 **Overpass API** 按路名查詢（免費、無金鑰、不需下載全台 pbf）。
註：OSM 的 `parking:lane` 標記在台北覆蓋率極低，不作為停車規則來源，**僅用來取得道路幾何**。

### 假日定義（已由使用者確認）

PDF 本身未定義「假日」，使用者已確認**假日包含國定假日**。據此：

- **算假日**：週六、週日、**國定假日**，以及行政院人事行政總處辦公日曆表中的調整放假日
- **不算假日**：補班日（需上班的週六）→ 判定為禁停（取保守側）
- 假日表資料：政府開放資料「中華民國政府行政機關辦公日曆表」，ETL 期轉為 `data/holidays.json`
- `holidays.json` 需涵蓋未來年度；每年政府公告新年度日曆表後需更新此檔（列為維護項目）

## 架構

純前端靜態站，資料為建置期產出的靜態檔案。核心邏輯刻意全部寫成純函式，可單元測試：

```
yellow-line-parking/
├─ index.html              查詢頁（地圖 + 附近清單）
├─ editor.html             建檔／校正工具頁
├─ src/
│  ├─ rules.js             ★ 時段規則引擎（純函式）
│  ├─ geo.js               ★ 點到線段距離、附近排序、側向 offset（純函式）
│  ├─ holidays.js          ★ 假日／補班日判斷（純函式）
│  ├─ map.js               Leaflet 繪製與互動
│  ├─ locate.js            Geolocation 包裝（權限、精度、失敗退路）
│  └─ editor/              建檔頁元件
├─ data/
│  ├─ segments.geojson     ★ 最終路段資料（建置產物，commit 進 repo）
│  ├─ manual_overrides.json  editor 產出的人工校正（真相來源之一）
│  └─ holidays.json        台灣辦公日曆表
├─ etl/
│  ├─ 01_parse_pdf.py      PDF → segments_raw.json
│  ├─ 02_match_osm.py      Overpass 路網比對 → 幾何
│  ├─ 03_merge.py          自動幾何 + manual_overrides → segments.geojson
│  └─ out/                 中間產物（git-ignored）
├─ tests/                  Vitest（JS）+ pytest（ETL）
└─ manifest.webmanifest, sw.js   PWA
```

### 資料模型（`segments.geojson` 每個 feature）

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "LineString", "coordinates": [[lng, lat], ...] },
  "properties": {
    "id": "TP-HOL-008",           // 來源代碼 + 原表編號
    "district": "士林",
    "road": "福林路",
    "axis": "both",               // n2s | s2n | e2w | w2e | both
    "side": "north",              // north|south|east|west|odd|even|null
    "fromName": "福林路", "fromAddr": "泰北高中門口",
    "toName": "雨農路口",  "toAddr": null,
    "lineType": "yellow_solid",
    "restrictionType": "holiday_open",   // 假日開放（日後可加 night_open）
    "openWindows": [                     // 假日的開放時段
      { "start": "00:00", "end": "13:00" },
      { "start": "20:00", "end": "24:00" }
    ],
    "note": "",
    "source": "pma_holiday_pdf_2021-12-14",
    "geomSource": "osm_auto" | "manual" | "none",
    "confidence": "high" | "low" | "unverified",
    "updatedAt": "2026-10-03"
  }
}
```

### 規則引擎（`src/rules.js`）

單一入口純函式，無 DOM、無隱含時鐘（時間由參數注入，便於測試）：

```js
evaluate(segment, nowDate, holidayTable) -> {
  status: 'allowed' | 'temp_only' | 'forbidden' | 'unknown',
  reason: '假日開放時段（00:00–13:00）',
  until: Date | null          // 狀態何時改變，用於「可停到 13:00」
}
```

| status | 條件 | 顏色 | UI 文案 |
|---|---|---|---|
| `allowed` | 今天算假日且當下落在 `openWindows` 內 | 綠 | 可停車（至 HH:MM） |
| `temp_only` | 黃線但不在開放時段（含平日） | 黃 | 僅可臨停 3 分鐘，人不離車 |
| `forbidden` | 紅線或全時段禁停 | 紅 | 禁止停車 |
| `unknown` | `geomSource: none` 或時段資料缺漏 | 灰 | 無時段資料，請依現場標誌，預設視為禁停 |

### ETL：OSM 路網比對演算法（`etl/02_match_osm.py`）

這是本專案工程風險最高的一段，流程與每一步的退路：

1. 對每筆路段，用 Overpass 查該行政區內 `highway` 且 `name` 匹配 `road` 的所有 way，接成一條或多條 linestring
2. 若起點／迄點是**路口名**（如`復興南路`）→ 同法查該路的幾何，與主路求幾何交點得座標
3. 若起點／迄點是**門牌**（如`東華街2段418號`）→ 無交點可求 → 標 `needs_manual`
4. 取主路 polyline 上介於兩交點之間的子線段
5. 依 `side` 將子線段往該側平移數公尺，讓「同路兩側」在地圖上可區分
6. **信心判定**：路名唯一命中 + 兩端交點皆唯一 → `high`；多重命中、交點不唯一、或長度異常（如 > 2km 或 < 20m）→ `low`
7. `low` 與 `needs_manual` 全部落到 `editor.html` 逐筆目視校正

預期自動命中率：起迄皆為路口名者約七成，其餘走人工。**不**追求 100% 自動化——`editor.html` 本來就要做，自動化只是減少人工筆數。

### 資料流

1. **建置期**：`etl/01` → `etl/02` → `etl/03` 產出 `data/segments.geojson` 並 commit
2. **人工校正**：`editor.html` 載入 geojson，篩出 `low`／`none`，地圖點選修正 → 匯出 `manual_overrides.json`（手動永遠優先於自動）
3. **載入**：瀏覽器抓 `segments.geojson` + `holidays.json`（99 筆資料量極小，單檔載入即可，不需切檔）
4. **定位**：`locate.js` 取 GPS 座標含 `accuracy`；失敗則退回手動在地圖點選位置
5. **篩選**：`geo.js` 以點到線段投影距離取半徑 500m 內路段並排序
6. **判斷**：逐段 `rules.evaluate(seg, new Date(), holidays)`
7. **呈現**：地圖依狀態上色 + 清單顯示「距離 / 狀態 / 可停到幾點 / 備註」

### 錯誤處理

| 情況 | 處理 |
|---|---|
| 拒絕定位權限 | 顯示說明 + 「在地圖上手動指定位置」 |
| GPS 精度差（accuracy > 50m） | 照常顯示並標示「定位誤差約 N 公尺，結果僅供參考」 |
| 附近無資料 | 明確顯示「此區域無收錄資料」，**不可**誤導為「附近沒有黃線」 |
| geojson 載入失敗 | 顯示錯誤與重試按鈕，不顯示空白地圖 |
| Overpass API 失敗／rate limit | ETL 腳本可續跑（已處理的筆數快取於 `etl/out/`），不整批重跑 |
| 時段資料缺漏 | 落入 `unknown`，保守視為禁停 |

### 測試策略（TDD）

核心全為純函式，先寫測試再寫實作：

- `rules.js`：平日、假日落在／落在外開放時段、跨午夜（`20:00–24:00`）、同日多時段（`#8`）、`openWindows` 為空、`unknown` 路徑、`until` 計算正確性
- `holidays.js`：週六日、國定假日、調整放假、**補班日的週六不算假日**
- `geo.js`：點到線段投影距離（含投影落在線段外取端點）、排序、側向 offset 方向正確
- `etl/01_parse_pdf.py`（pytest）：以實際 PDF 為 fixture 的快照測試，斷言 **99 筆**、forward-fill 正確、三種特殊時段（`#8`／`#87`／`#93`）解析正確、`#97/#98` 門牌缺漏不噴錯
- `etl/02_match_osm.py`：以快取的 Overpass 回應為 fixture，測交點計算與信心判定（不在測試中打網路）

**手動驗證**：手機實機開啟 GitHub Pages 頁面，到至少 3 個已知路段（挑一筆 `00~24`、一筆 `#8` 福林路分時段、一筆窄巷弄）對照現場標誌核對。

## 階段規劃

| Phase | 內容 | 產出 |
|---|---|---|
| 0 | git init、專案骨架、Vitest + pytest；本規劃存為 `docs/superpowers/specs/2026-10-03-yellow-line-parking-design.md` 並 commit；`rules.js`／`holidays.js`／`geo.js` 以 TDD 寫完 | 綠燈測試、可信的核心邏輯 |
| 1 | `etl/01_parse_pdf.py`：PDF → 99 筆結構化 JSON（含全部資料品質處理） | `etl/out/segments_raw.json` |
| 2 | `etl/02_match_osm.py` + `03_merge.py`：取得幾何、產出 geojson | `data/segments.geojson` |
| 3 | `editor.html`：校正 `low`／`needs_manual` 路段 | `data/manual_overrides.json` |
| 4 | `index.html`：Leaflet + 定位 + 四態上色 + 附近清單 + 免責提示 | 可用的查詢頁 |
| 5 | PWA（manifest + service worker）、GitHub Pages 部署 | 線上網址 |

## 驗證方式

1. **單元測試**：`npm test`（Vitest）與 `pytest` 全綠
2. **ETL 資料驗證**：`etl/03_merge.py` 結束時印出統計並人工確認——總筆數 99（分側拆分後會略多）、`geomSource` 分佈（auto/manual/none）、`confidence` 分佈；任何 `none` 都必須在 UI 顯示為 `unknown`
3. **規則引擎跨時間抽查**：寫一支小腳本，對同一路段分別代入「平日中午／假日中午／假日 14:00（`#8` 應為禁停）／假日 21:00」四個時間點，確認四態與 `until` 正確
4. **地圖幾何目視驗證**：在 `editor.html` 逐筆過目 polyline 是否落在正確道路與正確一側，特別檢查 `low` 信心者
5. **實機端到端**：手機開 GitHub Pages 網址 → 允許定位 → 確認地圖定位點正確、附近清單排序合理、狀態顏色與文案正確；至少 3 個路段現場對照標誌
6. **PWA 檢查**：Chrome DevTools Lighthouse 的 PWA 項目，並測試離線後重開仍可顯示已快取資料

## 待確認事項（不阻擋開工）

- 停管處是否有**比 2021-12-14 更新的版本**，以及是否有對應的「夜間開放黃線停車路段表」（研究 agent 進行中）。資料模型已預留 `restrictionType`，併入時不需改架構。
