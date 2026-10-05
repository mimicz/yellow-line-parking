import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseImport, exportOverrides, summarize, validateOverrides } from '../../src/editor/state.js';

// 與 tests/etl/test_merge.py 共用同一份範例與同一組預期數字：
// editor 與 merge.py 對 overrides.json 的理解必須一致
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf-8');
const review = JSON.parse(read('data/segments_review.geojson'));
const sample = JSON.parse(read('tests/fixtures/overrides_sample.json'));

describe('editor × merge.py 互通', () => {
  it('merge.py 接受的範例，editor 的驗證也接受', () => {
    expect(validateOverrides(sample, review.features)).toEqual([]);
    const r = parseImport(JSON.stringify(sample), review.features);
    expect(r.errors).toEqual([]);
  });

  it('匯入後再匯出內容不變（往返穩定）', () => {
    expect(exportOverrides(sample)).toEqual(sample);
  });

  it('即時統計與 merge.py 的 meta 相同（36 段、34 筆編號可顯示）', () => {
    const s = summarize(review.features, sample);
    expect([s.shownParts, s.shownIds]).toEqual([36, 34]);
  });

  it('沒有任何處理時，與目前提交的 segments.geojson 的 meta 相同', () => {
    const s = summarize(review.features, {});
    expect(s.shownParts).toBe(review.meta.shownParts);
    expect(s.shownIds).toBe(review.meta.shownIds);
    expect(s.totalIds).toBe(99);
    expect(s.totalParts).toBe(101);
  });
});
