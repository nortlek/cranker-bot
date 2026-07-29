# Pull Pool Keeper

A profit-aware Ethereum mainnet keeper for permissionless FWA maintenance. It
competes for compatible PullStandingOrder and PullVault `crank()` fees, the
PullPool lifecycle bounties
paid by `pull`, `syncFwaResult`, `settle`, and `settleForcedEth`, the public
FWA acquisition processor when it unlocks those bounties, and the FWAToken
`buyback()` caller reward. It also watches LiveBidAdapter's independently paid
`sweep()` lane and the official Liquity V2 WETH, wstETH, and rETH branches for
permissionless liquidations. It also prices Convex pool `earmarkRewards`
caller incentives and expired vlCVX lock `kickExpiredLocks` rewards. Every
candidate or dependent sequence is simulated and priced before private
submission.

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

Each new block, the keeper:

1. Reads the standing-order factory's `allOrders()` and the compatible vault
   factory's `allVaults()` registries.
2. Reads each subscription's fee and ticket count in multicalls, then simulates
   every currently callable order or vault.
3. Runs `eth_estimateGas` for `crank()` from the keeper account. Typed contract
   reverts are treated as ineligible orders.
4. Reads `roundCount` for the newest funding round and `ethPendingRound` for
   the independently resolving acquisition. It prioritizes
   `syncFwaResult → settle` for fulfilled acquisitions. When the acquisition is
   ready and is next in FWA's sequence, it builds
   `processAcquisitions(1) → syncFwaResult → settle` instead. Direct
   `settle`/`settleForcedEth` remains available for claimable rounds.
5. If the round is short of tickets, finds the least net-cost set of callable
   standing orders that covers the shortfall and appends `pull`. This allows a
   low- or zero-fee order only when the paid pull makes the complete sequence
   profitable.
6. Scans Liquity V2's official WETH, wstETH, and rETH branches for active or
   zombie troves below their branch MCR. It exact-simulates
   `batchLiquidateTroves`, budgets only the guaranteed 0.0375 WETH compensation
   per trove, and ignores variable collateral compensation when deciding
   profitability.
7. Compares the conservative net value of the PullPool/order plan, Liquity
   liquidation, Convex `earmarkRewards`, FWAToken `buyback()`, and
   LiveBidAdapter `sweep()`, then selects the best currently executable plan.
8. In live mode, reads the account's `latest` and `pending` transaction counts
   and assigns an explicit contiguous nonce range.
9. Signs the generic call sequence locally, simulates it in nonce order, and
   prices its combined rewards against combined gas. Pool bounties use the
   round's snapshotted cap/tip and a configurable reimbursement haircut.
10. Submits only economically safe contiguous prefixes as private Flashbots
   bundles for the next block. A cross-subsidized `orders → pull` sequence has
   a full-length dependency floor, so no subsidized crank is ever offered
   alone.
11. Records each relay-accepted bundle hash, target, and prefix length, then
   watches the target block and reports inclusion and realized profit. For
   missed orders it measures both priority fees and direct block-beneficiary
   payments made by the winning crank transaction, then updates that order's
   next bid. A missed bundle expires instead of entering the public mempool.

Candidate gas estimates run with bounded concurrency and retain fee-ranked
ordering. The block loop polls every 250 ms by default, so slow per-order RPC
round trips no longer serialize the critical path.

`lastRoundBought` and the pool's state remain the authoritative replay
protection. A new batch starts only when the keeper account has no existing
pending nonce gap; after a restart, this prevents the bot from duplicating
transactions that are still in flight. Competitive bid tuning is persisted
separately in `.keeper-bid-state.json`; deleting it resets every order to
`BUILDER_BID_BPS`.

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
for the signer. A replacement Railway deployment waits for the previous
instance to stop before it begins chain work, preventing rollout overlap from
racing the same account nonce. Database telemetry remains fail-open after
startup, but failure to acquire the signer lease is deliberately fail-closed.

For live execution, use a dedicated keeper EOA funded only with enough ETH for
gas:

