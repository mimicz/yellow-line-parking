// 清單排序與篩選（純函式）

import { featureKey, hasAction } from './state.js';

// 預設順序：low（有候選，最快確認）→ needs_manual → high（抽查）→ 已人工
const RANK = { low: 0, needs_manual: 1, high: 2, manual: 3 };

function matches(f, entry, filter) {
  const c = f.properties.confidence;
  switch (filter) {
    case 'todo': return c !== 'high' && c !== 'manual' && !hasAction(entry);
    case 'handled': return hasAction(entry);
    case 'low':
    case 'needs_manual':
    case 'high': return c === filter;
    default: return true;
  }
}

export function listItems(features, ov, filter = 'all', query = '') {
  const q = query.trim().toLowerCase();
  return features
    .filter((f) => matches(f, ov[featureKey(f.properties)], filter))
    .filter((f) => {
      if (!q) return true;
      const p = f.properties;
      return [p.id, p.road, p.district, p.fromName, p.toName].some((s) => s && String(s).toLowerCase().includes(q));
    })
    .sort((a, b) => {
      const pa = a.properties;
      const pb = b.properties;
      return (RANK[pa.confidence] ?? 9) - (RANK[pb.confidence] ?? 9) || pa.no - pb.no || pa.partIndex - pb.partIndex;
    });
}

// 目前選取的往前／後一筆；到頭不循環
export function nextKey(items, currentKey, direction) {
  const keys = items.map((f) => featureKey(f.properties));
  if (!keys.length) return null;
  const i = keys.indexOf(currentKey);
  if (i < 0) return keys[0];
  return keys[Math.max(0, Math.min(keys.length - 1, i + direction))];
}
