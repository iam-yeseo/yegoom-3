-- Additive: existing deployments ignore the new column and table.
ALTER TABLE users ADD COLUMN character TEXT CHECK (character IN ('axolotl', 'drop', 'cat', 'bunny', 'bread', 'manta', 'moon', 'monkey'));

CREATE TABLE attendance (
  user_id TEXT NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  streak INTEGER NOT NULL CHECK (streak >= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, date)
);
