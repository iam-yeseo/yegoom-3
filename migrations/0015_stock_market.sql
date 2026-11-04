-- 예굼방 주식 (docs/plan-stock.md §3–§6). Prices move only on the server: a
-- 10-minute Cron (and any stock read) replays missing ticks deterministically.
-- `writer` is a per-advance token: the rows written alongside a state update
-- (ticks, candles, news, delistings) are applied only by the run that won it.
CREATE TABLE stock_state (
  ticker TEXT PRIMARY KEY,
  price INTEGER NOT NULL CHECK (price >= 1),
  prev_close INTEGER NOT NULL CHECK (prev_close >= 1),
  day_open INTEGER, day_high INTEGER, day_low INTEGER,
  status TEXT NOT NULL DEFAULT 'listed' CHECK (status IN ('listed', 'warning', 'delisted')),
  warning_since TEXT, delisted_on TEXT, relist_on TEXT,
  last_tick_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  writer TEXT
);
-- 10-minute prices, kept 30 days (daily maintenance); candles are kept forever.
CREATE TABLE stock_ticks (
  ticker TEXT NOT NULL, at INTEGER NOT NULL, price INTEGER NOT NULL,
  PRIMARY KEY (ticker, at)
) WITHOUT ROWID;
CREATE TABLE stock_daily (
  ticker TEXT NOT NULL, date TEXT NOT NULL,
  open INTEGER NOT NULL, high INTEGER NOT NULL, low INTEGER NOT NULL, close INTEGER NOT NULL,
  PRIMARY KEY (ticker, date)
) WITHOUT ROWID;
-- Price events decided outside the daily schedule (game results, rumors).
-- Future rows are never returned by any API, including the admin console.
CREATE TABLE stock_events (
  id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL,
  kind TEXT NOT NULL,
  effect_bp INTEGER NOT NULL,
  apply_at INTEGER NOT NULL,
  applied_at INTEGER,
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX stock_events_due_idx ON stock_events(applied_at, apply_at);
-- Articles. Every read filters publish_at <= now AND hidden = 0.
CREATE TABLE stock_news (
  id TEXT PRIMARY KEY,
  event_id TEXT,
  ticker TEXT,
  kind TEXT NOT NULL,
  publish_at INTEGER NOT NULL,
  headline TEXT NOT NULL,
  body TEXT NOT NULL,
  effect_bp INTEGER,
  audience_user_id TEXT REFERENCES users(id),
  source TEXT NOT NULL DEFAULT 'template' CHECK (source IN ('ai', 'template')),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX stock_news_publish_idx ON stock_news(publish_at);
CREATE INDEX stock_news_ticker_idx ON stock_news(ticker, publish_at);
CREATE TABLE stock_holdings (
  user_id TEXT NOT NULL REFERENCES users(id),
  ticker TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0 AND quantity <= 500),
  cost_basis INTEGER NOT NULL CHECK (cost_basis >= 0),
  PRIMARY KEY (user_id, ticker)
) WITHOUT ROWID;
-- side 'delist' records holdings lost to a delisting (total 0, no ledger row).
-- cost_basis is the purchase cost consumed by a sell or delisting.
CREATE TABLE stock_trades (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell', 'delist')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  price INTEGER NOT NULL,
  fee INTEGER NOT NULL,
  total INTEGER NOT NULL CHECK (total >= 0),
  cost_basis INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, request_id)
);
CREATE INDEX stock_trades_user_idx ON stock_trades(user_id, ticker, created_at);
-- Administrator-added market holidays (elections, temporary public holidays).
CREATE TABLE market_holidays (
  date TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
-- Listing prices are the sheet values ×10 (shared/stocks.ts).
INSERT INTO stock_state (ticker, price, prev_close, last_tick_at) VALUES
  ('YKHX', 1500, 1500, unixepoch('now') * 1000),
  ('SIWN', 1500, 1500, unixepoch('now') * 1000),
  ('MINJ', 1500, 1500, unixepoch('now') * 1000),
  ('YEDO', 1000, 1000, unixepoch('now') * 1000),
  ('DWSC', 1000, 1000, unixepoch('now') * 1000),
  ('MDRG', 1000, 1000, unixepoch('now') * 1000),
  ('SOAR', 750, 750, unixepoch('now') * 1000),
  ('EEVA', 500, 500, unixepoch('now') * 1000),
  ('RIAN', 500, 500, unixepoch('now') * 1000),
  ('YEGM', 500, 500, unixepoch('now') * 1000);
