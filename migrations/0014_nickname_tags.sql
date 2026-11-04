-- Additive only: nickname tags drawn in the shop. One equipped tag per user.
CREATE TABLE nickname_tags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  grade TEXT NOT NULL CHECK (grade IN ('S', 'A', 'B', 'C')),
  text TEXT NOT NULL,
  equipped INTEGER NOT NULL DEFAULT 0 CHECK (equipped IN (0, 1)),
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, request_id)
);
-- Daily limit counts and the collection list read by (user, date).
CREATE INDEX nickname_tags_user_date_idx ON nickname_tags(user_id, date);
CREATE UNIQUE INDEX nickname_tags_equipped_idx ON nickname_tags(user_id) WHERE equipped = 1;
