import { describe, it, expect } from 'vitest';
import {
  featureKey,
  setConfirmed,
  setGeometry,
  setExcluded,
  setNote,
  clearEntry,
  exportOverrides,
  validateOverrides,
  parseImport,
  statusOf,
  effectiveShow,
  summarize,
} from '../../src/editor/state.js';

const LINE = [[121.5, 25.0], [121.51, 25.0]];
const OTHER = [[121.52, 25.01], [121.53, 25.01], [121.54, 25.02]];

// 模擬 segments_review.geojson 的 Feature
function feat(id, partIndex, confidence, { nParts = 1, geometry } = {}) {
  const geom = geometry === undefined && confidence !== 'needs_manual' ? LINE : geometry ?? null;
  return {
    type: 'Feature',
    properties: { id, partIndex, nParts, confidence, show: confidence === 'high' },
    geometry: geom && { type: 'LineString', coordinates: geom },
  };
}
const FEATS = [
  feat('TP-HOL-001', 0, 'high'),
  feat('TP-HOL-002', 0, 'low'),
  feat('TP-HOL-003', 0, 'needs_manual'),
  feat('TP-HOL-004', 0, 'high', { nParts: 2 }),
  feat('TP-HOL-004', 1, 'low', { nParts: 2 }),
];

describe('featureKey', () => {
  it('與 merge.py 的 override key 格式一致', () => {
    expect(featureKey({ id: 'TP-HOL-005', partIndex: 1 })).toBe('TP-HOL-005:1');
  });
});

describe('狀態更新（不可變）', () => {
  it('setConfirmed 新增 confirmed，且不改動原物件', () => {
    const a = {};
    const b = setConfirmed(a, 'K:0');
    expect(b).toEqual({ 'K:0': { confirmed: true } });
    expect(a).toEqual({});
  });

  it('setGeometry 取 7 位小數，並取代先前的動作、保留備註', () => {
    let ov = setConfirmed({}, 'K:0');
    ov = setNote(ov, 'K:0', '已目視');
    ov = setGeometry(ov, 'K:0', [[121.123456789, 25.123456789], [121.2, 25.2]]);
    expect(ov['K:0']).toEqual({ geometry: [[121.1234568, 25.1234568], [121.2, 25.2]], note: '已目視' });
  });

  it('setExcluded 取代先前的幾何', () => {
    let ov = setGeometry({}, 'K:0', LINE);
    ov = setExcluded(ov, 'K:0', '現場無標誌');
    expect(ov['K:0']).toEqual({ excluded: true, note: '現場無標誌' });
  });

  it('setNote 對尚未處理的路段只建立備註', () => {
    expect(setNote({}, 'K:0', 'x')).toEqual({ 'K:0': { note: 'x' } });
  });

  it('clearEntry 移除整筆（回到待處理）', () => {
    expect(clearEntry({ 'K:0': { confirmed: true }, 'K:1': { confirmed: true } }, 'K:0')).toEqual({ 'K:1': { confirmed: true } });
  });
});

describe('exportOverrides', () => {
  it('丟掉只有備註的項目、依 key 排序、不輸出空備註', () => {
    const ov = {
      'B:0': { confirmed: true, note: '' },
      'A:0': { geometry: LINE, note: '重畫' },
      'C:0': { note: '只有備註' },
    };
    const out = exportOverrides(ov);
    expect(Object.keys(out)).toEqual(['A:0', 'B:0']);
    expect(out['B:0']).toEqual({ confirmed: true });
    expect(out['A:0']).toEqual({ geometry: LINE, note: '重畫' });
  });
});

