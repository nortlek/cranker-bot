-- The standing-order lane now starts at 10% and relearns only from new exact
-- target-specific outcomes. Append-only keeper_events retains the historical
-- bid evidence for analysis; other adaptive scopes are deliberately untouched.
UPDATE adaptive_bid_state
SET
  current_bid_bps = 1000,
  consecutive_full_wins = 0,
  consecutive_contradicting_wins = 0,
  last_observed_winning_bid_bps = NULL,
  last_observed_winning_block = NULL,
  lowest_winning_bid_bps = NULL,
  highest_losing_bid_bps = NULL,
  highest_losing_bid_block = NULL,
  active_probe_bid_bps = NULL,
  last_updated_block = NULL,
  updated_at = now()
WHERE scope = 'standing_order';