```dotenv
RPC_URL=https://your-reliable-mainnet-rpc.example
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
  The first must support `eth_callBundle` and is used for simulation; remaining
  endpoints receive the already-simulated bundle. The default also submits
  directly to Quasar because it has recently built competing pool cycles.
  A bundle is submitted concurrently to every configured endpoint.
- `FLASHBOTS_BUILDERS`: registered builder names for relay multiplexing. The
  defaults cover several builders and can be replaced as the registry changes.
- `FLASHBOTS_AUTH_PRIVATE_KEY`: optional relay reputation key. It signs only
  relay authentication messages; when omitted, `PRIVATE_KEY` is used.
- `RELAY_TIMEOUT_MS`: timeout for relay simulation and submission calls.
- `BUILDER_BID_BPS`: starting bid and lower bound for every order. The default
  is `8100` (81%).
- `POOL_BUILDER_BID_BPS`: builder share applied only to pool lifecycle
  bounties. The default is `1000` (10%); mixed order/pool bundles weight each
  component by its own reward and bid policy.
- `LIVE_BID_SWEEP_BUILDER_BID_BPS`: builder share applied only to an adapter
  sweep. The default is `100` (1%); historical winning calls paid zero
  priority fee, so it does not inherit the standing-order bid.
- `LIQUITY_BUILDER_BID_BPS`: independent builder share for competitive
  liquidations. It starts at `8100` (81%) but remains bounded by the global
  fee cap, wallet gas reserve, and positive-profit requirement.
- `CONVEX_BUILDER_BID_BPS`: independent builder share for Convex earmarks and
  expired-lock kicks. It defaults to `1000` (10%) so thin caller incentives do
  not inherit the 81% standing-order bid.
- `ADAPTIVE_BIDDING`: enables post-block per-order bid learning.
- `ADAPTIVE_BID_STEP_BPS`: margin added above a measured winning bid after a
  loss. The default is `25` (0.25 percentage points).
- `ADAPTIVE_BID_MAX_BPS`: hard ceiling for the learned bid target.
- `ADAPTIVE_BID_WIN_STREAK`: consecutive wins required before probing a lower
  bid.
- `ADAPTIVE_BID_DECAY_BPS`: amount removed after the configured win streak.
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
- `DISCOVERY_RPC_URLS`: independent read-only fallback endpoints for bulk
  opportunity research so large scans cannot delay the production keeper loop.
  The singular `DISCOVERY_RPC_URL` remains supported as an override.
- `DISCOVERY_CONCURRENCY` and `DISCOVERY_VAULT_CHUNK_SIZE`: bound RPC pressure
  from the Maker vault inspector invoked with `npm run inspect:maker-barks`.
- `BLOCK_POLL_MS`: new-head polling interval.
- `ENABLE_POOL_LIFECYCLE`: enables paid PullPool lifecycle calls.
- `ENABLE_BUYBACK`: enables the conditional FWAToken buyback caller reward.
- `ENABLE_LIVE_BID_SWEEP`: enables the independently paid LiveBidAdapter
  fallback. `LIVE_BID_ADAPTER_ADDRESS` selects the verified adapter.
- `ENABLE_LIQUITY_LIQUIDATIONS`: scans the three official Liquity V2 Ethereum
  collateral branches and enables exact-simulated private liquidations.
- `ENABLE_CONVEX_EARMARKS`: caches Convex's active pool registry, checks pending
  gauge CRV, and enables profitable exact-simulated `earmarkRewards` calls.
- `ENABLE_CONVEX_KICKS`: scans the bounded set of observed unlockable vlCVX
  accounts and enables profitable exact-simulated `kickExpiredLocks` calls.
  Economics count only one reward epoch and apply a 5% CVX price haircut.
- `POOL_BOUNTY_ESTIMATE_BPS`: conservative haircut on simulated gas when
  estimating PullPool's internal gas-indexed reimbursement.
- `POOL_PULL_GAS_LIMIT`, `POOL_SYNC_GAS_LIMIT`, and
  `POOL_SETTLE_GAS_LIMIT`: conservative limits for calls that become valid only
  after an earlier bundled state transition.
- `FWA_PROCESS_GAS_LIMIT`: safety ceiling for the directly estimated
  permissionless acquisition processor. The 3M default accommodates complex
  result paths; private relay simulation and whole-prefix economics still
  gate submission.
- `BUYBACK_GAS_LIMIT`: safety ceiling for the separately estimated buyback.
- `LIVE_BID_SWEEP_GAS_LIMIT`: adapter safety ceiling; the default 250k is well
  above its observed roughly 83k–96k gas usage.
- `LIQUITY_GAS_LIMIT` and `LIQUITY_MAX_TROVES_PER_BATCH`: bound a liquidation
  transaction's buffered gas and number of troves. The default gas ceiling is
  below Ethereum's per-transaction limit.
- `CONVEX_EARMARK_GAS_LIMIT`: safety ceiling for a Convex reward harvest.
- `CONVEX_KICK_GAS_LIMIT`: safety ceiling for an expired-lock kick.

The private alternatives contain nonce `N`, then `N+1`, and so on. Each
alternative is atomic, and the shortest alternative is raised when a plan has
dependencies. For example, a three-order coverage plan followed by `pull`
offers only the four-transaction bundle; `sync → settle` may safely offer both
the sync prefix and the full sequence. A ready acquisition never offers its
unpaid processor alone: the minimum dependency prefix is
`processAcquisitions(1) → syncFwaResult`, and the economic prefix rises to
include `settle` if necessary. No losing transaction leaks into the public
mempool. Public mode deliberately disables cross-subsidized coverage and sends
only the first currently estimable paid step of a state transition.

### Profit controls

- `MIN_PROFIT_ETH`: optional minimum worst-case profit for the submitted
  bundle or prefix; defaults to `0`.
- `GAS_LIMIT_MULTIPLIER_BPS`: buffer applied to `eth_estimateGas`.
- `MAX_FEE_PER_GAS_GWEI`: hard ceiling for the proposed EIP-1559 max fee.
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
builder payment: standing orders use their learned target, while pool
lifecycle bounties use `POOL_BUILDER_BID_BPS`. The combined target is capped at
the priority fee that still clears the bundle profit floor and
`MAX_FEE_PER_GAS_GWEI`:

```text
desiredBuilderPayment =
  sum(jobReward * jobBuilderBidBps / 10_000)