describe('validateOverrides（規則與 merge.py 一致）', () => {
  const ok = { 'TP-HOL-002:0': { confirmed: true } };

  it('合法的內容沒有錯誤', () => {
    expect(validateOverrides(ok, FEATS)).toEqual([]);
    expect(validateOverrides({ 'TP-HOL-003:0': { geometry: OTHER } }, FEATS)).toEqual([]);
    expect(validateOverrides({ 'TP-HOL-001:0': { excluded: true, note: 'x' } }, FEATS)).toEqual([]);
  });

  it.each([
    ['不存在的路段', { 'TP-HOL-999:0': { confirmed: true } }, '不存在'],
    ['needs_manual 不能只確認', { 'TP-HOL-003:0': { confirmed: true } }, '沒有自動幾何'],
    ['幾何不足 2 點', { 'TP-HOL-002:0': { geometry: [[121.5, 25.0]] } }, '至少 2 點'],
    ['座標超出範圍', { 'TP-HOL-002:0': { geometry: [[121.5, 25.0], [121.5, 31.0]] } }, '範圍'],
    ['經緯度顛倒', { 'TP-HOL-002:0': { geometry: [[25.0, 121.5], [25.1, 121.5]] } }, '範圍'],
    ['動作重複', { 'TP-HOL-002:0': { confirmed: true, excluded: true } }, '只能擇一'],
    ['沒有動作', { 'TP-HOL-002:0': { note: 'x' } }, 'confirmed'],
    ['備註不是文字', { 'TP-HOL-002:0': { confirmed: true, note: 5 } }, 'note'],
  ])('%s', (_name, ov, msg) => {
    const errors = validateOverrides(ov, FEATS);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain(msg);
  });
});

describe('parseImport', () => {
  it('讀入合法的 overrides.json', () => {
    const r = parseImport(JSON.stringify({ 'TP-HOL-002:0': { confirmed: true } }), FEATS);
    expect(r.errors).toEqual([]);
    expect(r.overrides).toEqual({ 'TP-HOL-002:0': { confirmed: true } });
  });

  it('壞掉的 JSON、非物件、含不合法項目都回報錯誤且不採用', () => {
    expect(parseImport('{oops', FEATS).errors[0]).toContain('JSON');
    expect(parseImport('[]', FEATS).errors[0]).toContain('物件');
    const bad = parseImport(JSON.stringify({ 'TP-HOL-999:0': { confirmed: true } }), FEATS);
    expect(bad.errors.length).toBe(1);
    expect(bad.overrides).toBeNull();
  });
});

describe('statusOf / effectiveShow', () => {
  it('依動作回傳狀態', () => {
    expect(statusOf(undefined)).toBe('pending');
    expect(statusOf({ note: 'x' })).toBe('pending');
    expect(statusOf({ confirmed: true })).toBe('confirmed');
    expect(statusOf({ geometry: LINE })).toBe('redrawn');
    expect(statusOf({ excluded: true })).toBe('excluded');
  });

  it('顯示規則與 merge.py 相同：high 或人工確認／重畫；被排除者一律不顯示', () => {
    const [high, low, manual] = FEATS;
    expect(effectiveShow(high, undefined)).toBe(true);
    expect(effectiveShow(low, undefined)).toBe(false);
    expect(effectiveShow(manual, undefined)).toBe(false);
    expect(effectiveShow(low, { confirmed: true })).toBe(true);
    expect(effectiveShow(manual, { geometry: OTHER })).toBe(true);
    expect(effectiveShow(high, { excluded: true })).toBe(false);
    expect(effectiveShow(manual, { confirmed: true })).toBe(false); // 沒有自動幾何，確認無效
  });
});

describe('summarize', () => {
  it('沒有任何處理時：只有 high 可顯示；一筆編號的所有段都可顯示才算', () => {
    const s = summarize(FEATS, {});
    expect(s).toMatchObject({ totalParts: 5, totalIds: 4, handled: 0, todo: 3, shownParts: 2, shownIds: 1 });
  });

  it('處理後即時更新', () => {
    const ov = {
      'TP-HOL-002:0': { confirmed: true },
      'TP-HOL-003:0': { geometry: OTHER },
      'TP-HOL-004:1': { confirmed: true },
    };
    const s = summarize(FEATS, ov);
    expect(s).toMatchObject({ handled: 3, todo: 0, shownParts: 5, shownIds: 4 });
  });

  it('merge 後信心已是 manual 的路段不算待處理', () => {
    const s = summarize([feat('TP-HOL-009', 0, 'manual')], {});
    expect(s.todo).toBe(0);
  });

  it('被排除的 high 不算可顯示，但算已處理', () => {
    const s = summarize(FEATS, { 'TP-HOL-001:0': { excluded: true } });
    expect(s).toMatchObject({ handled: 1, shownIds: 0 });
  });
});
