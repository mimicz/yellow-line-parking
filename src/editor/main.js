// 校正頁（UI 控制器）。規則與資料處理都在同目錄的純函式模組（有測試）；這裡只負責畫面與事件。
// 需在 repo 根目錄用靜態伺服器開啟：python -m http.server 8000 → http://localhost:8000/editor.html

import {
  featureKey, setConfirmed, setGeometry, setExcluded, setNote, clearEntry,
  exportOverrides, validateOverrides, parseImport, statusOf, hasAction, summarize,
} from './state.js';
import { listItems, nextKey } from './list.js';
import { describeReasons, confidenceLabel, statusLabel } from './labels.js';
import { hintBases, selectHintWays } from './names.js';
import { nearestVertex, closestOnLines, shortestPath } from './snap.js';

const L = window.L;
const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'ylp-editor-v1';
const SNAP_PX = 22;
const SIDE_TEXT = { east: '東側', west: '西側', south: '南側', north: '北側', odd: '單號側', even: '雙號側' };

const state = {
  features: [],
  byKey: new Map(),
  ov: {},            // 編輯中的 overrides（含只有備註的草稿）
  base: '{}',        // repo 內 overrides.json 的匯出快照，用來偵測本機暫存是否過期
  committed: {},
  selected: null,
  filter: 'todo',
  query: '',
  autoAdvance: true,
  osm: null,         // 全部 OSM way（第一次選取時才載入）
  hintLines: [],
  drawing: null,     // { mode, pts, steps }
};

// ---------- 小工具 ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

async function fetchJson(url, optional = false) {
  const r = await fetch(url);
  if (!r.ok) {
    if (optional && r.status === 404) return null;
    throw new Error(`${url}：HTTP ${r.status}`);
  }
  return r.json();
}

function saveDraft() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ base: state.base, overrides: state.ov }));
  } catch { /* 私密視窗或被封鎖時只是不存，不影響操作 */ }
}

function loadDraft() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

const sel = () => state.byKey.get(state.selected);
const entryOf = (key) => state.ov[key];
const latlngs = (coords) => coords.map(([lng, lat]) => [lat, lng]);

// 目前採用的幾何：人工重畫優先，否則自動候選
function geometryOf(feature) {
  const entry = entryOf(featureKey(feature.properties));
  return entry?.geometry ?? feature.geometry?.coordinates ?? null;
}

function colorOf(feature) {
  const entry = entryOf(featureKey(feature.properties));
  const st = statusOf(entry);
  if (st === 'excluded') return { color: 'var(--excluded)', dashArray: '6 6' };
  if (st === 'confirmed' || st === 'redrawn' || feature.properties.confidence === 'manual') return { color: 'var(--manual)' };
  return { color: feature.properties.confidence === 'high' ? 'var(--high)' : 'var(--low)' };
}

// Leaflet 的 SVG 不吃 CSS 變數的 color 屬性以外的情況，這裡統一轉成實色
function resolveColor(v) {
  if (!v.startsWith('var(')) return v;
  return getComputedStyle(document.documentElement).getPropertyValue(v.slice(4, -1)).trim();
}

// ---------- 地圖 ----------

