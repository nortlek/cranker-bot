# Agent Operating Guide

This is the operational runbook for `pull-pool-keeper`. Read it before changing,
deploying, or operating the bot. The changing strategy and research queue lives
in [OPPORTUNITIES.md](./OPPORTUNITIES.md); update that file when an opportunity
is discovered, rejected, implemented, or needs another investigation.

## Mission and operating posture

The bot competes for permissionless Ethereum mainnet keeper rewards and submits
only transactions or atomic transaction sequences that are expected to remain
profitable after gas and builder payments.

The initial goal of **$10 verified net realized profit by
2026-07-29 23:59 America/Denver** was achieved at `$11.35632645` on
2026-07-28 America/Denver. The subsequent **$50 cumulative verified net
realized profit by 2026-07-30 23:59 America/Denver** stretch goal was achieved
at `$51.29412534` on 2026-07-28 America/Denver, measured from the same original
baseline and fully net of gas, builder payments, and other fees. The active
stretch goal of **$250 cumulative verified net realized profit by
2026-07-30 23:59 America/Denver** was achieved at `$253.73988689` on
2026-07-30 America/Denver. The completion snapshot had
`latest == pending == 722`, net ETH equivalent of
`0.131936983292652418`, and a fresh `$1,923.19` ETH/USD oracle. PostgreSQL
receipts and the wallet delta agreed exactly. No subsequent profit target has
been set. Continue to protect and reconcile realized profit; a goal is not
permission to expand custody, approval, or contract risk. Never claim progress
from a log estimate alone: reconcile wallet balances and successful receipts.

The production signer runs on Railway. Do not run a second live signer locally.
Local runs must be `DRY_RUN=true`, preferably `RUN_ONCE=true`.

## Start here

Requirements:

- Node.js 22 or newer
- Railway CLI authenticated to the user's account
- `gh` authenticated when pushing or inspecting GitHub
- A local `.env` for read-only RPC access; never print or commit it

Install and validate:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run inspect
```

Run one local read-only planning pass:

```bash
DRY_RUN=true RUN_ONCE=true DATABASE_URL= DISCORD_WEBHOOK_URL= PRIVATE_KEY= \
  node --env-file-if-exists=.env --import tsx src/main.ts
```

This explicit command prevents a value in `.env` from accidentally enabling
live signing, database writes, or routine Discord notifications.

Check the realized-profit goal:

```bash
npx tsx scripts/goal-status.ts
```

The status script includes the keeper's ETH, WETH, DAI, DOLA, CRV, and CVX
balances, uses on-chain price feeds, compares them with the recorded baseline,
and checks both `latest` and `pending` account nonces. DOLA is counted only
when its Chainlink round is complete and fresh, is capped at one USD, and uses
the configured FiRM reward haircut.

## Production topology

GitHub repository:

```text
https://github.com/nortlek/cranker-bot
```

Railway uses a dedicated project:

| Resource | Name | ID |
| --- | --- | --- |
| Project | `cranker-bot` | `5e3c3c6e-e814-4321-8ab1-020e8e3cc193` |
| Environment | `production` | `82c03e0a-86ba-4779-9781-d74f9d0f5281` |
| Worker service | `cranker-bot` | `b7254641-a937-4399-ae2d-75fc95c08049` |
| PostgreSQL service | `Postgres` | `d4826fd8-e203-40da-8dd5-5733a8750f31` |

The checkout is linked to this project. Confirm before doing anything:

```bash
railway status
```

`railway.toml` runs migrations before deployment, overlaps replacement
containers for 60 seconds, allows 15 seconds of draining, and restarts on
failure. The replacement completes read-only initialization with pending-event
execution disarmed, then waits for the PostgreSQL advisory signer lease. Only
the lease holder arms execution and begins keeper passes. Failure to acquire
the lease is fail-closed. The worker verifies the exact lock before each live
pass and immediately before submission; a lost lease stops the signer. Live
mode requires `DATABASE_URL`. Telemetry after startup is fail-open.

`WS_URL`, when configured, supplies the production raw `newHeads` wake-up.
The keeper validates and retains the notification's block number, hash,
timestamp, base fee, gas used, and gas limit and starts planning from that
header without viem's implicit `eth_getBlockByNumber` or a duplicate HTTP
block fetch. For private bundles targeting the immediate child, derive that
child's exact EIP-1559 base fee from the complete parent header; do not use the
worst-case 12.5% envelope or call a provider fee estimator that implicitly
fetches another `"latest"` block.
The same WebSocket client that announces a head is authoritative for
latency-sensitive foreground contract state, simulations, nonce, and balance
gates; every state read is pinned to the subscribed block number. This avoids
cross-backend publication skew without substituting a later `"latest"` state
or maintaining an HTTP planning fallback. `RPC_URL` remains the startup,
post-block competitor/relay-observation, and subscription-liveness client,
while `DISCOVERY_RPC_URL` remains the bulk/background client. Before the first
subscribed head at process startup, the initial pass obtains its complete
header over RPC and reads its exact state through the configured foreground
client. HTTP asserts subscription liveness after
`HEAD_STALE_TIMEOUT_MS`; if the chain advanced without a subscribed head, the
worker exits for a supervised restart instead of silently degrading to a
second head path. Exact fixed-block state reads tolerate up to one second of
publication skew by retrying only classified `BlockNotFound`, the observed
provider `-32602` fresh-state messages, and viem's typed
`InvalidInputRpcError[-32000]`; raw or untyped `-32000` errors and all other
classes remain immediate failures. The subscribed head is also the
authoritative private-submission deadline. The final exact-parent nonce and
balance gate races arrival of the target head, so a stalled or lagging RPC
response cannot authorize a stale bundle. Do not reintroduce a duplicate HTTP
head/nonce gate inside the private sender: the strategy account gate and final
target-bound gate already enforce `latest == pending`, balance, and signer
lease safety. The same WebSocket signal wakes target-block receipt
finalization, after which the foreground exact-state client must serve that
exact target block before receipts are classified. A target block can be
available slightly before its receipt index; only viem's typed
`TransactionReceiptNotFoundError` receives a bounded one-second publication
wait. Other receipt errors remain terminal. Successful waits emit
`keeper_receipt_availability_waited` before the authoritative
`keeper_receipt`; this prevents false expiration, incomplete batch P&L, and
incorrect loss-learning without waiting for another block. Never print either
endpoint.

When `ENABLE_PENDING_FUNDING_BACKRUNS=true`, the worker opens a second,
hash-only Alchemy filtered subscription on the same `WS_URL` for current
canonical order/vault recipients and the PullPool. It reconnects through that
same mechanism and has no polling or unfiltered alternative. Exact raw
transactions are fetched through `DISCOVERY_RPC_URL`; never log either the raw
bytes or either endpoint.

Pending delivery telemetry distinguishes provider visibility from local
resolution latency:

- `pending_funding_subscription_ready` identifies each connection generation
  and its target count.
- `pending_funding_hash_observed` records immediate hash delivery and queue
  depth.
- `pending_funding_candidate_validated` records a still-pending exact
  prerequisite.
- `pending_funding_candidate_late` records a candidate that resolved only
  after mining, including block, raw availability, and bounded timing.
- resolution failures use a fixed reason plus a secret-free nested error
  fingerprint. They never persist raw provider messages, RPC URLs, bodies, or
  transaction bytes.

The FWA fulfillment lane uses a separate coordinator-filtered, hash-only
subscription and bounded concurrent resolution so unrelated coordinator
traffic cannot delay order-funding candidates. Its
`pending_fwa_candidate_validated` event proves the raw hash, recovered sender,
canonical coordinator, FWA consumer/subscription, and proof-derived request ID
matched the current pool lifecycle. `pending_fwa_backrun_submitted` is always
the bounded exact contiguous coordinator nonce prefix ending in the target
fulfillment, followed either by keeper sync and settle or by the exact
parent-queue-count processor, sync, and settle. Both complete alternatives are
simulated and the highest-profit valid one is selected; only its two or three
keeper receipts enter P&L.

GitHub-source automatic deployment is not yet connected because Railway's web
UI still needs an authenticated browser session. Until that is completed,
deploy the exact local committed source with the Railway CLI.

Production submits private bundles through six paths: Flashbots, Quasar,
direct Titan, direct Beaver, direct Eureka, and direct BuilderNet. Flashbots
also multiplexes to the configured builder list, including the registered
`bobthebuilder`, `Bombora`, and `Eureka` routes. Direct Eureka was added after
another exact lifecycle bundle missed in an otherwise non-conflicting Eureka
block despite multiplexing; direct BuilderNet covers the same delivery risk
for BuilderNet blocks. Do not remove the direct paths without evidence:
after they were added, the keeper won consecutive round-171 and round-172
ready-cycle bundles in Titan-built blocks.

## Reading production logs

Fetch structured logs for the worker:

```bash
railway logs \
  --service b7254641-a937-4399-ae2d-75fc95c08049 \
  --environment production \
  --since 30m \
  --json
