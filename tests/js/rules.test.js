import { describe, it, expect } from 'vitest';
import { evaluate } from '../../src/rules.js';

const table = {
  years: [2026],
  offDays: { '2026-10-09': '補假' },
  workDays: { '2026-10-17': '補行上班' },
};

const tpe = (s) => new Date(`${s}+08:00`);

const line = { type: 'LineString', coordinates: [[121.5, 25.05], [121.501, 25.05]] };

const seg = (openWindows, extra = {}) => ({
  type: 'Feature',
  geometry: line,
  properties: { id: 'TP-HOL-001', openWindows, geomSource: 'osm_auto', ...extra },
});

const ALL_DAY = [{ start: '00:00', end: '24:00' }];
// #8 福林路：00~13 + 20~24
const FULIN = [{ start: '00:00', end: '13:00' }, { start: '20:00', end: '24:00' }];
// #87 三民路96巷、#93 萬美街：08~18
const DAYTIME = [{ start: '08:00', end: '18:00' }];

describe('evaluate：兩態判斷', () => {
  it('平日一律不可停', () => {
    const r = evaluate(seg(ALL_DAY), tpe('2026-10-05T12:00:00'), table);
    expect(r.canPark).toBe(false);
    expect(r.until).toBeNull();
    expect(r.reason).toMatch('不是假日');
  });

  it('假日全天開放：可停，且週六日連續時 until 合併到週一 00:00', () => {
    const r = evaluate(seg(ALL_DAY), tpe('2026-10-03T12:00:00'), table);
    expect(r.canPark).toBe(true);
    expect(r.until).toEqual(tpe('2026-10-05T00:00:00'));
  });

  it('連假：週五補假 + 週六日 → until 延到週一 00:00', () => {
    const r = evaluate(seg(ALL_DAY), tpe('2026-10-09T09:00:00'), table);
    expect(r.until).toEqual(tpe('2026-10-12T00:00:00'));
  });

  it('補班的週六不可停', () => {
    const r = evaluate(seg(ALL_DAY), tpe('2026-10-17T12:00:00'), table);
    expect(r.canPark).toBe(false);
  });

  it('週日前一天是補班週六，週日 until 仍正確停在週一', () => {
    const r = evaluate(seg(ALL_DAY), tpe('2026-10-18T10:00:00'), table);
    expect(r.canPark).toBe(true);
    expect(r.until).toEqual(tpe('2026-10-19T00:00:00'));
  });

  it('週五晚上 → 週六開始才可停（平日不可停）', () => {
    const r = evaluate(seg(ALL_DAY), tpe('2026-10-02T23:59:00'), table);
    expect(r.canPark).toBe(false);
  });
});

describe('evaluate：#8 福林路分時段', () => {
  it('假日 10:00 可停，until 13:00', () => {
    const r = evaluate(seg(FULIN), tpe('2026-10-03T10:00:00'), table);
    expect(r.canPark).toBe(true);
    expect(r.until).toEqual(tpe('2026-10-03T13:00:00'));
    expect(r.reason).toMatch('00:00–13:00');
  });

  it('假日 13:00 整（結束時刻）不可停', () => {
    expect(evaluate(seg(FULIN), tpe('2026-10-03T13:00:00'), table).canPark).toBe(false);
  });

  it('假日 14:00 不可停', () => {
    const r = evaluate(seg(FULIN), tpe('2026-10-03T14:00:00'), table);
    expect(r.canPark).toBe(false);
    expect(r.reason).toMatch('不在開放時段');
  });

  it('週六 21:00 可停，跨午夜接週日 00~13 → until 週日 13:00', () => {
    const r = evaluate(seg(FULIN), tpe('2026-10-03T21:00:00'), table);
    expect(r.canPark).toBe(true);
    expect(r.until).toEqual(tpe('2026-10-04T13:00:00'));
  });

  it('週日 21:00 可停，隔天週一非假日 → until 週一 00:00', () => {
    const r = evaluate(seg(FULIN), tpe('2026-10-04T21:00:00'), table);
    expect(r.until).toEqual(tpe('2026-10-05T00:00:00'));
  });
});

describe('evaluate：日間時段 08~18', () => {
  it('假日 07:59 不可停、08:00 可停、17:59 可停、18:00 不可停', () => {
    expect(evaluate(seg(DAYTIME), tpe('2026-10-03T07:59:00'), table).canPark).toBe(false);
    expect(evaluate(seg(DAYTIME), tpe('2026-10-03T08:00:00'), table).canPark).toBe(true);
    expect(evaluate(seg(DAYTIME), tpe('2026-10-03T17:59:00'), table).canPark).toBe(true);
    expect(evaluate(seg(DAYTIME), tpe('2026-10-03T18:00:00'), table).canPark).toBe(false);
  });

  it('until 不跨日（結束不在 24:00）', () => {
    const r = evaluate(seg(DAYTIME), tpe('2026-10-03T09:00:00'), table);
    expect(r.until).toEqual(tpe('2026-10-03T18:00:00'));
  });
});

describe('evaluate：保守側', () => {
  it('假日表未涵蓋的年份 → 不可停', () => {
    const r = evaluate(seg(ALL_DAY), tpe('2028-01-01T12:00:00'), table);
    expect(r.canPark).toBe(false);
    expect(r.reason).toMatch('2028');
  });

  it('年底可停，隔天跨入未涵蓋年份 → until 停在 1/1 00:00', () => {
    const r = evaluate(seg(ALL_DAY), tpe('2026-12-26T12:00:00'), table); // 週六
    expect(r.canPark).toBe(true);
    expect(r.until).toEqual(tpe('2026-12-28T00:00:00'));
    const end = evaluate(seg(ALL_DAY), tpe('2026-12-31T12:00:00'), { ...table, offDays: { '2026-12-31': '測試' } });
    expect(end.until).toEqual(tpe('2027-01-01T00:00:00'));
  });

  it('沒有幾何的路段 → 不可停', () => {
    const s = seg(ALL_DAY);
    s.geometry = null;
    const r = evaluate(s, tpe('2026-10-03T12:00:00'), table);
    expect(r.canPark).toBe(false);
    expect(r.reason).toMatch('位置未確認');
  });

  it('geomSource 為 none → 不可停', () => {
    const r = evaluate(seg(ALL_DAY, { geomSource: 'none' }), tpe('2026-10-03T12:00:00'), table);
    expect(r.canPark).toBe(false);
  });

  it('openWindows 空陣列或缺漏 → 不可停', () => {
    expect(evaluate(seg([]), tpe('2026-10-03T12:00:00'), table).canPark).toBe(false);
    expect(evaluate(seg(undefined), tpe('2026-10-03T12:00:00'), table).canPark).toBe(false);
  });

  it('時段格式錯誤 → 不可停，不丟例外', () => {
    const r = evaluate(seg([{ start: '8點', end: '18:00' }]), tpe('2026-10-03T12:00:00'), table);
    expect(r.canPark).toBe(false);
    expect(r.reason).toMatch('時段資料');
  });
});
