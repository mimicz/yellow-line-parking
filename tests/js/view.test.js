import { describe, it, expect } from 'vitest';
import { fromTaipei } from '../../src/holidays.js';
import {
  isShown,
  buildNearbyRows,
  unconfirmedList,
  formatDistance,
  formatUntil,
  windowsText,
  coverageText,
  accuracyNote,
  parseTaipeiInput,
  dayInfoText,
} from '../../src/view.js';

const HOLIDAYS = { years: [2026, 2027], offDays: { '2026-10-10': '國慶日' }, workDays: {} };
const SAT_NOON = fromTaipei(2026, 10, 3, 12 * 60);   // 2026-10-03 週六
const SAT_14 = fromTaipei(2026, 10, 3, 14 * 60);
const MON_NOON = fromTaipei(2026, 10, 5, 12 * 60);   // 週一

// 1 格 ≈ 111 m
const P = (x, y) => [+(121.5 + x * 0.0011).toFixed(7), +(25.0 + y * 0.001).toFixed(7)];
const line = (x0, x1, y = 0) => ({ type: 'LineString', coordinates: [P(x0, y), P(x1, y)] });

function feat(id, geometry, over = {}) {
  return {
    type: 'Feature',
    geometry,
    properties: {
      id, no: Number(id.slice(-3)), partIndex: 0, nParts: 1, district: '中正', road: `路${id.slice(-3)}`,
      direction: '南往北', fromName: '甲路', toName: '乙路', note: '', show: true, confidence: 'high',
      openWindows: [{ start: '00:00', end: '24:00' }], timeRaw: '00~24', ...over,
    },
  };
}

const NEAR = feat('TP-HOL-001', line(0, 2));                         // 距原點 0 m
const FAR = feat('TP-HOL-002', line(0, 2, 3));                       // ≈ 333 m
const OUT = feat('TP-HOL-003', line(0, 2, 8));                       // ≈ 890 m，半徑外
const HIDDEN = feat('TP-HOL-004', null, { show: false, confidence: 'needs_manual' });
const SPLIT = feat('TP-HOL-008', line(0, 2, 1), { openWindows: [{ start: '00:00', end: '13:00' }, { start: '20:00', end: '24:00' }], timeRaw: '00~13\n20~24' });
const ALL = [NEAR, FAR, OUT, HIDDEN, SPLIT];
const HERE = P(1, 0);

describe('isShown（安全底線：只有 show=true 且有幾何才可上圖）', () => {
  it('show=false 或沒有幾何都不算', () => {
    expect(isShown(NEAR)).toBe(true);
    expect(isShown(HIDDEN)).toBe(false);
    expect(isShown({ ...NEAR, geometry: null })).toBe(false);
    expect(isShown({ ...NEAR, properties: { ...NEAR.properties, show: false } })).toBe(false);
    expect(isShown({ ...NEAR, properties: { ...NEAR.properties, show: 'true' } })).toBe(false);
  });
});

describe('buildNearbyRows', () => {
  it('半徑內、由近到遠，並附上可停判斷', () => {
    const rows = buildNearbyRows(HERE, ALL, SAT_NOON, HOLIDAYS, 500);
    expect(rows.map((r) => r.feature.properties.id)).toEqual(['TP-HOL-001', 'TP-HOL-008', 'TP-HOL-002']);
    expect(rows[0].distance).toBeLessThan(5);
    expect(rows.every((r) => r.result.canPark)).toBe(true);
  });

  it('平日一律不可停，且說明原因', () => {
    const rows = buildNearbyRows(HERE, ALL, MON_NOON, HOLIDAYS, 500);
    expect(rows.every((r) => !r.result.canPark)).toBe(true);
    expect(rows[0].result.reason).toContain('不是假日');
  });

  it('分時段路段在 14:00 不可停（#8 的情境）', () => {
    const rows = buildNearbyRows(HERE, ALL, SAT_14, HOLIDAYS, 500);
    const split = rows.find((r) => r.feature.properties.id === 'TP-HOL-008');
    expect(split.result.canPark).toBe(false);
    expect(split.result.reason).toContain('不在開放時段');
    expect(rows.find((r) => r.feature.properties.id === 'TP-HOL-001').result.canPark).toBe(true);
  });

  it('未確認（show=false）的路段永遠不進清單', () => {
    expect(buildNearbyRows(P(1, 0), [HIDDEN], SAT_NOON, HOLIDAYS, 5000)).toEqual([]);
  });

  it('假日表未涵蓋的年份：不可停', () => {
    const rows = buildNearbyRows(HERE, [NEAR], fromTaipei(2030, 1, 5, 720), HOLIDAYS, 500);
    expect(rows[0].result.canPark).toBe(false);
    expect(rows[0].result.reason).toContain('未涵蓋');
  });
});

