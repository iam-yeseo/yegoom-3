-- 별명 태그 버리기 (2026-11-07 업데이트): a drawn tag can be thrown away so it never
-- joins the collection. The row stays (it still counts toward the daily draw
-- limit and the draw history), marked as discarded.
ALTER TABLE nickname_tags ADD COLUMN discarded INTEGER NOT NULL DEFAULT 0 CHECK (discarded IN (0, 1));
