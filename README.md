# Pull Pool Keeper

A profit-aware Ethereum mainnet keeper for permissionless FWA maintenance. It
competes for compatible PullStandingOrder and PullVault `crank()` fees, the
PullPool lifecycle bounties
paid by `pull`, `syncFwaResult`, `settle`, and `settleForcedEth`, the public
FWA acquisition processor when it unlocks those bounties, and the FWAToken
`buyback()` caller reward. It watches the official Liquity V2 WETH, wstETH,
and rETH branches for permissionless liquidations and prices Convex pool
`earmarkRewards` caller incentives and expired vlCVX lock
`kickExpiredLocks` rewards. Every candidate or dependent sequence is simulated
and priced before private submission. A disabled LiveBidAdapter `sweep()` lane
is retained for research but is unsafe to enable without an atomic nonzero
reward guard. An optional private-only lane also batches profitable Stake DAO
v4 Curve Accountant harvests for their CRV caller fee. A second default-off,
private-only lane watches canonical Inverse FiRM markets for capital-free,
DOLA-paid forced DBR replenishments. An opt-in private pending-funding lane
can also copy a public ETH transfer to a canonical standing order into the
same bundle as the dependent `crank`, allowing the keeper to compete when an
order becomes funded between confirmed heads.

## Examined transaction

