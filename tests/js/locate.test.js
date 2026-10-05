import { describe, it, expect } from 'vitest';
import { explainGeoError, geolocationSupport } from '../../src/locate.js';

describe('explainGeoError', () => {
  it('拒絕權限：說明並指引改用手動指定', () => {
    const e = explainGeoError({ code: 1 });
    expect(e.kind).toBe('denied');
    expect(e.message).toContain('權限');
    expect(e.message).toContain('地圖');
  });

  it.each([[2, 'unavailable'], [3, 'timeout']])('code %s → %s', (code, kind) => {
    expect(explainGeoError({ code }).kind).toBe(kind);
  });

  it('未知錯誤也要有說明', () => {
    expect(explainGeoError(new Error('x')).kind).toBe('unknown');
    expect(explainGeoError(undefined).message.length).toBeGreaterThan(0);
  });
});

describe('geolocationSupport', () => {
  it('不支援或非安全環境時回報原因（Geolocation 只在 HTTPS／localhost 可用）', () => {
    expect(geolocationSupport({ isSecureContext: true, navigator: { geolocation: {} } })).toEqual({ ok: true });
    const insecure = geolocationSupport({ isSecureContext: false, navigator: { geolocation: {} } });
    expect(insecure.ok).toBe(false);
    expect(insecure.message).toContain('HTTPS');
    const none = geolocationSupport({ isSecureContext: true, navigator: {} });
    expect(none.ok).toBe(false);
    expect(none.message).toContain('不支援');
  });
});
