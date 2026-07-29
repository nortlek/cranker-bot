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
2026-07-30 23:59 America/Denver**. At 2026-07-29 15:51 America/Denver, the
verified snapshot was **$161.91794074 net**, or **64.76%** of the goal, with
`latest == pending == 528` and net ETH equivalent of
`0.08582116868446094`. The four receipts at nonces 524–527 increased the
wallet by `0.000826081536176772 ETH`; decoded receipt accounting matched
within `0.000000000001 ETH`. Round 301's
`processAcquisitions(5) -> syncFwaResult -> settle` chain retained
`0.000823409901955356 ETH`, and the preceding standing order retained
`0.000002671635221416 ETH`. Since the nonce-488 snapshot, ten standing orders and
rounds 296–297 increased the wallet by `0.001998175837659669 ETH`. Round
297's `processAcquisitions(1) -> syncFwaResult -> settle` chain retained
`0.000928138441187552 ETH` after `0.000297072306606 ETH` of total gas. The
eight-order batch earned `0.0022 ETH`, spent
`0.002043066059655984 ETH`, and retained `0.000156933940344016 ETH`
in aggregate. Round 296's
`processAcquisitions(4) -> syncFwaResult -> settle` chain retained
`0.000866398031093311 ETH` after `0.000381882886751153 ETH` of total gas;
the two orders retained `0.000046705425034790 ETH`. The preceding round 295
chain processed ten acquisitions and retained `0.000578034549989178 ETH`
after every receipt's gas and builder payment. Round 291's
`processAcquisitions(2) -> syncFwaResult -> settle` chain earned
`0.001326643737918444 ETH` gross, spent `0.000404057653338204 ETH` of base gas
and `0.000057725256565197 ETH` of priority-fee builder payment, and retained
`0.000864860828015043 ETH`. The other three standing orders retained
`0.000037254858130777 ETH` in aggregate; one `0.0001 ETH` receipt was
individually negative, but its two-transaction bundle retained
`0.000023920702791492 ETH` after the shared gas-normalized bid. An earlier full
reconciliation through nonce 387 found
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

### P0 — Backrun a final direct ticket purchase with `pull`

Status: live in Railway deployment
`fb1ce0b3-c656-4987-bd77-7d36ab77e5f6` from exact source
`1f066085ff22f3781ad1acea5f9467ea4b3f54aa`. Startup verified one signer
lease and a hash-only filtered pending subscription covering 69 canonical
targets, including the PullPool. Awaiting the first live final-ticket
candidate, exact simulation, submission, and reconciled receipt.

Block `25641238` proved a confirmed-head blind spot. Transaction
`0xa4a0ed080276524cf88662a7bab29a7efc13e9ebd322a988043cc5f5d3971a4c`
bought the final six round-301 tickets at transaction index 114. Transaction
`0xa5d5cc0d543bddd43f6e48dbe8303558fc4c037498ee6080287303a0e55f00de`
immediately followed at index 115 and pulled the round through a private
executor. It earned `0.000801911522533836 ETH`, spent
`0.000059524847433732 ETH` of gas, and paid
`0.000019967596911092 ETH` directly to the block beneficiary, retaining about
`0.000722419 ETH`. The direct payment was about 249 bps of gross reward; the
new lane deliberately inherits the existing independent pool-pull policy of
1000 bps rather than the standing-order controller.

The implementation extends the already-live raw-prerequisite pipeline. It
accepts only legacy/EIP-2930/EIP-1559 Ethereum-mainnet transactions whose raw
hash, recovered sender, nonce, RPC representation, pool target, positive
value, and exact `buyTickets(uint256,uint32,address)` or
`buyIntoCurrentRound(uint32,address)` calldata all match. The latter canonical
entry point was observed in block `25641296`; its real signed transaction was
replayed through the validator before rollout. It binds to the authoritative
current funding round at execution. Every other pool call is rejected. Before
submission the lane requires the referenced round to remain open with no older
lifecycle active, then exact-simulates
`[raw purchase, preliminary pull]`. Non-final purchases fail `NotCovered` and
are not submitted. The keeper pull is reward-priced from its simulated gas,
the round's pinned bounty terms, a conservative next-block-base-fee floor, and
the lane-specific pool bid. The competitively signed pair is exact-simulated
again, the raw purchase and pending nonce are revalidated, and only the atomic
pair is sent privately. The user purchase is never sent alone and is excluded
from keeper gas/P&L accounting.

Acceptance:

- inspect the first `pending_pool_pull_opportunity` and both exact simulations
- require the prerequisite to remain pending immediately before submission
- reconcile only the keeper pull's `CrankBountyPaid` reward and receipt gas
- if it misses, require the prerequisite to have landed and inspect the
  competing `Pulled` event before changing the 1000-bps bid
- compare several captured and missed events before enabling adaptive bidding

### P0 — Capture same-block standing-order funding backruns

