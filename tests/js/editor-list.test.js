import { describe, it, expect } from 'vitest';
import { describeReasons, confidenceLabel, statusLabel } from '../../src/editor/labels.js';
import { listItems, nextKey } from '../../src/editor/list.js';

describe('describeReasons', () => {
  it('把原因代碼轉成中文，附上起點／迄點', () => {
    expect(describeReasons(['endpoint_landmark:from'])).toEqual(['起點是地標，無法自動定位']);
    expect(describeReasons(['no_intersection:to'])).toEqual(['迄點：在 OSM 找不到與主路相交的路口']);
  });

  it('沒有側別的代碼、已知旗標', () => {
    expect(describeReasons(['dual_carriageway', 'flag:has_note'])).toEqual([
      '分隔雙線道：兩側車道各有交點，取最短者',
      '官方備註欄有例外說明，需人工確認範圍',
    ]);
  });

  it('未知代碼原樣顯示，不吞掉', () => {
    expect(describeReasons(['brand_new_reason'])).toEqual(['brand_new_reason']);
  });

  it('信心與狀態標籤', () => {
    expect(confidenceLabel('needs_manual')).toBe('需人工');
    expect(statusLabel('excluded')).toBe('已排除');
  });
});

function feat(id, partIndex, confidence, no = Number(id.slice(-3))) {
  return { properties: { id, no, partIndex, confidence, road: `路${id}`, district: '中正' } };
}
const FEATS = [
  feat('TP-HOL-001', 0, 'high'),
  feat('TP-HOL-002', 0, 'needs_manual'),
  feat('TP-HOL-003', 0, 'low'),
  feat('TP-HOL-004', 0, 'low'),
  feat('TP-HOL-004', 1, 'needs_manual'),
];
const keys = (items) => items.map((f) => `${f.properties.id.slice(-1)}:${f.properties.partIndex}`);

describe('listItems', () => {
  it('預設排序：low → needs_manual → high，同級依編號與段序', () => {
    expect(keys(listItems(FEATS, {}, 'all'))).toEqual(['3:0', '4:0', '2:0', '4:1', '1:0']);
  });

  it('todo：low／needs_manual 且尚未處理', () => {
    const ov = { 'TP-HOL-003:0': { confirmed: true } };
    expect(keys(listItems(FEATS, ov, 'todo'))).toEqual(['4:0', '2:0', '4:1']);
  });

  it('handled：已有動作者；備註不算處理', () => {
    const ov = { 'TP-HOL-003:0': { confirmed: true }, 'TP-HOL-001:0': { note: '只有備註' } };
    expect(keys(listItems(FEATS, ov, 'handled'))).toEqual(['3:0']);
  });

  it('依信心篩選', () => {
    expect(keys(listItems(FEATS, {}, 'needs_manual'))).toEqual(['2:0', '4:1']);
    expect(keys(listItems(FEATS, {}, 'high'))).toEqual(['1:0']);
  });

  it('文字搜尋比對路名、編號、行政區', () => {
    expect(keys(listItems(FEATS, {}, 'all', '002'))).toEqual(['2:0']);
    expect(keys(listItems(FEATS, {}, 'all', '中正'))).toHaveLength(5);
    expect(listItems(FEATS, {}, 'all', '不存在')).toEqual([]);
  });
});

describe('nextKey', () => {
  const items = listItems(FEATS, {}, 'all');
  it('往後／往前一筆，到頭不循環', () => {
    expect(nextKey(items, 'TP-HOL-003:0', 1)).toBe('TP-HOL-004:0');
    expect(nextKey(items, 'TP-HOL-003:0', -1)).toBe('TP-HOL-003:0');
    expect(nextKey(items, 'TP-HOL-001:0', 1)).toBe('TP-HOL-001:0');
  });

  it('目前選的不在清單內時回傳第一筆；清單為空回傳 null', () => {
    expect(nextKey(items, 'X:9', 1)).toBe('TP-HOL-003:0');
    expect(nextKey([], 'X:9', 1)).toBeNull();
  });
});