const map = L.map('map', { zoomControl: true }).setView([25.05, 121.54], 12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const overviewLayer = L.layerGroup().addTo(map);
const hintLayer = L.layerGroup().addTo(map);
const selectedLayer = L.layerGroup().addTo(map);
const drawLayer = L.layerGroup().addTo(map);

function renderOverview() {
  overviewLayer.clearLayers();
  for (const f of state.features) {
    const coords = geometryOf(f);
    if (!coords) continue;
    const key = featureKey(f.properties);
    const c = colorOf(f);
    L.polyline(latlngs(coords), { color: resolveColor(c.color), weight: 4, opacity: 0.8, dashArray: c.dashArray })
      .bindTooltip(`#${f.properties.no} ${f.properties.road}`, { sticky: true })
      .on('click', () => { if (!state.drawing) select(key); })
      .addTo(overviewLayer);
  }
}

function endpointIcon(text) {
  return L.divIcon({ className: '', html: `<div class="endpoint">${text}</div>`, iconSize: [20, 20], iconAnchor: [10, 10] });
}

function renderSelected() {
  selectedLayer.clearLayers();
  const f = sel();
  if (!f) return;
  const coords = geometryOf(f);
  if (!coords) return;
  const c = colorOf(f);
  L.polyline(latlngs(coords), { color: '#fff', weight: 11, opacity: 0.95, interactive: false }).addTo(selectedLayer);
  L.polyline(latlngs(coords), { color: resolveColor(c.color), weight: 6, dashArray: c.dashArray, interactive: false }).addTo(selectedLayer);
  const [a, b] = [coords[0], coords[coords.length - 1]];
  L.marker([a[1], a[0]], { icon: endpointIcon('起'), interactive: false }).addTo(selectedLayer);
  L.marker([b[1], b[0]], { icon: endpointIcon('迄'), interactive: false }).addTo(selectedLayer);
}

function renderHints() {
  hintLayer.clearLayers();
  state.hintLines = [];
  const f = sel();
  if (!f || !state.osm) return;
  const ways = selectHintWays(state.osm, hintBases(f.properties));
  state.hintLines = ways.map((w) => w.geometry);
  for (const w of ways) {
    L.polyline(latlngs(w.geometry), { color: '#8a94a6', weight: 2.5, opacity: 0.75 })
      .bindTooltip(w.tags.name, { sticky: true })
      .addTo(hintLayer);
  }
}

async function ensureOsm() {
  if (state.osm) return;
  toast('載入 OSM 路網中（約 2.4 MB）…');
  state.osm = (await fetchJson('data/source/osm/taipei_roads.json')).ways;
}

function fitSelection() {
  const f = sel();
  if (!f) return;
  const coords = geometryOf(f);
  const pts = coords ?? state.hintLines.flat();
  if (!pts.length) return;
  map.fitBounds(L.latLngBounds(latlngs(pts)), { maxZoom: 17, padding: [60, 60] });
}

// ---------- 清單與標頭 ----------

function currentItems() {
  return listItems(state.features, state.ov, state.filter, state.query);
}

function renderHeader() {
  const s = summarize(state.features, state.ov);
  $('progress').replaceChildren(
    '已處理 ', h('b', {}, `${s.handled} / ${s.totalParts}`), ' 段　待處理 ', h('b', {}, s.todo),
    '　目前可顯示 ', h('b', {}, `${s.shownIds} / ${s.totalIds}`), ` 筆編號（${s.shownParts} / ${s.totalParts} 段）`,
  );
}

function renderList() {
  const ul = $('list');
  const items = currentItems();
  ul.replaceChildren(...items.map((f) => {
    const p = f.properties;
    const key = featureKey(p);
    const st = statusOf(entryOf(key));
    return h('li', { class: key === state.selected ? 'sel' : '', 'data-key': key, onclick: () => select(key) },
      h('span', { class: 't' }, `#${p.no}${p.nParts > 1 ? `-${p.partIndex + 1}` : ''} ${p.road}`, ' ',
        h('span', { class: `badge c-${p.confidence}` }, confidenceLabel(p.confidence))),
      h('span', { class: 's' }, `${p.district}　${p.fromName ?? '？'} → ${p.toName ?? '？'}`),
      h('span', { class: `st st-${st}` }, st === 'pending' ? '' : statusLabel(st)));
  }));
  if (!items.length) ul.append(h('li', {}, h('span', { class: 'hint' }, '沒有符合的路段')));
  ul.querySelector('li.sel')?.scrollIntoView({ block: 'nearest' });
}

function addrText(list) {
  return (list ?? []).map((a) => (a.side ? `${SIDE_TEXT[a.side] ?? a.side}：` : '') + a.text).join('；') || '—';
}

function renderDetail() {
  const box = $('detail');
  const f = sel();
  if (!f) {
    box.replaceChildren(h('p', { class: 'hint' }, '從清單或地圖選一個路段。'));
    return;
  }
  const p = f.properties;
  const key = featureKey(p);
  const entry = entryOf(key);
  const st = statusOf(entry);
  const hasAuto = f.geometry != null;
  const drawing = !!state.drawing;
  const windows = (p.openWindows ?? []).map((w) => `${w.start}–${w.end}`).join('、') || p.timeRaw;
  const reasons = describeReasons(p.reasons.filter((r) => !r.startsWith('manual_')));

  const row = (k, ...v) => [h('dt', {}, k), h('dd', {}, ...v)];
  box.replaceChildren(
    h('h2', {}, `#${p.no}${p.nParts > 1 ? `（第 ${p.partIndex + 1}/${p.nParts} 段）` : ''} ${p.road}　${p.district}`),
    h('div', {},
      h('span', { class: `badge c-${p.confidence}` }, confidenceLabel(p.confidence)), ' ',
      h('span', { class: `badge st-${st}` }, statusLabel(st))),
    h('dl', {},
      ...row('方向', p.direction ?? '—'),
      ...row('時段', windows),
      ...row('起點', `${p.fromName ?? '（空白）'}`, h('br'), h('span', { class: 'hint' }, `門牌：${addrText(p.fromAddr)}`)),
      ...row('迄點', `${p.toName ?? '（空白）'}${p.toNameAlt?.length ? `（候選：${p.toNameAlt.join('、')}）` : ''}`, h('br'),
        h('span', { class: 'hint' }, `門牌：${addrText(p.toAddr)}`)),
      ...(p.note ? row('官方備註', p.note) : []),
      ...row('自動比對', reasons.length ? h('ul', {}, reasons.map((r) => h('li', {}, r))) : (hasAuto ? '無疑慮' : '—')),
      ...(p.lengthM ? row('長度', `${Math.round(p.lengthM)} m`) : [])),
    h('div', { class: 'actions' },
      h('button', { class: 'primary', disabled: drawing || !hasAuto || st === 'redrawn', onclick: () => act('confirm'),
        title: hasAuto ? '候選幾何正確，確認收錄' : '沒有自動幾何，請重畫' }, '確認'),
      h('button', { disabled: drawing, onclick: startDrawing }, st === 'redrawn' ? '重新描線' : '重畫'),
      h('button', { class: 'danger', disabled: drawing, onclick: () => act('exclude'), title: '看過但無法確認：維持不顯示' }, '無法確認，不收錄'),
      h('button', { disabled: drawing || st === 'pending', onclick: () => act('reset') }, '復原為待處理')),
    h('label', { class: 'hint', for: 'note' }, '備註（會一併匯出）'),
    h('textarea', { id: 'note', oninput: (e) => { state.ov = setNote(state.ov, key, e.target.value); saveDraft(); } }, entry?.note ?? ''),
    h('p', { class: 'hint' }, '快捷鍵：j / k 上下一筆、c 確認、Esc 取消描線'),
  );
}

function refresh({ list = true } = {}) {
  renderHeader();
  if (list) renderList();
  renderDetail();
  renderOverview();
  renderSelected();
}

// ---------- 選取與動作 ----------

async function select(key, { fit = true } = {}) {
  if (state.drawing) cancelDrawing();
  state.selected = key;
  renderHints();          // 先清掉上一筆的輔助線（路網已載入時會直接畫出這一筆的）
  refresh();
  if (fit) fitSelection();
  try {
    await ensureOsm();
  } catch (e) {
    toast(`路網載入失敗：${e.message}`);
    return;
  }
  if (state.selected !== key) return;
  renderHints();
  if (fit && !geometryOf(sel())) fitSelection();
}

function act(kind) {
  const key = state.selected;
  if (!key) return;
  const items = currentItems();
  const after = nextKey(items, key, 1);
  if (kind === 'confirm') state.ov = setConfirmed(state.ov, key);
  else if (kind === 'exclude') state.ov = setExcluded(state.ov, key);
  else state.ov = clearEntry(state.ov, key);
  saveDraft();
  if (kind !== 'reset' && state.autoAdvance && after && after !== key) select(after);
  else refresh();
}

// ---------- 描線 ----------

function metersPerPixel() {
  return map.distance(map.containerPointToLatLng([0, 0]), map.containerPointToLatLng([1, 0]));
}

async function startDrawing() {
  if (!sel()) return;
  try {
    await ensureOsm();
  } catch (e) {
    toast(`路網載入失敗：${e.message}`);
    return;
  }
  if (!state.hintLines.length) renderHints();
  state.drawing = { mode: document.querySelector('input[name=mode]:checked').value, pts: [], steps: [] };
  $('drawbar').classList.add('show');
  map.getContainer().classList.add('drawing');
  renderDrawing();
  renderDetail();
  toast('在地圖上依序點選路口：沿路連線模式會自動沿路網連接；Enter 完成、Esc 取消');
}

function endDrawing() {
  state.drawing = null;
  drawLayer.clearLayers();
  $('drawbar').classList.remove('show');
  map.getContainer().classList.remove('drawing');
}

function cancelDrawing() {
  if (!state.drawing) return;
  endDrawing();
  renderDetail();
}

function renderDrawing() {
  drawLayer.clearLayers();
  const d = state.drawing;
  if (!d) return;
  if (d.pts.length) L.polyline(latlngs(d.pts), { color: '#d81b60', weight: 5, dashArray: '8 6', interactive: false }).addTo(drawLayer);
  for (const n of d.steps.map((_, i) => d.steps.slice(0, i + 1).reduce((a, b) => a + b, 0) - 1)) {
    const [lng, lat] = d.pts[n];
    L.circleMarker([lat, lng], { radius: 5, color: '#d81b60', fillColor: '#fff', fillOpacity: 1, weight: 2, interactive: false }).addTo(drawLayer);
  }
  $('d-info').textContent = `${d.steps.length} 個點、${d.pts.length} 個頂點`;
}

function addPoints(coords) {
  const d = state.drawing;
  if (!coords.length) return;
  d.pts.push(...coords);
  d.steps.push(coords.length);
  renderDrawing();
}

function onMapClick(e) {
  const d = state.drawing;
  if (!d) return;
  const p = [e.latlng.lng, e.latlng.lat];
  const maxM = SNAP_PX * metersPerPixel();
  const last = d.pts[d.pts.length - 1];
  if (d.mode === 'route') {
    const v = nearestVertex(p, state.hintLines, maxM);
    if (!v) { toast('附近沒有路網頂點：請點近一點，或改用「自由描線」'); return; }
    if (!last) { addPoints([v.point]); return; }
    let path = shortestPath(state.hintLines, last, v.point);
    if (!path) { toast('兩點在路網上不連通，已直線連接，請確認'); path = [last, v.point]; }
    addPoints(path.slice(1));
  } else {
    const s = closestOnLines(p, state.hintLines, maxM);
    addPoints([s ? s.point : [Math.round(p[0] * 1e7) / 1e7, Math.round(p[1] * 1e7) / 1e7]]);
  }
}

function undoPoint() {
  const d = state.drawing;
  if (!d || !d.steps.length) return;
  d.pts.length -= d.steps.pop();
  renderDrawing();
}

function finishDrawing() {
  const d = state.drawing;
  if (!d) return;
  if (d.pts.length < 2) { toast('至少需要 2 個頂點'); return; }
  state.ov = setGeometry(state.ov, state.selected, d.pts);
  saveDraft();
  endDrawing();
  refresh();
  fitSelection();
  toast('已重畫並記錄');
}

map.on('click', onMapClick);
$('d-undo').onclick = undoPoint;
$('d-clear').onclick = () => { if (state.drawing) { state.drawing.pts = []; state.drawing.steps = []; renderDrawing(); } };
$('d-done').onclick = finishDrawing;
$('d-cancel').onclick = cancelDrawing;
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', (e) => {
  if (state.drawing) state.drawing.mode = e.target.value;
}));

