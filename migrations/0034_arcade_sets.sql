-- Curling and penalty shoot-out sets (docs/plan-curling.md, docs/plan-penalty.md).
-- One set per player, game and three-hour slot. A set is played on the device
-- and recorded once: inputs_json holds the exact throws or kicks the server
-- judged again, results_json what each one came to.
CREATE TABLE arcade_sets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  game TEXT NOT NULL CHECK (game IN ('curling', 'penalty')),
  request_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot >= 0),
  -- KST date the set was started on: its game day, and the daily board's key.
  date TEXT NOT NULL,
  engine INTEGER NOT NULL CHECK (engine >= 1),
  tries INTEGER NOT NULL DEFAULT 0 CHECK (tries >= 0),
  made INTEGER NOT NULL DEFAULT 0 CHECK (made >= 0 AND made <= tries),
  points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  gold INTEGER NOT NULL DEFAULT 0 CHECK (gold >= 0),
  inputs_json TEXT,
  results_json TEXT,
  -- Set by the one request that recorded the set; its ledger rows depend on it.
  finish_token TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (user_id, game, slot),
  UNIQUE (user_id, request_id)
);
CREATE INDEX arcade_sets_board ON arcade_sets (game, date);
