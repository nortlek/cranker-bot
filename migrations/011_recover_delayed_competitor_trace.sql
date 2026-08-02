-- At block 25668116 these three standing orders lost at an effective 2833
-- bps to separate 5676 bps direct-payment competitors. The retired explorer
-- trace path was still unindexed after its bounded retries, so the controller
-- held instead of consuming the exact profitable evidence. Reproduce the
-- controller's normal 25 bps clearing-price step only when each row is still
-- in the precise post-miss state; any later learning makes this repair a no-op.
UPDATE adaptive_bid_state
SET
  current_bid_bps = 5701,
  consecutive_full_wins = 0,
  consecutive_contradicting_wins = 0,
  last_observed_winning_bid_bps = 5676,
  last_observed_winning_block = 25668116,
  lowest_winning_bid_bps = NULL,
  highest_losing_bid_bps = 2833,
  highest_losing_bid_block = 25668116,
  active_probe_bid_bps = NULL,
  last_updated_block = 25668116,
  updated_at = now()
WHERE scope = 'standing_order'
  AND target_address IN (
    '0x006695b8f7a852ced9e427b85b9c0eb1e93d19c1',
    '0x1f6102ff653e9468177516da010bcd6b2762685b',
    '0xf911ed4ae6b6dc2addca22da15b954d5fdc90f94'
  )
  AND current_bid_bps = 2832
  AND consecutive_full_wins = 0
  AND consecutive_contradicting_wins = 0
  AND last_observed_winning_bid_bps = 2807
  AND last_observed_winning_block = 25667963
  AND lowest_winning_bid_bps IS NULL
  AND highest_losing_bid_bps IN (1092, 1613)
  AND highest_losing_bid_block = 25667963
  AND active_probe_bid_bps IS NULL
  AND last_updated_block = 25668116;
