// 查詢頁的展示邏輯（純函式，無 DOM、無隱含時鐘）。

import { evaluate } from './rules.js';
import { nearby } from './geo.js';
import { toTaipei, fromTaipei, isHoliday } from './holidays.js';

const pad = (n) => String(n).padStart(2, '0');
const WEEKDAYS = '日一二三四五六';

// 安全底線：只有 merge 標為 show=true 且有幾何的路段才可上圖、才可判斷為可停。
// （segments.geojson 對 show=false 本來就是 geometry:null，這裡再擋一次）
export const isShown = (f) => f?.properties?.show === true && f.geometry != null;

// 半徑內已收錄的路段，由近到遠，並附上「現在可不可以停」的判斷
export function buildNearbyRows(point, features, now, holidayTable, radiusMeters = 500) {
  return nearby(point, features.filter(isShown), radiusMeters).map(({ feature, distance }) => ({
    feature,
    distance,
    result: evaluate(feature, now, holidayTable),
  }));
}

// 尚未收錄（位置未確認）的路段，供頁面誠實列出
export function unconfirmedList(features) {
  return features
    .filter((f) => !isShown(f))
    .map((f) => f.properties)
    .sort((a, b) => a.no - b.no || a.partIndex - b.partIndex)
    .map((p) => ({
      id: p.id,
      no: p.no,
      district: p.district,
      road: p.road,
      fromName: p.fromName,
      toName: p.toName,
      part: p.nParts > 1 ? `第 ${p.partIndex + 1}/${p.nParts} 段` : '',
    }));
}

export function formatDistance(meters) {
  if (meters >= 1050) return `約 ${(meters / 1000).toFixed(1)} 公里`;
  const rounded = Math.round(meters / 10) * 10;
  return rounded === 0 ? '0 公尺' : `約 ${rounded} 公尺`;
}

export function windowsText(openWindows) {
  if (!Array.isArray(openWindows) || !openWindows.length) return '—';
  if (openWindows.length === 1 && openWindows[0].start === '00:00' && openWindows[0].end === '24:00') return '全天';
  return openWindows.map((w) => `${w.start}–${w.end}`).join('、');
}

// 「可停到幾點」：午夜顯示成前一天的 24:00；非今天則加上月/日
export function formatUntil(until, now) {
  if (!until) return '';
  const t = toTaipei(until);
  const isMidnight = t.minutes === 0;
  const u = isMidnight ? toTaipei(new Date(until.getTime() - 1)) : t;
  const text = isMidnight ? '24:00' : `${pad(Math.floor(t.minutes / 60))}:${pad(t.minutes % 60)}`;
  const today = toTaipei(now);
  const sameDay = u.year === today.year && u.month === today.month && u.day === today.day;
  return sameDay ? text : `${u.month}/${u.day} ${text}`;
}

export function coverageText({ shownIds, totalIds, sourceDate }) {
  return `已收錄 ${shownIds} / ${totalIds} 筆路段；資料來源：臺北市停車管理工程處，${sourceDate} 版`;
}

export function accuracyNote(accuracy) {
  if (accuracy == null || accuracy <= 50) return '';
  return `定位誤差約 ${Math.round(accuracy)} 公尺，結果僅供參考`;
}

// <input type="datetime-local"> 的值視為台北時間；格式或日期不合法回傳 null
export function parseTaipeiInput(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text ?? '');
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || h > 23 || mi > 59) return null;
  return fromTaipei(y, mo, d, h * 60 + mi);
}

export function dayInfoText(now, holidayTable) {
  const t = toTaipei(now);
  const head = `${t.year}/${t.month}/${t.day}（${WEEKDAYS[t.weekday]}）台北時間 ${pad(Math.floor(t.minutes / 60))}:${pad(t.minutes % 60)}`;
  const holiday = isHoliday(now, holidayTable);
  if (holiday === 'unknown') return `${head}　假日表未涵蓋 ${t.year} 年，一律視為不可停`;
  return `${head}　${holiday ? '今天是假日' : '今天不是假日'}`;
}