```

Run Railway CLI commands serially. Concurrent CLI processes can race the local
OAuth refresh/config rewrite: on 2026-07-31 two simultaneous read-only commands
briefly reported a missing refresh token and regenerated `~/.railway/config.json`.
The next serialized `railway status` recovered without production impact.
Parallelize RPC inspection and local analysis instead, but do not invoke two
Railway CLI commands at once.

Important: application fields are at the root of each JSON object. `.message`
is often blank. Filter on `.event`, not `.message`.

Transactions, opportunities, bids, acquisition state, and competitor results:

```bash
railway logs \
  --service b7254641-a937-4399-ae2d-75fc95c08049 \
  --environment production \
  --since 30m \
  --json |
jq -c 'select(
  .event == "keeper_opportunity" or
  .event == "builder_bid" or
  .event == "keeper_batch_submitted" or
  .event == "keeper_batch_result" or
  .event == "keeper_transaction_sent" or
  .event == "keeper_receipt" or
  .event == "keeper_transaction_expired" or
  .event == "pending_funding_backrun_opportunity" or
  .event == "pending_funding_backrun_submitted" or
  .event == "pending_funding_backrun_complete" or
  .event == "pending_pool_pull_opportunity" or
  .event == "pending_pool_pull_submitted" or
  .event == "pending_pool_pull_backrun_complete" or
  .event == "pending_fwa_backrun_opportunity" or
  .event == "pending_fwa_backrun_submitted" or
  .event == "pending_fwa_backrun_complete" or
  .event == "acquisition_status" or
  .event == "competitor_bid_observed" or
  .event == "pool_competitor_bid_observed" or
  .event == "pool_lifecycle_competitor_bid_observed" or
  .event == "pool_lifecycle_bid_observation" or
  .event == "pool_pull_bid_observation"
)'
```

Process health:

```bash
railway logs \
  --service b7254641-a937-4399-ae2d-75fc95c08049 \
  --environment production \
  --since 30m \
  --json |
jq -c 'select(
  .event == "keeper_started" or
  .event == "pass_complete" or
  .event == "keeper_pass_failed" or
  .event == "signer_lease_waiting" or
  .event == "signer_lease_acquired" or
  .event == "fatal"
)' |
tail -n 100
```

Correlated latency and relay delivery:

```bash
railway logs \
  --service b7254641-a937-4399-ae2d-75fc95c08049 \
  --environment production \
  --since 30m \
  --json |
