-- At block 25665769 the standing-order target below lost at an effective
-- 1461 bps to a measured 1547 bps competitor. Its 0.1 gwei minimum priority
-- fee made the controller's requested increase from 1000 to 1111 bps
-- economically inert. Move only that exact unchanged state across the
-- observed clearing price plus the configured 25 bps loss step. If the row
-- has learned from any later outcome, this guarded repair deliberately does
-- nothing.
UPDATE adaptive_bid_state
SET
  current_bid_bps = 1572,
  updated_at = now()
WHERE scope = 'standing_order'
  AND target_address = '0x1a22fcc7b55a6c5e72c8f53f513fb121ec4e05b1'
  AND current_bid_bps = 1111
  AND last_observed_winning_bid_bps = 1547
  AND last_observed_winning_block = 25665769
  AND highest_losing_bid_bps = 1461
  AND highest_losing_bid_block = 25665769;
