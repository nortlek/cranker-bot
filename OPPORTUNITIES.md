# Keeper Opportunity Backlog

This file is the evolving research and implementation queue. Stable operating
instructions belong in [AGENTS.md](./AGENTS.md). Every entry should contain
enough evidence for another agent to reproduce the conclusion without trusting
an old narrative.

Last updated: 2026-07-29 (America/Denver)

## Current objective and snapshot

The $50 cumulative verified net realized-profit goal was achieved before its
2026-07-30 23:59 America/Denver deadline. The 2026-07-28 America/Denver closing
snapshot was **$51.29412534 net**, or **102.58%** of the goal, with
`latest == pending == 206` and net ETH equivalent of
`0.026953131931682566`. This was measured from the original baseline and fully
net of gas, builder payments, and other fees. The earlier $10 goal was achieved
at `$11.35632645`.

The active stretch goal is **$250 cumulative verified net realized profit by
2026-07-30 23:59 America/Denver**. At 2026-07-29 10:27 America/Denver, the
verified snapshot was **$136.87995348 net**, or **54.75%** of the goal, with
`latest == pending == 420` and net ETH equivalent of
`0.072445520755321769`. An earlier full reconciliation through nonce 387 found
172 successful receipts and matched them exactly to a
`0.043126556881111625 ETH` wallet increase: 38 settles, 41 syncs, 41
processors, 5 pulls, and 47 standing-order cranks. Those attempts had no fatal,
keeper-pass, Discord, or telemetry failures; 99 private transactions expired
without inclusion and did not leak into the public mempool. Two later
ready-head provider publication races at blocks `25639595` and `25639659`
each recovered on the same block two seconds later without submission or
nonce movement.

Any recorded snapshot is stale immediately after a transaction. Re-run:

```bash
npx tsx scripts/goal-status.ts
```

before reporting progress or deploying.

## Immediate engineering queue

### P0 — Replace the standing-order bid floor with bounded price discovery

Status: deployed and measuring; follow-up correction validated locally.

The previous per-order controller started at `8,644 bps` and could learn upward,
but its downward decay stopped at that same value. In the 24 hours ending
2026-07-29 09:05 America/Denver, 67 successful standing-order receipts earned
`0.0139 ETH` gross, spent `0.012741551037910720 ETH`, and retained only
`0.001158448962089280 ETH`. Several targets accumulated three to seven
consecutive wins without changing their bid. Durable competitor measurements
also showed distinct clearing levels: some targets required `8,956–9,429 bps`,
while others recently cleared at `941`, `1,366`, and `3,850 bps`.

New targets still begin at the configured standing-order bid. After the
configured consecutive-win streak, each target now bisects its durable bracket
between the lowest effective bid that has won and the greater of a `1,000 bps`
hard minimum, the highest effective bid that has lost, and its last measured
competitor plus the configured margin. Learning compares the exact
profit-capped bundle-effective bid—not merely the requested bid—with the
competitor's aggregate transaction bid. An explicit durable probe marker
distinguishes exploration from a proven below-starting-bid ceiling. A measured
higher winner raises the target immediately; a price-losing or unmeasured
failed probe returns to the known winning ceiling (or the starting bid when no
ceiling exists) and retains the failed lower bound so the same price probe is
not repeated. Competitor and losing-probe evidence expires after `7,200`
blocks; a single lower-effective win cannot erase fresh evidence. State below
the starting bid, probe phase, and bracket bounds remain durable across
restarts. Every attempt remains private, exact-simulated, profit-capped, and
gas-free when it misses.

Measure retained profit, target-specific inclusion, and recovery speed before
changing the hard minimum or the existing maximum.

Deployment `3411c130-67e6-43c5-91a9-c7ae9f11d631` first missed a five-order
private batch at an effective `6,342 bps`, then won consecutive five-order
batches at `6,293` and `6,898 bps`. The wins added
`0.000181109044245335 ETH` net after receipts. Durable state also exposed one
order with three full wins as low as `3,318 bps` while a four-hour-old
`8,659 bps` competitor observation still blocked probing until the observation
aged for `7,200` blocks. The follow-up controller retains a single cheaper win
as weak evidence, but after an uninterrupted configured streak in which every
effective winning bid is cheaper, it retires the contradicted competitor
observation and resumes bounded bracket search. Misses remain private and
gas-free.