jq -c 'select(
  .event == "keeper_pass_stage_timing" or
  .event == "keeper_planner_timing" or
  .event == "keeper_pass_timing" or
  .event == "bundle_stage_timing" or
  .event == "bundle_simulation_state_availability_waited" or
  .event == "private_target_block_delivery" or
  .event == "keeper_receipt_availability_waited" or
  .event == "relay_submission_result" or
  .event == "convex_candidate_cache_refreshed" or
  .event == "convex_candidate_cache_refresh_failed"
)'
```

Every event emitted inside a keeper pass includes the same `passId` and
`observedBlock`. Relay events use a numeric alias and categorized error, never
the potentially credential-bearing URL.

`private_target_block_delivery` records the exact target block hash, fee
recipient, extra data, and aggregate inclusion outcome after receipt
classification. Correlate it with the pass's numeric relay acceptance events
to distinguish price competition from a builder-reach, timing, or block
construction miss without another historical block lookup.

`keeper_pass_failed` also retains the attempted block, pass ID, head source,
and a secret-free error-name/code chain after leaving the pass context. Use
those fields to correlate the preceding stage timings in PostgreSQL before
changing retry behavior. The fingerprint deliberately excludes URLs, request
bodies, and provider metadata.

Named acquisition events have the form
`acquisition_status_<status-name>`. The general `acquisition_status` event also
contains the numeric status, named label, lifecycle round, and relevant FWA
state.

Multi-transaction private bundles retain one durable
`keeper_transaction_sent`, `keeper_receipt`, or `keeper_transaction_expired`
event per member, but Discord suppresses the intermediate submission and
member embeds and sends one aggregate `keeper_batch_result` embed. Evaluate
the batch's
`totalReward`, `totalGasCost`, and `realizedProfit`; individual members can
have negative receipt-level attribution because all members share one
gas-normalized priority fee.

`keeper_batch_result.realizedProfit` is a presentation aggregate of the
member `keeper_receipt.realizedProfit` values. For SQL P&L totals, sum either
member receipts or batch results for grouped batches, never both.

Never run `railway variables` without a narrow JSON filter. Its unfiltered
output contains secrets.

## Durable event and bid history

Production PostgreSQL stores:

- `keeper_runs`: one row per process lifetime
- `keeper_events`: append-only structured logs, indexed by time, event, block,
  target block, transaction hash, and job kind
- `adaptive_bid_state`: durable per-scope/per-target bidding state

After an ordinary PoolPull miss, `pool_competitor_bid_observed` stores the
winning transaction, round, cranker, gross pool bounty, priority payment,
direct beneficiary payment, and a pool-reward-normalized bid upper bound.
The observed `Pulled` event must match an exact missed round ID; V2 can have
concurrent rounds, so a pull for another round is neither a competitor win nor
bid evidence for the attempted round.
`pool_pull_bid_observation` distinguishes a target-block competitor win from a
miss with no competing pull. V1 observations remain record-only. Exact,
counterfactually profitable V2 evidence updates the independent durable
`v2_pool_pull` controller and must never update the standing-order controller.
`v2_pool_pull_adaptive_bid_adjusted` records every held, increased, or decreased
V2 target.

The competitor-normalized upper bound is not directly comparable with our
configured percentage when its realized gas reimbursement differs from our
simulated reimbursement. New observations therefore also retain our planned
gross reward and builder payment, the absolute payment required to exceed the
competitor, its percentage against our planned gross, the incremental payment,
and the exact counterfactual retained profit. Use
`requiredBidBpsAgainstPlannedGross` and `counterfactualProfitable` for bid
decisions; do not compare `winningBidBpsUpperBound` with the configured bid in
isolation.

Competitor direct-beneficiary payments come from the discovery RPC's exact
`trace_transaction` result. This avoids delayed explorer indexing on the hot
post-block learning path; a trace failure is held rather than interpreted as a
zero payment. Keep `DISCOVERY_RPC_URL` on a provider that supports the Parity
trace method, and do not restore the retired asynchronous trace-indexer path.

After a missed pool sync or settlement,
`pool_lifecycle_competitor_bid_observed` aggregates every
`CrankBountyPaid` event for the lost round and winning transaction, then stores
the same payment fields and a pool-reward-normalized upper bound. V1 and
ambiguous wrapper observations remain record-only. A pure V2 fulfilled
lifecycle observation may update the independent durable
`v2_pool_fulfilled` controller only when the exact receipt and trace prove all
logs came from the pool, every direct cranker call was same-round lifecycle or
beneficiary-payment scaffolding, the pool-to-cranker ETH inflow exactly matched
the emitted bounty, no other positive cranker inflow existed, and beating the
payment remained counterfactually profitable. Only our own pure, single-round
`pool_fulfilled` outcomes feed wins or losses to this scope; ready processor
chains and settle-only cleanup retain the independent low pool bid.
`v2_pool_fulfilled_adaptive_bid_adjusted` records every held, increased, or
decreased V2 fulfilled target.
`pool_lifecycle_bid_observation` distinguishes a competitor win from a miss
with no competing lifecycle transaction in that target block.

Connect without exposing a connection string:

```bash
railway connect Postgres --environment production
```

Useful SQL:

```sql
SELECT
  occurred_at,
  event_name,
  level,
  job_kind,
  transaction_hash,
  payload
FROM keeper_events
WHERE event_name NOT IN ('new_block', 'pass_complete')
ORDER BY occurred_at DESC
LIMIT 100;
```

```sql
SELECT *
FROM adaptive_bid_state
ORDER BY updated_at DESC;
```

For a particular transaction or target block:

```sql
SELECT occurred_at, event_name, payload
FROM keeper_events
WHERE transaction_hash = '0x...'
   OR target_block = 12345678
