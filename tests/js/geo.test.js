import { describe, it, expect } from 'vitest';
import { haversineMeters, distanceToLineMeters, nearby } from '../../src/geo.js';

// 台北車站附近
const P = [121.5170, 25.0478];
// 緯度 25° 時，經度 0.001° ≈ 100.9 m；緯度 0.001° ≈ 111.2 m
const LNG_M = 100.9;
const LAT_M = 111.2;

describe('haversineMeters', () => {
  it('同一點距離為 0', () => {
    expect(haversineMeters(P, P)).toBe(0);
  });

  it('南北 0.001° ≈ 111 m', () => {
    expect(haversineMeters(P, [P[0], P[1] + 0.001])).toBeCloseTo(LAT_M, 0);
  });
});

describe('distanceToLineMeters', () => {
  // 東西向線段，位於 P 北方 0.001°
  const ew = [[P[0] - 0.002, P[1] + 0.001], [P[0] + 0.002, P[1] + 0.001]];

  it('投影落在線段內 → 垂直距離', () => {
    expect(distanceToLineMeters(P, ew)).toBeCloseTo(LAT_M, -1);
  });

  it('投影落在線段外 → 取端點距離', () => {
    const q = [P[0] + 0.005, P[1] + 0.001]; // 線段東端再往東 0.003°
    expect(distanceToLineMeters(q, ew)).toBeCloseTo(3 * LNG_M, -1);
  });

  it('點在線上 → 0', () => {
    expect(distanceToLineMeters([P[0], P[1] + 0.001], ew)).toBeCloseTo(0, 3);
  });

  it('多段折線取最近的一段', () => {
    const bent = [[P[0] - 0.01, P[1] + 0.01], [P[0] - 0.01, P[1]], [P[0] - 0.0005, P[1]]];
    expect(distanceToLineMeters(P, bent)).toBeCloseTo(0.5 * LNG_M, -1);
  });

  it('單點線段 → 點距離', () => {
    expect(distanceToLineMeters(P, [[P[0], P[1] + 0.001]])).toBeCloseTo(LAT_M, -1);
  });
});

describe('nearby', () => {
  const f = (id, coords, type = 'LineString') => ({
    type: 'Feature',
    properties: { id },
    geometry: coords && { type, coordinates: coords },
  });

  const near = f('near', [[P[0] - 0.001, P[1] + 0.001], [P[0] + 0.001, P[1] + 0.001]]); // ~111 m
  const mid = f('mid', [[P[0] - 0.001, P[1] + 0.003], [P[0] + 0.001, P[1] + 0.003]]); // ~334 m
  const far = f('far', [[P[0], P[1] + 0.01], [P[0] + 0.001, P[1] + 0.01]]); // ~1.1 km
  const noGeom = f('none', null);
  const multi = f('multi', [
    [[P[0] + 0.02, P[1]], [P[0] + 0.03, P[1]]],
    [[P[0] + 0.002, P[1]], [P[0] + 0.003, P[1]]], // ~202 m
  ], 'MultiLineString');

  it('半徑內依距離排序，排除過遠與無幾何者', () => {
    const r = nearby(P, [far, mid, noGeom, near, multi], 500);
    expect(r.map((x) => x.feature.properties.id)).toEqual(['near', 'multi', 'mid']);
    expect(r[0].distance).toBeCloseTo(LAT_M, -1);
  });

  it('預設半徑 500 m', () => {
    expect(nearby(P, [near, far]).map((x) => x.feature.properties.id)).toEqual(['near']);
  });

  it('附近沒有路段 → 空陣列', () => {
    expect(nearby(P, [far], 500)).toEqual([]);
  });
});
