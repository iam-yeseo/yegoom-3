-- Santa's gift delivery, a limited Christmas event (docs/plan-santa.md §3).
-- One run per player per KST half day; each house is stored with the exact
-- release time the server re-judged (-1 when the house was passed).
CREATE TABLE santa_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot >= 0),
  -- KST date of the slot start, for the daily board.
  date TEXT NOT NULL,
  engine INTEGER NOT NULL CHECK (engine >= 1),
  drops INTEGER NOT NULL DEFAULT 0 CHECK (drops BETWEEN 0 AND 10),
  hits INTEGER NOT NULL DEFAULT 0 CHECK (hits >= 0 AND hits <= drops),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, slot),
  UNIQUE (user_id, request_id)
);
CREATE INDEX santa_runs_date ON santa_runs (date);
CREATE TABLE santa_drops (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES santa_runs(id),
  house_index INTEGER NOT NULL CHECK (house_index BETWEEN 0 AND 9),
  release_ms INTEGER NOT NULL CHECK (release_ms >= -1),
  hit INTEGER NOT NULL CHECK (hit IN (0, 1)),
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, house_index)
);
