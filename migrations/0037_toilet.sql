-- 변기 폭파 (docs/plan-toilet.md): two rounds a day (오전·오후). A row appears
-- with the round's first push; until then the round exists only in the rules.
-- A round that is still 'playing' when its window ends counts for nothing.
CREATE TABLE toilet_rounds (
  -- `YYYY-MM-DD:am` or `YYYY-MM-DD:pm` (KST).
  id TEXT PRIMARY KEY,
  round_date TEXT NOT NULL,
  half TEXT NOT NULL CHECK (half IN ('am', 'pm')),
  -- Player ids in turn order, fixed at the first push.
  order_json TEXT NOT NULL,
  -- The toilet bursts on one of this many pushes.
  slots INTEGER NOT NULL CHECK (slots >= 2),
  -- Pushes in order: [{ "for": turn player, "by": who pressed, "at": ISO time }].
  pushes_json TEXT NOT NULL,
  push_count INTEGER NOT NULL CHECK (push_count >= 1),
  -- The seat whose turn is next, and since when (null once it burst).
  turn INTEGER,
  turn_started_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('playing', 'burst')),
  loser_id TEXT REFERENCES users(id),
  -- What the burst paid: [{ "userId": ..., "points": ... }].
  results_json TEXT,
  -- The request that made the latest change, so its other statements apply only if it won.
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
