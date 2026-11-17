-- Additive only (작업 9). The inventory lists the tags a player still owns;
-- discarded ones (thrown away, or spent as evolution material) stay in the table
-- for the daily draw count and for replaying a draw's receipt. This index holds
-- only owned tags, so the list no longer reads every tag the player ever drew.
CREATE INDEX nickname_tags_owned_idx ON nickname_tags(user_id) WHERE discarded = 0;