// ---------- 匯出、匯入、重設 ----------

function exportFile() {
  const out = exportOverrides(state.ov);
  const errors = validateOverrides(out, state.features);
  if (errors.length) { alert(`無法匯出，請先修正：\n${errors.join('\n')}`); return; }
  const blob = new Blob([`${JSON.stringify(out, null, 2)}\n`], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: 'overrides.json' });
  document.body.append(a);
  a.click();
  a.remove();
  toast(`已下載 overrides.json（${Object.keys(out).length} 筆）。覆蓋 data/manual/overrides.json 後執行 python etl/merge.py`);
}

async function importFile(file) {
  const r = parseImport(await file.text(), state.features);
  if (r.errors.length) { alert(`匯入失敗：\n${r.errors.join('\n')}`); return; }
  const handled = Object.values(state.ov).filter(hasAction).length;
  if (handled && !confirm(`目前已有 ${handled} 筆處理紀錄，匯入會整批取代。要繼續嗎？`)) return;
  state.ov = r.overrides;
  saveDraft();
  refresh();
  toast(`已匯入 ${Object.keys(r.overrides).length} 筆`);
}

function resetToCommitted() {
  if (!confirm('捨棄本機暫存，改用 repo 內的 overrides.json？尚未匯出的處理會遺失。')) return;
  state.ov = structuredClone(state.committed);
  saveDraft();
  $('banner').classList.remove('show');
  refresh();
}