Status: live in production deployment
`dbfa8717-9a5c-4da7-8c26-167937754faf` with a 1000-bps lane-specific bid.
The filtered 64-target subscription acknowledged before `keeper_started`;
Railway/PostgreSQL show one open signer run and healthy WebSocket passes.
Monitoring the first candidate, submission, and reconciled receipt.

Block `25640168` exposed a confirmed-head blind spot. Transaction
`0xdc83150b31e45d68157ed0083c2437f3834ee4054063c09fa44beba4408ed0a4`
funded order `0x93d56d01534e7e4702fEE7a6282C708cB60d49E7` with `0.09 ETH` at
transaction index 116. The immediately following transaction
`0xe7925f830706f38119a9fc268fe712e6408da27ae555e9088c9e780c5050d538`
cranked it for `0.0025 ETH`. At the preceding confirmed head the order balance
was zero, so an ordinary next-head planner could not compete.

The winning crank paid zero priority fee and `0.000118275820830379 ETH`
directly to the block fee recipient: **473 bps** of the `0.0025 ETH` reward.
Its base-fee gas cost was `0.000143933305844128 ETH`, leaving about
`0.00223779 ETH` after gas and the direct payment. The new lane therefore
starts with an independent 1000-bps builder bid rather than inheriting the
confirmed-head standing-order controller's 8644–9454 bps state.

A 20,000-block scan across 64 known canonical targets found 1,690 `Cranked`
events. Fifty-three had a positive-ETH funding transfer to the same order
earlier in the same block, totaling `0.0273 ETH` of caller fees in roughly 2.8
days. The pattern includes round 269's `0.01 ETH` fee and the round 286
example above. This is meaningful gross reward, but inclusion share and
retained profit remain to be measured live.

The implementation uses Alchemy's hash-only filtered pending subscription and
fetches exact signed bytes with `eth_getRawTransactionByHash`. It rejects
malformed, unsigned, replaced, non-mainnet, EIP-4844/EIP-7702, noncanonical,
zero-value, and calldata-bearing prerequisites. It exact-simulates
`[raw funding, preliminary crank]`, prices only the crank item, re-signs with
the lane-specific static bid, exact-simulates the final pair, and submits only
that pair to private relays for one target block. The funding transaction
is never sent alone and its value, gas, priority fee, and hash are excluded
from keeper P&L. A target-block signer reservation serializes this lane with
the ordinary planner. A miss is measured only when the funding transaction
landed and another transaction emitted `Cranked`; the observed competitor bid
is logged without contaminating confirmed-head standing-order learning.

Remaining acceptance criteria:

- inspect every candidate rejection, exact simulation, relay result, and
  receipt from durable telemetry
- reconcile the first included crank from its decoded `Cranked` fee and only
  the keeper receipt's gas
- compare captured share and retained profit against the 53-event historical
  cohort before changing any bid ceiling

### P0 — Express fee-capped standing-order bids with direct coinbase payment

Status: implemented in exact source
`32ef07341c94d1059d2088cc248050ed43db36cf` and currently live in Railway
deployment `d5535d93-c078-4308-8114-e586a5dca353` from source
`f23e6da510603b3012a0fbc609bdcb2eed7efdab`. Startup verified the pinned
helper runtime, enabled the feature, acquired exactly one signer lease, and
continued healthy passes without warnings. Awaiting the first fee-capped
standing-order candidate that needs a direct payment and its reconciled helper
receipt; the first two post-deploy `0.0001 ETH` wins did not need or have enough
margin for the helper.

The existing `5 gwei` maximum fee protects the signer from unbounded gas-price
exposure, but it also prevented the priority-fee-only bundle from expressing
the adaptive bid on large `0.0025 ETH` standing-order rewards. At blocks
`25640294`, `25640391`, and `25640510`, the keeper's effective bids were only
`3,275`, `3,114`, and `3,204 bps`, while winners paid `8,914`, `8,656`, and
`8,857 bps` through zero-priority direct beneficiary transfers. The latter two
misses could have expressed the already-selected `8,939 bps` bid and retained
approximately `0.000099630 ETH` and `0.000126046 ETH` under conservative
next-block base-fee and helper-gas allowances. Raising the fee ceiling is
neither necessary nor desirable.

The implementation uses the already-deployed, exact-verified receive-only
`TransferValueToMinerCoinbase` helper at
`0x8512a66D249E3B51000b772047C8545Ad010f27c`. Its 113-byte runtime hash is
`0x6b7535dca3ee3e0f8b0e86209d088dee292bdba2888bfd32a0ffbdc39fcd8a02`;
the only successful path forwards all `msg.value` to `block.coinbase` with
Solidity `transfer`. It has no owner, storage, proxy, delegatecall, retained
balance, or mutable configuration. Startup pins the runtime hash.

