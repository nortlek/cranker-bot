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
stretch goal is **$250 cumulative verified net realized profit by
2026-07-30 23:59 America/Denver** on the same basis. Continue to protect and
reconcile realized profit; a goal is not permission to expand custody,
approval, or contract risk. Never claim progress from a log estimate alone:
reconcile wallet balances and successful receipts.

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

`railway.toml` runs migrations before deployment, disables deployment overlap,
allows 15 seconds of draining, and restarts on failure. Live instances also
hold a PostgreSQL advisory signer lease. Failure to acquire the lease is
fail-closed. The worker verifies the exact lock before each live pass and
immediately before submission; a lost lease stops the signer. Live mode
requires `DATABASE_URL`. Telemetry after startup is fail-open.

`WS_URL`, when configured, supplies the production `newHeads` wake-up.
`RPC_URL` remains authoritative: the keeper fetches and pins the exact observed
block over HTTP. HTTP also asserts subscription liveness after
`HEAD_STALE_TIMEOUT_MS`; if the chain advanced without a subscribed head, the
worker exits for a supervised restart instead of silently degrading to a
second head path. The exact fixed-block read tolerates up to one second of
publication skew by retrying only `BlockNotFound`; all other errors remain
immediate failures. The same WebSocket signal wakes private target-block
receipt finalization, after which HTTP must serve that exact block before
receipts are classified. Never print either endpoint.

When `ENABLE_PENDING_FUNDING_BACKRUNS=true`, the worker opens a second,
hash-only Alchemy filtered subscription on the same `WS_URL` for current
canonical order/vault recipients. It reconnects through that same mechanism
and has no polling or unfiltered alternative. Exact raw transactions are
fetched through `DISCOVERY_RPC_URL`; never log either the raw bytes or either
endpoint.

GitHub-source automatic deployment is not yet connected because Railway's web
UI still needs an authenticated browser session. Until that is completed,
deploy the exact local committed source with the Railway CLI.

Production submits private bundles through four paths: Flashbots, Quasar,
direct Titan, and direct Beaver. Flashbots also multiplexes to the configured
builder list. Do not remove the direct Titan/Beaver paths without evidence:
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
  .event == "acquisition_status" or
  .event == "competitor_bid_observed"
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
  .event == "relay_submission_result" or
  .event == "convex_candidate_cache_refreshed" or
  .event == "convex_candidate_cache_refresh_failed"
)'
```

Every event emitted inside a keeper pass includes the same `passId` and
`observedBlock`. Relay events use a numeric alias and categorized error, never
the potentially credential-bearing URL.

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
event per member, but Discord groups them into one `keeper_batch_submitted`
embed and one aggregate `keeper_batch_result` embed. Evaluate the batch's
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

There are two separate Discord channels:

- `DISCORD_WEBHOOK_URL`: automatic rich embeds from the running bot for
  important successes, failures, submissions, expirations, and P&L changes.
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
  open-round ticket plus the caller fee, or a compatible candidate with
  `lastRoundBought >= roundCount`. Never native-balance-filter a vault. A
  failed prefilter read must fall through to exact simulation rather than
  reject the candidate.
- `roundCount` identifies the funding round. `ethPendingRound` is the
  authoritative acquisition lifecycle pointer. Never collapse the two.
- A ready acquisition is built as
  `FWA.processAcquisitions(count) -> PullPool.syncFwaResult(round) ->
  PullPool.settle(round)`.
- The ready chain requires at least the processor plus sync prefix. Economic
  accounting may require the full processor/sync/settle prefix when earlier
  calls are not independently profitable.
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
- A WebSocket `newHeads` event selects the planning head when configured;
  otherwise `eth_blockNumber` does. Fetch that exact block number over the
  authoritative HTTP RPC and pin core pool, lifecycle, order/vault, and
  prefilter reads to it; never substitute a later `"latest"` response. Discard
  the plan if the head changes before nonce gating, and never submit after its
  target block arrives. Retry an exact header only for classified
  `BlockNotFound`. Exact-block planning and post-block competitor-state reads
  may retry only the observed nested RPC `-32602` detail
  `Missing or invalid parameters.` against the same block and provider during
  their bounded publication-skew windows.
- The exact signed bundle and every economically safe prefix are simulated
  before submission.
- Private one-block bundles are the default. A missed bundle expires and must
  not leak into the public mempool.
- Pool lifecycle, pool pull, standing orders, LiveBid sweep, Liquity, and
  Convex each have independent bidding policies. Do not apply the standing
  order's high bid to a thin-margin lane.
- Standing-order targets start at `BUILDER_BID_BPS`, but durable per-target
  price discovery may bid lower after repeated wins. Its bracket must learn
  from the exact bundle-effective bid after profit and fee caps, not just the
  requested bid, and must persist explicit probe state plus block-aged price
  evidence.
- A direct coinbase payment may only fill an existing fee-capped adaptive bid
  for a zero-value, standing-order-only private batch. The pinned receive-only
  helper must pass its startup code-hash check, occupy the final contiguous
  nonce, reserve gas plus value, and remain inseparable from every selected
  reward-producing crank. Require exact full-bundle simulation, exact
  `ethSentToCoinbase`/`coinbaseDiff`, and aggregate positive economics; never
  submit a helper-only or helper-free prefix of that paid variant.
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
| Standing-order baseline | 86.44% |
| Standing-order learned minimum | 10% |
| Standing-order learned maximum in use | 94.54% |
| Pending-funding standing-order backrun | 10% |
| Pool pull | 10% |
| Pool acquisition ready | 5% |
| Pool acquisition fulfilled | 5% |
| LiveBid sweep | 1% |
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
- PullPool funding and acquisition lifecycle
- public FWA acquisition processing
- FWAToken `buyback()`
- LiveBidAdapter `sweep()`
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
component bytecode hashes, the V2 order-factory relationship, immutable FWA
relationships, and launch state. V2 is not a live keeper lane while the pool is
paused or its expanded round layout lacks canonical source verification.

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
