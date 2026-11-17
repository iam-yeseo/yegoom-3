-- Additive only: achievement checks read one activity at a time (작업 7).
-- The trade facts must not walk a player's whole trade history:
--   * the best and the worst sell (gain and loss tiers) are the two ends of
--     an index on the realized gold of each sell;
--   * "was any of my holdings delisted" probes an index that only holds
--     delisting rows.
-- Both are partial, so a buy adds no index entry.
CREATE INDEX stock_trades_gain_idx ON stock_trades(user_id, total - cost_basis) WHERE side = 'sell';
CREATE INDEX stock_trades_delist_idx ON stock_trades(user_id) WHERE side = 'delist';
-- How far each player's past limit days have been checked (the last finished
-- KST day). Derived from stock_daily and stock_trades, never the source of an
-- unlock: deleting a row only makes the next check read that player's candles
-- from their first trade again.
CREATE TABLE achievement_scans (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  stock_limit_date TEXT NOT NULL DEFAULT ''
);
