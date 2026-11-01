-- Additive shop tables; existing deployments remain compatible.
CREATE TABLE inventory_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  item TEXT NOT NULL CHECK (item IN ('lotto_ticket', 'speetto_ticket')),
  amount INTEGER NOT NULL CHECK (amount != 0),
  reason TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX inventory_user_item_idx ON inventory_ledger(user_id, item);
CREATE TRIGGER inventory_no_update BEFORE UPDATE ON inventory_ledger
BEGIN SELECT RAISE(ABORT, 'inventory ledger is append-only'); END;
CREATE TRIGGER inventory_no_delete BEFORE DELETE ON inventory_ledger
BEGIN SELECT RAISE(ABORT, 'inventory ledger is append-only'); END;

CREATE TABLE shop_purchases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('kuji', 'lotto', 'speetto')),
  request_payload TEXT NOT NULL,
  payment TEXT NOT NULL CHECK (payment IN ('gold', 'ticket')),
  cost INTEGER NOT NULL CHECK (cost >= 0),
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  last_one INTEGER NOT NULL DEFAULT 0 CHECK (last_one IN (0, 1)),
  UNIQUE (user_id, request_id)
);
CREATE INDEX shop_user_date_idx ON shop_purchases(user_id, date, kind);

CREATE TABLE kuji_boards (
  id INTEGER PRIMARY KEY,
  grades TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE kuji_claims (
  board_id INTEGER NOT NULL REFERENCES kuji_boards(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  purchase_id TEXT NOT NULL REFERENCES shop_purchases(id),
  PRIMARY KEY (board_id, position)
);
CREATE INDEX kuji_purchase_idx ON kuji_claims(purchase_id);

CREATE TABLE lotto_draws (
  date TEXT PRIMARY KEY,
  numbers TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE lotto_tickets (
  id TEXT PRIMARY KEY REFERENCES shop_purchases(id),
  draw_date TEXT NOT NULL,
  numbers TEXT NOT NULL,
  settled_at TEXT,
  matches INTEGER,
  rank INTEGER,
  prize INTEGER
);
CREATE INDEX lotto_unsettled_idx ON lotto_tickets(draw_date, settled_at);
