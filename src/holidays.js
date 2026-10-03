// 假日判斷（純函式）。時間一律以台北時區計算，不看裝置時區。
// 台灣自 1979 年後不實施日光節約，固定 UTC+8。

const TPE_OFFSET_MS = 8 * 60 * 60 * 1000;

// Date（任一時區的瞬間）→ 台北當地的年月日、星期（0=日）、當日分鐘數
export function toTaipei(date) {
  const t = new Date(date.getTime() + TPE_OFFSET_MS);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    weekday: t.getUTCDay(),
    minutes: t.getUTCHours() * 60 + t.getUTCMinutes(),
  };
}

// 台北當地的某日某分鐘 → Date
export function fromTaipei(year, month, day, minutes = 0) {
  return new Date(Date.UTC(year, month - 1, day, 0, minutes) - TPE_OFFSET_MS);
}

export function dayKey({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// 回傳 true / false / 'unknown'（假日表未涵蓋該年，呼叫端須視為不可停）
export function isHoliday(date, table) {
  return isHolidayDay(toTaipei(date), table);
}

export function isHolidayDay(tpeDay, table) {
  if (!table?.years?.includes(tpeDay.year)) return 'unknown';
  const key = dayKey(tpeDay);
  if (table.workDays?.[key]) return false;
  if (table.offDays?.[key]) return true;
  const wd = tpeDay.weekday ?? new Date(Date.UTC(tpeDay.year, tpeDay.month - 1, tpeDay.day)).getUTCDay();
  return wd === 0 || wd === 6;
}
