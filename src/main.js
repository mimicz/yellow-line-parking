// 查詢頁（UI 控制器）。判斷與展示邏輯都在 view.js／rules.js／geo.js（有測試）；這裡只負責畫面與事件。
// 需用靜態伺服器開啟：python -m http.server 8000 → http://localhost:8000/index.html

import { evaluate } from './rules.js';
import { isShown, buildNearbyRows, unconfirmedList, formatDistance, formatUntil, windowsText,
  coverageText, accuracyNote, parseTaipeiInput, dayInfoText } from './view.js';
import { getPosition, geolocationSupport } from './locate.js';

const L = window.L;
const $ = (id) => document.getElementById(id);
const REFRESH_MS = 30_000;
const OK = '#2e7d32';
const NO = '#c62828';

const state = {
  features: [],
  meta: null,
  holidays: null,
  pos: null,          // { lng, lat, accuracy|null }
  radius: 500,
  simNow: null,       // 「查詢其他時間」；null = 現在
  picking: false,
  selected: null,
  lines: new Map(),   // key → polyline
};

const now = () => state.simNow ?? new Date();
const keyOf = (f) => `${f.properties.id}:${f.properties.partIndex}`;
const latlngs = (coords) => coords.map(([lng, lat]) => [lat, lng]);

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

// ---------- 地圖 ----------

