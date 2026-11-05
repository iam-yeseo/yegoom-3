-- Additive: one row per unlocked achievement (and per period for the ones that
-- repeat). Claiming writes claimed_at and the gold ledger row in one batch.
CREATE TABLE achievements (
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  -- '' for a one-time achievement, the KST date for a daily one, the week's
  -- Monday for a weekly one.
  period_key TEXT NOT NULL DEFAULT '',
  unlocked_at TEXT NOT NULL,
  claimed_at TEXT,
  PRIMARY KEY (user_id, key, period_key)
);
CREATE INDEX achievements_unclaimed_idx ON achievements(user_id) WHERE claimed_at IS NULL;

-- Notifications gain the 'achievement' kind. SQLite cannot widen a CHECK, so
-- the table is rebuilt with the same rows, indexes and append-only trigger.
CREATE TABLE notifications_next (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('lotto', 'speetto', 'rank', 'game', 'stock', 'admin', 'achievement')),
  audience TEXT NOT NULL CHECK (audience IN ('all', 'user')),
  user_id TEXT REFERENCES users(id),
  actor_id TEXT REFERENCES users(id),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  CHECK (audience = 'all' OR user_id IS NOT NULL)
);
INSERT INTO notifications_next (id, kind, audience, user_id, actor_id, payload_json, created_at, reference)
SELECT id, kind, audience, user_id, actor_id, payload_json, created_at, reference FROM notifications;
DROP TABLE notifications;
ALTER TABLE notifications_next RENAME TO notifications;
CREATE INDEX notifications_recent_idx ON notifications(created_at DESC, id DESC);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC, id DESC) WHERE user_id IS NOT NULL;
CREATE TRIGGER notifications_no_update BEFORE UPDATE ON notifications
BEGIN SELECT RAISE(ABORT, 'notifications are append-only'); END;

-- Achievement checks look at the last few days of finished rounds by date.
CREATE INDEX catchmind_rounds_date_idx ON catchmind_rounds(round_date);

-- The checks ask "has this player ever …" questions; these keep each one an
-- indexed probe instead of a scan of the player's whole history.
CREATE INDEX predictions_player_idx ON predictions(player_id, game_id);
CREATE INDEX catchmind_guesses_player_idx ON catchmind_guesses(player_id);
CREATE INDEX catchmind_rounds_drawer_idx ON catchmind_rounds(drawer_id);
CREATE INDEX shop_purchases_user_kind_idx ON shop_purchases(user_id, kind);
CREATE INDEX slot_spins_user_prize_idx ON slot_spins(user_id) WHERE prize > 0;
CREATE INDEX claw_plays_user_caught_idx ON claw_plays(user_id) WHERE caught > 0;
CREATE INDEX claw_plays_user_clear_idx ON claw_plays(user_id) WHERE clear_bonus > 0;
