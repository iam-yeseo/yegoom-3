-- 예굼방 주식 PR 12: AI news budget, the AI switch, and opening the market.
-- Daily Claude API usage; cost is computed from each response's usage.
CREATE TABLE ai_usage (
  date TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0
);
-- Administrator stock settings (key/value). ai_enabled: '1' or '0'.
CREATE TABLE stock_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);
INSERT INTO stock_settings (key, value, updated_at) VALUES ('ai_enabled', '1', '2026-11-05T00:00:00.000Z');
-- Game results published before the market opens to players never move prices:
-- mark them handled (effect 0, already applied) so opening day starts clean.
INSERT OR IGNORE INTO stock_events (id, ticker, kind, effect_bp, apply_at, applied_at, context_json, created_at)
SELECT 'game:' || game_id || ':' || round_date,
  CASE game_id WHEN 'wake' THEN 'MINJ' WHEN 'offwork' THEN 'SIWN' ELSE 'YEDO' END,
  'game', 0, COALESCE(revealed_at, reveal_at, 0), COALESCE(revealed_at, reveal_at, 0), '{"backfill":true}', '2026-11-05T00:00:00.000Z'
FROM game_rounds WHERE answer IS NOT NULL;
