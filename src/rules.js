// 假日黃線可停判斷（純函式，時間由參數注入）。
// 兩態：canPark = 今天算假日 AND 當下落在該路段開放時段內。
// 任何資料不確定（無幾何、無時段、假日表未涵蓋）一律判為不可停。

import { toTaipei, fromTaipei, isHolidayDay } from './holidays.js';

const DAY = 24 * 60;
// 往後合併連續可停時段時最多看幾天（避免資料異常時無限迴圈）
const MAX_LOOKAHEAD_DAYS = 31;

const no = (reason) => ({ canPark: false, reason, until: null });

function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v <= DAY && Number(m[2]) < 60 ? v : null;
}

// [{start:'HH:MM', end:'HH:MM'}] → 已排序、已合併的 [[startMin, endMin)]；格式錯誤回 null
function parseWindows(openWindows) {
  const ws = [];
  for (const w of openWindows) {
    const s = parseHM(w?.start);
    const e = parseHM(w?.end);
    if (s === null || e === null || s >= e) return null;
    ws.push([s, e]);
  }
  ws.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const w of ws) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else merged.push([...w]);
  }
  return merged;
}

const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function nextDay({ year, month, day }) {
  const d = new Date(Date.UTC(year, month - 1, day + 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() };
}

export function evaluate(segment, now, holidayTable) {
  const p = segment?.properties ?? {};

  if (!segment?.geometry || p.geomSource === 'none') {
    return no('路段位置未確認，請依現場標誌');
  }
  if (!Array.isArray(p.openWindows) || p.openWindows.length === 0) {
    return no('無開放時段資料，請依現場標誌');
  }
  const windows = parseWindows(p.openWindows);
  if (!windows) return no('時段資料格式有誤，請依現場標誌');

  const t = toTaipei(now);
  const holiday = isHolidayDay(t, holidayTable);
  if (holiday === 'unknown') return no(`假日表未涵蓋 ${t.year} 年，無法判斷`);
  if (!holiday) return no('今天不是假日（黃線僅可臨停 3 分鐘、人不離車）');

  const cur = windows.find(([s, e]) => t.minutes >= s && t.minutes < e);
  if (!cur) {
    const list = windows.map(([s, e]) => `${hm(s)}–${hm(e)}`).join('、');
    return no(`不在開放時段（假日 ${list}）`);
  }

  // 計算可停到何時：本時段若到 24:00，且隔天也是假日、從 00:00 開放，就接續下去
  let day = t;
  let end = cur[1];
  for (let i = 0; i < MAX_LOOKAHEAD_DAYS && end === DAY; i++) {
    const nd = nextDay(day);
    if (isHolidayDay(nd, holidayTable) !== true || windows[0][0] !== 0) break;
    day = nd;
    end = windows[0][1];
  }

  return {
    canPark: true,
    reason: `假日開放時段 ${hm(cur[0])}–${hm(cur[1])}`,
    until: fromTaipei(day.year, day.month, day.day, end),
  };
}
