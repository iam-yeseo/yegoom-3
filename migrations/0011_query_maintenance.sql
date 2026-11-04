-- Bound housekeeping scans and exclude completed prediction history from polls.
CREATE INDEX login_attempts_expiry_idx ON login_attempts(expires_at);
CREATE INDEX catchmind_requests_retention_idx ON catchmind_requests(created_at)
  WHERE action != 'guess';
CREATE INDEX game_rounds_unsettled_idx ON game_rounds(round_date, game_id, reveal_at, revealed_at)
  WHERE settled_at IS NULL AND answer IS NOT NULL;
-- Existing (draw_date, settled_at) also scans every old settled draw before today.
CREATE INDEX lotto_tickets_due_idx ON lotto_tickets(draw_date)
  WHERE settled_at IS NULL;
