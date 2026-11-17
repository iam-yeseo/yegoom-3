-- Additive only.
-- A scratched speetto stays scratched on every device (the prize was already
-- paid at purchase; this only records that the result has been seen).
ALTER TABLE shop_purchases ADD COLUMN revealed_at TEXT;

-- Nickname tag evolution: two tags with the same phrase, one attempt per row.
-- The evolved tag's grade is updated in place; a spent material is marked
-- discarded on nickname_tags. Daily free attempts are counted by (user, date).
CREATE TABLE nickname_tag_evolutions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  base_id TEXT NOT NULL REFERENCES nickname_tags(id),
  material_id TEXT NOT NULL REFERENCES nickname_tags(id),
  text TEXT NOT NULL,
  from_grade TEXT NOT NULL CHECK (from_grade IN ('A', 'B', 'C')),
  to_grade TEXT NOT NULL CHECK (to_grade IN ('S', 'A', 'B')),
  material_grade TEXT NOT NULL CHECK (material_grade IN ('S', 'A', 'B', 'C')),
  chance INTEGER NOT NULL CHECK (chance BETWEEN 0 AND 100),
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  material_lost INTEGER NOT NULL CHECK (material_lost IN (0, 1)),
  cost INTEGER NOT NULL CHECK (cost >= 0),
  date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, request_id)
);
CREATE INDEX nickname_tag_evolutions_user_date_idx ON nickname_tag_evolutions(user_id, date);
