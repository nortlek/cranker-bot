ALTER TABLE adaptive_bid_state
  ADD COLUMN lowest_winning_bid_bps integer
    CHECK (
      lowest_winning_bid_bps IS NULL OR
      lowest_winning_bid_bps BETWEEN 0 AND 10000
    ),
  ADD COLUMN highest_losing_bid_bps integer
    CHECK (
      highest_losing_bid_bps IS NULL OR
      highest_losing_bid_bps BETWEEN 0 AND 10000
    ),
  ADD COLUMN last_observed_winning_block bigint,
  ADD COLUMN highest_losing_bid_block bigint,
  ADD COLUMN active_probe_bid_bps integer
    CHECK (
      active_probe_bid_bps IS NULL OR
      active_probe_bid_bps BETWEEN 0 AND 10000
    );
