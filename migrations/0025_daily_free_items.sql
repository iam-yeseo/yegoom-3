-- 매일 무료 아이템 (2026-11-07 업데이트): each KST day a player may use three free
-- lotto tickets, speetto tickets, slot spins and nickname tag draws. A free use
-- is an ordinary purchase row marked free (no gold or ticket debit); counting
-- today's marked rows gives what is left, so nothing is granted or expired.
ALTER TABLE shop_purchases ADD COLUMN free INTEGER NOT NULL DEFAULT 0 CHECK (free IN (0, 1));
ALTER TABLE slot_spins ADD COLUMN free INTEGER NOT NULL DEFAULT 0 CHECK (free IN (0, 1));
-- nickname_tags.payment has no CHECK; a free draw stores payment 'free'.
