-- Additive: seek through finished rounds without scanning active or older rounds.
CREATE INDEX catchmind_rounds_status_number_idx ON catchmind_rounds(status, number);
