// 描線輔助（純函式）：吸附到 OSM 路網、沿路網連線。座標一律 [lng, lat]。
// 兩種模式：
//   自由：closestOnLines  吸附到路網線上最近點（靠近頂點時取頂點）
//   沿路：nearestVertex + shortestPath  點兩個路口，中間自動沿路網連線

import { haversineMeters } from '../geo.js';

const R = 6371008.8;
const RAD = Math.PI / 180;
const round7 = (n) => Math.round(n * 1e7) / 1e7;

// 以 origin 為原點投影到平面（公尺）
function project([lng, lat], [lng0, lat0]) {
  return [(lng - lng0) * RAD * R * Math.cos(lat0 * RAD), (lat - lat0) * RAD * R];
}

// lines：[[ [lng,lat], ... ], ...]；超出 maxMeters 回傳 null
export function closestOnLines(point, lines, maxMeters, vertexMeters = 2) {
  let best = null;
  lines.forEach((line, lineIndex) => {
    for (let i = 1; i < line.length; i++) {
      const a = project(line[i - 1], point);
      const b = project(line[i], point);
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      const k = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / len2));
      const distance = Math.hypot(a[0] + k * dx, a[1] + k * dy);
      if (!best || distance < best.distance) best = { distance, lineIndex, i, k };
    }
  });
  if (!best || best.distance > maxMeters) return null;

  const p0 = lines[best.lineIndex][best.i - 1];
  const p1 = lines[best.lineIndex][best.i];
  const on = [p0[0] + best.k * (p1[0] - p0[0]), p0[1] + best.k * (p1[1] - p0[1])];
  // 靠近頂點就直接取頂點，讓路口座標精確
  const vertex = [p0, p1].find((v) => haversineMeters(on, v) <= vertexMeters);
  return {
    point: vertex ? [...vertex] : [round7(on[0]), round7(on[1])],
    distance: best.distance,
    lineIndex: best.lineIndex,
  };
}

export function nearestVertex(point, lines, maxMeters) {
  let best = null;
  for (const line of lines) {
    for (const v of line) {
      const d = haversineMeters(point, v);
      if (d <= maxMeters && (!best || d < best.distance)) best = { point: [...v], distance: d };
    }
  }
  return best;
}

const keyOf = ([lng, lat]) => `${lng},${lat}`;

// 路網上兩頂點間的最短路徑（座標陣列，含起訖）；不連通或不在路網上回傳 null
export function shortestPath(lines, from, to) {
  const coords = new Map();
  const adj = new Map();
  const link = (a, b, w) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push([b, w]);
  };
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      coords.set(keyOf(line[i]), line[i]);
      if (i === 0) continue;
      const ka = keyOf(line[i - 1]);
      const kb = keyOf(line[i]);
      if (ka === kb) continue;
      const w = haversineMeters(line[i - 1], line[i]);
      link(ka, kb, w);
      link(kb, ka, w);
    }
  }
  const src = keyOf(from);
  const dst = keyOf(to);
  if (!coords.has(src) || !coords.has(dst)) return null;
  if (src === dst) return [coords.get(src)];

  const dist = new Map([[src, 0]]);
  const prev = new Map();
  const done = new Set();
  const queue = [[0, src]]; // 頂點數至多數千，線性取最小值即可
  while (queue.length) {
    let mi = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i][0] < queue[mi][0]) mi = i;
    const [d, n] = queue.splice(mi, 1)[0];
    if (done.has(n)) continue;
    done.add(n);
    if (n === dst) break;
    for (const [m, w] of adj.get(n) ?? []) {
      if (d + w < (dist.get(m) ?? Infinity)) {
        dist.set(m, d + w);
        prev.set(m, n);
        queue.push([d + w, m]);
      }
    }
  }
  if (!prev.has(dst)) return null;
  const path = [dst];
  while (path[path.length - 1] !== src) path.push(prev.get(path[path.length - 1]));
  return path.reverse().map((k) => coords.get(k));
}
