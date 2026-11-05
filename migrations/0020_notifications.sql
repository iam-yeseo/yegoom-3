-- Additive only: one notification store for the bell, the notification centre
-- and the four-second toast. The old `announcements` table keeps its rows; the
-- app reads and writes this table from now on.
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('lotto', 'speetto', 'rank', 'game', 'stock', 'admin')),
  audience TEXT NOT NULL CHECK (audience IN ('all', 'user')),
  -- The only reader when audience is 'user'; NULL for everyone.
  user_id TEXT REFERENCES users(id),
  -- Whose news it is, so a name or photo can be shown and self-news skipped.
  actor_id TEXT REFERENCES users(id),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  CHECK (audience = 'all' OR user_id IS NOT NULL)
);
-- The centre, the badge and the toast all read newest first, for everyone or
-- for one reader; the partial index keeps the personal list off the full table.
CREATE INDEX notifications_recent_idx ON notifications(created_at DESC, id DESC);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC, id DESC) WHERE user_id IS NOT NULL;
CREATE TRIGGER notifications_no_update BEFORE UPDATE ON notifications
BEGIN SELECT RAISE(ABORT, 'notifications are append-only'); END;

-- Opening the centre stores this watermark; anything newer counts as unread.
ALTER TABLE users ADD COLUMN notifications_seen_at TEXT;
