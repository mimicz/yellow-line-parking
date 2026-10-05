// 距離計算（純函式）。座標一律 GeoJSON 順序 [lng, lat]。
// 台北市範圍小（數公里），點到線段距離用局部等距投影近似，誤差遠小於 GPS 誤差。

const R = 6371008.8; // 地球平均半徑（公尺）
const RAD = Math.PI / 180;

export function haversineMeters([lng1, lat1], [lng2, lat2]) {
  const dLat = (lat2 - lat1) * RAD;
  const dLng = (lng2 - lng1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// 以 origin 為原點投影到平面（公尺）
function project([lng, lat], [lng0, lat0]) {
  return [(lng - lng0) * RAD * R * Math.cos(lat0 * RAD), (lat - lat0) * RAD * R];
}

// 點到折線的最短距離（公尺）；投影落在線段外時取端點
export function distanceToLineMeters(point, coords) {
  if (!coords?.length) return Infinity;
  if (coords.length === 1) return haversineMeters(point, coords[0]);
  let best = Infinity;
  let a = project(coords[0], point);
  for (let i = 1; i < coords.length; i++) {
    const b = project(coords[i], point);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    // 原點即使用者位置
    const k = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / len2));
    best = Math.min(best, Math.hypot(a[0] + k * dx, a[1] + k * dy));
    a = b;
  }
  return best;
}

function featureDistance(point, geometry) {
  if (!geometry) return Infinity;
  if (geometry.type === 'LineString') return distanceToLineMeters(point, geometry.coordinates);
  if (geometry.type === 'MultiLineString') {
    return Math.min(...geometry.coordinates.map((c) => distanceToLineMeters(point, c)));
  }
  return Infinity;
}

// 半徑內的路段，依距離由近到遠排序：[{ feature, distance }]
export function nearby(point, features, radiusMeters = 500) {
  return features
    .map((feature) => ({ feature, distance: featureDistance(point, feature.geometry) }))
    .filter((x) => x.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance);
}
