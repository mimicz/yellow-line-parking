// 校正頁的狀態與規則（純函式，無 DOM）。overrides 格式與 etl/merge.py 完全一致：
//   { "TP-HOL-005:0": { geometry: [[lng, lat], ...] | confirmed: true | excluded: true, note?: "…" } }
// 三種動作只能擇一；每筆可附 note。顯示規則（effectiveShow）也與 merge.py 相同。

// 與 etl/fetch_osm.py 的 TAIPEI_BBOX 一致
const BBOX = { south: 24.96, west: 121.45, north: 25.21, east: 121.67 };
const ACTION_KEYS = ['geometry', 'confirmed', 'excluded'];

export const featureKey = (props) => `${props.id}:${props.partIndex}`;

const round7 = (n) => Math.round(n * 1e7) / 1e7;
const isAction = (entry, k) => (k === 'geometry' ? entry[k] != null : entry[k] === true);
const actionsOf = (entry) => ACTION_KEYS.filter((k) => entry && isAction(entry, k));

export function hasAction(entry) {
  return actionsOf(entry).length > 0;
}

// 換成新動作：舊動作被取代，備註保留
function withAction(ov, key, action, note) {
  const prevNote = ov[key]?.note;
  const next = { ...action };
  const n = note ?? prevNote;
  if (n) next.note = n;
  return { ...ov, [key]: next };
}

export const setConfirmed = (ov, key) => withAction(ov, key, { confirmed: true });
export const setExcluded = (ov, key, note) => withAction(ov, key, { excluded: true }, note);
export const setGeometry = (ov, key, coords) =>
  withAction(ov, key, { geometry: coords.map(([lng, lat]) => [round7(lng), round7(lat)]) });

export function setNote(ov, key, note) {
  const entry = { ...(ov[key] ?? {}), note };
  if (!note) delete entry.note;
  if (!Object.keys(entry).length) return clearEntry(ov, key);
  return { ...ov, [key]: entry };
}

export function clearEntry(ov, key) {
  const { [key]: _removed, ...rest } = ov;
  return rest;
}

// 匯出：只留有動作的項目，依 key 排序，不輸出空備註
export function exportOverrides(ov) {
  const out = {};
  for (const key of Object.keys(ov).sort()) {
    const entry = ov[key];
    if (!hasAction(entry)) continue;
    const item = {};
    for (const k of actionsOf(entry)) item[k] = entry[k];
    if (entry.note) item.note = entry.note;
    out[key] = item;
  }
  return out;
}

function geometryErrors(key, geometry) {
  if (!Array.isArray(geometry) || geometry.length < 2) return [`override ${key}：geometry 至少 2 點`];
  const bad = geometry.find(
    (p) => !Array.isArray(p) || p.length !== 2
      || !(p[0] >= BBOX.west && p[0] <= BBOX.east && p[1] >= BBOX.south && p[1] <= BBOX.north),
  );
  return bad ? [`override ${key}：座標 ${JSON.stringify(bad)} 超出台北範圍（須為 [經度, 緯度]）`] : [];
}

// 規則與 etl/merge.py 的 _apply_override 一致，匯出前先擋掉，避免 merge 時才失敗
export function validateOverrides(ov, features) {
  const byKey = new Map(features.map((f) => [featureKey(f.properties), f]));
  const errors = [];
  for (const [key, entry] of Object.entries(ov)) {
    const feature = byKey.get(key);
    if (!feature) {
      errors.push(`override ${key}：對應的路段不存在`);
      continue;
    }
    if (actionsOf(entry).length > 1) {
      errors.push(`override ${key}：geometry、confirmed、excluded 只能擇一`);
    } else if ('note' in entry && typeof entry.note !== 'string') {
      errors.push(`override ${key}：note 必須是文字`);
    } else if (entry.excluded === true) {
      // 無額外條件
    } else if (entry.geometry != null) {
      errors.push(...geometryErrors(key, entry.geometry));
    } else if (entry.confirmed === true) {
      if (!feature.geometry) errors.push(`override ${key}：沒有自動幾何，不能只確認，請提供 geometry`);
    } else {
      errors.push(`override ${key}：需要 geometry、confirmed: true 或 excluded: true`);
    }
  }
  return errors;
}

export function parseImport(text, features) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { overrides: null, errors: [`不是合法的 JSON：${e.message}`] };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { overrides: null, errors: ['內容必須是物件（key 為「編號:段序」）'] };
  }
  const errors = validateOverrides(data, features);
  return errors.length ? { overrides: null, errors } : { overrides: data, errors: [] };
}

export function statusOf(entry) {
  if (!entry) return 'pending';
  if (entry.excluded === true) return 'excluded';
  if (entry.geometry != null) return 'redrawn';
  if (entry.confirmed === true) return 'confirmed';
  return 'pending';
}

// 與 merge.py 的 show 規則相同：high 或人工確認／重畫；被排除者一律不顯示
export function effectiveShow(feature, entry) {
  if (entry?.excluded === true) return false;
  if (entry?.geometry != null) return true;
  if (entry?.confirmed === true) return feature.geometry != null;
  return feature.properties.confidence === 'high';
}

export function summarize(features, ov) {
  const ids = new Map(); // id → 該筆編號的各段是否都可顯示
  let handled = 0;
  let todo = 0;
  let shownParts = 0;
  for (const f of features) {
    const entry = ov[featureKey(f.properties)];
    const done = hasAction(entry);
    handled += done;
    todo += !done && (f.properties.confidence === 'low' || f.properties.confidence === 'needs_manual');
    const show = effectiveShow(f, entry);
    shownParts += show;
    ids.set(f.properties.id, (ids.get(f.properties.id) ?? true) && show);
  }
  return {
    totalParts: features.length,
    totalIds: ids.size,
    handled,
    todo,
    shownParts,
    shownIds: [...ids.values()].filter(Boolean).length,
  };
}
