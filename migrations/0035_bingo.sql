-- Bingo, a group game (docs/plan-bingo.md). One game at a time: the leader
-- names a topic and the winning line count, 30 words are made from it, every
-- player fills a 5x5 board from them, and players take turns calling a word.
CREATE TABLE bingo_games (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  leader_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  lines INTEGER NOT NULL CHECK (lines IN (3, 5)),
  -- The 30 words of the pool, and whether OpenAI or the leader wrote them.
  words_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('ai', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('filling', 'playing', 'ended', 'cancelled')),
  turn_id TEXT REFERENCES users(id),
  turn_started_at TEXT,
  -- Called words in order: [{ "word": ..., "by": user id, "at": ISO time }].
  calls_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE (leader_id, request_id)
);
CREATE TABLE bingo_boards (
  game_id TEXT NOT NULL REFERENCES bingo_games(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  -- 25 words of the pool, row by row.
  cells_json TEXT NOT NULL,
  rank INTEGER CHECK (rank >= 1),
  points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  ranked_at TEXT,
  submitted_at TEXT NOT NULL,
  PRIMARY KEY (game_id, user_id)
);
-- The one table every bingo write goes through: whose lead it is, the current
-- (or last) game, and a version every change raises. `token` names the request
-- that made the latest change, so its other statements apply only if it won.
CREATE TABLE bingo_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  leader_id TEXT REFERENCES users(id),
  game_id TEXT REFERENCES bingo_games(id),
  -- Since when the leader has been expected to open a game.
  waiting_since TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  token TEXT
);
INSERT INTO bingo_state (id) VALUES (1);
