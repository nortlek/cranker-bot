ALTER TABLE adaptive_bid_state
  ADD COLUMN consecutive_contradicting_wins integer NOT NULL DEFAULT 0
    CHECK (consecutive_contradicting_wins >= 0);
