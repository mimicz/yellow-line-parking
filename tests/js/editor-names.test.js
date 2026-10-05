import { describe, it, expect } from 'vitest';
import { baseRoadName, hintBases, selectHintWays } from '../../src/editor/names.js';

describe('baseRoadName（與 etl/fetch_osm.py 的 base_road_name 同規則）', () => {
  it.each([
    ['東華街', '東華街'],
    ['承德路5段', '承德路'],
    ['杭州南路二段', '杭州南路'],
    ['羅斯福路2-3段', '羅斯福路'],
    ['德行東路365巷11弄', '德行東路'],
    ['市民大道8段', '市民大道'],
    ['凱達格蘭大道', '凱達格蘭大道'],
    ['環南2段', '環河南路'],
    ['東華橋', '東華橋'],
    ['石牌路口', '石牌路'],
    ['370巷', null],
    ['北門', null],
    ['南港交流道', null],
    [null, null],
  ])('%s → %s', (raw, expected) => {
    expect(baseRoadName(raw)).toBe(expected);
  });
});

describe('hintBases', () => {
  it('取路段名與起迄點的基本路名，去重', () => {
    const props = { road: '承德路5段', fromName: '中正路', toName: '承德路5段' };
    expect(hintBases(props).sort()).toEqual(['中正路', '承德路']);
  });

  it('地標與巷號不產生路名', () => {
    expect(hintBases({ road: '松仁路', fromName: '253巷', toName: '北門' })).toEqual(['松仁路']);
  });
});

describe('selectHintWays', () => {
  const ways = [
    { id: 1, tags: { name: '承德路五段' }, geometry: [[0, 0], [1, 1]] },
    { id: 2, tags: { name: '承德路五段123巷' }, geometry: [[0, 0], [1, 1]] },
    { id: 3, tags: { name: '承德北路' }, geometry: [[0, 0], [1, 1]] },
    { id: 4, tags: { name: '中正路' }, geometry: [[0, 0], [1, 1]] },
    { id: 5, tags: {}, geometry: [[0, 0], [1, 1]] },
    { id: 6, tags: { name: '臺北橋' }, geometry: [[0, 0], [1, 1]] },
  ];

  it('以名稱前綴挑出主路與橫街（含該路的巷弄），不會誤收相似路名', () => {
    expect(selectHintWays(ways, ['承德路', '中正路']).map((w) => w.id)).toEqual([1, 2, 4]);
  });

  it('臺／台視為相同', () => {
    expect(selectHintWays(ways, ['台北橋']).map((w) => w.id)).toEqual([6]);
  });

  it('沒有路名時回傳空陣列', () => {
    expect(selectHintWays(ways, [])).toEqual([]);
  });
});
