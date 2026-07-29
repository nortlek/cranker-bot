# Keeper Opportunity Backlog

This file is the evolving research and implementation queue. Stable operating
instructions belong in [AGENTS.md](./AGENTS.md). Every entry should contain
enough evidence for another agent to reproduce the conclusion without trusting
an old narrative.

Last updated: 2026-07-28 (America/Denver)

## Current objective and snapshot

Objective: reach at least $50 cumulative verified net realized profit by
2026-07-30 23:59 America/Denver, measured from the original baseline and fully
net of gas, builder payments, and other fees. The initial $10 goal was achieved
at `$11.35632645`.

The last verified snapshot was approximately **$21.14 net**, or **42.3%** of
the active goal, with `latest == pending == 163` and net ETH equivalent of
approximately `0.01116625`. This is stale immediately after any transaction.
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

Status: validated live and capital-free; default-off because the lane is
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

Implementation should discover DBR markets and borrowers from canonical
events, snapshot a positive fixed deficit, re-read live price/incentive and
market relationships, exact-simulate and estimate gas from the signer, value
DOLA conservatively, and submit only a private next-block single-transaction
bundle. Receipt accounting must require the matching `ForceReplenish` event,
exact input/reward fields, DOLA balance delta, and gas cost. Keep this default
off until the higher-value FWA streak ends; it is a useful background lane,
not a material path to the active goal.

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
