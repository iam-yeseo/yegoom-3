-- Additive: rounds, submitted guesses, and the current drawing turn are separate.
CREATE TABLE catchmind_rounds (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  drawer_id TEXT NOT NULL REFERENCES users(id),
  word TEXT NOT NULL,
  normalized_word TEXT NOT NULL,
  word_history TEXT NOT NULL,
  rerolls INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'ended')),
  image TEXT,
  round_date TEXT,
  published_at TEXT,
  ended_at TEXT,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  winner_id TEXT REFERENCES users(id),
  end_reason TEXT CHECK (end_reason IN ('correct', 'misses', 'manual')),
  created_at TEXT NOT NULL
);
CREATE TABLE catchmind_turn (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  drawer_id TEXT REFERENCES users(id),
  round_id TEXT REFERENCES catchmind_rounds(id)
);
INSERT INTO catchmind_turn (id) VALUES (1);

CREATE TABLE catchmind_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  round_id TEXT REFERENCES catchmind_rounds(id),
  result_round_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, request_id)
);
CREATE TABLE catchmind_guesses (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE REFERENCES catchmind_requests(id),
  round_id TEXT NOT NULL REFERENCES catchmind_rounds(id),
  player_id TEXT NOT NULL REFERENCES users(id),
  answer TEXT NOT NULL,
  normalized_answer TEXT NOT NULL,
  correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX catchmind_guesses_round_idx ON catchmind_guesses(round_id, sequence);