The route is opt-in and applies only to zero-value, contiguous,
standing-order-only private batches whose existing adaptive bid is constrained
by the fee cap. It never raises that bid: helper value is only the shortfall
between the desired aggregate builder payment and priority fees, capped again
by aggregate base gas and the retained-profit floor. The helper is the final
nonce, its gas and value are pre-funded, and the only submitted variant
contains every selected reward-producing crank plus the helper. It is never
submitted alone or as a prefix. Exact target-block simulation must succeed for
the complete bundle and report both the intended helper
`ethSentToCoinbase` and exact aggregate `coinbaseDiff`; final economics are
recomputed from simulated gas before private submission. Receipts and Discord
batch P&L count the helper value and gas as costs.

A simulation-only Flashbots call on 2026-07-29 confirmed the live response
shape and helper compatibility: `ethSentToCoinbase == coinbaseDiff == 1 wei`
and actual helper gas was `27,920`, below the conservative `50,000` planning
envelope. The current builder beneficiary may change, and the helper's
2,300-gas transfer stipend can reject a future contract beneficiary; exact
simulation then skips that block without an on-chain loss. The residual trust
assumption is private-relay atomicity, the same assumption already used for
multi-transaction lifecycle bundles.

Acceptance:

- enable only after startup verifies the pinned runtime on Ethereum mainnet
- observe the first `direct_coinbase_payment_simulated` event, relay
  acceptance, helper receipt, and aggregate positive batch P&L
- confirm the helper nonce is last and no helper-only bundle variant was sent
- compare the first high-fee order result with the contemporaneous winning bid
  before changing adaptive bid bounds or the maximum fee

### P0 — StonkPit fee-collection crank on Robinhood Chain

Status: target, ABI, payout, history, and competition verified; read-only
inspector implemented. Live execution remains disabled.

Robinhood Chain mainnet is an Arbitrum Nitro L2 with chain ID `4663`, ETH as
its gas token, the public RPC `https://rpc.mainnet.chain.robinhood.com`, and
Blockscout at `https://robinhoodchain.blockscout.com`. Its documented
first-come-first-served ordering means a higher fee cannot bypass an earlier
transaction. Latency, stale-state protection, and expected value matter here;
Ethereum builder bidding does not.

The permissionless entrypoint is
`StonkPitLocker.collect(address tipTo)` (`0x06ec16f8`) at
`0xDeb8d589251717e367d0f3E9dDE5D4dB63968B40`. The user-supplied
`0xe934e36a439c94017b64a3fece66af12099abf50` is the StonkBroker collection
token, not the crank target. The locker pays `tipTo` 1% of collected native
ETH, sends the post-tip ETH 70/30 to the merchant/treasury, and refills the
green/blue mines with the collected DERP token in a 5:1 ratio.

`collect` reverts only when both ETH and DERP collection are zero. A DERP-only
or tiny-ETH collection can therefore succeed while losing gas. The user-linked
transaction `0x8ff04cc39b1dac6bb16a02e5910a5216946ead38ca76a692b2ea6aa00502dd35`
collected `0.000711473512236046 ETH`, paid a
`0.000007114735122360 ETH` tip, spent `0.000004978334942 ETH` in gas, and
netted only `0.000002136400180360 ETH`.

A scan from the first observed successful collection through block `22635502`
found 273 successes: 176 profitable and 97 unprofitable after receipt gas.
Gross tips were `0.013750746559413902 ETH`, successful gas was
`0.001378067039562 ETH`, and successful-only net was
`0.012372679519851902 ETH` before failed-race gas. Blockscout also showed 23
failed crank transactions costing `0.000072785051656 ETH`. The distribution is
highly skewed by early outliers; recent samples are much thinner. In the eight
user-supplied clue blocks plus the linked transaction, aggregate net was just
`0.000047302406830197 ETH`, and one of nine calls lost money.

Use `npm run inspect:robinhood` for a current read-only simulation and bounded
history/competitor sample. Optional knobs are `ROBINHOOD_RPC_URL`,
`ROBINHOOD_LOOKBACK_BLOCKS`, `ROBINHOOD_MAX_RECEIPTS`, and
`ROBINHOOD_MAX_BLOCKSCOUT_PAGES`.

Live prerequisites:

1. Add a minimal immutable guard contract that calls the locker with the EOA
   as `tipTo` and reverts unless returned `ethTotal` meets a caller-supplied
   minimum. This prevents successful token-only/tiny-tip losses but cannot
   avoid gas spent losing a stale race.
2. Run an observer to measure signal-to-inclusion latency, contemporaneous
   competitor win rate, and expected profit after both successful and failed
   calls. Gate on expected value rather than simulated profit alone.
3. Use a separate Railway worker and dedicated gas-only signer, with explicit
   Robinhood chain configuration and chain-scoped lease/telemetry identity.
   Do not mix this public FCFS lane into the Ethereum/Flashbots signer.
4. Obtain explicit authorization for public sequencer submission and signer
   funding before enabling it. No private Robinhood submission path has been
   verified, and the current operating boundary forbids switching to public
   submission.

