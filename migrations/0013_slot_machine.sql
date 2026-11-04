-- Additive only: old Workers and existing shop/announcement CHECKs stay valid.
CREATE TABLE slot_spins (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  cost INTEGER NOT NULL CHECK (cost > 0),
  reels TEXT NOT NULL,
  prize INTEGER NOT NULL CHECK (prize >= 0),
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, request_id)
);
-- Preserve the user/day prefix and stream the newest 20 without sorting a day.
CREATE INDEX slot_spins_user_date_idx ON slot_spins(user_id, date DESC, created_at DESC, id DESC);
