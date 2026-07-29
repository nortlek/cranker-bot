# Keeper Opportunity Backlog

This file is the evolving research and implementation queue. Stable operating
instructions belong in [AGENTS.md](./AGENTS.md). Every entry should contain
enough evidence for another agent to reproduce the conclusion without trusting
an old narrative.

Last updated: 2026-07-28 (America/Denver)

## Current objective and snapshot

Objective: reach at least $10 of verified net realized profit by
2026-07-29 23:59 America/Denver.

The last verified snapshot was approximately **$7.47 net**, or **74.7%** of the
goal, with `latest == pending == 143`. The lower USD value versus the preceding
snapshot is primarily the live ETH/USD conversion; net ETH equivalent was
approximately `0.00397059`. This is stale immediately after any transaction.
Re-run:

```bash
npx tsx scripts/goal-status.ts
```

before reporting progress or deploying.

## Immediate engineering queue

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

Status: implementation in the working tree; validate and deploy.

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

Status: implemented and awaiting deployment.

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

Status: needs investigation before changing the ready bid.

At round 167, a competitor directly called `processAcquisitions` with roughly
766k gas and very little visible priority payment. That transaction alone is
not enough to infer the competitor's total bid: associated sync/settle or
wrapper transactions in the same block may include a direct beneficiary
payment.

Next action:

- inspect every pool/FWA transaction in block `25635965`
- associate process, sync, settle, and wrapper calls
- inspect receipts and direct block-beneficiary transfers
- compute bid as a share of the complete lifecycle reward
- adjust `POOL_BUILDER_BID_BPS` only from the complete result

### P1 — Finish Railway GitHub-source deployment

Status: CLI deployment works; automatic source deployment is not connected.

Authenticate Railway's browser UI, connect
`https://github.com/nortlek/cranker-bot`, select the worker root, and verify
that a pushed commit deploys the exact SHA. Do not create another Railway
project. Keep the existing dedicated `cranker-bot` project.

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