### P0 — Replace the standing-order bid floor with bounded price discovery

Status: deployed and measuring; provider-race correction deployed in Railway
deployment `b18df13b-45b3-487d-9221-f5ce9f5309ed`.

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

Competitor observations must use every known `Cranked` fee in the winning
transaction, not only fees for orders that happened to be present in our
losing batch. At block `25639742`, competitor transaction
`0x127b5dfbcfb9c593cc6039873fb9282cbde0299a9b5823a474514991df6ddbf8`
cranked two known orders for `0.0006 ETH` total fees and paid
`0.000460659240652228 ETH` to the builder. The old observer saw only the
attempted order's `0.0003 ETH` fee, reported an impossible `15,356 bps`, and
poisoned that target's learned bid at the `9,900 bps` maximum. The correct
aggregate observation is `7,678 bps`; with the configured 25 bps margin its
next bid is `7,703 bps`. The corrected observer enumerates the factory and
vault registries at the fully available planning parent block, decodes all
known crank logs from the full target-block receipt, and rejects an empty
denominator. A conditional migration repairs only the exact poisoned durable
row.

Fresh-block competitor reads at blocks `25639785`, `25639870`, and `25639904`
also exposed a second provider spelling of the same JSON-RPC `-32602`
state-availability race: `Invalid parameters were provided to the RPC method.`
The transient-read classifier previously recognized only `Missing or invalid
parameters.` and therefore abandoned those observations without retrying.
Historical replay succeeded once the blocks were available and recovered two
previously missed clearing bids of `7,515` and `7,413 bps`. The observer now
retries only those two exact provider messages; unrelated invalid-argument
errors remain terminal.

The same failure persisted through every short retry after target block
`25640510`, even though its header, logs, and receipts were already available.
Historical replay found the winner paid `8,857 bps`. The remaining failing
calls were factory/vault registry `eth_call`s at the fresh target state. Those
registries now use target minus one—the exact planning state—while the winning
logs, receipt, base fee, and beneficiary payment remain pinned to the target.
This removes the race instead of extending a latency-sensitive retry loop.

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

The eight-order win at target block `25640932` supplied a broader live sample.
It earned `0.0022 ETH` gross, cleared at an aggregate effective `8,160 bps`,
and retained `0.000156933940344016 ETH`. The controller did not treat that one
aggregate outcome as proof that every target needs the same price: three
previously unmeasured targets entered bounded probes at `3,795–3,869 bps`,
targets with existing `5,965 bps` losses retained their brackets, and the
high-bid `CC74...` target recorded `8,160 bps` as a lower win but required
another contradiction before discarding older evidence. This supports
continued target-specific learning; it does not justify a global floor or
starting-bid change.

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

Status: enrichment and dependency-safe preliminary prefix admission are live
in Railway deployment `6f30b913-2930-4404-a671-c04c2579b6c6`. The follow-up
pull economics and gas-envelope correction is live in deployment
`aa22e5d3-b7c6-44b2-ac29-111deeed9f2d` from commit
`38604b653983e659a20b92ebdf0ca441a4d0cf7c`.

Across 58 live lifecycle plans, 36 successfully appended a next-round
`pool_pull`, but none submitted that suffix. Every pull used the static
`500,000` gas envelope and preliminary exact simulation truncated the bundle.
The same pulls, once directly estimable, required buffered limits from
`616,636` to `2,934,132` gas, with an `860,214` median. The first repair raised
the static envelope to `3,000,000`, but that remained an arbitrary cutoff
rather than an economic constraint. A dependency-blocked pull now uses
Ethereum's per-transaction protocol ceiling, reduced only when the signer
cannot pre-fund that envelope after earlier bundle reservations. Preliminary
accounting explicitly marks this call as deferred instead of treating its
envelope as consumed gas. The relay's exact signed-bundle simulation supplies
actual gas, then the usual reward-weighted builder bid and positive-profit gate
decide whether any dependency-safe prefix is submitted.

An exact 20,000-block follow-up audited the latest 50 `Pulled` events with
receipts and call traces. After excluding 23 cross-subsidized multi-action
transactions, 27 standalone pulls produced `0.032504139519 ETH` of bounty,
paid `0.006551341739 ETH` of base gas, `0.001134395586 ETH` of priority fee,
and `0.003620123882 ETH` directly to builders, retaining
`0.021198278313 ETH`. Excluding the keeper's two wins, 18 of 25 competitors
cleared at or below `1,000 bps`; the low cluster topped out at `779 bps`.
The high cluster reached `7,368 bps`, but its latest rounds retained almost
nothing, so it is not an economic target.

The keeper's 12 clean direct wins also show PullPool's internal reimbursed gas
at `10,230`–`10,673 bps` of receipt gas, median `10,449 bps`. A pull-specific
`10,000 bps` reimbursement estimate therefore remains conservative while the
shared sync/settle estimate stays at `9,000 bps`. The pool-pull builder policy
is reduced from `2,000` to **`1,000 bps`**: it still clears the evidenced cheap
cluster without paying nearly twice as much in the otherwise empty bid band.
Ready and fulfilled lifecycle policies remain independent.

