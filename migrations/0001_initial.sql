PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('player', 'admin')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
-- Credential/role/status updates invalidate sessions in the same database write.
CREATE TRIGGER users_revoke_sessions AFTER UPDATE OF password_hash, role, active ON users
WHEN OLD.password_hash != NEW.password_hash OR OLD.role != NEW.role OR OLD.active != NEW.active
BEGIN
  DELETE FROM sessions WHERE user_id = NEW.id;
END;
CREATE TABLE login_attempts (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE TABLE game_rounds (
  game_id TEXT NOT NULL CHECK (game_id IN ('wake', 'offwork', 'luck')),
  round_date TEXT NOT NULL,
  answer TEXT,
  hint TEXT NOT NULL DEFAULT '',
  reveal_at INTEGER,
  revealed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, round_date)
);
CREATE TABLE predictions (
  game_id TEXT NOT NULL,
  round_date TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES users(id),
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, round_date, player_id),
  FOREIGN KEY (game_id, round_date) REFERENCES game_rounds(game_id, round_date)
);
-- Append-only accounting foundation. Settlement rules are deliberately unset.
-- Corrections must be a compensating row, never an UPDATE/DELETE of history.
CREATE TABLE ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  currency TEXT NOT NULL CHECK (currency IN ('gold', 'score')),
  amount INTEGER NOT NULL CHECK (amount != 0),
  reason TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  week_start TEXT,
  CHECK (currency = 'gold' OR week_start IS NOT NULL)
);
CREATE INDEX ledger_user_idx ON ledger(user_id, created_at);
CREATE INDEX ledger_week_idx ON ledger(currency, week_start, user_id);
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
