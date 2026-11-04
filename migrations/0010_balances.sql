-- Derived balances stay in the same transaction as their append-only source rows.
-- Existing deployments may continue writing the original ledger column lists.
CREATE TABLE user_balances (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  gold INTEGER NOT NULL DEFAULT 0,
  lotto_tickets INTEGER NOT NULL DEFAULT 0,
  speetto_tickets INTEGER NOT NULL DEFAULT 0
);

INSERT INTO user_balances (user_id, gold, lotto_tickets, speetto_tickets)
SELECT u.id,
  COALESCE(g.gold, 0), COALESCE(i.lotto_tickets, 0), COALESCE(i.speetto_tickets, 0)
FROM users u
LEFT JOIN (
  SELECT user_id, SUM(amount) AS gold FROM ledger WHERE currency = 'gold' GROUP BY user_id
) g ON g.user_id = u.id
LEFT JOIN (
  SELECT user_id,
    SUM(CASE WHEN item = 'lotto_ticket' THEN amount ELSE 0 END) AS lotto_tickets,
    SUM(CASE WHEN item = 'speetto_ticket' THEN amount ELSE 0 END) AS speetto_tickets
  FROM inventory_ledger GROUP BY user_id
) i ON i.user_id = u.id;

CREATE TRIGGER ledger_update_balance AFTER INSERT ON ledger
WHEN NEW.currency = 'gold'
BEGIN
  INSERT INTO user_balances (user_id, gold) VALUES (NEW.user_id, NEW.amount)
  ON CONFLICT(user_id) DO UPDATE SET gold = user_balances.gold + excluded.gold;
END;

CREATE TRIGGER inventory_update_balance AFTER INSERT ON inventory_ledger
BEGIN
  INSERT INTO user_balances (user_id, lotto_tickets, speetto_tickets)
  VALUES (NEW.user_id,
    CASE WHEN NEW.item = 'lotto_ticket' THEN NEW.amount ELSE 0 END,
    CASE WHEN NEW.item = 'speetto_ticket' THEN NEW.amount ELSE 0 END)
  ON CONFLICT(user_id) DO UPDATE SET
    lotto_tickets = user_balances.lotto_tickets + excluded.lotto_tickets,
    speetto_tickets = user_balances.speetto_tickets + excluded.speetto_tickets;
END;