Round 290 then supplied a live confirmation of the cross-subsidized pull path.
Two funding cranks plus `pull` cleared atomically for
`0.000718906984853275 ETH` aggregate net; the pull itself used `502,574` gas
and paid `0.00118036197053133 ETH`. The subsequent seven-request
`processAcquisitions -> sync -> settle` chain cleared for another
`0.0004082328037365 ETH` aggregate net. Both batches were reconciled from
successful receipts, and nonce returned to `latest == pending == 464`.

The enrichment path also exposed a prefix-admission bug. The planner could
append an optional next-round suffix to a profitable lifecycle base, then the
preliminary whole-plan economics check rejected every job when that suffix
made the full estimate negative. The exact prefix selector that was designed
to drop the suffix was therefore never reached. At historical head block
`25639351`, the round-263 replay produced
`processAcquisitions(8) -> sync -> settle -> pull`; the three-call base
retained an estimated `0.000171186211710636 ETH`, while the optional pull made
the full estimate `-0.000215057674289364 ETH`. Preliminary admission now
requires any dependency-safe prefix—not the optional full suffix—to clear the
same conservative gas and profit floor. Private submission still
exact-simulates and reward-weighted-reprices every safe prefix, and submits
none when no exact prefix is profitable.

### P0 — Remove arbitrary FWA processor gas and queue cutoffs

Status: the gas cutoff, wider queue discovery, and exact-simulation deferral
are deployed. The latest implementation is Railway deployment
`c3740155-b3c7-4722-be74-21cd4b160be4` from exact source
`bcd29480fbdd3f9602a64c2bec614e4b36ff7095`.

The ready-cycle planner previously rejected a directly estimated
`processAcquisitions` call when its buffered gas exceeded `3,000,000`, before
signed-bundle simulation or aggregate economics ran. This lost rounds 282 and
283: the last eligible passes recorded `fwa_process_gas_above_limit`, then
competitors processed ten acquisitions using `4,447,655` and `6,442,210` gas.
Seven other ready cycles between rounds 276 and 285 landed profitably, so the
processor path itself remains healthy.

The fixed 3M value was not an economic bound: a transaction gas limit is not
the amount charged, and every ready dependency-safe prefix is exact-simulated
and repriced from actual simulated gas plus its builder payment before private
submission. The default processor ceiling is therefore Ethereum's
`16,777,216` per-transaction protocol cap. The signer-balance gate, exact
signed-prefix simulation, aggregate profit gate, and private one-block expiry
remain unchanged. No signed processor can exceed the protocol cap.

The same planner searched only the first five queued request IDs. A 20,000
block event reconstruction matched 285 PullPool requests to their
`AcquisitionProcessed` sequence positions: 13 were beyond position five, with
a maximum position of ten. Seven recent ready rounds—259, 260, 261, 263, 264,
270, and 272—were at positions six through nine and therefore could not reach
simulation under the old default. Exact historical replay at each last
eligible block processed the full required prefix, with buffered gas from
`2,248,056` through `9,696,305`, all below the protocol cap. The discovery
window is now 50. That is only a read/simulation bound: the required count,
complete return value, protocol gas cap, signed-prefix simulation, signer
balance, and aggregate profitability still fail closed before submission.

Rounds 299 and 300 exposed a second consequence of treating the processor gas
ceiling as an estimate. Local `simulateContract` plus `estimateContractGas`
took `8.204` to `10.787` seconds on the public processor; one profitable
round-299 plan was stale before it reached submission. The same static
admission step then charged the complete `16,777,216` signing envelope as if
it were consumed gas and repeatedly labeled ready round 300
`primary_bundle_unprofitable`.

The ready planner now derives the exact required queue prefix from pinned
state, signs the processor with the maximum fundable protocol envelope, and
defers processor correctness and gas economics to mandatory private bundle
simulation. A processor result that cannot support `syncFwaResult` makes the
required two-call prefix revert and fail closed. The successful simulation's
actual per-transaction gas then drives reward-weighted prefix selection,
builder payment, and the profit floor; the competitively priced signed bundle
is exact-simulated again before submission. This removes the duplicate
high-latency local calls without weakening simulation, atomicity, balance,
nonce, or private-expiry safeguards.

The retiring deployment won round 300 immediately before releasing its signer
lease: `processAcquisitions(7) -> syncFwaResult(300) -> settle(300)` landed in
block `25641096`, used `4,481,332` gas in aggregate, paid
`0.000636126538314232 ETH` in gas, and realized
`0.000541654019964083 ETH` net from `0.001177780558278315 ETH` gross. This
validates that the large processor is economically viable, but it occurred on
the prior source. The next ready lifecycle is the first direct production
exercise of the new exact-deferred admission path.

