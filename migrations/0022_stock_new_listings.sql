-- Five more companies from the 주식 리스트 sheet (shared/stocks.ts): GU, 피자대학,
-- 구로미해적단, 고글, 야마존. Listing prices are the sheet values ×10. The new rows
-- start at the earliest existing last_tick_at so one advance moves every stock
-- from the same instant (a fresh database falls back to now).
INSERT OR IGNORE INTO stock_state (ticker, price, prev_close, last_tick_at)
SELECT t.ticker, t.price, t.price, COALESCE((SELECT MIN(last_tick_at) FROM stock_state), unixepoch('now') * 1000)
FROM (
  SELECT 'GEUU' AS ticker, 500 AS price UNION ALL
  SELECT 'PZUV', 1000 UNION ALL
  SELECT 'GURO', 750 UNION ALL
  SELECT 'GOOG', 1500 UNION ALL
  SELECT 'AMAZ', 1500
) AS t;