ORDER BY occurred_at;
```

Migrations are ordered in `migrations/`. Production applies them through
`npm run db:migrate` as a Railway pre-deploy command. For a local development
database use `npm run db:migrate:dev`.

## Discord updates

There are three separate Discord channels:

- `DISCORD_WEBHOOK_URL`: automatic rich embeds from the running bot for
  terminal outcomes such as confirmations, expirations, competitor wins,
  realized P&L changes, and actionable failures. Intermediate planning and
  submission events remain in structured telemetry but are not posted.
- `HOURLY_STATS_DISCORD_WEBHOOK_URL`: top-of-hour rolling 1h/24h receipt P&L,
  transaction outcomes, gas/reward, supported account balance, lane, and
  health stats. It is armed only by the live signer lease holder, queries
  durable PostgreSQL telemetry, and fails open without affecting signing.
- `CODEX_UPDATES_WEBHOOK`: short manual updates from an agent.

Send an agent update with:

```bash
npm run codex:update -- 'Investigation complete.'
```

Always single-quote the message to prevent shell interpolation. The script also
accepts stdin, splits messages at Discord's 2,000-character limit, and disables
mentions.

Send a manual update only for:

- a meaningful strategy or architecture decision
- a newly validated opportunity
- a material realized-profit change
- a significant failure or production incident
- a question or request that needs the user

Do not send routine heartbeat noise. Never include secret URLs, private keys,
RPC credentials, database URLs, or raw environment values in an update.

## Monitoring and iteration loop

On each scheduled check-in (roughly every 30 minutes while actively operating)
or after a meaningful chain event:

1. Run `railway status`.
2. Run `npx tsx scripts/goal-status.ts`.
3. Require the account's `latest` nonce to equal `pending` before any
   deployment or live mutation.
4. Read at least the last 30 minutes of structured production logs.
5. Inspect the current PullPool/FWA state with read-only calls or
   `npm run inspect`.
6. Query PostgreSQL when console logs do not provide enough history.
7. For a missed bundle, inspect the winning transaction, receipt, relevant
   block transactions, and direct beneficiary payments before adjusting a bid.
8. Make only an evidence-backed code/config change. It is valid to make no
   change when the data does not justify one.
9. Run `npm run typecheck`, `npm test`, `npm run build`, and
   `git diff --check`.
10. Recheck the nonce gate and confirm there is no active lifecycle sequence
    that a rollout could disrupt.
11. Commit and push the intentional change.
12. Deploy the committed source with Railway.
13. Watch the deployment and startup logs. Confirm one signer lease, healthy
    passes, and no `fatal`/repeating pass failure.
14. Reconcile any realized P&L and send a meaningful Discord update when
    warranted.
15. Update [OPPORTUNITIES.md](./OPPORTUNITIES.md) with evidence and the next
    action.

Do not deploy on a timer merely to appear active. Monitor on the schedule;
deploy only when a tested improvement or necessary repair exists.

## Safe deployment workflow

Inspect the working tree first and preserve user changes:

```bash
git status --short
git diff
```

After validation, commit only the intended files and push `main` (the user has
authorized direct pushes for this bot):

```bash
git add <intentional-files>
git commit -m '<concise description>'
git push origin main
```

Railway CLI source uploads do not refresh the platform-provided
`RAILWAY_GIT_COMMIT_SHA`. Inject the exact committed revision without
triggering a separate variable-only deployment, then deploy that source:

```bash
keeper_source_sha="$(git rev-parse HEAD)"
railway variable set \
  "DEPLOY_GIT_SHA=$keeper_source_sha" \
  --skip-deploys \
  --service b7254641-a937-4399-ae2d-75fc95c08049 \
  --environment production
railway up --detach \
  --message "$keeper_source_sha" \
  --service b7254641-a937-4399-ae2d-75fc95c08049 \
  --environment production
```

Inspect deployment history:

```bash
railway deployment list \
  --service b7254641-a937-4399-ae2d-75fc95c08049 \
  --environment production \
  --json