priorityFee = min(
  ceil(desiredBuilderPayment / totalSimulatedGasUsed),
  maximumProfitSafePriorityFee,
  maximumFeeCapSafePriorityFee
)
expectedProfit = grossBundleReward
               - totalSimulatedGasUsed
                 * (baseFeeAllowance + priorityFee)
```

Both checks require at least one wei of expected profit and must clear any
higher configured absolute profit floor.

### Adaptive bid feedback

Bid state is maintained per order because orders with `0.0002`, `0.0003`, and
`0.0005 ETH` crank fees can face materially different clearing percentages.

- On an order loss, the keeper finds the successful `Cranked` event in the
  target block, sums that transaction's priority payment and direct payment to
  the block beneficiary, divides by all crank fees earned by that transaction,
  and targets the result plus `ADAPTIVE_BID_STEP_BPS`.
- A measured winner below the keeper's current bid does not cause an increase;
  that miss is more likely delivery, timing, or a state conflict.
- An unmeasured loss holds the current bid instead of blindly escalating.
- Each included order records a win. The keeper holds its bid until
  `ADAPTIVE_BID_WIN_STREAK` consecutive wins, then reduces it by
  `ADAPTIVE_BID_DECAY_BPS`, never below `BUILDER_BID_BPS`.
- Partial-prefix inclusion updates each order independently: included orders
  record wins while missed orders process their observed competitors.

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
  this factory. Set both factory and expected pool addresses when targeting a
  different deployment.
- **Eligibility timing:** the loop reacts to confirmed heads. It can compete
  immediately once a call is eligible and can create its own atomic
  order-to-pull transition, but it does not yet backrun an unrelated pending
  ticket purchase or FWA processor transaction in the same block.
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
