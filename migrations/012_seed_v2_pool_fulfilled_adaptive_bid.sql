-- Seed the independent V2 fulfilled-lifecycle auction from five repeated,
-- counterfactually profitable losses at blocks 25659194, 25663722, 25663762,
-- 25663803, and 25669419. Exact receipts and trace_transaction proved each
-- winner was a zero-value, pool-only sync wrapper: all logs came from this
-- pool, the pool's ETH reward exactly matched CrankBountyPaid, and the cranker
-- had no other value inflow or reward-producing call. The latest clearing
-- requirement was 3631 bps, so 3632 bps is the one-bps recovery boundary.
INSERT INTO adaptive_bid_state (
  scope,
  target_address,
  current_bid_bps,
  consecutive_full_wins,
  consecutive_contradicting_wins,
  last_observed_winning_bid_bps,
  last_observed_winning_block,
  lowest_winning_bid_bps,
  highest_losing_bid_bps,
  highest_losing_bid_block,
  active_probe_bid_bps,
  last_updated_block,
  updated_at
)
VALUES (
  'v2_pool_fulfilled',
  '0x03c45c9c594b19ca5fde54f38c7e6b6a5f2329d7',
  3632,
  0,
  0,
  3631,
  25669419,
  NULL,
  301,
  25669419,
  NULL,
  25669419,
  now()
)
ON CONFLICT (scope, target_address) DO NOTHING;
