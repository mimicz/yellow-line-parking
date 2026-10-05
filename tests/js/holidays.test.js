import { describe, it, expect } from 'vitest';
import { toTaipei, dayKey, isHoliday } from '../../src/holidays.js';
import realTable from '../../data/holidays.json' with { type: 'json' };

// 測試用小型假日表：2026 年，含一個平日放假與一個週六補班（虛構）
const table = {
  years: [2026],
  offDays: { '2026-10-09': '補假' },
  workDays: { '2026-10-17': '補行上班' },
};

// 台北時間 → UTC Date（台灣無日光節約，固定 UTC+8）
const tpe = (s) => new Date(`${s}+08:00`);

describe('toTaipei', () => {
  it('以台北時區取日期與分鐘，不受執行環境時區影響', () => {
    // 2026-10-03 23:30 台北 = 2026-10-03 15:30 UTC
    const t = toTaipei(new Date('2026-10-03T15:30:00Z'));
    expect(t).toMatchObject({ year: 2026, month: 10, day: 3, weekday: 6, minutes: 23 * 60 + 30 });
  });

  it('UTC 已過午夜但台北仍是同一天的情況正確換日', () => {
    // 2026-10-03 16:00 UTC = 2026-10-04 00:00 台北（週日）
    const t = toTaipei(new Date('2026-10-03T16:00:00Z'));
    expect(t).toMatchObject({ day: 4, weekday: 0, minutes: 0 });
  });

  it('dayKey 產出 YYYY-MM-DD', () => {
    expect(dayKey(toTaipei(tpe('2026-01-05T08:00:00')))).toBe('2026-01-05');
  });
});

describe('isHoliday', () => {
  it('週六、週日算假日', () => {
    expect(isHoliday(tpe('2026-10-03T12:00:00'), table)).toBe(true); // 六
    expect(isHoliday(tpe('2026-10-04T12:00:00'), table)).toBe(true); // 日
  });

  it('一般平日不算假日', () => {
    expect(isHoliday(tpe('2026-10-05T12:00:00'), table)).toBe(false);
  });

  it('表列平日放假日算假日', () => {
    expect(isHoliday(tpe('2026-10-09T12:00:00'), table)).toBe(true);
  });

  it('補班的週六不算假日（保守側）', () => {
    expect(isHoliday(tpe('2026-10-17T12:00:00'), table)).toBe(false);
  });

  it('假日表未涵蓋的年份回傳 unknown', () => {
    expect(isHoliday(tpe('2028-01-01T12:00:00'), table)).toBe('unknown');
  });

  it('表格缺 years 時一律 unknown', () => {
    expect(isHoliday(tpe('2026-10-03T12:00:00'), {})).toBe('unknown');
  });
});

describe('真實假日表 data/holidays.json', () => {
  it('涵蓋 2026 與 2027', () => {
    expect(realTable.years).toEqual([2026, 2027]);
  });

  it('2026 國慶日（10/10 週六）前一天 10/9 週五補假', () => {
    expect(isHoliday(tpe('2026-10-09T12:00:00'), realTable)).toBe(true);
  });

  it('2027 春節除夕 2/5 週五放假，2/3 週三上班', () => {
    expect(isHoliday(tpe('2027-02-05T12:00:00'), realTable)).toBe(true);
    expect(isHoliday(tpe('2027-02-03T12:00:00'), realTable)).toBe(false);
  });
});