### P0 — Make the live signer lease continuously fail-closed

Status: implemented and validated; deploy after the nonce/lifecycle gate.

The original PostgreSQL advisory lease failed closed only during acquisition.
PostgreSQL releases a session-level advisory lock when its connection ends, but
the worker did not re-check the lock after startup. A severed lease connection
could therefore release the lock while the old process continued signing and a
replacement acquired it.

The lease now verifies its exact two-integer advisory-lock row in `pg_locks`
before each live pass and again immediately before public or private
submission. A missing connection or lock records `signer_lease_lost`, stops the
signer, and exits instead of degrading into a retry loop. Live startup now also
requires `DATABASE_URL`; the previous warn-and-sign-without-a-lease path is
removed.

### P0 — Repair lifecycle funding enrichment and pool-pull bidding

Status: implemented and validated; deploy and measure.

Across 58 live lifecycle plans, 36 successfully appended a next-round
`pool_pull`, but none submitted that suffix. Every pull used the static
`500,000` gas envelope and preliminary exact simulation truncated the bundle.
The same pulls, once directly estimable, required buffered limits from
`616,636` to `2,934,132` gas, with an `860,214` median. The static envelope is
now `3,000,000`; actual gas, economics, and every final signed prefix remain
exactly simulated.

Standalone pulls won only 5 of 48 target blocks. Competitors pulled in 38 of
the 43 misses, paying a median `1,872 bps`, p90 `1,998 bps`, and almost always
using a direct block-beneficiary transfer. The pool-pull lane is therefore
bounded at `2,000 bps`. Repricing all 48 historical quotes at that level left a
minimum expected profit of `0.00069927 ETH` and a median of
`0.00095048 ETH`. Ready and fulfilled lifecycle bids remain unchanged.

### P0 — Replace polling and synchronous full scans on the hot path

Status: exact-head prefiltering, phase telemetry, the strict WebSocket head
path, and the first background cold-planner cache are implemented.

The worker is network-bound, not compute-bound:

- Railway usage averaged about `0.019 vCPU` and `0.276 GB` RAM.
- Head-to-submission was p50 `2.01 seconds` and p90 `3.10 seconds`.
- Before the WebSocket change, production polled every `2,000 ms`. Block
  timestamp age is not publication latency: a controlled 12-sample comparison
  found the public and authenticated endpoints on the same head in every
  sample. The authenticated endpoint had a faster standalone `getBlock` p50
  (`80 ms` versus `125 ms`) but was slower in three full planning passes
  (`2.56 seconds` versus `2.36 seconds`), so the public HTTP endpoint remains
  authoritative.
- Production discovery traffic is now separated onto the authenticated
  endpoint instead of sharing the latency-sensitive primary endpoint.
- A read-only pass took `2.61 seconds` with every lane, `1.81 seconds` without
  Convex, and `1.42 seconds` with only pool/orders.
- The minimal pass still simulated 61 orders even though almost all reverted
  `InsufficientBalance` or `AlreadyBought`.

The first bounded reduction batches authoritative standing-order native
balances and compatible `lastRoundBought` values through Multicall3 at the
exact planning block. For an open round, a standing order is simulated only if
its balance can cover at least one ticket plus the caller fee and a compatible
order/vault has not already bought. Vaults are never rejected from native
balance because they may fund through their underlying asset. Exact
simulation, gas estimation, and economic checks remain mandatory for every
retained candidate. At round 257 this reduced 61 standing-order candidates to
one and reduced three-pass average planning time from `2,111 ms` to `1,526 ms`
(about 28%).

The bundle sender now retains the successful preliminary prefix simulation
instead of repeating the same relay call only to recover gas. The final
competitively priced signed bundle still undergoes exact simulation.

The first production telemetry sample also proved that `"latest"` is not a
stable planning identifier behind the load-balanced RPC: `eth_blockNumber`
reported block `25638975` while the immediately following
`eth_getBlockByNumber("latest")` returned `25638974`. Core pool state, round
snapshots, order/vault registries, prefilters, and lifecycle simulations are now
pinned to the exact block first observed by the loop. A head that cannot be
fetched is retried; a plan is discarded if a newer head exists before nonce
gating, and a bundle is discarded if its target block arrives before relay
submission.

