-- 행운 점수 맞히기 배점 조정 (2026-11-07 업데이트): 정확히 15, 1점 차 12, 2점 차 10,
-- 3점 차 8, 4점 차 6, 5점 차 4, 10점 차 이내 2, 15점 차 이내 1, 그 외 0.
-- Rounds that already started keep their snapshot. A saved administrator setting
-- overrides the code default, so the latest saved luck setting gets a new row from
-- today (KST) with only the score table replaced, and any row scheduled later is
-- updated the same way.
INSERT OR REPLACE INTO game_settings (game_id, effective_from, settings_json, created_at, created_by)
SELECT 'luck', date('now', '+9 hours'),
  json_set(settings_json, '$.scoreTable', json('[{"maxDifference":0,"points":15},{"maxDifference":1,"points":12},{"maxDifference":2,"points":10},{"maxDifference":3,"points":8},{"maxDifference":4,"points":6},{"maxDifference":5,"points":4},{"maxDifference":10,"points":2},{"maxDifference":15,"points":1}]')),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), created_by
FROM game_settings
WHERE game_id = 'luck' AND effective_from <= date('now', '+9 hours')
ORDER BY effective_from DESC LIMIT 1;
UPDATE game_settings
SET settings_json = json_set(settings_json, '$.scoreTable', json('[{"maxDifference":0,"points":15},{"maxDifference":1,"points":12},{"maxDifference":2,"points":10},{"maxDifference":3,"points":8},{"maxDifference":4,"points":6},{"maxDifference":5,"points":4},{"maxDifference":10,"points":2},{"maxDifference":15,"points":1}]'))
WHERE game_id = 'luck' AND effective_from > date('now', '+9 hours');
