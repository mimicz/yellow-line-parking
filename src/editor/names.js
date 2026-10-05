// 路名處理：挑出要疊在地圖上當描線輔助的 OSM way。
// base 的取法與 etl/fetch_osm.py 的 base_road_name 相同。

const ROAD_RE = /^(.+?(?:大道|路|街|橋))/;
// PDF 用簡稱、OSM 用全名的路
const ALIASES = { 環南: '環河南路' };

export function normalizeName(s) {
  return s.normalize('NFKC').replace(/\s+/g, '').replaceAll('臺', '台');
}

export function baseRoadName(name) {
  if (!name) return null;
  let s = normalizeName(name);
  for (const [short, full] of Object.entries(ALIASES)) {
    if (s.startsWith(short) && !s.startsWith(full)) s = full + s.slice(short.length);
  }
  const m = ROAD_RE.exec(s);
  return m ? m[1] : null;
}

// 該路段相關的基本路名：路段名與起迄點
export function hintBases({ road, fromName, toName }) {
  return [...new Set([road, fromName, toName].map(baseRoadName).filter(Boolean))];
}

// 名稱以任一 base 開頭的 way（含該路的巷弄；「承德路」不會誤收「承德北路」）
export function selectHintWays(ways, bases) {
  const wanted = bases.map(normalizeName);
  if (!wanted.length) return [];
  return ways.filter((w) => {
    const name = w.tags?.name;
    if (!name) return false;
    const n = normalizeName(name);
    return wanted.some((b) => n.startsWith(b));
  });
}
