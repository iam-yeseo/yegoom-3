-- Free-throw official sets (docs/plan-freethrow.md §3). One set per player per
-- three-hour slot; each shot is stored with the exact input the server re-simulated.
CREATE TABLE freethrow_sets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot >= 0),
  -- KST date of the slot start, for the daily board.
  date TEXT NOT NULL,
  engine INTEGER NOT NULL CHECK (engine >= 1),
  shots INTEGER NOT NULL DEFAULT 0 CHECK (shots BETWEEN 0 AND 10),
  made INTEGER NOT NULL DEFAULT 0 CHECK (made >= 0 AND made <= shots),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, slot),
  UNIQUE (user_id, request_id)
);
CREATE INDEX freethrow_sets_date ON freethrow_sets (date);
CREATE TABLE freethrow_shots (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL REFERENCES freethrow_sets(id),
  shot_index INTEGER NOT NULL CHECK (shot_index BETWEEN 0 AND 9),
  power INTEGER NOT NULL CHECK (power BETWEEN 0 AND 100),
  aim INTEGER NOT NULL CHECK (aim BETWEEN -100 AND 100),
  made INTEGER NOT NULL CHECK (made IN (0, 1)),
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (set_id, shot_index)
);