describe('unconfirmedList', () => {
  it('列出尚未收錄（show=false）的路段', () => {
    const list = unconfirmedList(ALL);
    expect(list.map((x) => x.id)).toEqual(['TP-HOL-004']);
    expect(list[0]).toMatchObject({ road: '路004', district: '中正', fromName: '甲路', toName: '乙路' });
  });

  it('多段路段只要有一段未收錄就會列出，並標註第幾段', () => {
    const part = feat('TP-HOL-009', null, { show: false, nParts: 2, partIndex: 1 });
    const ok = feat('TP-HOL-009', line(0, 1), { nParts: 2, partIndex: 0 });
    expect(unconfirmedList([ok, part])).toEqual([expect.objectContaining({ id: 'TP-HOL-009', part: '第 2/2 段' })]);
  });
});

describe('格式化', () => {
  it.each([[0, '0 公尺'], [7, '約 10 公尺'], [84, '約 80 公尺'], [999, '約 1000 公尺'], [1234, '約 1.2 公里'], [12500, '約 12.5 公里']])(
    'formatDistance(%s)', (m, text) => expect(formatDistance(m)).toBe(text),
  );

  it('windowsText：全天與分時段', () => {
    expect(windowsText([{ start: '00:00', end: '24:00' }])).toBe('全天');
    expect(windowsText([{ start: '00:00', end: '13:00' }, { start: '20:00', end: '24:00' }])).toBe('00:00–13:00、20:00–24:00');
    expect(windowsText([])).toBe('—');
    expect(windowsText(undefined)).toBe('—');
  });

  it('formatUntil：同日、午夜、跨日接續', () => {
    const now = SAT_NOON;
    expect(formatUntil(fromTaipei(2026, 10, 3, 13 * 60), now)).toBe('13:00');
    expect(formatUntil(fromTaipei(2026, 10, 4, 0), now)).toBe('24:00');                 // 當日午夜
    expect(formatUntil(fromTaipei(2026, 10, 5, 0), now)).toBe('10/4 24:00');            // 接續到週日結束
    expect(formatUntil(null, now)).toBe('');
  });

  it('coverageText：誠實標示已收錄筆數與來源版本', () => {
    const meta = { shownIds: 32, totalIds: 99, sourceDate: '2021-12-14' };
    expect(coverageText(meta)).toBe('已收錄 32 / 99 筆路段；資料來源：臺北市停車管理工程處，2021-12-14 版');
  });

  it('accuracyNote：誤差大於 50 m 才提示', () => {
    expect(accuracyNote(20)).toBe('');
    expect(accuracyNote(50)).toBe('');
    expect(accuracyNote(120)).toBe('定位誤差約 120 公尺，結果僅供參考');
    expect(accuracyNote(null)).toBe('');
  });
});

describe('時間輸入與假日說明', () => {
  it('parseTaipeiInput：datetime-local 字串視為台北時間', () => {
    expect(parseTaipeiInput('2026-10-03T14:30').getTime()).toBe(fromTaipei(2026, 10, 3, 14 * 60 + 30).getTime());
    expect(parseTaipeiInput('')).toBeNull();
    expect(parseTaipeiInput('不是日期')).toBeNull();
    expect(parseTaipeiInput('2026-13-40T99:99')).toBeNull();
  });

  it('dayInfoText：今天是否算假日', () => {
    expect(dayInfoText(SAT_NOON, HOLIDAYS)).toBe('2026/10/3（六）台北時間 12:00　今天是假日');
    expect(dayInfoText(MON_NOON, HOLIDAYS)).toBe('2026/10/5（一）台北時間 12:00　今天不是假日');
    expect(dayInfoText(fromTaipei(2026, 10, 10, 600), HOLIDAYS)).toContain('今天是假日');
    expect(dayInfoText(fromTaipei(2030, 1, 5, 600), HOLIDAYS)).toContain('假日表未涵蓋 2030 年');
  });
});
