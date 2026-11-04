-- Run only through npm run launch:reset:remote after recording a backup bookmark.
-- D1 imports this entire file atomically; do not execute its statements separately.
-- Keep users, sessions, d1_migrations, claw_config and user_photos unchanged.

DROP TRIGGER ledger_no_update;
DROP TRIGGER ledger_no_delete;
DROP TRIGGER inventory_no_update;
DROP TRIGGER inventory_no_delete;

DELETE FROM announcements;
DELETE FROM luck_photos;

UPDATE catchmind_turn SET drawer_id = NULL, round_id = NULL;
DELETE FROM catchmind_guesses;
DELETE FROM catchmind_requests;
DELETE FROM catchmind_rounds;
DELETE FROM kuji_claims;
DELETE FROM lotto_tickets;
DELETE FROM kuji_boards;
DELETE FROM lotto_draws;
DELETE FROM shop_purchases;
DELETE FROM predictions;
DELETE FROM game_rounds;
DELETE FROM claw_plays;
DELETE FROM claw_coin_purchases;
DELETE FROM claw_accounts;
DELETE FROM ledger;
DELETE FROM inventory_ledger;
DELETE FROM user_balances;
DELETE FROM attendance;
DELETE FROM login_attempts;

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger
BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
CREATE TRIGGER inventory_no_update BEFORE UPDATE ON inventory_ledger
BEGIN SELECT RAISE(ABORT, 'inventory ledger is append-only'); END;
CREATE TRIGGER inventory_no_delete BEFORE DELETE ON inventory_ledger
BEGIN SELECT RAISE(ABORT, 'inventory ledger is append-only'); END;

-- RESET VERIFICATION: read-only queries, also printed by launch-reset.mjs after import.
SELECT 'ledger' AS cleared_table, COUNT(*) AS remaining FROM ledger;
SELECT 'attendance' AS cleared_table, COUNT(*) AS remaining FROM attendance;
SELECT 'game_rounds' AS cleared_table, COUNT(*) AS remaining FROM game_rounds;
SELECT 'predictions' AS cleared_table, COUNT(*) AS remaining FROM predictions;
SELECT 'inventory_ledger' AS cleared_table, COUNT(*) AS remaining FROM inventory_ledger;
SELECT 'user_balances' AS cleared_table, COUNT(*) AS remaining FROM user_balances;
SELECT 'shop_purchases' AS cleared_table, COUNT(*) AS remaining FROM shop_purchases;
SELECT 'kuji_claims' AS cleared_table, COUNT(*) AS remaining FROM kuji_claims;
SELECT 'kuji_boards' AS cleared_table, COUNT(*) AS remaining FROM kuji_boards;
SELECT 'lotto_tickets' AS cleared_table, COUNT(*) AS remaining FROM lotto_tickets;
SELECT 'lotto_draws' AS cleared_table, COUNT(*) AS remaining FROM lotto_draws;
SELECT 'catchmind_guesses' AS cleared_table, COUNT(*) AS remaining FROM catchmind_guesses;
SELECT 'catchmind_requests' AS cleared_table, COUNT(*) AS remaining FROM catchmind_requests;
SELECT 'catchmind_rounds' AS cleared_table, COUNT(*) AS remaining FROM catchmind_rounds;
SELECT 'claw_plays' AS cleared_table, COUNT(*) AS remaining FROM claw_plays;
SELECT 'claw_coin_purchases' AS cleared_table, COUNT(*) AS remaining FROM claw_coin_purchases;
SELECT 'claw_accounts' AS cleared_table, COUNT(*) AS remaining FROM claw_accounts;
SELECT 'login_attempts' AS cleared_table, COUNT(*) AS remaining FROM login_attempts;
SELECT 'announcements' AS cleared_table, COUNT(*) AS remaining FROM announcements;
SELECT 'luck_photos' AS cleared_table, COUNT(*) AS remaining FROM luck_photos;

SELECT 'users' AS preserved_table, COUNT(*) AS rows_kept FROM users;
SELECT 'sessions' AS preserved_table, COUNT(*) AS rows_kept FROM sessions;
SELECT 'd1_migrations' AS preserved_table, COUNT(*) AS rows_kept FROM d1_migrations;
SELECT 'claw_config' AS preserved_table, COUNT(*) AS rows_kept FROM claw_config;
SELECT 'user_photos' AS preserved_table, COUNT(*) AS rows_kept FROM user_photos;

SELECT id, drawer_id, round_id FROM catchmind_turn;
SELECT COUNT(*) AS restored_append_only_triggers FROM sqlite_master
WHERE type = 'trigger' AND name IN ('ledger_no_update', 'ledger_no_delete', 'inventory_no_update', 'inventory_no_delete');
SELECT name, sql FROM sqlite_master
WHERE type = 'trigger' AND name IN ('ledger_no_update', 'ledger_no_delete', 'inventory_no_update', 'inventory_no_delete')
ORDER BY name;
