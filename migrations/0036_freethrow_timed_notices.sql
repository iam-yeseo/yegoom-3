-- Free throw becomes a 30-second set (docs/plan-freethrow.md §3): a set holds as
-- many balls as were thrown in time, so the 10-ball limits go. SQLite cannot
-- drop a CHECK, so freethrow_sets is rebuilt in the shape of arcade_sets: the
-- balls move from freethrow_shots into results_json, and finished_at (not a
-- ball count) says a set was recorded. Sets recorded under the 10-ball rule
-- keep their goals, points and gold.
CREATE TABLE freethrow_sets_next (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  request_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot >= 0),
  -- KST date of the slot start, for the daily board.
  date TEXT NOT NULL,
  engine INTEGER NOT NULL CHECK (engine >= 1),
  shots INTEGER NOT NULL DEFAULT 0 CHECK (shots >= 0),
  made INTEGER NOT NULL DEFAULT 0 CHECK (made >= 0 AND made <= shots),
  -- Half points: a goal is worth 0.5.
  points REAL NOT NULL DEFAULT 0 CHECK (points >= 0),
  gold INTEGER NOT NULL DEFAULT 0 CHECK (gold >= 0),
  inputs_json TEXT,
  results_json TEXT,
  -- Set by the one request that recorded the set; its ledger rows depend on it.
  finish_token TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (user_id, slot),
  UNIQUE (user_id, request_id)
);
INSERT INTO freethrow_sets_next (id, user_id, request_id, slot, date, engine, shots, made, points, gold, inputs_json, results_json, created_at, finished_at)
SELECT s.id, s.user_id, s.request_id, s.slot, s.date, s.engine, s.shots, s.made,
  COALESCE((SELECT SUM(l.amount) FROM ledger l WHERE l.user_id = s.user_id AND l.currency = 'score'
    AND (l.reference = 'freethrow:set:' || s.id || ':score' OR l.reference LIKE 'freethrow:goal:' || s.id || ':%')), 0),
  COALESCE((SELECT SUM(l.amount) FROM ledger l WHERE l.user_id = s.user_id AND l.currency = 'gold'
    AND (l.reference = 'freethrow:set:' || s.id || ':gold' OR l.reference LIKE 'freethrow:goal:' || s.id || ':%')), 0),
  CASE WHEN s.shots >= 10 THEN (SELECT json_group_array(json_object('power', power, 'aim', aim))
    FROM (SELECT power, aim FROM freethrow_shots WHERE set_id = s.id ORDER BY shot_index)) END,
  CASE WHEN s.shots >= 10 THEN (SELECT json_group_array(json_object('index', shot_index, 'power', power, 'aim', aim, 'made', json(CASE made WHEN 1 THEN 'true' ELSE 'false' END), 'kind', kind))
    FROM (SELECT shot_index, power, aim, made, kind FROM freethrow_shots WHERE set_id = s.id ORDER BY shot_index)) END,
  s.created_at,
  CASE WHEN s.shots >= 10 THEN COALESCE((SELECT MAX(created_at) FROM freethrow_shots WHERE set_id = s.id), s.created_at) END
FROM freethrow_sets s;
DROP TABLE freethrow_shots;
DROP TABLE freethrow_sets;
ALTER TABLE freethrow_sets_next RENAME TO freethrow_sets;
CREATE INDEX freethrow_sets_date ON freethrow_sets (date);

-- The free-throw goal achievements move from 3·5·10 to 5·10·20 goals. A "3골"
-- reward that was earned but not yet collected is paid now, with the same
-- ledger reference a claim would have used, so nothing earned is lost.
INSERT OR IGNORE INTO ledger (id, user_id, currency, amount, reason, reference, created_at)
SELECT lower(hex(randomblob(16))), user_id, 'gold', 50, '도전과제 · 이정도면 충분한가?',
  'achievement:freethrow_3:' || period_key || ':' || user_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM achievements WHERE key = 'freethrow_3' AND claimed_at IS NULL;
UPDATE achievements SET claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE key = 'freethrow_3' AND claimed_at IS NULL;

-- Notices (공지) are written in shared/notices.ts; this keeps which ones each
-- reader has opened, as a JSON array of notice ids. A notice stays unread, and
-- the bell keeps its badge, until that notice itself is opened.
ALTER TABLE users ADD COLUMN notices_read_json TEXT;