$('btn-export').onclick = exportFile;
$('btn-import').onclick = () => $('file').click();
$('file').onchange = (e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ''; };
$('btn-reset').onclick = resetToCommitted;
$('filter').onchange = (e) => { state.filter = e.target.value; renderList(); };
$('query').oninput = (e) => { state.query = e.target.value; renderList(); };

document.addEventListener('keydown', (e) => {
  if (e.target.matches?.('input, textarea, select')) return;
  if (e.key === 'Escape') cancelDrawing();
  else if (e.key === 'Enter' && state.drawing) finishDrawing();
  else if (state.drawing) return;
  else if (e.key === 'j' || e.key === 'k') {
    const k = nextKey(currentItems(), state.selected, e.key === 'j' ? 1 : -1);
    if (k) select(k);
  } else if (e.key === 'c' && state.selected && sel().geometry && statusOf(entryOf(state.selected)) !== 'redrawn') act('confirm');
});

// ---------- 啟動 ----------

async function init() {
  try {
    const review = await fetchJson('data/segments_review.geojson');
    state.features = review.features;
    state.byKey = new Map(state.features.map((f) => [featureKey(f.properties), f]));
    state.committed = (await fetchJson('data/manual/overrides.json', true)) ?? {};
    state.base = JSON.stringify(exportOverrides(state.committed));
  } catch (e) {
    $('progress').textContent = `載入失敗：${e.message}（請在 repo 根目錄用 python -m http.server 開啟）`;
    return;
  }
  const draft = loadDraft();
  if (draft?.overrides) {
    state.ov = draft.overrides;
    const stale = draft.base !== state.base;
    $('banner').textContent = stale
      ? '本機暫存是根據舊版 overrides.json 建立的，可能已過期；要以 repo 版本為準請按「重設」。'
      : '';
    $('banner').classList.toggle('show', stale);
  } else {
    state.ov = structuredClone(state.committed);
  }
  refresh();
  const first = currentItems()[0];
  if (first) select(featureKey(first.properties), { fit: false });
}

window.__editor = { state, map }; // 除錯用：開發者工具裡檢查狀態、模擬地圖點擊
init();
