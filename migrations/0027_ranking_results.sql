-- Additive only: every active player's place, score and payout for each settled
-- ranking period, written in the same batch as the payout. It keeps the exact
-- snapshot a payout was computed from, and the "랭킹 집계 완료" dialog reads a
-- player's row once (seen_at) to tell them their place and reward.
CREATE TABLE ranking_results (
  period TEXT NOT NULL CHECK (period IN ('week', 'month')),
  key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  place INTEGER NOT NULL CHECK (place >= 1),
  score INTEGER NOT NULL,
  gold INTEGER NOT NULL CHECK (gold >= 0),
  -- How many players were ranked, for "3명 중 1위".
  players INTEGER NOT NULL CHECK (players >= 1),
  seen_at TEXT,
  PRIMARY KEY (period, key, user_id),
  FOREIGN KEY (period, key) REFERENCES ranking_settlements(period, key)
);
-- Bootstrap asks only "what has this player not seen yet".
CREATE INDEX ranking_results_unseen_idx ON ranking_results(user_id, period, key) WHERE seen_at IS NULL;
