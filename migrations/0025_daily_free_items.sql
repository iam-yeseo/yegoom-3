-- 매일 무료 아이템 (2026-11-07 업데이트): each KST day a player may use three free
-- lotto tickets, speetto tickets, slot spins and nickname tag draws. A free use
-- is an ordinary purchase row marked free (no gold or ticket debit); counting
-- today's marked rows gives what is left, so nothing is granted or expired.
ALTER TABLE shop_purchases ADD COLUMN free INTEGER NOT NULL DEFAULT 0 CHECK (free IN (0, 1));
ALTER TABLE slot_spins ADD COLUMN free INTEGER NOT NULL DEFAULT 0 CHECK (free IN (0, 1));
-- nickname_tags.payment has no CHECK; a free draw stores payment 'free'.
-- Counting today's free uses touches only free rows (partial indexes), so a
-- player with many paid spins or purchases today costs no extra reads.
CREATE INDEX shop_purchases_free_idx ON shop_purchases(user_id, kind, date) WHERE free = 1;
CREATE INDEX slot_spins_free_idx ON slot_spins(user_id, date) WHERE free = 1;
CREATE INDEX nickname_tags_free_idx ON nickname_tags(user_id, date) WHERE payment = 'free';