`WS_URL` now drives the production head wake-up while the public HTTP endpoint
continues to fetch authoritative exact blocks and perform every simulation and
staleness check. This is deliberately not a silent polling fallback: after
`HEAD_STALE_TIMEOUT_MS`, HTTP asserts liveness; if it proves the chain advanced
without a subscribed head, the worker exits for Railway to restart it. A local
three-head validation observed the subscribed heads and began their planning
passes in the same millisecond; `RUN_ONCE` and explicit shutdown both closed
the shared viem socket client without leaving a process behind.

Per-planner timing then identified the next critical path rather than assuming
it: in a representative full pass, Convex earmark discovery took `1,246 ms`,
Liquity `585 ms`, and order enumeration `248 ms`. Convex now refreshes its
active registry and 32 highest-claimable gauges atomically on the separate
discovery RPC after a non-submitting pass. The hot path never waits for a cold
cache: a cold lane skips immediately, refresh failure keeps the previous
complete snapshot, and every shortlisted gauge's claimable CRV, current
incentive, oracle values, and gas remain pinned to the exact head. Cached
reward, gas, profitability, and calldata are prohibited.

Local production-shaped validation measured the cold full Convex scan at
`1,238 ms`, the background refresh at `662 ms` outside the pass, and the next
head's exact shortlist validation at `414 ms`. A representative whole planning
pass fell from `1,688 ms` to `1,045 ms` (about 38%). These timings are now
emitted once per pass as `keeper_planner_timing`.

The first live WebSocket window also exposed cross-provider publication skew:
three subscribed heads reached Alchemy before the public HTTP endpoint could
serve the same numbered block, causing a full two-second pass retry. The
authoritative fixed-block read now retries only viem's classified
`BlockNotFound` error at 100 ms intervals for up to one second and emits
`blockReadAttempts` plus `blockAvailabilityWaitMs`. It does not substitute
`latest`, switch providers, or retry unrelated RPC failures.

The header-read fix exposed a second phase of the same publication race. At
blocks `25639595` and `25639659`, the exact header became available after five
and six attempts, but the provider briefly returned RPC `-32602` with the
specific detail `Missing or invalid parameters.` for pinned state calls.
Reprocessing the identical block two seconds later succeeded. Planning now
retries only that exact nested viem error against the same pinned block, for at
most ten 100 ms waits. It never changes the block or provider, and unrelated or
persistent invalid-parameter failures still fail closed. Successful waits emit
`planning_state_availability_waited` and planning attempt/wait fields.

Live timing then exposed a separate zero-submission delay. At block
`25639710`, the exact ready-chain simulation correctly rejected the bundle
because its `0.001134976261628922 ETH` gross reward could not cover
`2,459,456` gas at the current base fee even with no builder payment. The relay
sender returned zero transaction hashes, but the strategy still waited for the
nominal target block and stretched the no-submission pass to `14.24 seconds`.
Private target-block receipt waiting is now conditional on at least one
submitted transaction, so an economically rejected quote returns immediately
and the next head remains available for replanning.

Next actions, in order:

1. Move Liquity discovery to a conservative near-MCR background watchlist,
   while retaining exact-head price/status/ICR/gas validation.
2. Replace per-pass factory enumeration with an event-maintained order/vault
   registry; measured expected savings are about 75–80 ms normally, below the
   Convex and Liquity work.
3. Move receipt finalization, competitor tracing, and adaptive-bid persistence
   behind a bounded observer queue so the signer can process the next head.

Do not add another head provider or polling path without measured evidence.
The HTTP liveness assertion is a watchdog, not a second head selector.

### P1 — Add correlated, typed attempt and outcome telemetry

Status: pass/relay instrumentation implemented; typed schema and normalized
economics pending.

The append-only JSON event stream is a useful audit log, but it cannot cleanly
attribute latency, relay delivery, or sequence-level realized economics.
`keeper_runs.git_sha` is also null for current CLI deployments.

Every pass now carries an asynchronous `passId` and observed block through all
structured events. Monotonic events report head/fee fetch, planning, account
gate, preliminary and competitive signing/simulation, first relay acceptance,
every relay-prefix result by numeric alias, full relay wait, and total pass
duration. Relay errors are categorized without logging credential-bearing
URLs.