### P0 — Replace polling and synchronous full scans on the hot path

Status: exact-head prefiltering, phase telemetry, the strict WebSocket head
path, subscribed-header reuse, and the first background cold-planner cache are
implemented.

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
provider initially represented this as viem's classified `BlockNotFound`.
Later, at blocks `25640490` and `25640617`, the exact header read instead
returned RPC `-32602` with the already-observed provider detail
`Missing or invalid parameters.`; the whole pass failed, then the identical
block succeeded two seconds later. Both the authoritative head read and the
post-target exact-block read now recognize those two narrowly classified
fresh-state errors. They retry the same provider and same block at 100 ms
intervals for at most ten waits and emit attempt and wait timing. They do not
substitute `latest`, switch providers, or retry unrelated RPC failures.
This exact-block repair is live in Railway deployment
`d5535d93-c078-4308-8114-e586a5dca353` from source
`f23e6da510603b3012a0fbc609bdcb2eed7efdab`; PostgreSQL showed one open run and
one advisory signer lock after the rollout. Its first production exercise at
block `25640871` waited `300 ms` across four same-block read attempts and then
completed the pass normally. Before the fix, block `25640744` reached the
header stage but then failed with the same externally rendered message; the
persisted error is too coarse to prove which nested provider class escaped.
Four recent `keeper_pass_failed` rows also lost their pass context because the
error was logged after leaving the asynchronous per-pass scope. Failure
telemetry now explicitly retains the pass ID, exact block, and head source,
indexes the block in PostgreSQL, and records a bounded nested error-name/code
fingerprint. Messages, URLs, request bodies, and metadata are excluded. Discord
shows the same safe correlation fields. This makes the next occurrence
diagnosable before broadening any retry classifier.
The change is live in Railway deployment
`d5f3d0b1-be9c-479b-bfaf-3980a73e098e` from exact source
`da47f5d6c2447464a5c4e54308797a6346f317e7`. The replacement acquired one
advisory signer lease and won round 297's complete ready chain on its first
pass; no failure event was required to validate the normal path.

The correlated fingerprint subsequently captured the same transient provider
detail at blocks `25641062`, `25641094`, and `25641126`, but viem classified
those responses as `InvalidInputRpcError[-32000]` rather than
`InvalidParamsRpcError[-32602]`. The identical block path recovered on a later
pass, and the block-94 failure preceded a successful round-300 lifecycle
submission at block 95. Exact fixed-block reads now include only that typed
`-32000` class; raw/untyped `-32000` errors remain immediate failures and
retries remain pinned to the same provider and block for at most ten 100 ms
waits. The first message-gated implementation did not catch block `25641158`:
viem generated its generic short message at the typed wrapper while retaining
a different provider detail underneath. That identical block succeeded two
seconds later. The corrected boundary uses the typed class itself; a false
classification can delay a read-only pass by at most one second and cannot
authorize submission.
The first message-gated repair was deployed in Railway deployment
`68e5fc1f-4971-4773-9d87-eed977beb011` from exact source
`daec80fda95b8d0fecfc063ec4bd93db22111cc4`. PostgreSQL showed one open run
and one granted advisory signer lock after the rollout; the first subscribed
pass completed normally with no duplicate HTTP block read.
The corrected typed-class boundary is live in Railway deployment
`c3740155-b3c7-4722-be74-21cd4b160be4` from exact source
`bcd29480fbdd3f9602a64c2bec614e4b36ff7095`. The replacement acquired one
signer lease and completed its initial and first subscribed passes normally.
Keep monitoring for `planning_state_availability_waited` to verify the next
real typed `-32000` occurrence is absorbed.

The subscribed-head investigation then found that the worker already received
the block number, hash, timestamp, and base fee in each `newHeads` notification
but discarded all except the number. It waited for
`eth_getBlockByNumber(number)` on the separate HTTP transport before beginning
the state reads that actually determine eligibility. The keeper now retains
the complete subscribed header and starts exact-block planning immediately.
It does not use `"latest"` or infer contract storage from the header: every
state read remains pinned to the subscribed block and only those reads absorb
the same narrow publication-skew errors. A mismatched supplied header fails
closed, and the initial process-start pass still obtains a complete header
from HTTP before the first subscription event.

This is live in Railway deployment
`b81f65c4-3d6c-48ed-a776-71abfc57d1e7` from exact source
`a2ffbcf2bf730c9bb97b6031e16fd8e66d084ccd`. All 213 tests, typecheck, build,
and diff checks passed. The first subscribed production pass, block
`25641002`, reported `planningHeaderSource=websocket_subscription`,
`blockReadAttempts=0`, and `blockAvailabilityWaitMs=0`, then completed
normally. PostgreSQL showed exactly one open keeper run and one granted
advisory signer lock.

