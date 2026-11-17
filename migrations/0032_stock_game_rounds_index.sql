-- Additive only (작업 8). Every stock advance (each stock read, the 10-minute
-- Cron and each game reveal) asks for game results published in the last few
-- days that have no stock event yet. game_rounds is keyed by (game_id,
-- round_date), so that date range walked every round ever answered. This index
-- holds answered rounds by date: the same query reads only the recent ones.
-- Settled rounds stay in it on purpose (a settled result may still be waiting
-- to move its stock), so it is not the unsettled index of 0011.
CREATE INDEX game_rounds_answered_date_idx ON game_rounds(round_date) WHERE answer IS NOT NULL;
