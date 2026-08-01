-- Block 25656702 attributed the seven-transaction bundle's aggregate 5641
-- bps bid to every order. The lost 0x2053 transaction actually expressed
-- about 9050 bps from its own simulated gas and reward, above the measured
-- 7834 bps competitor package. Restore only the bracket fields that the false
-- price-loss classification changed; retain the observation and append-only
-- event history.
UPDATE adaptive_bid_state
SET
  current_bid_bps = 3119,
  highest_losing_bid_bps = 2921,
  highest_losing_bid_block = 25656120,
  updated_at = now()
WHERE scope = 'standing_order'
  AND target_address = '0x20537147391a1c6dee78b1597e9abf749e761162'
  AND current_bid_bps = 7859
  AND highest_losing_bid_bps = 5641
  AND highest_losing_bid_block = 25656702
  AND last_observed_winning_bid_bps = 7834
  AND last_observed_winning_block = 25656702;
