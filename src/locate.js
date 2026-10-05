// Geolocation 包裝：環境檢查、錯誤說明（純函式，可測）與取得位置。
// Geolocation API 只在 HTTPS 或 localhost 可用；失敗時一律引導使用者「在地圖上指定位置」。

export function geolocationSupport(env = globalThis) {
  if (env.isSecureContext === false) {
    return { ok: false, message: '定位功能需要 HTTPS 連線（或 localhost）。請改用「在地圖上指定位置」。' };
  }
  if (!env.navigator?.geolocation) {
    return { ok: false, message: '這個瀏覽器不支援定位。請改用「在地圖上指定位置」。' };
  }
  return { ok: true };
}

export function explainGeoError(err) {
  switch (err?.code) {
    case 1:
      return { kind: 'denied', message: '無法使用定位：位置權限被拒絕。請在瀏覽器的網站設定允許定位，或改用「在地圖上指定位置」點選地圖。' };
    case 2:
      return { kind: 'unavailable', message: '目前取不到位置（訊號不佳或裝置未開啟定位）。可稍後再試，或在地圖上指定位置。' };
    case 3:
      return { kind: 'timeout', message: '定位逾時。可再試一次，或在地圖上指定位置。' };
    default:
      return { kind: 'unknown', message: '定位失敗。請在地圖上指定位置。' };
  }
}

// 取得一次定位：{ lng, lat, accuracy }；失敗時 reject { kind, message }
export function getPosition(env = globalThis, options = { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }) {
  const support = geolocationSupport(env);
  if (!support.ok) return Promise.reject({ kind: 'unsupported', message: support.message });
  return new Promise((resolve, reject) => {
    env.navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lng: pos.coords.longitude, lat: pos.coords.latitude, accuracy: pos.coords.accuracy }),
      (err) => reject(explainGeoError(err)),
      options,
    );
  });
}