The header-read fix exposed a second phase of the same publication race. At
blocks `25639595` and `25639659`, the exact header became available after five
and six attempts, but the provider briefly returned RPC `-32602` with the
specific detail `Missing or invalid parameters.` for pinned state calls.
Reprocessing the identical block two seconds later succeeded. Planning now
retries only that exact nested viem error against the same pinned block, for at
most ten 100 ms waits. It never changes the block or provider, and unrelated or
persistent invalid-parameter failures still fail closed. Successful waits emit
`planning_state_availability_waited` and planning attempt/wait fields.

The same state-publication race also applies immediately after a target block.
At block `25639870`, all four relay paths accepted every safe prefix of a
six-order `6,988 bps` batch, but none landed. The post-block competitor
observer immediately queried the exact block and received the same nested
invalid-parameters error, so the adaptive controller lacked clearing-price
evidence. Re-reading the identical block later succeeded and found no
competitor crank for the attempted orders; a two-order retry won the next
block at `7,162 bps`. Competitor observation now applies the same narrow,
same-provider, same-block maximum of ten 100 ms waits and emits
`competitor_bid_state_availability_waited` when exercised. Persistent or
unrelated errors still leave the batch unmeasured and do not alter a ceiling
from invented evidence.

Live timing then exposed a separate zero-submission delay. At block
`25639710`, the exact ready-chain simulation correctly rejected the bundle
because its `0.001134976261628922 ETH` gross reward could not cover
`2,459,456` gas at the current base fee even with no builder payment. The relay
sender returned zero transaction hashes, but the strategy still waited for the
nominal target block and stretched the no-submission pass to `14.24 seconds`.
Private target-block receipt waiting is now conditional on at least one
submitted transaction, so an economically rejected quote returns immediately
and the next head remains available for replanning.

The adjacent round-277 pull miss exposed latency after a real submission. All
four relay paths accepted the bundle within `263 ms`, but the pass lasted
`18.47 seconds`: the WebSocket observed target block `25639689` at
`16:28:49.868Z`, while the lagging HTTP block-number loop did not expire the
private attempt until `16:28:57.026Z`. Private receipt finalization now wakes
from the same strict WebSocket head signal as planning, then requires the
authoritative HTTP endpoint to serve that exact target block before reading
receipts. The exact-block gate retries only classified `BlockNotFound`; it
does not switch the target block or provider. This removes polling latency
without adding another head implementation.

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
Railway CLI source uploads also left `RAILWAY_GIT_COMMIT_SHA` stuck at
`52d4228` across three later deployed images, so `keeper_runs.git_sha` was
plausible-looking but wrong rather than merely null. The deploy workflow now
injects the exact committed `DEPLOY_GIT_SHA` without triggering an extra
deployment; the application prefers it for `keeper_runs.git_sha` and exposes
both `sourceRevision` and Railway's dynamic `deploymentId` in `keeper_started`.

Every pass now carries an asynchronous `passId` and observed block through all
structured events. Monotonic events report head/fee fetch, planning, account
gate, preliminary and competitive signing/simulation, first relay acceptance,
every relay-prefix result by numeric alias, full relay wait, and total pass
duration. Relay errors are categorized without logging credential-bearing
URLs.

Bundled receipt and expiration events use `batchTargetBlock`, while the
PostgreSQL sink originally indexed only `targetBlock`. Consequently, every
recent bundled expiration had a null indexed target block and could not be
grouped efficiently with its submission or competitor result. The sink now
uses `batchTargetBlock` as a fallback, treats aggregate batch submission,
result, and adaptive-outcome events as queue-critical, and backfills existing
valid numeric batch targets.

The pending-funding subscription previously had an unobservable loss mode. At
block `25640951`, owner funding transaction
`0x1b5d5cce24d898f07f7255f9dee0064079eade0a742c8497c9a79eb7347216b0`
was immediately followed by a competitor crank that retained about
`0.000256649238296217 ETH` after gas and direct builder payment, but the
durable stream contained no pending-candidate event. A hash that resolved only
after mining was silently discarded, so provider non-delivery and late local
resolution could not be distinguished.

Deployment `c3740155-b3c7-4722-be74-21cd4b160be4` now emits subscription
generation readiness, immediate hash observation with queue depth, validated
pending candidates, mined-late candidates with raw-availability and resolution
timing, duplicates, and sanitized resolution failures. Raw transactions,
endpoint URLs, RPC bodies, and provider messages are excluded. The first
replacement connection emitted `pending_funding_subscription_ready` for all
67 canonical targets.

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

Status: the canonical deployer suite is identified on-chain and has a
fail-closed read-only inspector. The pool remains paused with no rounds or
orders, and verified source is not yet available; live execution is not
enabled.

