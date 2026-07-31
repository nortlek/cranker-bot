WITH profitable_evidence AS (
  SELECT
    lower(payload ->> 'pool') AS target_address,
    (payload ->> 'requiredBidBpsAgainstPlannedGross')::integer
      AS required_bid_bps,
    COALESCE(
      target_block,
      (payload ->> 'targetBlock')::bigint
    ) AS observed_block
  FROM keeper_events
  WHERE event_name = 'pool_competitor_bid_observed'
    AND payload ->> 'poolVersion' = 'v2'
    AND payload ->> 'counterfactualProfitable' = 'true'
    AND payload ->> 'pool' ~ '^0x[0-9A-Fa-f]{40}$'
    AND payload ->> 'requiredBidBpsAgainstPlannedGross'
      ~ '^(?:0|[1-9][0-9]{0,4})$'
),
best_evidence AS (
  SELECT DISTINCT ON (target_address)
    target_address,
    LEAST(10000, required_bid_bps) AS observed_bid_bps,
    LEAST(10000, required_bid_bps + 1) AS next_bid_bps,
    observed_block
  FROM profitable_evidence
  WHERE required_bid_bps <= 10000
  ORDER BY
    target_address,
    required_bid_bps DESC,
    observed_block DESC NULLS LAST
)
INSERT INTO adaptive_bid_state (
  scope,
  target_address,
  current_bid_bps,
  consecutive_full_wins,
  consecutive_contradicting_wins,
  last_observed_winning_bid_bps,
  last_observed_winning_block,
  highest_losing_bid_bps,
  highest_losing_bid_block,
  last_updated_block,
  updated_at
)
SELECT
  'v2_pool_pull',
  target_address,
  next_bid_bps,
  0,
  0,
  observed_bid_bps,
  observed_block,
  1000,
  observed_block,
  observed_block,
  now()
FROM best_evidence
ON CONFLICT (scope, target_address) DO UPDATE
SET
  current_bid_bps = GREATEST(
    adaptive_bid_state.current_bid_bps,
    EXCLUDED.current_bid_bps
  ),
  last_observed_winning_bid_bps = GREATEST(
    COALESCE(
      adaptive_bid_state.last_observed_winning_bid_bps,
      0
    ),
    EXCLUDED.last_observed_winning_bid_bps
  ),
  last_observed_winning_block = EXCLUDED.last_observed_winning_block,
  last_updated_block = EXCLUDED.last_updated_block,
  updated_at = now();
