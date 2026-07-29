UPDATE keeper_events
SET target_block = (payload ->> 'batchTargetBlock')::bigint
WHERE target_block IS NULL
  AND payload ->> 'batchTargetBlock' ~ '^(?:0|[1-9][0-9]*)$';
