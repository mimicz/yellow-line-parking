// 校正頁的中文標籤。原因代碼來自 etl/match_osm.py 與 etl/merge.py（tests/etl 會檢查每個代碼都有標籤）。
// 帶「:from／:to」後綴的代碼會把 {side} 換成「起點／迄點」。

const REASONS = {
  road_unparsable: '無法解析路段名稱',
  no_main_road_way: '在 OSM 找不到這條路（名稱或段號對不上）',
  ambiguous_endpoint: '官方表格的迄點有兩個候選名稱，無法判斷',
  missing_endpoint: '{side}名稱空白',
  endpoint_landmark: '{side}是地標，無法自動定位',
  endpoint_not_intersection: '{side}不是路口（巷內某處或某門牌位置）',
  endpoint_address_only: '{side}只寫了路名，實際位置由門牌欄決定，無法自動定位',
  no_intersection: '{side}：在 OSM 找不到與主路相交的路口',
  same_endpoint: '起迄點在同一個路口',
  no_route: '起迄路口在 OSM 路網上不連通',
  ambiguous_candidates: '有多個候選路口且無法區分，需人工判斷',
  route_too_winding: '路徑繞路比過大（> 2.5），疑似比對錯誤',
  chosen_shortest: '有多個候選路口，已取最短者',
  dual_carriageway: '分隔雙線道：兩側車道各有交點，取最短者',
  wide_intersection: '橫街在寬路口有多個交點，取最近者',
  winding: '路徑繞路比偏高（1.5～2.5）',
  length_out_of_range: '長度異常（短於 30 m 或長於 3 km）',
  section_fallback: 'OSM 路名沒有段號，已改用整條路比對',
  'flag:complex_range': '門牌欄含「至」的分段範圍，需人工確認範圍',
  'flag:has_note': '官方備註欄有例外說明，需人工確認範圍',
  manual_override: '已人工重畫',
  manual_confirmed: '已人工確認',
  manual_excluded: '已人工排除（看過但無法確認）',
};

const SIDES = { from: '起點', to: '迄點' };

export function describeReasons(reasons) {
  return reasons.map((code) => {
    const parts = code.split(':');
    const side = SIDES[parts[parts.length - 1]];
    const key = side ? parts.slice(0, -1).join(':') : code;
    const text = REASONS[key];
    return text ? text.replace('{side}', side ?? '') : code;
  });
}

const CONFIDENCE = { high: '高信心', low: '低信心', needs_manual: '需人工', manual: '人工' };
const STATUS = { pending: '待處理', confirmed: '已確認', redrawn: '已重畫', excluded: '已排除' };

export const confidenceLabel = (c) => CONFIDENCE[c] ?? c;
export const statusLabel = (s) => STATUS[s] ?? s;
