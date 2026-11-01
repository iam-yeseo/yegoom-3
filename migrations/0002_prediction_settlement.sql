-- Additive: the currently deployed Worker can continue using this table.
ALTER TABLE game_rounds ADD COLUMN settled_at INTEGER;
