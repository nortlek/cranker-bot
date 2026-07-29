CREATE TABLE adaptive_bid_state (
  scope text NOT NULL,
  target_address text NOT NULL,
  current_bid_bps integer NOT NULL
    CHECK (current_bid_bps BETWEEN 0 AND 10000),
  consecutive_full_wins integer NOT NULL DEFAULT 0
    CHECK (consecutive_full_wins >= 0),
  last_observed_winning_bid_bps integer
    CHECK (
      last_observed_winning_bid_bps IS NULL OR
      last_observed_winning_bid_bps >= 0
    ),
  last_updated_block bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, target_address)
);

CREATE INDEX adaptive_bid_state_updated_at_idx
  ON adaptive_bid_state (updated_at DESC);