Next add `plan_id`, `job_id`, `variant_id`, and `relay_submission_id`; endpoint
aliases and per-RPC-method instrumentation; and raw wei/gas in typed
`numeric(78,0)` columns. Add `keeper_passes`,
`keeper_attempts`, `keeper_bundle_variants`, `keeper_relay_submissions`, and
`keeper_outcomes` fact tables while retaining `keeper_events` as the audit
stream.

Sequence outcomes must report aggregate reward, base-fee burn, priority/direct
builder payment, and realized net. Per-transaction figures remain components:
a uniformly priced cross-subsidized bundle can make one receipt look
loss-making even when that call belongs to the most profitable aggregate
prefix. Add startup reconciliation of unresolved sent hashes and persist
deployment SHA, source digest, policy fingerprint, region, and image digest.

### P2 — Keep TypeScript and Railway; do not deploy an executor yet

Status: decision recorded; revisit only with contrary measurements.

TypeScript/Node is appropriate for the current I/O-bound workload. CPU stays
below `0.03 vCPU`, while remote head, RPC, simulation, and relay calls consume
seconds. A Rust or Go rewrite would add economic and ABI/receipt risk while
recovering milliseconds at most.

Railway is not the measured bottleneck and the single-worker/PostgreSQL-lease
topology has produced healthy takeovers and material profit. Keep it while
instrumenting provider/relay latency. Then compare read-only shadow probes from
US West, US East, and Europe before moving the sole signer. Add a CI gate,
source-SHA injection, pinned Node image digest, and a health signal for last
head/pass, lease, and nonce. Do not run active-active signers.

Do not deploy a keeper executor now. Consolidating a three-call ready cycle
saves at most `42,000` intrinsic gas before wrapper and reward-forwarding
overhead—about 2.3% of observed cycle gas—and a monolithic call would have
forfeited five profitable two-call partial-prefix wins in the audited sample.
It also makes the contract the bounty recipient, creating forwarding, custody,
code-hash, audit, and receipt-accounting work. Revisit a minimal non-upgradeable
executor only if fork replays prove a material advantage for a specific lane;
preserve same-nonce variants for every safe prefix and prohibit arbitrary
calls, delegatecall, approvals, retained balances, and public submission.

### P0 — Discover and support the announced PullPool V2

Status: announced as nearly finished; no deployment or canonical source
identified yet.