On 2026-07-28, [the pool author reported](https://x.com/ripe0x/status/2082297793478082570)
that subscriptions are filling new pools almost as soon as they open and that a
V2 pool contract is nearly finished, with higher capacity and support for
running more pools more often.

This has two immediate implications:

- Current funding and lifecycle windows are becoming more latency-sensitive.
- A single pinned V1 pool/factory will miss V2 revenue if V2 uses new
  deployments, registries, ABIs, lifecycle states, or reward formulas.

The V1 pool's direct deployer
`0xCB43078C32423F5348Cab5885911C3B5faE217F9` created the V2 pool
`0x03C45c9C594b19ca5Fde54f38C7e6b6A5f2329d7` in block `25639384`
through transaction
`0x369e1819e8477df92540e26919a168d9bfd99d2b73907657b6fb0d9ca258f64c`
on 2026-07-29 at 09:27 America/Denver. Its runtime hash is
`0x9086cc5f10b8b8ee1a775ae683f0770d151665a56e7b5f9632cc2253ec68a792`.
The same EOA created the V2 order factory
`0xc62cEF28ccDbaBE147eCD3Baf4492119aCf4c657` in block `25639639`;
the factory's immutable `POOL()` points back to V2 and its runtime hash is
`0x45ccf63419269cadbb49f4dc5b7496ddc5c2d813f71296e55a56dd522d1dab49`.

Runtime selectors expose the familiar permissionless `pull`,
`syncFwaResult`, `settle`, and `settleForcedEth` calls, but V2 replaces the
single `ethPendingRound` pointer with `firstOpenRound`, `currentOpenRound`, and
`pendingPullCount`, and expands `getRound` to 35 ABI words. The immutable FWA,
FWA rewards, and FWA token addresses exactly match V1. The configured
`0.005 ETH` ticket, `0.0015 ETH` bounty cap, `0.01 ETH` VRF allowance, and
`2 gwei` bounty tip also match V1; three new trailing config fields are
currently `1`, `1`, and `150` and must be named from canonical source rather
than guessed.

At block `25640704`, the pool was paused, not deprecated, and had
`roundCount == 0`, `currentOpenRound == 0`, `pendingPullCount == 0`, and zero
accounted ETH. The new factory had zero orders. `npm run
inspect:pull-pool-v2` pins and verifies all seven deployed component hashes,
both creation transactions, deployer ownership, the factory relationship,
immutable FWA relationships, configuration, launch state, and any current
round's raw ABI words. It fails closed on a relationship or bytecode mismatch.

Next action:

- monitor the identified pool/factory and the author's canonical channels for
  unpause, first-round creation, order deployment, and verified source
- name and decode the expanded round/config fields from verified source or
  authoritative live event/state evidence
- determine whether subscriptions migrate, whether V1 remains active, and how
  multiple concurrent pools are enumerated
- refactor discovery/planning toward a verified pool registry or versioned
  adapters instead of blindly replacing the pinned V1 constants
- extend the existing read-only V2 inspector with live event/competition
  history once the first round opens
- add exact sequence simulation, independent V2 bid scopes, telemetry, and
  startup relationship checks

Do not infer the 35-word round semantics from field position alone or enable
calls against an unopened pool. Keep V1 live while V2 is paused and until an
exact-simulated, versioned V2 adapter is validated.

### P0 — Reduce acquisition lifecycle latency

Status: lifecycle-first routing is deployed. Processor correctness and gas
economics are now deferred to mandatory exact private bundle simulation in
Railway deployment `c3740155-b3c7-4722-be74-21cd4b160be4`; measure the next
ready lifecycle.

The ready acquisition path has a short competitive window. `planJobs` should
read the acquisition lifecycle first and return a profitable lifecycle plan
before waiting for order registries, Liquity, Convex, buyback, and sweep scans.
The previous processor simulation and gas estimate did run concurrently, but
live calls still consumed most of a block on large queues. They are no longer
duplicated before relay simulation.

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
- won the full round-171 and round-172
  `processAcquisitions -> syncFwaResult -> settle` bundles in Titan-built
  blocks, netting `0.001007735370452469 ETH` and
  `0.000991136629002709 ETH` respectively after all gas
- Titan's direct bundle tracer marked both full bundles `Submitted`, with
  builder payments of about `0.000100994 ETH` and `0.000101023 ETH`
- asked the operator to pursue FWAVRFService allowlisting for the keeper

The later direct-relay sample submitted eight ready cycles between target
blocks `25639655` and `25640514`; all eight won, including one profit-capped
bundle that cleared at an effective `435 bps`. The other seven paid
approximately `1001 bps`. The most recent round-288 chain realized
`0.000761554213542174 ETH` net after all three receipts. Combined with the
measured incumbent's `250 bps` direct Titan payment, this supports lowering the
ready-cycle policy from 1000 to **500 bps** while leaving fulfilled and pull
lanes independent. This is a bounded retention improvement, not a bid-ceiling
increase; exact signed-bundle simulation and the positive-profit floor remain
unchanged.

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
The optional pending-funding exact-pair lane covers orders that become funded
between confirmed heads; its prerequisite transaction is never treated as a
keeper cost, reward, or independently submit-able prefix.

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
