-- Additive launch profiles and event records. Run the nickname preflight first.
-- This unique index also aborts migration safely if active names conflict.
CREATE UNIQUE INDEX users_active_display_name_idx
  ON users(display_name COLLATE NOCASE) WHERE active = 1;

-- Keep the counter after deleting a photo so old immutable URLs are never reused.
ALTER TABLE users ADD COLUMN photo_version INTEGER;

CREATE TABLE user_photos (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  mime TEXT NOT NULL CHECK (mime IN ('image/webp', 'image/jpeg')),
  data BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('lotto', 'speetto')),
  user_id TEXT NOT NULL REFERENCES users(id),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE
);
CREATE INDEX announcements_recent_idx ON announcements(created_at DESC, id DESC);

CREATE TABLE luck_photos (
  round_date TEXT PRIMARY KEY,
  mime TEXT NOT NULL CHECK (mime IN ('image/webp', 'image/jpeg')),
  data BLOB NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at TEXT NOT NULL
);