```

Then inspect startup logs for:

- migrations completed
- `signer_initialization_ready` before the replacement requests the lease
- `signer_lease_waiting` followed by `signer_lease_acquired` during replacement
- exactly one live signer after the rollout
- `keeper_started`, with `sourceRevision` equal to the deployed commit and the
  expected `deploymentId`
- continuing `pass_complete`
- no `fatal`, repeated `keeper_pass_failed`, or telemetry queue growth

`railway setup agent -y` may appear as a CLI suggestion; it is not required for
deployment.

## Strategy invariants

These constraints prevent expensive or unsafe regressions:

- There are no unconditional raw `crank()` calls. Every standing order and
  vault must pass exact contract simulation, gas estimation, and economic
  checks.
- Before exact order simulation, authoritative exact-block Multicall3 reads may
  reject only impossible candidates: standing-order native balances below one
  open-round ticket plus the caller fee, or a compatible V1 candidate with
  `lastRoundBought >= roundCount`. A successor-aware V2 order may be rejected
  as already bought only when `lastPool` is the active pool and
  `lastRoundBought` equals the selected round; V1 round identifiers must not
  suppress V2 work. Never native-balance-filter a vault. A failed prefilter
  read must fall through to exact simulation rather than reject the candidate.
- `roundCount` identifies the funding round. `ethPendingRound` is the
  authoritative acquisition lifecycle pointer. Never collapse the two.
- A ready acquisition is built as
  `FWA.processAcquisitions(count) -> PullPool.syncFwaResult(round) ->
  PullPool.settle(round)`.
- The ready chain requires at least the processor plus sync prefix. Economic
  accounting may require the full processor/sync/settle prefix when earlier
  calls are not independently profitable.
- If the exact-simulated selected lifecycle contains `settle` or
  `settleForcedEth`, the relay submission floor must include that settlement.
  Do not let a builder choose a same-nonce processor/sync alternative and
  discard a profitable settlement. Optional jobs after settlement may still
  use the prefix ladder beginning at the settled lifecycle core.
- The ready processor uses `FWA_PROCESS_GAS_LIMIT` only as a protocol signing
  envelope. Do not charge that ceiling as consumed gas or add duplicate local
  processor simulation/estimation to the hot path. Mandatory private prefix
  simulation must prove processor compatibility with sync, return actual gas
  for pricing, and the competitively priced signed bundle must simulate again
  before submission.
- A confirmed-head ready processor must call the pinned owner-bound FWA
  sequence executor, never FWA `processAcquisitions(maxCount)` directly. Bind
  both the exact parent `nextSequenceToProcess` and its expected post-pointer;
  if earlier target-block activity moves the FIFO, the whole private prefix
  must revert and retry from a fresh parent rather than process newer unpriced
  acquisitions. If the executor is absent, its pinned CREATE2 deployment,
  exact processor call, and sync are one mandatory private prefix.
- A fulfilled acquisition is normally `syncFwaResult(round) -> settle(round)`.
- Standing-order cranks and a pool `pull` may form a cross-subsidized sequence.
  If so, the minimum viable prefix must include every call needed for the
  aggregate profit. Never submit a subsidized crank by itself.
- A `pull` that is blocked until an earlier bundled funding transaction changes
  state has no artificial gas cutoff. Give it the largest Ethereum-valid
  envelope the signer can fund after prior reservations, defer its preliminary
  economics, and let exact signed-bundle simulation provide actual gas before
  bidding or submission.
- Explicit contiguous nonces are assigned only when `latest == pending`.
- A pending-funding backrun is always the exact two-transaction bundle
  `[public empty-calldata ETH transfer, keeper crank]`. Verify the raw hash,
  recovered sender, mainnet chain ID, supported legacy/2930/1559 type, sender
  nonce, positive value, canonical recipient, empty input, and pending status
  before signing. Simulate the full pair twice, price and account only the
  keeper crank, never submit a prerequisite-only prefix, suppress observed
  replacements, and reserve the signer target block against the normal loop.
  Record a bid loss only when the prerequisite landed and a competitor
  actually emitted `Cranked`. Keep this lane's static bid independent from
  confirmed-head standing-order adaptive state until it has enough live
  outcomes to justify its own durable policy.
- A pending final-ticket backrun is always the exact two-transaction bundle
  `[public buyTickets, keeper pull]`. In addition to the raw-transaction gates
  above, prove the canonical pool target and exact
  `buyTickets(uint256,uint32,address)` or
  `buyIntoCurrentRound(uint32,address)` calldata, bind an implicit purchase to
  the authoritative current round, require that round to remain open with no
  older lifecycle active, and let complete-pair simulation reject purchases
  that do not finish coverage. Revalidate the prerequisite immediately before
  private submission, price only the pull under the independent pool-pull bid,
  account only the pull receipt, and never submit the public purchase alone.
- GroupPull execution is limited to the pinned successor runtime at
  `0xd23DCbfD47E849DAC946689E264AaD3c6bbD4187` while its live `pool()` remains
  the canonical V2 pool. Confirmed-head planning may call only bounty-paying
  `close(round)`, `submit(round,maxPoolRounds)`, and
  `collect(round,maxPoolRounds)` variants that pass exact fixed-block
  estimation and retained-profit checks. The successor initializes its bounty
  shares only when a selling round closes; pre-close planning must derive the
  `1 + 2 * pullsPerRound` share count rather than require a stored nonzero
  value. `buyingRounds` counts both Buying and Collecting rounds. A pending GroupPull
  backrun is always the exact pair `[public enter, keeper submit]`: prove the
  raw signed mainnet transaction decodes to `enter(uint256,uint32,address)`,
  has the exact current-round payment, and makes the live selling round covered
  at the authoritative parent. Revalidate its raw bytes, pending status,
  replacement identity, runtime, pool relationship, signer nonce/balance,
  lease, and target deadline immediately before submission. Simulate the whole
  pair twice, price and account only the keeper `submit`, never offer the entry
  or a partial submit prefix, and keep its builder policy independent from
  standing orders and ordinary PullPool lifecycle work. When an exact V2 pool
  lifecycle settlement makes one of the GroupPull's underlying rounds
  collectable, append `collect` immediately after that settlement and extend
  the mandatory private prefix through it. Price only the one bounty share
  guaranteed by the bundled settlement; earlier ready shares are unpriced
  upside because a public transaction may take them before the bundle. Use a
  funded Ethereum-valid gas envelope, require complete signed-bundle
  simulation for actual gas and retained profit, and keep the collect bid
  independent from close/submit bidding.
- A pending GroupPull standing-order creation backrun is always the exact pair
  `[public factory createOrder, keeper order crank]`. Prove the signed raw
  mainnet transaction targets the pinned factory and decodes to
  `createOrder(uint32,uint96,uint64,address)` with positive value. Derive the
  new order address from the factory's exact parent-state CREATE nonce, verify
  the factory runtime and immutable canonical GroupPull relationship, and let
  complete-pair simulation prove construction, callability, actual gas, and
  retained profit. Revalidate raw bytes, pending status, replacement identity,
  signer nonce/balance, lease, and target deadline immediately before private
  submission. Price and account only the crank under the independent
  GroupPull standing-order bid, and never submit the creation alone.
- A pending FWA fulfillment backrun is always one exact bounded bundle:
  `[contiguous public coordinator nonce prefix ending in the target
  fulfillRandomWords, keeper syncFwaResult, keeper settle]`, or
  `[the same public prefix, keeper processAcquisitions(count),
  keeper syncFwaResult, keeper settle]`.
  Prove the signed raw transaction targets the coordinator pinned by
  `vrfCoordinatorAndSubId`, has zero value, decodes to the canonical FWA
  consumer/subscription, and derives the pool round's exact `fwaRequestId`
  from the proof key hash and seed. Starting at the coordinator sender's exact
  parent-state nonce, require every raw fulfillment through the target nonce
  to be present, signed, still pending, coordinator-targeted, zero-value, and
  selector-matched; reject a chain longer than eight. Require the lifecycle
  pointer, pulling state, unresolved round, and Pending acquisition at the
  exact parent. Derive a processor candidate only from the exact parent FWA
  queue, with `count` covering every queued sequence through the pool request;
  never assume one. Simulate and price every complete alternative twice,
  select the highest-profit valid variant, never offer a prerequisite,
  processor-only, or sync-only prefix, and account only the selected keeper
  receipts. This lane uses the low pool-ready bid, not the ordinary
  confirmed-head fulfilled bid. A classified relay
  `max fee per gas less than block base fee` response may be retried only
  against the same relay and target during a bounded 500 ms publication
  window; signed fee capacity may exceed the exact expected child base fee by
  one wei while economics continue to charge the exact expected effective gas
  price. If the target arrives before submission, retarget only when every
  public prerequisite remains current and pending. Re-enter the complete
  executor so parent state, queue count, signer nonce/balance, simulations,
  economics, lease, and deadline are all revalidated; permit at most three
  consecutive target attempts and never retarget a mined or replaced
  prerequisite.
  Each attempt, including every retarget after `target_block_arrived`, binds
  its exact parent to the authoritative subscribed head. A retarget may proceed
  only after that head reaches the completed target and advances beyond the
  previous planning parent; otherwise it fails closed instead of repeating an
  already-arrived target. The HTTP/WS client's `eth_blockNumber` view is not a
  planning-head fallback for this lane.
- A WebSocket `newHeads` event selects the planning head when configured;
  otherwise `eth_blockNumber` does. Retain the complete subscribed header and
  do not wait for a duplicate HTTP block object or provider fee estimate.
  Derive the private immediate child's exact EIP-1559 base fee from the
  subscribed parent's base fee, gas used, and gas limit. Pin core pool,
  lifecycle, order/vault, and prefilter state reads to that exact block number
  on the same foreground WebSocket client; never substitute a later
  `"latest"` response or retry against HTTP.
  Discard the plan if the head changes before nonce gating, and never submit
  after its target block arrives. Exact-block planning and post-block
  competitor-state reads may retry only classified `BlockNotFound`, the
  observed nested RPC `-32602` detail, or typed
  `InvalidInputRpcError[-32000]` against the same block and provider during
  their bounded publication-skew windows. Do not classify raw/untyped
  `-32000` errors as publication lag.
- The exact signed bundle and every economically safe prefix are simulated
  before submission. Every relay simulation pins `stateBlockNumber` to the
  exact target parent; never use the relay's lagging `"latest"` state. A
  classified Flashbots `-32001 block not found` response may retry against the
  same relay, target, and exact parent for at most one second, then fails
  closed. A typed Flashbots `-32000 max fee per gas less than block base fee`
  response may retry against that same relay and target for at most 500 ms when
  the locally derived target base fee is already covered. Do not apply this
  retry to any other `-32000` response, and never let it outlive the target-head
  deadline.
- Prefix selection normally maximizes retained profit. If multiple prefixes
  are clamped by the retained-profit floor, prefer the prefix with the larger
  absolute builder payment: the sub-gas-unit retained-profit difference is
  integer fee-rate rounding, while pruning positive-reward standing-order
  suffixes can make our aggregate bid lose to a broader competitor batch.
- Private one-block bundles are the default. A missed bundle expires and must
  not leak into the public mempool.
- Pool lifecycle, pool pull, standing orders, the default-off LiveBid sweep,
  Liquity, and Convex each have independent bidding policies. Do not apply the
  standing-order policy to a thin-margin lane. LiveBid bidding is not a
  safety control: its `sweep()` can succeed with zero reward after another
  transaction empties the adapter earlier in the same block.
- V2 pool pulls start at `POOL_PULL_BUILDER_BID_BPS` and learn exact aggregate
  clearing prices in the durable `v2_pool_pull` scope. Only counterfactually
  profitable competitor payments may raise the target. A V2 pull-containing
  prefix has no fixed percentage or `MAX_FEE_PER_GAS_GWEI` ceiling: its exact
  signed-bundle quote is clamped to the configured retained-profit floor. The
  internal 10,000 bps target requests the whole gross reward and is therefore
  above the economically admissible payment, not an economic cap. Because the
  aggregate high bid is justified by the pull, the private prefix floor must
  include that pull; never offer the same high-fee lifecycle-only prefix.
- V2 fulfilled acquisition batches start at the low pool bid and learn exact
  clearing prices in the independent durable `v2_pool_fulfilled` scope. The
  adaptive target applies only to the fulfilled lifecycle reward, has no fixed
  percentage or `MAX_FEE_PER_GAS_GWEI` ceiling, and remains clamped by the
  exact retained-profit floor. Ready processor chains and settle-only cleanup
  never inherit this bid. Competitor evidence is eligible only after the
  receipt-and-trace attribution gate above proves pure pool lifecycle
  economics; every ambiguous wrapper remains record-only.
- Competitive lanes share `AdaptiveBidController`; add a durable scope and
  safe lane-specific outcome normalization instead of copying its feedback
  loop. A measured, profitable higher competitor raises the target. Sustained
  full wins eventually probe below old competitor evidence, while retaining
  that evidence as the immediate recovery boundary for a price-losing probe.
  A measured price loss must cross the competitor's absolute clearing boundary
  as well as correcting any requested-versus-effective payment gap; a minimum
  gas-tip floor can otherwise make a small requested increase economically
  inert.
  A probe miss with no competitor or a cheaper measured winner must hold the
  probe; raising payment cannot repair builder reach, timing, or state conflict.
  Never feed ambiguous wrapper economics into any controller.
- Standing-order targets start at `BUILDER_BID_BPS`, but durable per-target
  price discovery may bid lower after repeated wins. Its bracket must learn
  from the exact payment expressed by that order's simulated gas and reward
  after profit and fee caps, not the bundle-wide average or requested bid.
  Direct-payment variants without an exact per-order allocation remain on the
  conservative aggregate attribution. The controller must persist explicit
  probe state plus block-aged price evidence.
- A multi-transaction standalone standing-order batch prices every transaction
  from that order's own reward-normalized target. Do not use one shared
  priority fee: it can dilute a contested high-reward order while overpaying
  cheap orders even when the aggregate payment looks correct. Order stable
  independent work by descending adaptive target, then expected profit, and
  place active price-discovery probes in a suffix ordered by the same rule. A
  losing probe must not invalidate otherwise winnable stable work. Recompute
  the exact safe prefix floor from each transaction's assigned fee and preserve
  the aggregate retained-profit boundary.
- A direct coinbase payment may only fill an existing fee-capped adaptive bid
  for a zero-value, standing-order-only private batch. The pinned receive-only
  helper must pass its startup code-hash check, occupy the final contiguous
  nonce, reserve gas plus value, and remain inseparable from every selected
  reward-producing crank. Require exact full-bundle simulation, exact
  `ethSentToCoinbase`/`coinbaseDiff`, and aggregate positive economics; never
  submit a helper-only or helper-free prefix of that paid variant.
- The standing-order batch executor may replace only a private plan containing
  two to 64 standalone standing-order cranks. Preserve every order's independent
  adaptive bid and compute its embedded builder payment from that order's
  actual reward. Verify the deterministic executor's exact owner-patched
  runtime hash before use. If it is absent, deploy it only through the pinned
  EIP-2470 singleton factory as the inseparable `[deploy, execute]` prefix and
  require the full signing envelopes to be profitable. Select either form only
  when its conservative retained profit strictly exceeds the best
  dependency-safe direct prefix under the same bids, base fee, minimum
  priority fee, fee ceiling, and profit floor. Both forms require an
  exact final bundle simulation whose aggregate `coinbaseDiff` and executor
  transaction `ethSentToCoinbase` exactly equal the modeled payments. Account
  realized reward as the owner's returned ETH, validate every `Cranked` log
  against the executor's `BatchExecuted` event, and never count the embedded
  builder payment twice.
- Profit checks include gas and builder payments. A receipt is the source of
  truth for gas; decoded token transfers and balance reconciliation are the
  source of truth for reward value.
- Post-block standing-order competition reads registry membership from the
  target's planning parent block, where every attempted order necessarily
  existed. Winning logs, receipts, base fee, and beneficiary payments remain
  pinned to the target block. Do not move registry `eth_call`s back to the
  just-mined target state; that reintroduces the provider publication race.
- A receipt inside a bundle may look loss-making because every transaction
  shares one gas-normalized priority fee. Do not infer marginal contribution
  from that receipt alone. Re-price every dependency-safe prefix with its own
  reward-weighted builder payment and choose the highest aggregate net.
- Use `DISCOVERY_RPC_URLS` for bulk discovery and historical scans. Never let a
  research scan saturate the latency-sensitive `RPC_URL`.

Current production policy should always be read from Railway's narrowly
filtered environment and `adaptive_bid_state`, not assumed from `.env.example`.
At the last handoff, the configured policy was approximately:

| Lane | Builder bid |
| --- | ---: |
| Standing-order baseline | 10% |
| Standing-order learned minimum | 10% |
| Standing-order learned maximum | 99% profitability-capped policy ceiling |
| Aggregate minimum retained profit | 0.000001 ETH |
| Pending-funding standing-order backrun | 10% |
| Pool pull | V1 10%; V2 adaptive from 10% to profitability boundary |
| Pool acquisition ready | 3% |
| Pool acquisition fulfilled | V1 72.5%; V2 adaptive from 3% to profitability boundary |
| LiveBid sweep | 1% (feature default-off) |
| Liquity V2 | 81% |
| Convex | 10% |
| Stake DAO Curve harvest | 10% |
| FiRM forced replenishment | 10% (feature default-off) |

`ENABLE_DIRECT_COINBASE_PAYMENTS=true` is live only for fee-capped,
standing-order-only batches. It does not define another bid: it expresses the
existing adaptive standing-order bid without raising the `5 gwei` maximum fee.

These values are context, not immutable recommendations. Re-read recent
competition and durable bid state before changing them.

## Active keeper lanes

Production currently evaluates:

- PullStandingOrder and compatible PullVault `crank()`
- optional exact-pair backruns of public ETH funding transfers to canonical
  orders/vaults; private-only and default-off unless production enables
  `ENABLE_PENDING_FUNDING_BACKRUNS`
- exact-pair backruns of a final public PullPool `buyTickets` or
  `buyIntoCurrentRound` transaction with the permissionless `pull`;
  private-only under the same pending subscription
- PullPool funding and acquisition lifecycle
- public FWA acquisition processing
- exact private backruns of the canonical VRF fulfillment that self-processes
  the pool's pending FWA acquisition, followed by mandatory sync and settle
- FWAToken `buyback()`
- optional LiveBidAdapter `sweep()`; production-disabled because a same-block
  earlier sweep turns the call into a successful zero-reward no-op that
  parent-state simulation cannot reject
- official Liquity V2 WETH, wstETH, and rETH liquidations
- Convex `earmarkRewards` and expired vlCVX lock kicks
- optional Stake DAO v4 Curve Accountant harvests; the code is validated but
  the production feature remains default-off while margins are thin
- optional Inverse FiRM forced replenishments; fixed observed deficits and
  exact DOLA receipt accounting are implemented, but production remains
  default-off because realized competitor margins are extremely thin

The core control flow is:

- `src/main.ts`: process startup, relay submission, receipt/competition loop
- `src/strategy.ts`: opportunity discovery, simulation, planning, and execution
- `src/lifecycle.ts`: round/lifecycle routing helpers
- `src/bidding.ts`: builder payment policy
- `src/economics.ts`: rewards, gas, and profitability
- `src/firm.ts`: canonical FiRM discovery, fixed-input economics, and receipt
  validation
- `src/adaptive-bidding.ts`: in-memory learned bidding behavior
- `src/postgres-adaptive-bidding.ts`: durable learned bids
- `src/flashbots.ts`: bundle simulation and relay submission
- `src/pending-funding.ts`: raw prerequisite validation, replacement tracking,
  and the hash-only filtered subscription
- `src/pending-funding-backrun.ts`: exact-pair simulation, crank-only
  economics, relay submission, receipt accounting, and adaptive outcome rules
- `src/pending-fwa-fulfillment.ts`: raw VRF fulfillment proof and request
  validation
- `src/pending-fwa-backrun.ts`: exact fulfillment/sync/settle simulation,
  private submission, and keeper-only receipt accounting
- `src/signer-coordinator.ts`: per-target-block signer reservation shared by
  confirmed-head and pending-event lanes
- `src/telemetry.ts`: PostgreSQL event persistence
- `src/singleton.ts`: signer advisory lease
- `src/discord.ts`: automatic embeds
- `src/format.ts`: structured console logging
- `src/config.ts`: environment parsing and validation
- `src/abi.ts` and `src/constants.ts`: contract interfaces and addresses

Tests live under `test/*.test.ts`. Add focused tests for economic,
lifecycle, bidding, and relay-prefix behavior whenever practical.

Convex earmark discovery is intentionally two-phase. After a non-submitting
pass, the discovery RPC refreshes an atomic shortlist of the 32
highest-claimable gauges every four blocks and its pool registry every 128
blocks. The hot planner uses only the last complete shortlist, then re-reads
claimable CRV, incentives, oracles, and gas at the exact planning block. A cold
cache skips the lane immediately; a failed refresh retains the prior snapshot.
Never cache a `KeeperJob`, reward valuation, gas estimate, or calldata.

## Research and one-off scripts

Inspection scripts under `scripts/inspect-*.ts` should be read-only. Scripts
with names such as `claim-*` or `liquidate-*` can sign and submit transactions;
do not run them until you have read the code, confirmed their dry-run behavior,
verified current state, and passed the nonce and profitability gates.

The announced PullPool V2 suite is inspected with:

```bash
npm run inspect:pull-pool-v2
```

The inspector pins the canonical deployer's creation transactions, all known
component bytecode hashes, the original V2-only factory and successor-aware
factory relationships, immutable FWA relationships, verified source metadata,
its 36-component round layout, event-indexed active rounds, and launch state.
Production keeps V1 enabled and adds V2 to the same signer pass only after an
unpause or first round and successful verification of all eight runtime hashes
and relationships. Independent V1/V2 order work shares one nonce plan; when
both have lifecycle work, only the stronger lifecycle alternative is eligible
for that target block.

The V2 adapter reconstructs concurrent active rounds from `RoundOpened`,
`RoundSettled`, and `RoundVoided`, exact-reads every retained round at the
subscribed parent, and counts both pulling and claimable rounds when validating
`pendingPullCount`. It merges and deduplicates orders from both pinned V2
registries, decodes mutable order pool/recipient/referrer/pacing state plus the
pool-scoped last purchase, and keeps ordinary exact simulation, private
submission, and profit gates. V1-only vault, final-ticket, and pending-FWA
decoders stay scoped to V1; the validated pending ETH-funding lane includes
the registered successor orders. Shared non-pool planners execute only once.
Remove V1 only after it is paused or deprecated, has no active lifecycle, and
its immutable orders no longer offer viable keeper work.

Third-party CLIs may echo environment-derived URLs, including embedded API
keys. Inspect their source or filter/suppress output before running them. Do not
paste a secret-bearing URL into logs, Discord, commits, or agent responses.

When researching a new keeper:

1. Identify the canonical deployed contracts from primary sources and verify
   bytecode/configuration on-chain.
2. Prove the action is permissionless and identify the exact caller reward.
3. Check current eligibility and historical event frequency using the
   discovery RPC.
4. Reconstruct recent winning transactions and competition payments.
5. Model gross reward, token conversion, gas, builder payment, revert risk, and
   capital lock.
6. Add a read-only inspector before adding live execution.
7. Add exact simulation, economic gates, a lane-specific bid, structured
   events, durable telemetry, and Discord reporting.
8. Run in dry-run mode and compare against actual competitors.
9. Enable live execution only after a reviewed, bounded implementation exists.

Record the outcome and evidence in [OPPORTUNITIES.md](./OPPORTUNITIES.md).

## Security and change boundaries

- Never print, commit, or message `.env`, private keys, webhook URLs, database
  URLs, or RPC URLs containing credentials.
- Never use the subscriber/owner key. The keeper EOA is gas-funded only.
- Never add token approvals, custody, swaps, withdrawals, or capital-locking
  strategies without explicit review and authority.
- Preserve unrelated local changes. Do not reset or overwrite a dirty
  worktree.
- Avoid destructive git or filesystem commands.
- Pin addresses and verify their expected relationships at startup.
- Treat external feeds as hints. Authoritative contract state and receipts win.
- Estimated rewards must be labeled as estimates until decoded or reconciled.
- Keep the production private key and webhooks only in Railway/local secret
  storage.

## Dashboard boundary

A future dashboard should be a separate read-only Railway service. It may
receive a read-only database URL and HTTP authentication, but never the keeper
private key, RPC credentials, or webhooks. Useful views are summary/P&L,
transactions, events, competition, and adaptive bids. Clearly distinguish
decoded realized P&L from estimated reward equivalents.

## Handoff checklist

Before ending a working session:

- leave the worktree understandable and report any intentional uncommitted work
- record new research, evidence, and next actions in `OPPORTUNITIES.md`
- state whether production is healthy and which deployment is live
- state the last verified goal balance/P&L and nonce condition
- state whether the signer lease is healthy
- send Discord only if the handoff contains a meaningful decision, profit, or
  incident
- do not leave a local live process running
