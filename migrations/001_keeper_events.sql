CREATE TABLE keeper_runs (
  run_id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL,
  stopped_at timestamptz,
  service text NOT NULL DEFAULT 'keeper',
  git_sha text,
  instance_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE keeper_events (
  event_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES keeper_runs(run_id),
  occurred_at timestamptz NOT NULL,
  level text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event_name text NOT NULL,
  block_number bigint,
  target_block bigint,
  transaction_hash text,
  job_kind text,
  payload jsonb NOT NULL
);

CREATE INDEX keeper_events_occurred_at_idx
  ON keeper_events (occurred_at DESC);

CREATE INDEX keeper_events_name_time_idx
  ON keeper_events (event_name, occurred_at DESC);

CREATE INDEX keeper_events_block_idx
  ON keeper_events (block_number)
  WHERE block_number IS NOT NULL;

CREATE INDEX keeper_events_target_block_idx
  ON keeper_events (target_block)
  WHERE target_block IS NOT NULL;

CREATE INDEX keeper_events_transaction_hash_idx
  ON keeper_events (transaction_hash)
  WHERE transaction_hash IS NOT NULL;
