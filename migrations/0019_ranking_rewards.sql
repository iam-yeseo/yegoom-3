-- Additive only: one row per settled ranking period keeps the payout job from
-- paying the same week or month twice, and lets a late run catch up.
CREATE TABLE ranking_settlements (
  period TEXT NOT NULL CHECK (period IN ('week', 'month')),
  key TEXT NOT NULL,
  settled_at TEXT NOT NULL,
  PRIMARY KEY (period, key)
);
