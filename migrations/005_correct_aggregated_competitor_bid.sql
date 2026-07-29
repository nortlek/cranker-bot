UPDATE adaptive_bid_state
SET
  current_bid_bps = 7703,
  last_observed_winning_bid_bps = 7678,
  updated_at = now()
WHERE scope = 'standing_order'
  AND target_address = '0x32406b31cde54c713894aa8da4e2d89953c7477a'
  AND current_bid_bps = 9900
  AND last_observed_winning_bid_bps = 15356
  AND last_observed_winning_block = 25639742;