[Transaction `0xe446…20d89`](https://etherscan.io/tx/0xe446200c31daf3d5727f49d993f9d18da9cf141a54e8948fe6013952cf820d89)
succeeded in block `25,633,039` and called:

```solidity
PullStandingOrderFactory.createOrder{value: 0.053 ether}(
    1,          // ticketsPerRound
    0.0003 ether // crankFee
);
```

| Item | Value |
| --- | --- |
| Creator / fixed order owner | `0x55907Cf476998d2F58591C6D0a10eCbbE249A8EB` (`keltron.eth`) |
| Factory | `0xe60a9341C3C73636B911e609dEFaf05B09EDeB9C` |
| Created order | `0x9e957185F108F535BAEFcaF6A4A8bDEa4813557A` |
| Pool | `0xB2D80254af189854Bf90D2C338d87236d67D2bF3` |
| Opening order balance | `0.053 ETH` |
| Tickets per round | `1` |
| Fee paid to each successful cranker | `0.0003 ETH` |
| Ticket price at creation | `0.005 ETH` |
| Factory minimum deposit at creation | `0.0053 ETH` |

The transaction created the 29th registered order. Its only log was the
factory's `OrderCreated` event, and the deployed order received the full
`0.053 ETH`.

The order does not receive the subscription's eventual payout. On every
successful `crank`, it buys tickets with the immutable owner as beneficiary, so
pool shares or refunds go directly to the owner. The order holds only future
ticket principal and keeper fees, plus any clamped-buy change returned by the
pool.

The call is eligible only when all of the following are true:

- The pool is not paused.
- The current open round has not passed its funding deadline.
- FWA can price the round, the round still needs tickets, and ticket capacity
  remains.
- This order has not already bought in the current round.
- The order balance covers the clamped ticket cost plus its current
  `crankFee`.

If no round is open, `crank` can open the next one through
`buyIntoCurrentRound`. The pool and order both clamp ticket quantity when less
than the configured amount can be accepted.

Shortly after creation, independent keepers cranked this order in rounds
98–101. Those transactions used roughly 195k–238k gas. With their observed
effective gas prices, gas cost was about `0.0000336–0.0000958 ETH`, leaving
about `0.000204–0.000266 ETH` from the `0.0003 ETH` fee before infrastructure
cost.

## Keeper behavior

At startup the worker verifies the pinned V2 suite. V1 remains enabled because
its standing orders are permanently bound to the V1 pool. Once canonical V2 is
unpaused or has opened its first round, the verified V2 adapter joins the same
keeper pass without starting another signer. Both adapters plan from the same
subscribed parent, merge independent order work into one nonce plan, and allow
only one lifecycle chain per target block. A per-head V2 state check begins
alongside V1 planning and is mandatory before submission.

V2 reconstructs every active round from `RoundOpened`, `RoundSettled`, and
`RoundVoided`, exact-reads those rounds at the subscribed parent, and routes
concurrent funding and acquisition work independently. Its standing-order
decoder binds the mutable pool, recipient, referrer, pacing fields, and the
pool-scoped last purchase. It reads both the original V2-only factory and the
successor-aware factory that migrated orders from V1 to V2. The V1 vault,
final-ticket, and pending-FWA decoders remain scoped to V1; the validated
pending ETH-funding lane covers registered V1 and V2 orders. Shared Liquity,
Convex, Stake DAO, FiRM, buyback, and LiveBid planners run only once through
the primary adapter. Confirmed-head V2 orders and lifecycle calls remain
private, exact-simulated, and profit-gated.

Each new block, the keeper:

1. Under V1, reads `roundCount` for the newest funding round and
   `ethPendingRound` for the independently resolving acquisition. Under V2,
   uses the event-indexed active set and per-round snapshots instead. It
   prioritizes
   `syncFwaResult → settle` for fulfilled acquisitions. When the acquisition is
   ready and is within the configured FWA processing window, it builds
   `processAcquisitions(count) → syncFwaResult → settle`, where `count`
   includes every queued sequence through that acquisition. Direct
   `settle`/`settleForcedEth` remains available for claimable rounds.
2. While planning that lifecycle prefix, revalidates a bounded cache of the
   highest-fee standing orders against the same head block. It waits at most
   75 ms after the base lifecycle plan is ready, then either appends an exact
   `crank(s) → pull(nextRound)` suffix or submits the unchanged lifecycle
   prefixes. Slow, stale, uncovered, or unavailable funding discovery is
   fail-open only to the already-safe lifecycle plan.
3. Outside that fast path, reads the standing-order and compatible vault
   registries, refreshes the candidate cache, and exact-estimates every
   currently callable `crank()` from the keeper account. Typed contract
   reverts are treated as ineligible orders.
4. If the round is short of tickets, finds the least net-cost set of callable
   standing orders that covers the shortfall and appends `pull`. This allows a
   low- or zero-fee order only when the paid pull makes the complete sequence
   profitable.
5. Scans Liquity V2's official WETH, wstETH, and rETH branches for active or
   zombie troves below their branch MCR. It exact-simulates
   `batchLiquidateTroves`, budgets only the guaranteed 0.0375 WETH compensation
   per trove, and ignores variable collateral compensation when deciding
   profitability.
6. Compares the conservative net value of the PullPool/order plan, Liquity
   liquidation, Convex `earmarkRewards`, Stake DAO Curve harvest, FiRM forced
   replenishment, FWAToken `buyback()`, and any explicitly enabled optional
   lane, then selects the best currently executable plan.
7. In live mode, reads the account's `latest` and `pending` transaction counts
   and assigns an explicit contiguous nonce range.
8. Signs the generic call sequence locally, simulates it in nonce order, and
   prices its combined rewards against combined gas. Pool bounties use the
   round's snapshotted cap/tip and a configurable reimbursement haircut.
9. Submits only economically safe contiguous prefixes as private Flashbots
   bundles for the next block. A cross-subsidized `orders → pull` sequence has
   a full-length dependency floor, so no subsidized crank is ever offered
   alone.
10. Records each relay-accepted bundle hash, target, and prefix length, then
   watches the target block and reports inclusion and realized profit. For
   missed orders it measures both priority fees and direct block-beneficiary
   payments made by the winning crank transaction, then updates that order's
   next bid. A missed bundle expires instead of entering the public mempool.

When `ENABLE_PENDING_FUNDING_BACKRUNS=true`, a separate filtered Alchemy
subscription watches only canonical order and vault recipients. A positive,
empty-calldata Ethereum transfer is accepted only after its exact raw bytes,
hash, recovered sender, nonce, chain ID, type, recipient, value, and pending
status agree with the authoritative RPC response. The keeper then simulates
`[public funding transaction, keeper crank]`, prices only the crank's reward
and gas, re-signs and re-simulates the exact pair, and submits the pair
privately for one block. It never submits the funding transaction alone or
counts the funder's value, gas, or priority fee as keeper P&L. A shared
target-block reservation prevents this asynchronous lane and the confirmed
head planner from making conflicting signer decisions.

When `ENABLE_PENDING_FWA_FULFILLMENT_BACKRUNS=true`, another isolated
hash-only subscription watches the canonical VRF coordinator. It accepts only
an exact signed `fulfillRandomWords` whose decoded consumer, subscription, and
proof-derived request ID match the pool's current pending FWA acquisition. The
keeper exact-simulates and privately submits only one of two complete
alternatives:
`[contiguous public coordinator nonce prefix ending in the target fulfillment,
syncFwaResult(round), settle(round)]` or
`[the same public prefix, processAcquisitions(count),
syncFwaResult(round), settle(round)]`. The exact parent-state FWA queue defines
`count`; it includes every sequence through the pool's request rather than
assuming the request is next. Both alternatives must fully simulate, and the
keeper selects the highest-profit valid one. The bounded public prefix is
necessary when the oracle has earlier pending fulfillments; neither it nor a
partial keeper prefix is ever sent alone, and only the selected two or three
keeper receipts enter P&L. This captures callbacks that either self-process to
`fulfilled` or leave the acquisition `ready` before a confirmed-head planner
can observe the intermediate state. The lane uses the low
`POOL_BUILDER_BID_BPS` policy rather than the high ordinary fulfilled-state
bid. If a target block arrives before submission while every prerequisite is
still current and pending, the lane re-runs every state, nonce, balance,
simulation, and profit gate for the immediate next target. It tries at most
three consecutive target blocks and never retargets a mined or replaced
prerequisite.

Candidate gas estimates run with bounded concurrency and retain fee-ranked
ordering. When `WS_URL` is configured, a raw `newHeads` subscription supplies
the complete planning header and wakes the block loop immediately; no duplicate
HTTP block fetch gates the pass. Contract storage, balances, nonces, gas
estimates, and simulations are not contained in the header, so those reads use
the same WebSocket RPC and remain pinned to the subscribed block. If that node
announces a header just before it exposes the corresponding execution state,
the exact-state read retries only classified fresh-block publication errors for
up to one second. HTTP is only a subscription-liveness watchdog: if it proves
that the subscription missed a head, the process exits for a supervised
restart rather than switching to a second planning path.

Private submission uses that subscribed head as its target-block deadline as
well. The final exact-parent nonce and balance gate runs on the WebSocket RPC
and races arrival of the target head. A slow or lagging state read therefore
causes the bundle to be skipped, never submitted to an already-built block.
`bundle_stage_timing` reports this gate as `final_submission_gate`.

V1 uses `lastRoundBought` with the pool's state as replay protection. V2 scopes
that round to `lastPool`, because round identifiers restart on a successor,
and exact simulation remains authoritative. A new batch starts only when the
keeper account has no existing pending nonce gap; after a restart, this
prevents the bot from duplicating transactions that are still in flight.
Competitive bid tuning is persisted separately in `.keeper-bid-state.json`;
deleting it resets every order to `BUILDER_BID_BPS`.

## Setup

Requires Node.js 22 or newer.

```bash
npm install
cp .env.example .env
npm run inspect
npm test
```

`npm run inspect` prints the live pool configuration and every registered
order. It never needs a private key.

Start with one read-only pass:

```dotenv
DRY_RUN=true
RUN_ONCE=true
```

```bash
npm start
```

### Codex progress updates

Set a separate Discord webhook in the environment or `.env`:

```dotenv
CODEX_UPDATES_WEBHOOK=https://discord.com/api/webhooks/...
```

Codex can then send short progress updates with:

```bash
npm run codex:update -- "Keeper investigation is complete."
```

The command also accepts a multiline message on standard input, splits messages
over Discord's 2,000-character limit, and disables user and role mentions.

### Durable telemetry

Set `DATABASE_URL` to a PostgreSQL connection URL to persist every structured
keeper log entry across restarts and deployments. Console JSON and Discord
notifications continue unchanged. Database writes use a bounded, batched queue
with short timeouts and retry backoff; a database outage is reported to stdout
but never stops block processing or transaction submission.

Build and apply the ordered SQL migrations before starting the keeper:

```bash
npm run build
npm run db:migrate
```

For Railway, attach a PostgreSQL service, expose its `DATABASE_URL` to the
keeper, and use `npm run db:migrate` as the pre-deploy command. The production
image includes the compiled migration runner and `migrations/` directory.

The initial schema stores append-only `keeper_events` rows with indexed block,
target-block, transaction-hash, and job-kind fields, plus a `keeper_runs`
record for each process lifetime. `TELEMETRY_BATCH_SIZE`,
`TELEMETRY_FLUSH_MS`, and `TELEMETRY_MAX_QUEUE` tune batching and the bounded
failure buffer. Leave `DATABASE_URL` empty to disable database telemetry.

Live instances that have `DATABASE_URL` also hold a PostgreSQL advisory lease
for the signer. Railway overlaps replacement containers for 60 seconds. The
replacement performs chain validation and establishes read-only subscriptions
while pending-event execution is explicitly disarmed, then waits for the
previous instance to release the lease. Only after acquiring and verifying the
lease does it arm pending execution and begin ordinary keeper passes. This
keeps exactly one signer while avoiding a full initialization blackout during
rollout. Database telemetry remains fail-open after startup, but failure to
acquire the signer lease is deliberately fail-closed. The reusable adaptive
bid controller stores independent scope-and-target state in PostgreSQL, so
standing-order and V2 pool-pull clearing-price history survives Railway's
ephemeral filesystem and subsequent deployments without mixing lanes.

For live execution, use a dedicated keeper EOA funded only with enough ETH for
gas:

```dotenv
RPC_URL=https://your-reliable-mainnet-rpc.example
WS_URL=wss://your-low-latency-mainnet-rpc.example
PRIVATE_KEY=0x...
DRY_RUN=false
RUN_ONCE=false
SUBMISSION_MODE=flashbots
```

Never use the subscriber/owner key. The bot only needs a gas-paying keeper key;
successful `crank` fees are sent to that keeper address.

### Submission controls

- `SUBMISSION_MODE`: `flashbots` (default) sends an exact one-block private
  bundle; `public` broadcasts transactions directly.
- `ENABLE_VAULTS` and `VAULT_FACTORY_ADDRESS`: include the compatible
  PullVault registry. Startup verifies that it targets the expected pool.
- `FLASHBOTS_RELAY_URLS`: comma-separated authenticated bundle relay endpoints.
  The default sends through Flashbots and Quasar plus direct Titan and Beaver
  endpoints. Flashbots still multiplexes to the configured builder list; the
  direct paths reduce latency and provide independent delivery for short FWA
  ready windows.
  The first must support `eth_callBundle` and is used for simulation; remaining
  endpoints receive the already-simulated bundle. The default also submits
  directly to Quasar because it has recently built competing pool cycles.
  A bundle is submitted concurrently to every configured endpoint.
- `FLASHBOTS_BUILDERS`: registered builder names for relay multiplexing. The
  defaults cover Flashbots, builder0x69, Beaver, Titan, rsync, and
  `bobthebuilder`. Bob was added after a recurring final-ticket/pull pair landed
  in a Bob-built block outside the Alchemy pending feed. Builder names must
  remain entries from the canonical Flashbots builder registry.
- `FLASHBOTS_AUTH_PRIVATE_KEY`: optional relay reputation key. It signs only
  relay authentication messages; when omitted, `PRIVATE_KEY` is used.
- `RELAY_TIMEOUT_MS`: timeout for relay simulation and submission calls.
- `BUILDER_BID_BPS`: starting bid for every standing order. The default is
  `1000` (10%); exact measured competitors can raise each target independently
  up to the profitability boundary.
- `POOL_BUILDER_BID_BPS`: builder share for a ready
  `processAcquisitions → sync → settle` chain. The default is `300` (3%),
  just above the incumbent's observed 2.5% direct Titan payment.
- `POOL_PULL_BUILDER_BID_BPS`: independent builder share for `pull`. The
  default is `1000` (10%). It remains the V1 static policy and is the V2
  controller's starting point/lower bound. V2 learns exact profitable misses
  in the separate `v2_pool_pull` durable scope. Its learned target is applied
  to the aggregate bundle a builder evaluates, and can rise to the exact
  retained-profit boundary without inheriting the standing-order controller.
- `POOL_FULFILLED_BUILDER_BID_BPS`: builder share for ordinary fulfilled
  `sync → settle` and settle-only work. The default is `7250` (72.5%), just
  above the lowest of three exact recent fulfilled-cycle clearings. This does
  not affect the ready acquisition lane, which retains its low independent
  bid. Exact simulation, the global fee ceiling, and the positive-profit gate
  still reject a fulfilled bundle that cannot afford this target. Mixed
  order/pool bundles weight every component by its own policy.
- `LIVE_BID_SWEEP_BUILDER_BID_BPS`: builder share applied only to an adapter
  sweep. The default is `100` (1%); historical winning calls paid zero
  priority fee, so it does not inherit the standing-order bid.
- `LIQUITY_BUILDER_BID_BPS`: independent builder share for competitive
  liquidations. It starts at `8100` (81%) but remains bounded by the global
  fee cap, wallet gas reserve, and positive-profit requirement.
- `CONVEX_BUILDER_BID_BPS`: independent builder share for Convex earmarks and
  expired-lock kicks. It defaults to `1000` (10%) so thin caller incentives do
  not inherit another lane's policy.
- `STAKEDAO_BUILDER_BID_BPS`: independent builder share for Stake DAO Curve
  harvests. It defaults to `1000` (10%) and never inherits the standing-order
  bid.
- `FIRM_BUILDER_BID_BPS`: independent builder share for FiRM forced
  replenishments. It defaults to `1000` (10%) and remains subject to exact
  positive-profit caps.
- `ADAPTIVE_BIDDING`: enables post-block per-order bid learning.
- `ADAPTIVE_BID_MIN_BPS`: hard lower bound for private per-order price
  discovery. New orders still start at `BUILDER_BID_BPS`.
- `ADAPTIVE_BID_STEP_BPS`: margin added above a measured winning bid after a
  loss. The default is `25` (0.25 percentage points).
- `ADAPTIVE_BID_MAX_BPS`: hard ceiling for the learned bid target.
- `ADAPTIVE_BID_WIN_STREAK`: consecutive wins required before probing a lower
  bid.
- `ADAPTIVE_BID_DECAY_BPS`: minimum amount removed when bisecting toward the
  target-specific lower bound after the configured win streak.
- `ADAPTIVE_BID_EVIDENCE_MAX_AGE_BLOCKS`: maximum age of competitor and
  failed-probe price evidence. The default `7200` is roughly one day.
- `ADAPTIVE_BID_STATE_PATH`: persisted per-order bid state.
- `COMPETITOR_TRACE_URL`: internal-operation index used to measure direct ETH
  payments to the target block's beneficiary. The default is Routescan's
  keyless Ethereum endpoint.
- `COMPETITOR_TRACE_TIMEOUT_MS`, `COMPETITOR_TRACE_RETRIES`, and
  `COMPETITOR_TRACE_RETRY_DELAY_MS`: indexing-lag and request controls.
- `DISCORD_WEBHOOK_URL`: optional Discord webhook receiving embeds for keeper
  starts/stops, submissions, confirmed receipts, realized P&L changes,
  competitor wins, rejected economics, and operational failures. Keep it only
  in the gitignored `.env`.
- `DISCORD_WEBHOOK_TIMEOUT_MS`: per-delivery timeout. Notifications are queued
  independently and never block block processing or transaction submission.
- `DATABASE_URL`: optional PostgreSQL storage for durable structured events.
  The value is never included in keeper logs.
- `TELEMETRY_BATCH_SIZE`, `TELEMETRY_FLUSH_MS`, and `TELEMETRY_MAX_QUEUE`:
  bound telemetry batching, latency, and memory use. Important transaction,
  receipt, competition, and failure events displace debug events first if an
  extended database outage fills the queue.
- `MIN_PRIORITY_FEE_GWEI`: lower bound for the derived builder tip.
- `POOL_MIN_PRIORITY_FEE_GWEI`: separate lower bound for pool-only private
  bundles. It defaults to zero because `POOL_BUILDER_BID_BPS` already creates
  the intended builder payment.
- `SIMULATION_CONCURRENCY`: maximum simultaneous per-order gas estimates.
- `WS_URL`: optional WSS `newHeads` source used to wake the loop. When set,
  the raw subscribed header supplies the exact planning block, timestamp,
  base fee, gas used, and gas limit. The keeper computes the immediate child's
  exact EIP-1559 base fee locally, and the same WebSocket client serves
  foreground state, simulations, nonce/balance gates, target blocks, and
  receipts. `RPC_URL` remains the startup, subscription-liveness, and
  post-block observation client rather than a duplicate planning path. The
  same signal wakes private target-block finalization. A typed
  receipt-not-found publication race is retried for one bounded second; other
  receipt errors remain terminal.
- `ENABLE_PENDING_FUNDING_BACKRUNS`: enables the hash-only filtered Alchemy
  `alchemy_pendingTransactions` watcher. It requires `WS_URL` and
  `SUBMISSION_MODE=flashbots`, accepts only current canonical order/vault
  recipients, fetches and validates the exact raw prerequisite through
  `DISCOVERY_RPC_URL`, and has no polling or unfiltered alternative. It
  defaults to `false`.
- `ENABLE_PENDING_FWA_FULFILLMENT_BACKRUNS`: enables a separate hash-only
  coordinator subscription for the pool's exact pending FWA request. It
  derives the request ID from the fulfillment proof, verifies the canonical
  consumer/subscription and raw signed transaction, and permits only a fully
  simulated atomic private `bounded contiguous coordinator prefix → optional
  exact-count processor → sync → settle` bundle. It requires `WS_URL` and
  private submission and defaults to `false`.
- `PENDING_FUNDING_BUILDER_BID_BPS`: independent builder bid for the
  pending-funding lane. It defaults to 1000 bps and deliberately does not
  inherit or update the much higher confirmed-head standing-order adaptive
  state.
- `HEAD_STALE_TIMEOUT_MS`: maximum wait for a subscribed head before HTTP is
  consulted as a liveness assertion. If HTTP has advanced, the subscription is
  treated as broken and the worker exits for a supervised restart.
- `DISCOVERY_RPC_URLS`: independent read-only fallback endpoints for bulk
  opportunity research so large scans cannot delay the production keeper loop.
  The singular `DISCOVERY_RPC_URL` remains supported as an override and is
  also used for the Stake DAO registry's historical log scan; current state
  and final simulations remain on `RPC_URL`.
- `DISCOVERY_CONCURRENCY` and `DISCOVERY_VAULT_CHUNK_SIZE`: bound RPC pressure
  from the Maker vault inspector invoked with `npm run inspect:maker-barks`.
  Active Maker auctions can be checked independently with the read-only
  `npm run inspect:maker-redos` command.
- `BLOCK_POLL_MS`: new-head polling interval when `WS_URL` is absent and retry
  delay after a failed planning pass.
- `ENABLE_POOL_LIFECYCLE`: enables paid PullPool lifecycle calls.
- `ENABLE_BUYBACK`: enables the conditional FWAToken buyback caller reward.
- `ENABLE_DIRECT_COINBASE_PAYMENTS`: permits a pinned, exact-verified
  receive-only helper as the mandatory final transaction of a
  standing-order-only private bundle when the requested builder bid cannot be
  expressed under `MAX_FEE_PER_GAS_GWEI`. The value fills only the existing
  bid target, remains bounded by the aggregate profit floor, reserves signer
  balance, and is included in receipt P&L. Startup verifies the helper runtime
  hash; exact bundle simulation must report the intended direct and aggregate
  coinbase payments. It defaults to `false` and requires private submission.
- `ENABLE_LIVE_BID_SWEEP`: retains the independently paid LiveBidAdapter lane
  for controlled research, but defaults to `false`. Its `sweep()` succeeds
  with zero reward when another transaction empties the adapter earlier in the
  same block, which a parent-state bundle simulation cannot reject. Do not
  enable it without an atomic nonzero-reward guard.
- `ENABLE_LIQUITY_LIQUIDATIONS`: scans the three official Liquity V2 Ethereum
  collateral branches and enables exact-simulated private liquidations.
- `ENABLE_CONVEX_EARMARKS`: refreshes the active pool registry and the 32
  highest-claimable gauges on the separate discovery RPC after non-submitting
  passes. Every head re-reads only that shortlist, current incentives, and
  oracles at the exact planning block before gas estimation and profitability
  checks. No cached reward, gas, or calldata enters final ranking.
- `ENABLE_CONVEX_KICKS`: scans the bounded set of observed unlockable vlCVX
  accounts and enables profitable exact-simulated `kickExpiredLocks` calls.
  Economics count only one reward epoch and apply a 5% CVX price haircut.
- `ENABLE_STAKEDAO_CURVE_HARVESTS`: enables the canonical Stake DAO v4 Curve
  Accountant watcher. It defaults to `false` and configuration fails closed
  unless `SUBMISSION_MODE=flashbots`.
- `ENABLE_FIRM_REPLENISHMENTS`: enables the canonical Inverse FiRM
  forced-replenishment watcher. It defaults to `false` and configuration fails
  closed unless `SUBMISSION_MODE=flashbots`.
- `POOL_BOUNTY_ESTIMATE_BPS`: conservative haircut on simulated gas when
  estimating PullPool's internal gas-indexed reimbursement for sync and settle
  work.
- `POOL_PULL_BOUNTY_ESTIMATE_BPS`: pull-specific reimbursement estimate. It
  defaults to `10000`; historical direct-pull receipts still make this
  conservative because PullPool's internal meter includes pre-call overhead.
- `POOL_SYNC_GAS_LIMIT` and `POOL_SETTLE_GAS_LIMIT`: conservative limits for
  calls that become valid only after an earlier bundled state transition.
  A dependency-blocked pull instead receives the largest protocol-valid
  envelope the signer can fund; exact bundle simulation supplies its actual
  gas and remains the submission gate.
- `FWA_PROCESS_GAS_LIMIT`: safety ceiling for the directly estimated
  permissionless acquisition processor. It defaults to Ethereum's
  `16,777,216` per-transaction protocol cap instead of imposing a lower
  economic proxy. The buffered estimate must remain below this limit, and the
  signed dependency-safe bundle is still exact-simulated and required to be
  profitable after actual simulated gas and builder payment.
- `FWA_PROCESS_MAX_COUNT`: maximum ready acquisition sequence prefix the
  keeper searches to reach its pool request. The default is `50`; the call
  must report that the full required prefix processed, remain under Ethereum's
  transaction gas cap, and pass exact bundle economics before it can be
  bundled with `syncFwaResult`.
- `BUYBACK_GAS_LIMIT`: safety ceiling for the separately estimated buyback.
- `LIVE_BID_SWEEP_GAS_LIMIT`: adapter safety ceiling; the default 250k is well
  above its observed roughly 83k–96k gas usage.
- `LIQUITY_GAS_LIMIT` and `LIQUITY_MAX_TROVES_PER_BATCH`: bound a liquidation
  transaction's buffered gas and number of troves. The default gas ceiling is
  below Ethereum's per-transaction limit.
- `CONVEX_EARMARK_GAS_LIMIT`: safety ceiling for a Convex reward harvest.
- `CONVEX_KICK_GAS_LIMIT`: safety ceiling for an expired-lock kick.
- `STAKEDAO_HARVEST_GAS_LIMIT`: cap on buffered gas for one atomic harvest
  batch.
- `STAKEDAO_HARVEST_MAX_BATCH_SIZE` and
  `STAKEDAO_HARVEST_MAX_CANDIDATES`: bound exact single/batch simulations.
- `STAKEDAO_HARVEST_REWARD_HAIRCUT_BPS`: haircut applied after converting the
  exact conservative CRV caller fee through CRV/USD and ETH/USD Chainlink
  feeds.
- `STAKEDAO_ORACLE_MAX_AGE_SECONDS`: rejects incomplete or stale Chainlink
  rounds.
- `STAKEDAO_DISCOVERY_BLOCK_RANGE`: bounds each controller event-log request;
  the process caches the complete registry and incrementally scans new blocks.
- `FIRM_REPLENISH_GAS_LIMIT` and `FIRM_MAX_CANDIDATES`: cap buffered gas and
  exact signer simulations for one pass.
- `FIRM_REWARD_HAIRCUT_BPS`,
  `FIRM_DOLA_ORACLE_MAX_AGE_SECONDS`, and
  `FIRM_ETH_ORACLE_MAX_AGE_SECONDS`: value the exact DOLA reward through
  independently fresh DOLA/USD and ETH/USD Chainlink rounds, cap DOLA at one
  USD, and apply an exit-risk haircut. The defaults allow DOLA's long
  heartbeat while limiting ETH/USD to two hours.
- `FIRM_DISCOVERY_BLOCK_RANGE` and `FIRM_BORROWER_LOOKBACK_BLOCKS`: bound the
  cached canonical DBR `AddMarket` and recent `ForceReplenish` event scans.

The Stake DAO watcher starts at the canonical ProtocolController's first
`VaultRegistered` block, filters the `CURVE` protocol id, and re-reads every
gauge's current vault and shutdown status. It reads the Accountant's live
harvest percentage and vault accounting, treats locker CRV as a lower bound
that excludes sidecar upside, and applies the configured price haircut. It
exact-simulates each single gauge plus bounded reward-ranked prefixes with
empty `harvestData`. One reverting or raced gauge invalidates only its atomic
candidate; the selected call is re-simulated as a next-block private bundle.
The bot grants no token approvals and performs no reward swaps.

The FiRM watcher reconstructs the immutable market registry from the canonical
DBR contract's `AddMarket` events and caches recent borrower/market pairs from
its `ForceReplenish` events. On every head it re-reads the positive DBR deficit,
DBR replenishment price, market incentive, and the market's pinned DBR/DOLA
relationships. It only builds `forceReplenish(account, observedDeficit)` with
the exact positive observed amount—never `forceReplenishAll`. If a competitor
reduces the deficit before inclusion, the fixed call reverts atomically rather
than accepting a smaller reward. Final planning requires exact signer
simulation and gas estimation, and receipt accounting requires the matching
DBR event, exact DOLA transfer, and exact signer DOLA balance delta.

The private alternatives contain nonce `N`, then `N+1`, and so on. Each
alternative is atomic, and the shortest alternative is raised when a plan has
dependencies. For example, a three-order coverage plan followed by `pull`
offers only the four-transaction bundle. A ready acquisition never offers its
unpaid processor alone: the minimum planning dependency is
`processAcquisitions(count) → syncFwaResult`. When an exact-simulated selected
lifecycle includes `settle` or `settleForcedEth`, settlement is also part of
the submission floor; builders are not offered a same-nonce alternative that
stops before it. A selected lifecycle without settlement retains its existing
dependency/economic floor. No losing transaction leaks into the public
mempool. Public mode deliberately disables cross-subsidized coverage and sends
only the first currently estimable paid step of a state transition.

When an older acquisition and a newer funding round coexist, the lifecycle
prefix may be extended as
`process → sync → settle(previous) → exact crank(s) → pull(current)`.
The prefix ladder starts at the complete settled lifecycle core and still
offers every longer same-nonce alternative. `pull(current)` is never offered
unless the preceding lifecycle settles and the exact crank prefix supplies
sufficient coverage. Each job retains its own bid policy, so the relay prices
the bundle with the existing reward-weighted lifecycle, order, and pull bids.

### Profit controls

- `MIN_PROFIT_ETH`: optional minimum worst-case profit for the submitted
  bundle or prefix; defaults to `0`. Production uses `0.000001 ETH` so a
  profit-capped quote must retain more than rounding dust.
- `GAS_LIMIT_MULTIPLIER_BPS`: buffer applied to `eth_estimateGas`.
- `MAX_FEE_PER_GAS_GWEI`: hard ceiling for ordinary proposed EIP-1559 max
  fees. A bundle prefix containing an adaptively priced V2 `pull` deliberately
  bypasses this ceiling and is bounded by exact simulated profitability only.
- `MAX_TRANSACTIONS_PER_PASS`: optional per-block transaction cap; `0` is
  unlimited.
- `RECEIPT_TIMEOUT_MS`: how long batch receipt monitoring waits before leaving
  unresolved transactions to pending-nonce reconciliation.

Candidate discovery first uses fixed order/buyback rewards and conservatively
estimated pool bounties:

```text
estimatedPoolBounty = min(
  simulatedGas * POOL_BOUNTY_ESTIMATE_BPS / 10_000
    * (currentBaseFee + roundBountyTip),
  roundBountyCap
)

bundleProfit =
  sum(expectedRewards) - sum(bufferedGas * proposedMaxFeePerGas)
```

Before private submission, the bot runs an ordered signed simulation and
re-prices the whole viable sequence. Each reward contributes its own desired
builder payment: standing orders use their learned target, while pool jobs use
the ready-chain, pull, or fulfilled-chain policy matching their competition
family. V2 pull competition can add a learned floor against the aggregate
bundle payment. Ordinary combined targets are capped by both the retained
profit floor and `MAX_FEE_PER_GAS_GWEI`; V2 pull-containing prefixes omit the
fee ceiling and retain only the exact profit bound:

```text
desiredBuilderPayment =
  sum(jobReward * jobBuilderBidBps / 10_000)
priorityFee = min(
  ceil(desiredBuilderPayment / totalSimulatedGasUsed),
  maximumProfitSafePriorityFee,
  maximumFeeCapSafePriorityFee # omitted for adaptive V2 pull prefixes
)
expectedProfit = grossBundleReward
               - totalSimulatedGasUsed
                 * (baseFeeAllowance + priorityFee)
```

Both checks require at least one wei of expected profit and must clear any
higher configured absolute profit floor.

### Adaptive bid feedback

`AdaptiveBidController` is lane-agnostic. Each lane supplies its own policy,
durable scope, target key, effective bid, and safely normalized competitor
price. State is maintained per target because different contracts and reward
sizes can face materially different clearing percentages.

- On an order loss, the keeper finds the successful `Cranked` event in the
  target block, sums that transaction's priority payment and direct payment to
  the block beneficiary, divides by all crank fees earned by that transaction,
  and targets the result plus `ADAPTIVE_BID_STEP_BPS`. The same observation
  records receipt gas, base gas cost, and the remainder after full transaction
  gas plus direct beneficiary payment. That remainder is explicitly measured
  only against known crank fees, so it can reveal a subsidized clearing bid
  without falsely claiming the competitor's complete wallet P&L.
- A measured winner below the keeper's current bid does not cause an increase;
  that miss is more likely delivery, timing, or a state conflict.
- An unmeasured loss holds the current bid instead of blindly escalating.
- Each included target records a win. The keeper holds its bid until
  `ADAPTIVE_BID_WIN_STREAK` consecutive wins, then probes halfway between the
  lowest effective bid that has won and the greater of the policy minimum or
  highest fresh effective bid that has lost. A past measured competitor is
  retained as recovery evidence, but it cannot permanently prevent a lower
  probe after sustained wins. `ADAPTIVE_BID_DECAY_BPS` remains the minimum
  reduction for a probe.
- The bundle-effective bid after profit and fee caps—not merely the requested
  bid—is recorded in each participating order's bracket and compared with the
  competitor's aggregate transaction bid.
- An explicit persisted probe marker separates exploration from a proven
  below-starting-bid ceiling. A probe recovers immediately to its known winning
  ceiling only when a measured competitor paid at least its effective bid.
  A miss with no competitor or a cheaper winner holds the probe because more
  payment cannot fix delivery, timing, or state conflict. Price-losing probes
  retain the failed lower bound so they do not repeat the same price.
- Measured competitors remain recovery evidence for
  `ADAPTIVE_BID_EVIDENCE_MAX_AGE_BLOCKS`. A price-losing downward probe
  immediately returns above fresh measured competition, while an uninterrupted
  configured streak of cheaper wins retires contradicted evidence.
  Losing-probe evidence remains the active lower bracket until it expires or a
  lower bid wins.
- A loss at or above the starting bid still holds rather than blindly
  escalating unless a measured higher winner supplies direct price evidence.
- Partial-prefix inclusion updates each order independently: included orders
  record wins while missed orders process their observed competitors.

Pool-pull and lifecycle competition are measured separately from standing
orders. A missed pull scans the target block's `Pulled` events but accepts only
the exact missed round IDs; concurrent-round pulls are unrelated evidence. A
missed sync or settlement aggregates the winning transaction's
`CrankBountyPaid` events for that round. Both paths record the winning
transaction, cranker, gross pool
reward, priority payment, direct beneficiary payment, and a
pool-reward-normalized bid upper bound. Exact, counterfactually profitable V2
pull observations update their own adaptive scope. V1 pull and lifecycle
observations remain record-only because a wrapper transaction may earn
unrelated rewards; none contaminate standing-order state.

Direct beneficiary transfers are read from the
[Routescan internal-operations API](https://routescan.io/docs/api/transactions).
The result is an inferred transaction-level bid; if the competing transaction
contains unrelated MEV, it can overstate the portion funded by the crank.

## Production

Build and run directly:

```bash
npm run build
npm run start:prod
```

Or run the container after creating `.env`:

```bash
docker compose up -d --build
```

Use a supervised process, a dedicated RPC, and keeper-wallet balance alerts.

## Risks and limitations

- **Builder competition:** private submission removes public-mempool leakage,
  but it does not guarantee inclusion. Builder coverage, arrival time, tip,
  bundle value, and competing state changes still determine whether the bundle
  lands.
- **Bid economics:** the default 81% is the standing-order adaptive floor, not
  a permanent universal bid. Pool rewards use their separate 10% default.
  Competing keepers can still bid more, while profit and max-fee caps limit
  each signed transaction.
- **Feedback delay:** private bids are not observable before inclusion.
  Adaptation occurs after the target block and only affects later rounds.
  Internal-operation indexing can lag or be unavailable; those losses hold
  their prior bid.
- **One-block expiry:** each private bundle targets exactly the next block. A
  missed bundle is resimulated and repriced on the next pass rather than left
  pending.
- **Ordered batch state changes:** the complete signed sequence is simulated
  in nonce order, then submitted with a dependency-aware prefix floor. An
  early conflict still invalidates every longer alternative that depends on
  that nonce; the bot never permits reverts merely to consume the remaining
  nonces.
- **Public fallback:** `SUBMISSION_MODE=public` restores ordinary sequential
  broadcast. Another keeper can land first, leaving the losing transaction to
  revert and still consume gas.
- **Nonce safety:** the broadcaster stops the batch on the first submission
  error so it never intentionally creates a nonce gap. If the account already
  has pending transactions, new batches pause until those nonces settle.
- **Mutable fee:** the order owner can change `crankFee` at any time, and
  `crank()` has no keeper-supplied minimum-fee argument. A fee change between
  simulation and inclusion cannot be made atomic by this bot.
- **Mutable funding:** the owner can withdraw the order balance at any time.
- **Registry scope:** the bot deliberately executes only orders returned by
  the configured registries. Each registry and its expected pool relationship
  must be pinned before targeting another deployment.
- **Eligibility timing:** the loop reacts to confirmed heads. It can compete
  immediately once a call is eligible and can create its own atomic
  order-to-pull transition. Separate exact pending lanes cover a final public
  ticket purchase and the canonical VRF fulfillment that self-processes the
  pool's FWA acquisition. Arbitrary public FWA processor calls outside those
  validated dependencies are not backrun.
- **Deliberate lifecycle scope:** the keeper executes only caller-paid
  lifecycle work, except that it may cross-subsidize FWA's public, unpaid
  acquisition processor when the same private bundle unlocks profitable pool
  bounties. It does not run unpaid `voidRound`, sweeps, or claims.
- **Buyback market state:** a positive FWAToken ETH balance is not sufficient;
  the buyback is attempted only when `eth_estimateGas` also clears its delay,
  liquidity, and price-limit checks.
- **Adapter sweep state:** a sweep requires buffered ETH, an elapsed cooldown
  when throttled, an exact nonzero caller reward, successful gas estimation,
  and positive worst-case profit. It never sends keeper ETH or grants token
  approvals.
- **Liquity reward accounting:** the strategy treats only the fixed 0.0375 WETH
  per successfully liquidated trove as revenue. The additional collateral
  compensation is upside, not a prerequisite. Calls require no keeper
  principal or token approval and are submitted only after exact simulation.
- **Convex reward accounting:** the caller's 0.5% share of pending CRV is
  converted to an ETH equivalent with Chainlink CRV/USD and ETH/USD feeds, then
  haircutted by 5% for price movement and exit slippage. Registry reads are
  cached, and only candidates that clear a conservative gas prefilter receive
  full simulations.
- **Relay/RPC trust:** simulation and fee estimates are only as reliable as the
  configured RPC and relay. Use a dedicated RPC and configure the private
  relays/builders whose coverage you trust.
