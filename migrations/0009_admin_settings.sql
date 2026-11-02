-- Additive settings and audit records; 0008 already belongs to Catchmind gallery.
CREATE TABLE game_settings (
  game_id TEXT NOT NULL CHECK (game_id IN ('wake', 'offwork', 'luck')),
  effective_from TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (game_id, effective_from)
);
ALTER TABLE game_rounds ADD COLUMN settings_json TEXT;

CREATE TABLE admin_changes (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES users(id),
  target TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Reverse traversal also orders the implicit rowid, so equal timestamps keep insertion order.
CREATE INDEX admin_changes_recent_idx ON admin_changes(created_at);
