-- Preserve all previously shown words, including rerolled prompts.
CREATE TABLE catchmind_used_words (
  word TEXT PRIMARY KEY,
  round_id TEXT NOT NULL,
  used_at TEXT NOT NULL
);
INSERT OR IGNORE INTO catchmind_used_words (word, round_id, used_at)
SELECT j.value, r.id, r.created_at FROM catchmind_rounds r, json_each(r.word_history) j
WHERE j.type = 'text' ORDER BY r.number DESC;

ALTER TABLE catchmind_turn ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

-- A legacy ended round may point at its winner; rotate from its actual drawer.
UPDATE catchmind_turn SET drawer_id = COALESCE(
  (SELECT u.id FROM users u WHERE u.active = 1 AND u.role = 'player'
    AND u.username > (SELECT u2.username FROM users u2 JOIN catchmind_rounds r ON r.drawer_id = u2.id WHERE r.id = catchmind_turn.round_id)
    ORDER BY u.username LIMIT 1),
  (SELECT id FROM users WHERE active = 1 AND role = 'player' ORDER BY username LIMIT 1)
), version = version + 1
WHERE EXISTS (SELECT 1 FROM catchmind_rounds WHERE id = catchmind_turn.round_id AND status = 'ended');

-- Receipts exist only for an accepted action. Both old and new Workers use the
-- same receipt table, so the migration/deployment interval has no version gap.
CREATE TRIGGER catchmind_request_version AFTER INSERT ON catchmind_requests
BEGIN
  UPDATE catchmind_turn SET version = version + 1 WHERE id = 1;
END;

-- Bridge old Workers too. New Workers reserve with a strict INSERT before the
-- round write; these compatibility triggers cannot suppress a collision.
CREATE TRIGGER catchmind_word_insert AFTER INSERT ON catchmind_rounds
BEGIN
  INSERT OR IGNORE INTO catchmind_used_words (word, round_id, used_at) VALUES (NEW.word, NEW.id, NEW.created_at);
END;
CREATE TRIGGER catchmind_word_update AFTER UPDATE OF word ON catchmind_rounds
WHEN OLD.word != NEW.word
BEGIN
  INSERT OR IGNORE INTO catchmind_used_words (word, round_id, used_at) VALUES (NEW.word, NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

-- Turn assignment is part of the same round-ending SQL statement/transaction.
CREATE TRIGGER catchmind_round_rotation AFTER UPDATE OF status ON catchmind_rounds
WHEN OLD.status != 'ended' AND NEW.status = 'ended'
BEGIN
  UPDATE catchmind_turn SET drawer_id = COALESCE(
    (SELECT id FROM users WHERE active = 1 AND role = 'player'
      AND username > (SELECT username FROM users WHERE id = NEW.drawer_id) ORDER BY username LIMIT 1),
    (SELECT id FROM users WHERE active = 1 AND role = 'player' ORDER BY username LIMIT 1)
  ) WHERE id = 1 AND round_id = NEW.id;
END;

-- A legacy correct-guess handler writes the winner AFTER ending the round.
-- Correct that overwrite, while preserving explicitly skipped turns. rowid is
-- deterministic even when several accepted requests share created_at.
CREATE TRIGGER catchmind_legacy_rotation AFTER UPDATE OF drawer_id ON catchmind_turn
WHEN EXISTS (SELECT 1 FROM catchmind_rounds WHERE id = NEW.round_id AND status = 'ended')
  AND NEW.version = OLD.version
  AND COALESCE((SELECT action FROM catchmind_requests WHERE result_round_id = NEW.round_id ORDER BY rowid DESC LIMIT 1), '') != 'skip'
  AND NEW.drawer_id IS NOT COALESCE(
    (SELECT id FROM users WHERE active = 1 AND role = 'player' AND username >
      (SELECT u.username FROM users u JOIN catchmind_rounds r ON r.drawer_id = u.id WHERE r.id = NEW.round_id)
      ORDER BY username LIMIT 1),
    (SELECT id FROM users WHERE active = 1 AND role = 'player' ORDER BY username LIMIT 1))
BEGIN
  UPDATE catchmind_turn SET drawer_id = COALESCE(
    (SELECT id FROM users WHERE active = 1 AND role = 'player' AND username >
      (SELECT u.username FROM users u JOIN catchmind_rounds r ON r.drawer_id = u.id WHERE r.id = NEW.round_id)
      ORDER BY username LIMIT 1),
    (SELECT id FROM users WHERE active = 1 AND role = 'player' ORDER BY username LIMIT 1)) WHERE id = 1;
END;

-- Unchanged responses must not hide roster, nickname or avatar changes.
CREATE TRIGGER catchmind_profile_version AFTER UPDATE OF username, display_name, character, photo_version, role, active ON users
WHEN OLD.username IS NOT NEW.username OR OLD.display_name IS NOT NEW.display_name OR OLD.character IS NOT NEW.character
  OR OLD.photo_version IS NOT NEW.photo_version OR OLD.role IS NOT NEW.role OR OLD.active IS NOT NEW.active
BEGIN
  UPDATE catchmind_turn SET version = version + 1 WHERE id = 1;
END;
CREATE TRIGGER catchmind_roster_insert_version AFTER INSERT ON users
WHEN NEW.active = 1 AND NEW.role = 'player'
BEGIN
  UPDATE catchmind_turn SET version = version + 1 WHERE id = 1;
END;
CREATE TRIGGER catchmind_roster_delete_version AFTER DELETE ON users
WHEN OLD.active = 1 AND OLD.role = 'player'
BEGIN
  UPDATE catchmind_turn SET version = version + 1 WHERE id = 1;
END;