const map = L.map('map').setView([25.05, 121.54], 12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const segLayer = L.layerGroup().addTo(map);
const posLayer = L.layerGroup().addTo(map);

function drawSegments() {
  segLayer.clearLayers();
  state.lines.clear();
  for (const f of state.features.filter(isShown)) {
    const line = L.polyline(latlngs(f.geometry.coordinates), { weight: 6, opacity: 0.9 })
      .on('click', () => { if (!state.picking) selectFeature(f); })
      .addTo(segLayer);
    state.lines.set(keyOf(f), line);
  }
}

function styleSegments(results) {
  for (const f of state.features.filter(isShown)) {
    const r = results.get(f);
    const line = state.lines.get(keyOf(f));
    const selected = keyOf(f) === state.selected;
    line.setStyle({ color: r.canPark ? OK : NO, dashArray: r.canPark ? null : '8 8', weight: selected ? 9 : 6 });
    line.unbindTooltip().bindTooltip(`${f.properties.road}｜${r.canPark ? '現在可停' : '現在不可停'}`, { sticky: true });
    if (selected) line.bringToFront();
  }
}

function drawPosition() {
  posLayer.clearLayers();
  if (!state.pos) return;
  const c = [state.pos.lat, state.pos.lng];
  L.circle(c, { radius: state.radius, color: '#1565c0', weight: 1, dashArray: '4 6', fillOpacity: 0.04, interactive: false }).addTo(posLayer);
  if (state.pos.accuracy != null) {
    L.circle(c, { radius: state.pos.accuracy, color: '#1565c0', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(posLayer);
  }
  L.circleMarker(c, { radius: 8, color: '#fff', weight: 3, fillColor: '#1565c0', fillOpacity: 1, interactive: false }).addTo(posLayer);
}

function fitToPosition() {
  if (!state.pos) return;
  // 以定位點為中心、邊長 2 倍半徑的方框（不能用沒加到地圖的 L.circle().getBounds()，它需要地圖才算得出）
  map.fitBounds(L.latLng(state.pos.lat, state.pos.lng).toBounds(state.radius * 2), { padding: [20, 20] });
}

function fitAll() {
  const shown = state.features.filter(isShown);
  if (!shown.length) return;
  map.fitBounds(L.latLngBounds(shown.flatMap((f) => latlngs(f.geometry.coordinates))), { padding: [30, 30] });
}

function selectFeature(f) {
  state.selected = keyOf(f);
  render();
  const line = state.lines.get(state.selected);
  map.fitBounds(line.getBounds(), { maxZoom: 18, padding: [40, 40] });
  document.querySelector('#rows li.sel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- 清單 ----------

function rowEl(f, result, distance) {
  const p = f.properties;
  const key = keyOf(f);
  const status = result.canPark
    ? h('span', { class: 'chip ok' }, `可停車${result.until ? `（至 ${formatUntil(result.until, now())}）` : ''}`)
    : h('span', { class: 'chip no' }, '不可停車');
  return h('li', { class: `${result.canPark ? 'ok' : 'no'}${key === state.selected ? ' sel' : ''}`, 'data-key': key, onclick: () => selectFeature(f) },
    h('div', { class: 'row-h' },
      h('span', { class: 'row-t' }, `${p.road}`, p.nParts > 1 ? `（第 ${p.partIndex + 1}/${p.nParts} 段）` : '', `　${p.district}`),
      distance == null ? null : h('span', { class: 'dist' }, formatDistance(distance))),
    h('div', {}, status),
    h('div', { class: 'meta' }, `${p.direction ?? ''}　${p.fromName ?? '？'} → ${p.toName ?? '？'}`),
    h('div', { class: 'meta' }, `假日開放：${windowsText(p.openWindows)}`),
    result.canPark ? null : h('div', { class: 'meta' }, result.reason),
    p.note ? h('div', { class: 'meta' }, `官方備註：${p.note}`) : null);
}

function render() {
  const t = now();
  $('dayinfo').textContent = dayInfoText(t, state.holidays);
  $('simbanner').classList.toggle('show', state.simNow != null);

  const shown = state.features.filter(isShown);
  const results = new Map(shown.map((f) => [f, evaluate(f, t, state.holidays)]));
  styleSegments(results);

  let rows;
  if (state.pos) {
    rows = buildNearbyRows([state.pos.lng, state.pos.lat], state.features, t, state.holidays, state.radius)
      .map((r) => rowEl(r.feature, r.result, r.distance));
    $('list-title').textContent = `附近的已收錄路段（${rows.length} 筆，由近到遠）`;
    $('empty').textContent = rows.length ? '' : `此區域無收錄資料：${formatDistance(state.radius)}內沒有已收錄的路段。這不代表附近沒有假日可停的黃線，請依現場標誌為準。`;
  } else {
    rows = [...shown].sort((a, b) => a.properties.no - b.properties.no).map((f) => rowEl(f, results.get(f), null));
    $('list-title').textContent = `已收錄路段（${rows.length} 筆，依編號）`;
    $('empty').textContent = rows.length ? '尚未定位：按「定位我的位置」或「在地圖上指定位置」，只看附近的路段。' : '目前沒有已收錄的路段資料。';
  }
  $('rows').replaceChildren(...rows);

  const info = [];
  if (state.pos) {
    const note = accuracyNote(state.pos.accuracy);
    if (state.pos.accuracy == null) info.push('位置：地圖上手動指定');
    else info.push(note ? `位置：GPS　${note}` : `位置：GPS（誤差約 ${Math.round(state.pos.accuracy)} 公尺）`);
  }
  $('posinfo').textContent = info.join('　');
}

function renderStatic() {
  $('disclaimer').textContent = `${state.meta.disclaimer}。非開放時段黃線僅可臨停 3 分鐘、人不離車。`;
  $('coverage').textContent = coverageText(state.meta);
  const list = unconfirmedList(state.features);
  $('unconfirmed').hidden = list.length === 0;
  $('unconfirmed-title').textContent = `尚未收錄的路段（${list.length} 段）`;
  $('unconfirmed-list').replaceChildren(...list.map((x) => h('li', {},
    `#${x.no} ${x.district} ${x.road}${x.part ? `（${x.part}）` : ''}：${x.fromName ?? '？'} → ${x.toName ?? '？'}`)));
}

// ---------- 定位 ----------

function notice(msg) {
  const el = $('notice');
  el.textContent = msg ?? '';
  el.classList.toggle('show', !!msg);
}

function setPosition(pos) {
  state.pos = pos;
  notice('');
  drawPosition();
  render();
  fitToPosition();
}

async function locate() {
  const support = geolocationSupport();
  if (!support.ok) { notice(support.message); return; }
  $('btn-locate').disabled = true;
  $('btn-locate').textContent = '定位中…';
  try {
    setPosition(await getPosition());
  } catch (e) {
    notice(e.message);
  } finally {
    $('btn-locate').disabled = false;
    $('btn-locate').textContent = '定位我的位置';
  }
}

function setPicking(on) {
  state.picking = on;
  $('btn-pick').classList.toggle('active', on);
  $('btn-pick').textContent = on ? '請點選地圖上的位置…' : '在地圖上指定位置';
  map.getContainer().classList.toggle('picking', on);
}

map.on('click', (e) => {
  if (!state.picking) return;
  setPicking(false);
  setPosition({ lng: e.latlng.lng, lat: e.latlng.lat, accuracy: null });
});

$('btn-locate').onclick = locate;
$('btn-pick').onclick = () => setPicking(!state.picking);
$('radius').onchange = (e) => { state.radius = Number(e.target.value); drawPosition(); render(); fitToPosition(); };
$('sim-input').onchange = (e) => {
  const d = parseTaipeiInput(e.target.value);
  state.simNow = d;
  render();
};
$('sim-now').onclick = () => { $('sim-input').value = ''; state.simNow = null; render(); };

// 時間會流動：定時重算（模擬時間時不變，但重算無害）；回到前景時也立即重算
setInterval(() => { if (!state.simNow && !document.hidden) render(); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

// ---------- 啟動 ----------

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}：HTTP ${r.status}`);
  return r.json();
}

async function init() {
  $('error').classList.remove('show');
  try {
    const [geo, holidays] = await Promise.all([fetchJson('data/segments.geojson'), fetchJson('data/holidays.json')]);
    state.features = geo.features;
    state.meta = geo.meta;
    state.holidays = holidays;
  } catch (e) {
    $('disclaimer').textContent = '本表僅供參考，實際開放黃線假日停車路段仍以現場標誌標示範圍為準';
    $('error-text').textContent = `資料載入失敗（${e.message}）。請檢查網路後重試；在資料載入前，請勿依本頁判斷是否可停車。`;
    $('error').classList.add('show');
    return;
  }
  renderStatic();
  drawSegments();
  render();
  map.invalidateSize();
  fitAll();
}

// 容器大小變動（旋轉手機、縮放視窗、字型載入後版面位移）時，Leaflet 要重新量測。
// 頁面若在背景分頁載入，fitBounds 當下容器尺寸為 0，縮放會算錯：
// 第一次出現有效尺寸時，在使用者還沒定位或選取路段的前提下重新套用全覽。
let sized = false;
new ResizeObserver(([entry]) => {
  const { width, height } = entry.contentRect;
  if (!width || !height) return;
  map.invalidateSize();
  if (!sized) {
    sized = true;
    if (!state.pos && !state.selected) fitAll();
  }
}).observe($('mapwrap'));

$('sim-input').value = ''; // 瀏覽器重新整理會還原表單值，但「查詢其他時間」的狀態不跨頁面保留
$('retry').onclick = init;
window.__app = { state, map }; // 除錯用
init();
