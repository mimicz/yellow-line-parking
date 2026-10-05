import { describe, it, expect } from 'vitest';
import { haversineMeters } from '../../src/geo.js';
import { closestOnLines, nearestVertex, shortestPath } from '../../src/editor/snap.js';

// 1 格 ≈ 111 m（x：經度 0.0011°，y：緯度 0.001°）
const P = (x, y) => [+(121.5 + x * 0.0011).toFixed(7), +(25.0 + y * 0.001).toFixed(7)];

describe('closestOnLines（自由描線：吸附到線上最近點）', () => {
  const lines = [[P(0, 0), P(4, 0)]];

  it('線外附近的點吸附到線上的投影點', () => {
    const r = closestOnLines(P(2, 0.05), lines, 20);
    expect(r.point[1]).toBeCloseTo(25.0, 6);
    expect(r.point[0]).toBeCloseTo(P(2, 0)[0], 6);
    expect(r.distance).toBeLessThan(10);
  });

  it('離頂點很近時直接取頂點（讓路口座標精確）', () => {
    const r = closestOnLines(P(2.01, 0.02), [[P(0, 0), P(2, 0), P(4, 0)]], 20);
    expect(r.point).toEqual(P(2, 0));
  });

  it('超出吸附距離回傳 null；沒有線也回傳 null', () => {
    expect(closestOnLines(P(2, 1), lines, 20)).toBeNull();
    expect(closestOnLines(P(2, 0), [], 20)).toBeNull();
  });

  it('投影落在線段外時取端點', () => {
    const r = closestOnLines(P(-0.05, 0), lines, 20);
    expect(r.point).toEqual(P(0, 0));
  });
});

describe('nearestVertex（沿路描線：吸附到最近頂點）', () => {
  const lines = [[P(0, 0), P(1, 0), P(2, 0)], [P(1, 0), P(1, 1)]];

  it('回傳範圍內最近的頂點', () => {
    const r = nearestVertex(P(1.05, 0.05), lines, 30);
    expect(r.point).toEqual(P(1, 0));
    expect(r.distance).toBeLessThan(10);
  });

  it('範圍內沒有頂點回傳 null', () => {
    expect(nearestVertex(P(5, 5), lines, 30)).toBeNull();
  });
});

describe('shortestPath（沿路連線）', () => {
  // 十字路網：橫線 (0,0)-(2,0)、縱線 (1,0)-(1,1)，共用頂點 (1,0)
  const lines = [[P(0, 0), P(1, 0), P(2, 0)], [P(1, 0), P(1, 1)]];

  it('穿過共用頂點轉彎', () => {
    expect(shortestPath(lines, P(0, 0), P(1, 1))).toEqual([P(0, 0), P(1, 0), P(1, 1)]);
  });

  it('起點等於終點時只回傳該點', () => {
    expect(shortestPath(lines, P(1, 0), P(1, 0))).toEqual([P(1, 0)]);
  });

  it('不連通或點不在路網上時回傳 null', () => {
    const split = [[P(0, 0), P(1, 0)], [P(3, 0), P(4, 0)]];
    expect(shortestPath(split, P(0, 0), P(4, 0))).toBeNull();
    expect(shortestPath(lines, P(0, 0), P(9, 9))).toBeNull();
  });

  it('多條路可選時取最短', () => {
    // 直達 (0,0)-(2,0) = 2 格；繞路 (0,0)-(0,3)-(2,3)-(2,0) 長得多
    const net = [[P(0, 0), P(2, 0)], [P(0, 0), P(0, 3), P(2, 3), P(2, 0)]];
    const path = shortestPath(net, P(0, 0), P(2, 0));
    expect(path).toEqual([P(0, 0), P(2, 0)]);
    expect(haversineMeters(path[0], path[1])).toBeCloseTo(222, -1);
  });
});
