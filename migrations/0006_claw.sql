-- The payout schedule is private server configuration, never a shared balance export.
CREATE TABLE claw_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payout_every INTEGER NOT NULL CHECK (payout_every BETWEEN 1 AND 50),
  weak_pickup INTEGER NOT NULL CHECK (weak_pickup BETWEEN 5 AND 100),
  weak_carry INTEGER NOT NULL CHECK (weak_carry BETWEEN 5 AND 100),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO claw_config (id, payout_every, weak_pickup, weak_carry) VALUES (1, 10, 45, 30);

CREATE TABLE claw_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  free_coins INTEGER NOT NULL DEFAULT 0 CHECK (free_coins >= 0),
  purchased_coins INTEGER NOT NULL DEFAULT 0 CHECK (purchased_coins >= 0),
  last_grant_slot INTEGER NOT NULL,
  -- Bootstrap creates only the wallet. The machine is initialized on first opening.
  board_json TEXT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  next_play_at INTEGER NOT NULL DEFAULT 0,
  power_counter INTEGER NOT NULL DEFAULT 0 CHECK (power_counter >= 0)
);
CREATE TABLE claw_plays (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  version INTEGER NOT NULL,
  claw_x REAL NOT NULL,
  stop REAL,
  caught INTEGER NOT NULL CHECK (caught >= 0),
  score INTEGER NOT NULL CHECK (score >= 0),
  gold INTEGER NOT NULL CHECK (gold >= 0),
  clear_bonus INTEGER NOT NULL CHECK (clear_bonus >= 0),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, request_id),
  UNIQUE (user_id, version)
);
CREATE TABLE claw_coin_purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity IN (1, 5)),
  cost INTEGER NOT NULL CHECK (cost > 0),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, request_id)
);
