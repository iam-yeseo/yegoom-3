-- Additive only: nickname tag draw tickets get their own append-only ledger, so
-- inventory_ledger's CHECK list and older Workers stay valid.
CREATE TABLE tag_ticket_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL CHECK (amount != 0),
  reason TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX tag_ticket_user_idx ON tag_ticket_ledger(user_id);
CREATE TRIGGER tag_ticket_no_update BEFORE UPDATE ON tag_ticket_ledger
BEGIN SELECT RAISE(ABORT, 'tag ticket ledger is append-only'); END;
CREATE TRIGGER tag_ticket_no_delete BEFORE DELETE ON tag_ticket_ledger
BEGIN SELECT RAISE(ABORT, 'tag ticket ledger is append-only'); END;

-- The cached balance follows the same trigger pattern as gold and shop tickets.
ALTER TABLE user_balances ADD COLUMN tag_tickets INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER tag_ticket_update_balance AFTER INSERT ON tag_ticket_ledger
BEGIN
  INSERT INTO user_balances (user_id, tag_tickets) VALUES (NEW.user_id, NEW.amount)
  ON CONFLICT(user_id) DO UPDATE SET tag_tickets = user_balances.tag_tickets + excluded.tag_tickets;
END;

-- A draw now records how it was paid for. Every existing tag was bought with gold.
ALTER TABLE nickname_tags ADD COLUMN payment TEXT NOT NULL DEFAULT 'gold';

-- One-off grant: NICKNAME_TAG_RULES.welcomeTickets (5) draw tickets per active
-- player. The fixed reference is UNIQUE, so a re-run grants nothing twice.
INSERT OR IGNORE INTO tag_ticket_ledger (id, user_id, amount, reason, reference, created_at)
SELECT 'tag-welcome-' || id, id, 5, '별명 뽑기권 지급', 'tag:grant:welcome:' || id, '2026-11-05T00:00:00.000Z'
FROM users WHERE role = 'player' AND active = 1;