On 2026-07-28, [the pool author reported](https://x.com/ripe0x/status/2082297793478082570)
that subscriptions are filling new pools almost as soon as they open and that a
V2 pool contract is nearly finished, with higher capacity and support for
running more pools more often.

This has two immediate implications:

- Current funding and lifecycle windows are becoming more latency-sensitive.
- A single pinned V1 pool/factory will miss V2 revenue if V2 uses new
  deployments, registries, ABIs, lifecycle states, or reward formulas.

Next action:

- monitor the known deployer/factory and the author's canonical channels for
  verified V2 bytecode, source, deployment transactions, and addresses
- diff V2 against the current pool, order/vault factories, FWA processor, and
  reward accounting
- determine whether subscriptions migrate, whether V1 remains active, and how
  multiple concurrent pools are enumerated
- refactor discovery/planning toward a verified pool registry or versioned
  adapters instead of blindly replacing the pinned V1 constants
- create read-only V2 inspection and historical competition tooling before
  enabling live execution
- add exact sequence simulation, independent V2 bid scopes, telemetry, and
  startup relationship checks

Do not guess an address from social posts or deploy against unverified
bytecode. Keep V1 live while V2 is researched unless authoritative on-chain
state says otherwise.

### P0 — Reduce acquisition lifecycle latency

Status: deployed in `7175815`; continue measuring.

The ready acquisition path has a short competitive window. `planJobs` should
read the acquisition lifecycle first and return a profitable lifecycle plan
before waiting for order registries, Liquity, Convex, buyback, and sweep scans.
The processor simulation and gas estimate can run concurrently.

Acceptance:

- ready/fulfilled lifecycle behavior and minimum viable prefixes are unchanged
- typecheck, tests, build, and `git diff --check` pass
- a no-lifecycle dry run remains healthy
- deployment acquires the signer lease and continues passing
- subsequent live lifecycle logs show reduced planning latency

### P0 — Optimize marginal standing-order inclusion

Status: deployed; continue measuring aggregate prefix outcomes.

A recent three-order bundle was aggregate-positive but contained two
individually loss-making `0.0001 ETH` receipts. Durable bid telemetry proved
that the individual receipt view was misleading: the bundle uses one uniform
gas-normalized priority fee. At the required 86.44% aggregate builder payment,
the three-job prefix retained about `0.0000407 ETH`, while the `0.0003 ETH`
job alone would have retained only about `0.0000316 ETH` after re-pricing its
builder payment.

The builder stage now prices every dependency-safe contiguous prefix using its
exact simulated gas, reward-weighted builder policy, and independent fee quote,
then chooses the prefix with the highest aggregate expected net. This preserves
the observed profitable three-job case while pruning a suffix only when the
re-priced bundle would actually retain less profit. Orders required to unlock a
profitable pool `pull` remain protected by the full dependency floor.

Acceptance:

- unit tests cover both a genuinely negative suffix and the observed
  individually-negative-but-aggregate-beneficial case
- cross-subsidized `orders -> pull` dependency floors remain intact
- logging explains excluded marginal jobs

### P1 — Reconstruct full FWA ready-cycle competition

Status: investigated and acted on.

The incumbent processor is not paying the public core-FWA cost. It calls the
official `FWAVRFService` at
`0xa084c33Fb7a467307452898b8D58165ebd2E5D9f`, whose allowlisted operator path
reimburses acquisition gas. In block `25636032`, its processor received
`0.000151422516 ETH` against about `0.000146243145 ETH` of transaction gas.
The service exposed about `26.98 ETH` of available processor surplus at the
time of inspection. Our keeper is not currently an authorized operator, so it
must continue using the public core FWA path unless the service owner calls
`setOperator(0xeAaf34AEaF4A10F9c5f5400E0bD6f9f5a8Ba2D48, true)`.

The same competitor's pool wrapper collected the sync and settle bounties and
paid the Titan beneficiary exactly 2.5% of gross, with no material priority
fee. Our lost round-169 bundle offered 10%, so the primary problem was delivery
or latency rather than an insufficient bid.

Action taken:

- added direct Titan and Beaver relay delivery alongside Flashbots and Quasar
- retained the 10% ready-cycle policy while collecting more evidence
- won the full round-171 and round-172
  `processAcquisitions -> syncFwaResult -> settle` bundles in Titan-built
  blocks, netting `0.001007735370452469 ETH` and
  `0.000991136629002709 ETH` respectively after all gas
- Titan's direct bundle tracer marked both full bundles `Submitted`, with
  builder payments of about `0.000100994 ETH` and `0.000101023 ETH`
- asked the operator to pursue FWAVRFService allowlisting for the keeper

Next action: if allowlisting is granted, add an operator-checked sponsored
processor path that verifies the service's FWA address and accounts for the
decoded `AcquisitionsSponsored` reimbursement. Never attempt the service call
while `operators(keeper)` is false.

### P1 — Finish Railway GitHub-source deployment

Status: CLI deployment works; automatic source deployment is not connected.

Authenticate Railway's browser UI, connect
`https://github.com/nortlek/cranker-bot`, select the worker root, and verify
that a pushed commit deploys the exact SHA. Do not create another Railway
project. Keep the existing dedicated `cranker-bot` project.

### P2 — Inverse FiRM forced replenishments

Status: implemented and mainnet dry-run validated in the working tree, but not
committed, deployed, or enabled. It remains default-off because the lane is
extremely competitive and worth only small cumulative revenue.

The verified Inverse FiRM wBTC market at
`0x48BA574Edf0bc4E2E40B529863aaA6a67c264E7C` permits anyone to replenish a
borrower's DBR deficit and pays the caller DOLA. The recurring borrower
`0x52555b437EeE8F55a7897B4E1F8fB3e7Edb2b344` accrues about `3.12863 DBR`
of deficit per hour against roughly `27,406.6 DOLA` of debt. The safe call is
`forceReplenish(user, observedDeficit)`, never `forceReplenishAll(user)`.
The fixed amount is deterministic and race-safe: a smaller remaining deficit
reverts instead of silently reducing the payout.

At validation time:

- DBR `replenishmentPriceBps` was `5475` and the market replenishment
  incentive was `1000`
- caller reward was
  `floor(floor(amount * 5475 / 10000) * 1000 / 10000)` DOLA
- a signer simulation estimated `215,919` gas before the keeper's first DOLA
  receipt; established winners typically used about `193,673` gas
- the last 100,000 blocks contained 1,813 `ForceReplenish` events, 1,768 for
  this borrower, with only three replenishers
- this borrower's median replenishment interval was 45 blocks and the last 50
  winners retained a median of only about `$0.00164` after gas and tips
- a 10% builder bid was above the observed median effective bid but below its
  tail; total theoretical retained value was only about `$0.21/day` even if
  every opportunity were captured

The current implementation reconstructs the canonical market and recent
borrower registry from bounded, incrementally cached DBR events. It re-reads a
positive deficit, market relationships, price, and incentive; encodes only the
fixed observed amount; exact-simulates and estimates gas from the signer; and
uses an independent builder bid for a private single-transaction plan. DOLA is
valued through separately fresh DOLA/USD and ETH/USD rounds, capped at one USD,
and haircutted. Receipt accounting requires matching DBR event fields, the
exact DOLA transfer, DOLA balance delta, and gas cost. Goal reconciliation now
uses the same cap, freshness rule, and haircut for any DOLA balance. Repeated
planning opportunities stay in structured telemetry but do not generate
Discord embeds; submissions, receipts, and failures still do.

The enabled mainnet dry run at block `25,636,263` reconstructed 45 unique
markets and three recent borrower/market pairs. Two positive-deficit candidates
passed exact signer simulation but were rejected as unprofitable; the third had
zero deficit. No transaction was signed or sent.

Pre-enable blockers:

- Move the initial multi-million-block DBR market scan off the
  latency-sensitive per-head planning path, or persist/warm its canonical
  registry before FiRM participates in live selection.
- Make cross-lane ranking compare final bid-aware retained profit consistently
  across FiRM and existing alternatives; the current pre-bid ranking is not a
  sufficient basis for enabling this extremely thin-margin lane.

Keep this default-off until those blockers are resolved and the higher-value
FWA streak ends. It is a useful background lane, not a material path to the
active goal.

### P2 — Aladdin permissionless harvest monitoring

Status: one recurring lane identified, but raw execution is unsafe; the other
reviewed lanes are access-gated or pay no caller bounty.

The Concentrator Harvester diamond at
`0xfa86aa141e45da5183B42792d99Dede3D26Ec515` requires `2,500 veCTR` locked
for at least one year. The keeper is not authorized, and obtaining the lock
would have cost about `0.1244 WETH` at validation time, so this path is outside
the capital-free and approval boundary. CLever USD harvests are permissionless,
but all four deployed contracts had `bountyPercentage == 0`, making them
economically useless to an external caller.

A permissionless Aladdin Concentrator sdCRV Stake DAO Gauge Wrapper harvest
remains worth monitoring:

- contract `0x09B0E3A114135F528F762DB8363b4f5eae3F3bF1`
- canonical deployment and source are
  [Aladdin's pinned mainnet manifest](https://github.com/AladdinDAO/aladdin-v3-contracts/blob/b8d232ba31abd2c815f5662e0bd99d26e09dd79a/deployments/mainnet/Concentrator.StakeDAO.json)
  and
  [`ConcentratorSdCrvGaugeWrapper.sol`](https://github.com/AladdinDAO/aladdin-v3-contracts/blob/b8d232ba31abd2c815f5662e0bd99d26e09dd79a/contracts/concentrator/stakedao/sdcrv/ConcentratorSdCrvGaugeWrapper.sol)
- function `harvest(address receiver)`
- caller reward is 0.5% of active rewards, observed as CRV and crvUSD
- the validation snapshot offered only about `$0.00729` against roughly
  `$0.03986` of gas, so it was not executable
- 139 harvests in the preceding 50,000 blocks paid about `$13.85` of aggregate
  caller bounty over roughly 6.95 days; one helper won 98 of the latest 100

The call has no minimum-bounty argument. If a competitor harvests first, a
stale raw EOA call can still succeed for zero reward and burn gas. Do not add
raw execution. A future implementation needs a reviewed atomic balance-delta
guard that reverts on inadequate received tokens, or an equivalent protocol
primitive, before private submission can be considered safe.

### P2 — Read-only operations dashboard

Status: design outlined; not implemented.

Create a separate Railway web service backed by a read-only PostgreSQL role.
Recommended endpoints/views:

- current goal and reconciled P&L
- successful, failed, and expired bundles
- event timeline and job filters
- competitor bid observations
- adaptive bid state
- process/deployment health

Do not expose the signer key, write-capable database URL, RPC credentials, or
webhooks. Label decoded realized values separately from estimates.

## Active strategies

### PullStandingOrder and PullVault cranks

Status: live.

Competition is strong. Historical pull competition was roughly 593 bps median,
773 bps p75, with recent specialists near 1243–1450 bps. Individual
standing-order bids are adaptively learned and persisted in PostgreSQL.

Priority work is marginal-profit selection, not simply raising the global bid.

### PullPool/FWA lifecycle

Status: live.

Lifecycle routing:

- ready: `processAcquisitions(count) -> syncFwaResult(round) -> settle(round)`
- fulfilled: `syncFwaResult(round) -> settle(round)`
- funding: selected orders/vaults followed by `pull`

Historical ready chains appeared near 859–995 bps; fulfilled sync/settle work
appeared near 248 bps, while public calls were roughly 256–432 bps. Current
production policy is intentionally separate per lifecycle. Reconstruct complete
winning sequences before drawing a fresh conclusion from one transaction.

Round 191 exposed a cross-round fast-path gap. At head block `25636285`, the
round-191 acquisition was `ready`, round 192 was open, and standing order
`0x8BD89DFe160925f28db6202C20F8e9401e0dd47F` exactly simulated for one
ticket and a `0.0005 ETH` fee. The keeper returned its three-job lifecycle
plan before funding discovery. In target block `25636286`, a competitor
cranked that order at transaction index 97 and paid the Titan beneficiary
`0.000474888539024186 ETH` (94.98% of the fee). Our included contiguous
`processAcquisitions(1) -> syncFwaResult(191) -> settle(191)` transactions
followed at indexes 107–109. Another competitor pulled round 192 in block
`25636287`, earning the `0.0015 ETH` pull bounty and paying
`0.000295503424785014 ETH` directly to the beneficiary.

No searcher atomically combined lifecycle, funding crank, and pull in one
sequence across rounds 188–195, but rounds 188–191 repeatedly settled one
block before the already-covered next round was pulled. The keeper therefore
preserves immediate lifecycle planning while concurrently revalidating a
bounded high-fee order cache at the same head. A result available within 75 ms
extends the existing prefix ladder with exact funding cranks and a covered
pull; slow, stale, unavailable, or uncovered discovery falls back to the
unchanged lifecycle-only prefixes. Lifecycle, standing-order, and pull bids
remain reward-weighted under their existing independent policies.

### FWAToken buyback

Status: live, exact-simulated.

Keep enabled only under the shared profitability and bundle-simulation gates.
Revisit if it becomes a material source of opportunities or repeated scan
latency.

### LiveBidAdapter sweep

Status: live.

Historical sweep winners paid nearly zero priority fee. It therefore has an
independent low builder bid and must not inherit the standing-order bid.

### Liquity V2 liquidations

Status: live watcher for official WETH, wstETH, and rETH branches.

Budget only the guaranteed fixed WETH compensation in the eligibility model;
variable collateral compensation is upside until decoded. Maintain exact batch
simulation and a lane-specific competitive bid.

### Convex earmarks and expired-lock kicks

Status: live watcher.

Rewards are thin and use an independent bid. Keep contract/event decoding
current and do not treat an estimated token equivalent as realized P&L.

### Stake DAO v4 Curve Accountant harvests

Status: implemented and mainnet-validated, default-off.

Canonical Ethereum mainnet contracts:

- ProtocolController:
  `0x2d8BcE1FaE00a959354aCD9eBf9174337A64d4fb`
- Curve Accountant:
  `0x93b4B9bd266fFA8AF68e39EDFa8cFe2A62011Ce0`
- Curve Strategy:
  `0xb010C392F9572aEb5Ea3817e94DC6745421b2bb5`
- Curve Locker:
  `0x52f541764E6e90eeBc5c21Ff570De0e2D63766B6`

The Accountant's permissionless `harvest(gauges, harvestData, receiver)` pays
the receiver its configured harvest fee in CRV. The live fee observed during
implementation was `0.1%`. A recent 10-gauge winning transaction harvested
about `5,312.159145 CRV`, paid about `5.312159 CRV` to the caller, and used
`2,696,607` gas. Smaller winners can be marginal, so batches must be selected
by exact simulation and total net value rather than by raw claimable CRV.

Implementation constraints:

- discover all Curve gauges from canonical `VaultRegistered` events and verify
  current vault/shutdown state on every pass
- use the live Accountant fee and vault accounting; ignore sidecar reward
  upside in the eligibility floor
- convert CRV through canonical Chainlink CRV/USD and ETH/USD feeds, reject
  stale/incomplete rounds, and apply a configurable 5% haircut
- simulate each high-value single gauge and bounded reward-ranked batch with
  empty `harvestData`
- cap buffered gas at 5M by default and send one atomic transaction only
- submit through private Flashbots bundles only, with an independent builder
  bid; never fall back to the public mempool
- decode actual `Harvest` events for CRV reward and P&L telemetry
- do not approve, swap, or otherwise move the received CRV

The validation pass found 344 Curve registrations, 301 active gauges, and ran
35 exact simulations. Its best six-gauge candidate was worth about
`0.000147311 ETH` after the configured CRV haircut, with a buffered gas limit
of `2,327,328`; no transaction was sent. Keep the lane default-off while this
margin is thin. Enable only when the exact conservative net is comfortably
positive and the stale-harvest race behavior has been confirmed or protected
by an on-chain minimum-reward guard.

## Promising dormant opportunities

### Liquity V1 liquidations

Status: read-only inspector exists; no currently eligible trove at last scan.

Economics: exact 200 LUSD gas compensation plus 0.5% of liquidated collateral.
The last scan's lowest individual collateral ratio was about 442%, so there was
no immediate action.

Next action:

- build an event/block-driven candidate watcher rather than a costly full scan
- simulate exact liquidation calls
- price LUSD and collateral conservatively
- study recent liquidation competition
- start with a lane-specific bid model around 25–35% of gross only if current
  history supports it; do not inherit the standing-order 81% bid

### PoolTogether prize claims

Status: draw 24 economically exhausted; revisit at the next draw.

Canonical reconstruction found 1,339 winners, 1,337 claimed, and two unclaimed
tier-5 prizes that were uneconomic at then-current gas. The existing signer
historically executed nine atomic claim/withdraw bundles covering 1,008 prizes:

- WETH rewards: about `0.004265803008657456`
- gas: about `0.003902227210558839`
- net: about `0.000363575798098617 ETH`

Future implementation should:

- index winners directly from the TwabController/canonical contracts
- check `isWinner`/claim state on-chain
- atomically claim and withdraw rewards in a private bundle
- exact-simulate and price the full sequence
- avoid relying on the stale official winners CLI (which stopped at draw 23)
  or the unavailable Goldsky endpoint observed during research

The keeper's current WETH balance is already included by
`scripts/goal-status.ts`.

## Investigated and rejected or inactive

Revalidate only when protocol state or incentives materially change:

| Opportunity | Last conclusion |
| --- | --- |
| Maker `bark`/auction `redo` | No active profitable candidates |
| Aura earmarks | Relevant system shut down/inactive |
| Beefy harvests | No profitable candidates at observed gas/reward |
| Gravita | Inactive for this keeper model |
| Prisma | Inactive for this keeper model |
| Synthetix maintenance | Inactive/no suitable caller reward |
| Aladdin harvests | Required unwanted capital lock or approval exposure |
| Origin maintenance | No permissionless caller reward |

Keep the supporting read-only scripts where they remain useful. Do not enable a
live path just because a call is permissionless; it needs a measurable,
capturable caller reward and positive post-cost economics.

## Opportunity research template

Copy this section for a new candidate:

```markdown
### Protocol / action

Status: idea | researching | dry-run | live | rejected | dormant

Canonical contracts and chain:

Permissionless action:

Exact caller reward:

Eligibility frequency and current candidates:

Recent winning transactions and builder payments:

Gas, token conversion, capital, approval, and revert risks:

Inspector / implementation files:

Evidence-backed conclusion:

Next action and acceptance criteria:
```
