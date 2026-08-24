# Keeper Opportunity Backlog

This file is the evolving research and implementation queue. Stable operating
instructions belong in [AGENTS.md](./AGENTS.md). Every entry should contain
enough evidence for another agent to reproduce the conclusion without trusting
an old narrative.

Last updated: 2026-08-19 (America/Denver)

## Production shutdown and restart gate

Status: routine production remains intentionally shut down. MegaRip Season 02
is finalized and its temporary worker has been removed; PostgreSQL remains
online.

At the shutdown gate, the keeper had `latest == pending == 2243`, no active
PullPool lifecycle (`pendingLifecycleRound == 0`), and no viable opportunity,
submission, or receipt in the preceding 30 minutes. The verified account
snapshot was `0.699942998027875896 ETH` net equivalent, about `$1,317.73` at a
fresh `$1,882.62` ETH/USD oracle. Railway deployment
`f0a7e3e2-4439-4a9a-a37e-e110d270080d` was removed; the worker service is
offline and PostgreSQL remains online.

The configured RPC provider exhausted its monthly capacity immediately before
shutdown and the worker correctly failed closed on a stale WebSocket head.
Restore or replace production RPC and WebSocket capacity before any future
activation. Do not schedule a deployment for routine monitoring or existing
dormant lanes. A new deployment requires a newly validated profitable MegaRip
season or another concrete bountied opportunity, a reviewed and tested
implementation, fresh exact-state economics, and the ordinary nonce,
lifecycle, signer-lease, and rollout gates.

MegaRip Season 02 satisfied that exception gate on 2026-08-16. Its temporary
MegaRip-only worker was removed after the last actionable settlement and exact
reconciliation on 2026-08-18; this does not authorize re-enabling routine
lanes.

## Current objective and snapshot

The $50 cumulative verified net realized-profit goal was achieved before its
2026-07-30 23:59 America/Denver deadline. The 2026-07-28 America/Denver closing
snapshot was **$51.29412534 net**, or **102.58%** of the goal, with
`latest == pending == 206` and net ETH equivalent of
`0.026953131931682566`. This was measured from the original baseline and fully
net of gas, builder payments, and other fees. The earlier $10 goal was achieved
at `$11.35632645`.

The **$250 cumulative verified net realized profit by
2026-07-30 23:59 America/Denver** stretch goal was achieved. At the
2026-07-30 16:46 America/Denver completion snapshot, verified profit was
**$253.73988689**, or **101.49%** of the goal, with
`latest == pending == 722`, net ETH equivalent of
`0.131936983292652418`, and a fresh `$1,923.19` ETH/USD oracle. Round 365's
pending FWA processor/sync/settle bundle earned `0.00120333783714914 ETH`,
spent `0.000290943677169978 ETH`, and retained
`0.000912394159979162 ETH`. The round 366 pending final-ticket pull earned
`0.0015 ETH`, spent `0.00018560280430971 ETH`, and retained
`0.00131439719569029 ETH`. Their combined
`0.002226791355669452 ETH` net exactly equals the wallet increase from the
previous verified snapshot. PostgreSQL member receipts, its aggregate batch
result, account balances, and nonces agree.

At 2026-08-05 07:30 America/Denver, verified net ETH equivalent was
`0.557909675076449224` (about `$1,041.64` at the fresh `$1,867.0451`
oracle), with `latest == pending == 2067`. Seven new successful receipts
increased the wallet by exactly `0.001209057888523152 ETH`: round 330's
sync/settle lifecycle retained `0.000997433398012727 ETH`, and a five-order
batch retained `0.000211624490510425 ETH`. Stable-first/probe-suffix ordering
worked and all five orders landed, but the first member independently lost
`0.000059766412357204 ETH`; aggregate pricing had cross-subsidized it with
the other four. Commit `772231e` now removes any standalone order whose exact
requested bid cannot retain its own profit floor, reassigns contiguous nonces,
and rechecks every retained member after the final exact bundle simulation.
The historical replay keeps the four profitable members and drops exactly the
loser. Production deployment `af806d30-108a-40bd-ad59-efabf18d2f2d` runs that
exact revision with one signer and healthy passes.

At 2026-07-30 14:16 America/Denver, the preceding
verified snapshot was **$239.69256803 net**, or **95.87%** of the goal, with
`latest == pending == 699`, net ETH equivalent of
`0.124753820619572591`, and a fresh `$1,921.32` ETH/USD oracle. The 32
successful receipts from nonces 667–698 earned
`0.014030220960008531 ETH`, spent `0.007497170813293468 ETH`, and increased
the wallet by exactly `0.006533050146715063 ETH`. Ten complete PullPool
lifecycle batches supplied the material gain. Four standing-order wins earned
`0.0006 ETH` but were profit-capped to a combined
`0.000000000000036564 ETH` retained; they do not materially advance the goal.
PostgreSQL receipt aggregation and the wallet delta agree exactly.

At 2026-07-30 08:27 America/Denver, the
verified snapshot was **$226.20480443 net**, or **90.48%** of the goal, with
`latest == pending == 667`, net ETH equivalent of
`0.118220770472857528`, and a fresh `$1,913.41` ETH/USD oracle. The 64
successful receipts from nonces 603–666 increased the wallet by exactly
`0.017124563692175932 ETH`. The first five retained
`0.001058883679268133 ETH` from round 316's pending-purchase pull,
`0.000925468999074068 ETH` from round 317's pending-purchase pull, and
`0.001019770537204972 ETH` from round 317's complete lifecycle. The live
`3c8faa0` worker then recorded 59 receipts from nonces 608–666 and retained
exactly `0.014120440476628759 ETH`; its PostgreSQL receipt aggregate equals the
wallet delta exactly. Round 315 had previously added exactly
`0.002267704619179513 ETH`: its funding-order/pull pair retained
`0.001285175373603051 ETH`, and its complete
`processAcquisitions(1) -> syncFwaResult -> settle` lifecycle retained
`0.000982529245576462 ETH`. Since the nonce-572 snapshot, the preceding 26
successful receipts increased the wallet by exactly
`0.009491592945639591 ETH`. Receipt aggregation and the wallet delta agree
exactly. The retained components were round 307's four-call lifecycle/pull
bundle (`0.000803134480853976 ETH`), one standing order
(`0.000002493297054820 ETH`), the round-309 funding/pull pair
(`0.000894963214100483 ETH`), round 309's four-call lifecycle/pull bundle
(`0.001964283428878568 ETH`), round 310's three-call lifecycle
(`0.000536242642660129 ETH`), the round-311 funding/pull pair
(`0.001119464494094752 ETH`), the round-312 funding/pull pair
(`0.001168871529689505 ETH`), and round 312's three-call lifecycle
(`0.000759787782015036 ETH`). Round 313 then added
`0.001276612293489616 ETH` from its funding/pull pair and
`0.000965739782802706 ETH` from its complete lifecycle. The preceding three
standing-order receipts retained exactly `0.000032864522890725 ETH`; their
decoded aggregate and wallet delta also agree exactly. The preceding nine
successful receipts from nonces 560–568 increased the wallet by exactly
`0.000657094625890769 ETH`. Round 305's processor/sync prefix retained
`0.000114463792007881 ETH`, five standing orders retained
`0.000298811712187825 ETH`, and round 306's processor/sync prefix retained
`0.000243819121695063 ETH`. PostgreSQL receipt aggregation and the observed
wallet delta agree exactly. The preceding 14 receipts increased the wallet by
exactly
`0.001178101655471192 ETH`: an 11-order batch earned `0.0022 ETH`, spent
`0.001605888512157402 ETH`, and retained `0.000594111487842598 ETH`;
round 304's `processAcquisitions(18) -> syncFwaResult -> settle` chain earned
`0.001182614789569458 ETH`, spent `0.000598624621940864 ETH`, and retained
`0.000583990167628594 ETH`. The decoded aggregate equals the observed wallet
increase exactly. Since the nonce-532 snapshot, an eight-order batch,
a three-order batch, and round 303's complete ready chain increased the wallet
by exactly `0.001173843036778288 ETH`. The batches retained
`0.000442084780285520 ETH` and `0.000001557720137532 ETH`; round 303's
`processAcquisitions(7) -> syncFwaResult -> settle` chain retained
`0.000730200536355236 ETH` after `0.000429297019862508 ETH` of total gas.
Round 302's complete ready chain at nonces 529–531
retained `0.000469645281310683 ETH` after `0.000724749017084498 ETH` of
total gas. The immediately preceding standing order at nonce 528 retained
`0.000004191409059895 ETH`. The four receipts at nonces 524–527 increased the
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

### P0 — Independent FWA buyback bidding

Status: four exact price losses reconstructed; the independent lane target is
now 9858 bps with direct beneficiary payment enabled for a single isolated
buyback. At parent block
`25683817`, the keeper exact-simulated an FWA token `buyback()` with
`0.003740206223983917 ETH` caller reward and `159622` gas. It offered
`0.000374020622494774 ETH` (effectively 1001 bps), all six private paths
accepted within 252 ms, and Titan block `25683818` omitted it.

Transaction
`0xed81fe5eeee24e02c32d91fba3b853df0aea87c5dd044aed509954bd6701307e`
captured the same reward through wrapper
`0x5B5A0580bcfd3673820Bb249514234aFAD33e209`, paid zero priority fee and
`0.001575408195862322 ETH` directly to the block beneficiary. That is 4212.08
bps of our exact planned gross. One wei above the observed payment normalizes
to 4213 bps and leaves a counterfactual
`0.002137573040588198 ETH` after the incremental builder payment, still far
above the retained-profit floor. This is price competition, not builder reach
or timing. The first 4250-bps target was deployed and won one small buyback,
but a second profitable opportunity at target block `25684814` proved it
stale. Our six accepted submissions offered `0.000578983340190038 ETH`
against a `0.001362313741436637 ETH` gross reward and expired in a Titan block.
Transaction
`0x861a869ef950e8e1f45db0524107fbf365a339dfce60e8059f4fad7b33515a04`
captured the exact reward, paid `0.000002991858074036 ETH` in priority fees and
`0.001134118561512794 ETH` directly to Titan, or 8346.61 bps in aggregate.
One wei above it normalizes to 8347 bps and would still have retained
`0.000218814483958562 ETH` after our planned gas and incremental payment.

The 8400-bps target was not expressible under the 5-gwei fee cap on the next
opportunity. At parent block `25690188`, the keeper exact-simulated buyback
target `0xa0Df17B5aC76ABaBA36E1450E2cbCd18A620C845` with a
`0.002531985045301370 ETH` reward and `159626` gas. It targeted blocks
`25690189` and `25690190`; all six relays accepted both attempts, but the fee
cap limited the expressed payments to `0.000750910446793328 ETH` (2966 bps)
and `0.000746798667316870 ETH` (2950 bps). Transaction
`0x430a19a9b5a899a0dc79bcafca0f34a6b1103374c6396a63cbce98c3e5cb93bb`
captured the exact reward in Titan block `25690190` through wrapper
`0x73851bf6c6e49cc44a1680451a127795c951c3e5`, paid zero priority fee and
`0.002456924975570103 ETH` directly to Titan, and retained about
`0.000015143072737142 ETH` after gas. One wei above the payment normalizes to
9704 bps. The pinned direct-payment helper can express
`0.002457038287960449 ETH` at the exact historical base fee, including its
full 50000-gas signing envelope, while retaining
`0.000007536799407791 ETH`, above the `0.000001 ETH` production floor. This is
exact price competition rather than reach, construction, or timing: the
single-buyback direct-payment path is isolated from other job kinds and the
complete signed bundle remains subject to exact simulation and retained-profit
checks.

A separate buyback in block `25684944` is not a confirmed-head planner miss:
the FWA token had zero ETH at parent block `25684943`, and the winner
atomically supplied value and called buyback. Its 530-bps builder payment is
therefore not comparable with a pre-existing balance opportunity.

The first live direct-payment exposure uncovered a correctness gap at target
block `25692551`. The keeper simulated a `0.005 ETH` reward and selected a
9704-bps payment: `0.000779185804428825 ETH` through priority fee plus
`0.004072814195571175 ETH` through the helper, retaining an expected
`0.000122801975378825 ETH`. Bundle construction then rejected the isolated
buyback with the stale standing-order-only guard, so nothing reached a relay.
Transaction `0x1c199da7c5bacf146082c3215c733597849b7ecd09dec128d686d4ec5e2651ef`
captured the exact reward in the Titan block and paid
`0.004928557644957567 ETH` directly to the beneficiary with zero priority fee.
One wei above it normalizes to 9858 bps and remains profitable by roughly
`0.000046244330421257 ETH` even when charging the full 50,000-gas helper
envelope at the exact child base fee. The helper guard now accepts either a
contiguous zero-value standing-order batch or exactly one zero-value FWA
buyback; mixed jobs, value-bearing jobs, nonce gaps, partial simulation, and
helper-free prefixes remain rejected.

A second, distinct residual buyback at target `25692552` exposed builder reach.
All six configured routes accepted our 9705-effective-bps offer of
`0.000692556877947260 ETH`, but Bombora omitted it and included transaction
`0xed55d7ac7fda1fefb3e8cbefbffc0d652be7f777578128953337f8382d97273e`,
which captured the same `0.000713681860983105 ETH` reward and paid only
`0.000685869067392007 ETH` directly to Bombora. Payment was not causal: our
offer exceeded the winner by `0.000006687810555253 ETH`, all six relays had
accepted, and the block used only `19,225,903 / 60,000,000` gas. Bombora's
official unauthenticated `eth_sendBundle` endpoint accepted the keeper's
existing request shape, so add `https://rpc.bombora.build` as a seventh direct
delivery path rather than raising the bid from this second miss.

While this repair was being validated, production won a smaller buyback on the
first target, block `25696749`, at the still-live 9704-bps target. Its receipt
earned `0.000301653174335544 ETH`, spent `0.000300653174238220 ETH`, and
retained exactly `0.000001000000097324 ETH`. The wallet and nonce 2078
reconcile. An equivalent small reward will fail the retained-profit boundary at
9858 bps and be skipped; that is intentional. The higher target is reserved for
buybacks whose exact reward and gas can still afford the newest 9857-bps
clearing evidence, while the final economic gate prevents an on-chain loss.

Decreasing-base-fee relay-simulation incident, 2026-08-06 through 2026-08-07:
the deployed isolated-buyback direct-payment path passed its preliminary exact
simulation but failed its final competitive Flashbots simulation 11 times with
typed `-32000 max fee per gas less than block base fee`. In every case the
immediate child's actual base fee equaled the keeper's deterministic EIP-1559
derivation and was lower than its parent. The helper had been signed at only
the child base fee plus one wei while the reward call retained the configured
5-gwei fee capacity. Flashbots continued to reject the helper throughout the
bounded 500-ms publication retry, proving this was not an incorrect local base
fee or ordinary publication delay.

All 11 exact target blocks contained a competing `Bought` event for the same
reward, so these were 11 distinct avoidable economic losses. Targets
`25697511`, `25697674`, `25698363`, `25698583`, `25698990`, `25699503`,
`25701827`, `25702678`, `25703521`, `25703816`, and `25704207` were built by
Quasar, Eureka, Titan, Builder+, BuilderNet, or their identified routes. Their
observed normalized payments ranged from 8,732 to 9,837 bps, all below our
9,858-bps target; price was not causal. The latest example offered a `0.005
ETH` reward at parent `25704206`, derived child base fee `198755378 wei`, and
expected `0.000028191271664848 ETH` retained profit, but never reached relay
submission; Titan captured it in target `25704207` for a
`0.004507892806978179 ETH` direct payment.

The bounded repair gives the zero-tip helper the highest signed max-fee
capacity already assigned to the reward-producing bundle while economics still
charge its actual gas at the exact child base fee. The helper therefore cannot
add an effective priority payment, but can satisfy a relay simulator that is
temporarily retaining the higher parent base fee. The signer balance gate now
reserves the full helper signing envelope. Exact full-bundle simulation,
helper-code identity, payment equality, retained-profit, nonce, balance, lease,
and target-deadline gates remain unchanged. The historical
`203177738 -> 198755378 wei` decrease is covered by regression tests, including
a fail-closed rejection when the helper envelope is below the exact child base
fee.

Follow-on relay-accounting incident, 2026-08-08: the higher helper envelope
removed the typed base-fee rejection and immediately produced four successful
post-deploy buyback captures, including target `25705053`, where the exact
two-member bundle earned `0.004829705284893819 ETH`, paid
`0.003981067015332266 ETH` directly plus exact gas, and retained
`0.000046666554656603 ETH`. However, it also exposed Flashbots simulating the
reward transaction's fee-cap-saturated priority contribution against the
higher parent base fee on decreasing-child targets. The helper payment itself
was exact, but `coinbaseDiff` was lower than the deterministic-child payment
by reward gas times the parent/child base-fee delta, so the keeper correctly
failed closed on aggregate payment equality.

Eight such final simulations failed at targets `25705464`, `25705700`,
`25707610`, `25707611`, `25708686`, `25708687`, `25711068`, and `25711766`.
Three fully submitted attempts also expired at targets `25705701`, `25708685`,
and `25711765`. Exact on-chain `Bought` logs prove a competitor captured the
same reward in every one of these 11 distinct blocks; they are economic misses,
not duplicate transaction-member expirations. The bounded follow-on repair
keeps only the lane's configured minimum priority fee whenever an exact direct
payment is used and moves the remainder of the unchanged builder bid into the
helper value. This preserves the same total bid, exact child-base gas cost,
retained-profit floor, max-fee envelope, signer balance reservation, and all
identity/simulation/lease/deadline gates, while making both
`ethSentToCoinbase` and aggregate `coinbaseDiff` invariant to the relay's
parent-versus-child base-fee view. The exact historical
`203177738 -> 198755378 wei` decrease and full 9,858-bps buyback payment are
covered by regression tests.

Second follow-on, 2026-08-09: production proved that removing all intended
priority payment was necessary but not sufficient for Flashbots' aggregate
accounting. Six final simulations still reported a lower `coinbaseDiff` than
the exact helper value, despite every reward transaction being signed with
zero priority. The first exact discrepancy was
`0.004928914347379123 ETH` reported versus
`0.004929 ETH` paid by the helper. The affected target sequences were
`25714683-25714686`, `25716729-25716730`, and
`25718341-25718342`. Exact `Bought` logs show these were four economic
opportunities, not eight independent losses: the reward persisted across the
first no-inclusion block in each sequence, then a competitor captured it at
`25714684`, `25714686`, `25716730`, and `25718342`.

The exact fallback now validates the signed payment components rather than
trusting the inconsistent aggregate: it is available only when the helper is
the entire intended payment, every reward transaction is signed with zero
priority, every non-helper simulation item reports zero direct payment, and
the helper item reports the exact intended value. Only a lower aggregate is
classified as the known relay base-fee artifact; an inexact helper, unexpected
non-helper transfer, or higher aggregate remains fail-closed. The first exact
production discrepancy is a regression fixture and production emits a
dedicated event whenever this narrowly bounded fallback is exercised.

Signer-availability incident, 2026-08-09: Railway gracefully stopped the
healthy `ca0cf2b` worker at `20:13:29 UTC`, marked its deployment Removed, and
left zero advisory signer leases. There was no `fatal`, pass failure, pending
nonce, or active lifecycle at shutdown, but the signer remained absent until
the next monitoring run restored it. Exact downtime replay across blocks
`25719742-25721194` found 371 FWA `Bought` events; none remained profitable at
the keeper's 9,858-bps bid after exact block base fee and the buyback/helper
gas, so those were not avoidable keeper losses.

GroupPull round 46 did expose avoidable work. Its covering `enter` paid one
close bounty atomically to the entrant and was not independently addressable.
The later `submit` at block `25720268` paid four GroupPull bounty shares
totalling `0.003555555555555556 ETH` while the competitor paid only
`0.000013809615 ETH` of priority and no direct payment; the configured
3,000-bps lane would have remained profitable. Once pool rounds 356-359
fulfilled, eight separate zero-builder-payment pool calls at blocks
`25720300-25720303` and `25720319-25720322` captured
`0.001648130493074796 ETH` of sync bounties and
`0.003303212146462005 ETH` of settle bounties. These nine reward calls exposed
`0.008506898195092357 ETH` gross during the outage; that is missed gross
reward, not realized or net profit. The eventual four-share GroupPull collect
paid `0.003504175660674695 ETH` to the builder against
`0.003555555555555556 ETH` gross and retained only
`0.000000679649280184 ETH` after exact base gas, below the keeper's
`0.000001 ETH` floor, so raising the collect bid is not justified.

Production was restored as deployment
`9aa76d6c-4f00-4948-935a-4c1c8a4d4f41` on exact revision
`3b7f0688db3956b280942ec72b90c8dc8e5a7b05`, with one signer lease, no
waiter, and continuing WebSocket passes. The stop had no application error
fingerprint to repair; continue treating a zero-lease/Removed deployment as an
availability incident requiring immediate safe redeployment after nonce and
lifecycle gates.

The RPC-cost audit retained this lane because durable history contains 65
opportunities and 19 successful receipts, including a profitable receipt on
2026-08-10. It did expose avoidable empty-state work: 7,033 of the preceding
24 hours' passes reported `buyback_no_eth`. Buyback planning now reads the
token's ETH balance first at the exact planning block and reads the two reward
parameters only when that balance is nonzero. This preserves immediate
eligibility and exact simulation while avoiding 14,066 contract reads per day
at the observed pass rate.

Acceptance:

- replay the newest exact payment comparison with the full helper gas envelope
- deploy 9858 bps, the corrected single-buyback direct payment, and direct
  Bombora delivery with one signer lease and
  latest nonce equal to pending
- on the next buyback, reconcile reward, gas, builder payment, and wallet delta
- change the target again only from new buyback-specific clearing evidence

### P0 — MegaRip one-pass FWA pool

Status: funded canonical successor validated and competitive reward-gated
batch keeper integration implemented. The canonical deployer's nonce-3455 MegaRip at
`0x49ba5f1C980a153Fd66FA61a60EeacF9c2b484ec` remains a zero-deposit Pending
predecessor. Nonce 3456 created the later verified successor at
`0x68f8E0Bd62eD310F692Ae0D01F7e568948818D25` in block `25721560`; nonce 3457
then funded it. Its 21,108-byte runtime hash is
`0x7cd2bfa992850e1fb61393852e38f7c48b0e4fc01031ad820f3e3fd95d55ad8b`.
The only verified-source change from the predecessor is a `0.01 ETH` minimum
deposit. The verified constructor pins canonical FWA
`0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c`, canonical FWA token
`0xa0Df17B5aC76ABaBA36E1450E2cbCd18A620C845`, FWA rewards
`0x6a1a1C0CfB3D3C538e13D36d608a5bcaa992fc78`, and a
`0.0003 ETH` per-crank bounty. Exact runtime reads at block `25726144` on
2026-08-10 matched those relationships and showed Funding state, `7.5778 ETH`
deposited, zero pulls and active allocations, and
`fundingEndsAt=1786418945`. The exact FWA quote was
`0.081783700221525224 ETH`; after the two reserved bounties per acquisition,
the pool could fund 91 acquisitions and therefore exposed at most `0.0546 ETH`
of gross pull-plus-terminal keeper rewards. This is opportunity inventory, not
realized or guaranteed net profit.

The verified source exposes capital-free, permissionless bounty work after
funding: `lock()` closes the fixed funding window, `pull(maxPulls)` first
reconciles resolved acquisitions and then requests bounded new acquisitions,
and `settle(listingId)` pays the reserved terminal bounty after an auction
deadline. `syncStuck`, `releaseStale`, `finalize`, and `sync` are also
permissionless lifecycle/recovery calls, but only paths consuming a reserved
crank bounty should enter the profit lane; `open` and ordinary reconcile calls
have no bounty. The original adapter's single `pull(1)` left most first-block
rewards exposed, stalled whenever an earlier request moved out of Pending
before reconciliation, and ignored every high-bid auction terminal bounty.
The replacement derives an owner-bound CREATE2 executor, pins its runtime, and
makes the first eligible private prefix `[deploy if needed, lock(),
pullExact(40, 0.012 ETH)]`; two later rewarded batches can cover the remaining
40 and 11 at their next exact states. The 40-call cap is derived from the
keeper's `16,777,216` gas signing envelope: the 64-call fork replay succeeded
but consumed `21,747,959` gas and therefore cannot be signed safely. In Pulling
state the executor batches up to 40
pulls and reverts the whole call unless the exact expected bounty arrives, so
reconciled fulfillments cannot silently turn the attempt into unrewarded work.
After auctions close, the planner tests every reserved allocation—including
high-bid outcomes—through a one-item reward-gated estimate, batches only proven
terminal bounties, and reverts unless the aggregate `0.0003 ETH` per listing is
received. Executor receipt accounting and forwarded wallet balances must
agree. Complete signed-bundle simulation, retained profit, nonce/balance/lease,
and private delivery remain authoritative. Pull execution retains its
independent 1,000-bps private bid. Terminal auction settlement also starts at
an independent 1,000-bps discovery bid: there is no same-lane clearing sample
yet, while comparable FWA ready lifecycle work cleared around 250–1,001 bps.
After a loss, raise settlement bidding only when the exact target block proves
a competing MegaRip settlement, reconstructs its normalized builder payment,
and shows that beating it would have retained the configured profit floor.

The funding boundary arrived in block `25729077` on 2026-08-10 America/Denver.
The keeper's exact deploy/lock/40-pull prefix confirmed with `0.012 ETH` gross
bounty and `0.010328368606535973 ETH` verified net realized profit. The three
successful receipt attributions sum exactly to the wallet increase from
`0.602447522227890090 ETH` to `0.612775890834426063 ETH`; this is about
`$19.41` at the fresh `$1,879.18` oracle used by the reconciliation. Competing
bundles then captured the other 339 pull bounties. The earliest four competing
40-pull batches paid `0.011514 ETH` directly from each `0.012 ETH` reward and
retained only about `0.0000043-0.0000049 ETH` after base gas, so they are not
evidence for blindly bidding above 95.95% with the keeper's slightly larger
executor gas. The final eight-pull competitor in block `25729092` paid
`0.002159882279490615 ETH` directly from `0.0024 ETH` gross and retained
`0.000068741406457957 ETH` after base gas. That tail was counterfactually
profitable at a higher pull-specific bid, but production had exhausted its
restart budget during a WebSocket provider outage; keep pull and terminal
settlement bidding independent before applying this clearing evidence.

The outage exposed a planner reliability defect: Pulling-state discovery sent
one concurrent WebSocket request for every acquisition. At 379 acquisitions it
closed the public exact-state socket and amplified failures on the
capacity-constrained Alchemy socket. The planner now reads all acquisition
records through one exact-block Multicall3 request. A production-equivalent
read-only pass at block `25729170` completed with all 379 records and no socket
failure. Until the Alchemy production WebSocket is independently stable again,
the confirmed-head keeper uses the validated public exact-state WebSocket and
the two optional Alchemy-filtered pending feeds remain disarmed; private relay
submission and all exact simulation, nonce, balance, signer-lease, and retained
profit gates are unchanged.

The follow-up RPC audit keeps MegaRip enabled because the first rewarded batch
realized `0.010392136602992931 ETH` on its reward-bearing member. Its six hot
state getters now share one exact-block Multicall3 request. The 21,108-byte
non-proxy runtime and immutable FWA/token/rewards relationships are verified
once per exact-state client instead of being downloaded and re-read on every
head; all mutable state, acquisition records, estimates, simulations, and
submission gates remain exact-head reads.

At block `25729131`, all 379 allocations remained bounty-reserved: 366 were
pending fulfillment and 13 had open auctions, with no high bids and no terminal
settlement callable yet. The first observed auction deadlines are
2026-08-11 09:30:35-09:31:47 America/Denver. The reserved terminal bounty
inventory is `0.1137 ETH` gross across all allocations, not guaranteed or
realized profit. Continue exact per-listing reward proofs and compete for every
terminal bounty regardless of the auction's bidder outcome.

The focused 2026-08-11 terminal watch captured all 379 reserved settlement
bounties in 44 successful reward-gated transactions from nonces 2190-2233.
Exact `BountyPaid` logs sent `0.1137 ETH` gross to the canonical executor;
PostgreSQL receipts charged `0.022242025055292211 ETH` of gas and retained
`0.091457974944707789 ETH`. The keeper wallet rose by exactly that net amount,
from `0.613779218926293555 ETH` to `0.705237193871001344 ETH`, with
`latest == pending == 2234`. Four private attempts expired in target blocks
`25732694`, `25732695`, `25732712`, and `25732717`. Each had all seven relay
paths accepted within 63-291 ms; the bobTheBuilder, Titan, Nethermind-labeled,
and Titan blocks contained no competing MegaRip settlement, bounty, priority
payment, or direct beneficiary payment. Same-1,000-bps retries landed, including
the 54-listing retry after the first two omissions, so these were builder/block
construction omissions rather than price losses and the settlement-only bid
remains 1,000 bps. The three high-bid auctions extended to 09:57:59, 09:58:23,
and 09:59:11 and each landed on its first eligible target through BuilderNet,
Titan, and Titan. The final exact scan had 375 Resolved and four `STUCK_NFT`
records, all non-reserved; no callable reserved allocation remained.

Release follow-up, 2026-08-12: the canonical deployer advanced from nonce 3457
through 3468 without creating another contract. Nonces 3458-3468 were ordinary
MegaRip/FWA participation and cleanup: NFT approval/mint activity, a V2 pool
purchase, additional MegaRip funding, auction bids, a token swap, and the final
claim/withdraw path. A fresh exact runtime/immutable check at block `25739705`
still matched the pinned successor and showed Finalized state, 379 pulls, zero
remaining pulls, all 379 acquisitions Resolved, and no reserved or callable
terminal bounty. The four records that were initially `STUCK_NFT` therefore
resolved during the canonical cleanup without exposing another keeper reward.

The new @ripe0x S01 postmortem is a release lead, not production authority. It
targets a next version around 2026-08-12/13 with settled ETH recycled into more
pulls until a bankroll floor is reached, contribution-weighted prize pools, and
most auctions replaced by direct settlement back into FWA. That materially
changes lifecycle shape and can create repeated pull/settlement reward cycles,
but no successor deployment existed at canonical-deployer nonce 3469. Watch
for a canonical creation and verified source; before enabling anything, derive
the new state machine, reward authority, recycling loop bounds, direct-settle
callability, and exact independent economics. Do not assume the S01 auction
settlement adapter or one-pass pull-count model is compatible.

Release watch, 2026-08-13: canonical-deployer nonce 3469 was successful
transaction `0x723b963e893e315509ead5a68730319ec2911cfca190324c72b4b663bc1dcf68`,
an ordinary `contribute(...)` call into verified `FWAPHouse` at
`0x00000000000E56073987EAF8694Fe54fCA2F53de`, not a creation, upgrade,
factory/configuration mutation, or MegaRip successor. The transaction supplied
NFT/FWA inventory and minted house receipt/share assets. Exact verified-source
review found permissionless `activateInventory`, `recycleAllocated`,
`recoverAllocated`, `relistReturned`, and terminal-sync methods, but none pays
the external caller: ETH/FWA proceeds and rewards are allocated to the house,
treasury, or its holders. Calling them would spend keeper gas without a reward,
so this downstream lead is rejected for the capital-free keeper. The newest
visible @ripe0x post still predates the prior release boundary and supplies no
successor address. Continue watching from deployer transaction count 3470.

Release watch, 2026-08-14: @ripe0x posted a new MegaRip “SEASON 02” teaser at
`2087930700347347414`, but supplied no address, lifecycle specification, or
reward surface. Exact latest and pending transaction counts for the canonical
deployer both remain 3470, so no canonical creation, configuration change, or
successor relationship corroborates the teaser yet. Production remains pinned
to the finalized S01 successor and has no remaining rewarded S01 allocation.
Continue watching from deployer transaction count 3470 and require verified
source plus exact reward authority before implementing Season 02.

Release watch, 2026-08-15: no new MegaRip implementation evidence appeared.
The only new visible @ripe0x post since the Season 02 teaser concerned TRUST,
not FWA, PullPool, GroupPull, or MegaRip. The canonical deployer transaction
count remains exactly 3470, so there is still no successor creation,
configuration mutation, or downstream event to inspect. Keep the same 3470
boundary and treat the teaser as uncorroborated until canonical code appears.

Season 02 launch, 2026-08-16 America/Denver: the teaser is now corroborated by
canonical code and live funding. The public `megarip.fun` application pins
MegaRip `0x6769944589f5CC96d5F900F06539681Db84AC5c6` and deployment block
`25771992`. Canonical deployer `0xCB43078C32423F5348Cab5885911C3B5faE217F9`
created that exact nonproxy at nonce 3470 in transaction
`0x42b70312ce38793a8888b79150255f0b1356ea6d5248ef31ed04e6c195fb1667`.
Its 22,009-byte runtime hash is
`0x56b1436bab9f9a603fb91de8fea2d10abbb3adfb2d280e3ac71386b2d5e60661`.
Blockscout's verified Solidity 0.8.28 source and two independent exact-state
providers agree on canonical FWA
`0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c`, FWA token
`0xa0Df17B5aC76ABaBA36E1450E2cbCd18A620C845`, and rewards
`0x6a1a1C0CfB3D3C538e13D36d608a5bcaa992fc78`. The decoded constructor fixes a
24-hour funding window, 30-minute auction, 500-bps minimum bid increment,
9,500-bps floor, 2% settlement fee, `0.0003 ETH` crank bounty, 10-second request
interval, one no-auction collection, and fee recipient
`0xea194A186EBe76A84E2B2027f5f23F81939c05AD`. That recipient scheduled
`openAt=1786936691`; funding ends at `1787023091` (2026-08-17 21:18:11
America/Denver).

This runtime is not compatible with the S01 batch assumption. Each acquisition
now reserves three bounties—request, reveal/sync, and terminal settlement—and
the ten-second throttle permits only one new request per block timestamp even
when `pull(maxPulls)` receives a larger bound. It also adds permissionless
`crankReveal(maxCount)`, a `pendingSyncCount` view, and a per-acquisition
`syncReserved` flag. The old `[lock,pullExact(40,0.012 ETH)]` prefix would
create one request, pay only `0.0003 ETH`, and correctly revert at the old
executor's reward floor. The new pinned executor instead uses
`pullExact(1,bounty)` at lock, prices the exact sum of paced request and
already-terminal sync bounties, and exposes a separate sequence-bound
`crankRevealExact`: both the pre/post FWA queue pointers and aggregate ETH
reward must match or the whole FWA/MegaRip mutation reverts. Terminal settlement
retains the existing per-listing and aggregate reward gates.

At exact block `25772329`, funding held `0.89 ETH`, zero pulls, and no sync
work. The FWA acquisition quote was `0.079423870684798324 ETH`; after all three
`0.0003 ETH` reserves, the current pool could afford 11 acquisitions and
therefore exposed `0.0099 ETH` maximum gross bounty inventory. This is live,
changing inventory, not realized profit. The new read-only
`npm run inspect:mega-rip` command pins creation provenance, runtime,
relationships, state, queue, three-leg economics, executor identity, and both
keeper nonces. A mainnet fork at block `25772203`, warped to the fixed funding
deadline, proved the atomic `lock -> pullExact(1,0.0003 ETH)` path and exact
wallet forwarding; the reward-gated pull, settlement, recovery, and
sequence-moved reveal rollback paths also have focused Solidity and TypeScript
coverage. The deterministic owner-bound executor is
`0xd9FB9e5C7936BB878432E5D22aBe89b295252cC5`; its exact factory deployment
estimated `750523` gas against a `1000000` limit.

The conditional restart gate is satisfied. The full validation passed 416
Vitest tests, all 25 Solidity tests, TypeScript, both builds, and diff/format
checks. The live fork's deliberately conservative 1.439M-gas test envelope,
the observed 0.0411-gwei immediate-child base-fee allowance, and the independent
1,000-bps MegaRip builder bid still leave the first `deploy -> lock -> pull`
reward positive; target-block signed-bundle simulation remains authoritative.
Production is already configured with the replacement public HTTP/WebSocket
foreground path and public discovery mix. A live WebSocket check delivered a
complete head and exact fixed-block runtime, nonce, and balance, and a
MegaRip-only `DRY_RUN=true RUN_ONCE=true` pass completed from that head in
about 0.46 seconds with no job before the boundary. At that snapshot Railway
was still offline, PostgreSQL was online, keeper `latest == pending == 2245`,
the legacy PullPool had no active lifecycle (`pendingLifecycleRound == 0`), and
the account's reconciled net value was `$1,333.19990935`.

Rollout completed at 2026-08-16 22:23 America/Denver as Railway deployment
`57382684-a143-457b-a594-67124f1a2ad3` from source revision
`4e73454b173a375a0bc4ff9ec368955cc9c2bce8`. The exact predeploy gate again
showed keeper `latest == pending == 2245`, legacy pending lifecycle zero, and
V2 pending-pull count zero. Production has only MegaRip enabled; stale Gacha,
all other strategies, and both pending subscriptions are disabled. Migrations,
signer initialization, and one signer lease completed in order. The first ten
WebSocket-head passes completed with zero failures, fatals, or submissions and
continued to read the exact Funding state. Keep this deployment temporary and
remove it after the last actionable Season 02 settlement/recovery.

Season 02 operational check, 2026-08-17 09:03 America/Denver: exact block
`25775573` remained in Funding with `1.758 ETH` deposited, zero pulls, zero
pending syncs, and 6,216 active FWA listings. The live acquisition quote was
`0.079736768362443242 ETH`; after the three independent `0.0003 ETH` bounties,
the pool could afford 21 acquisitions and therefore exposed `0.0189 ETH` of
maximum gross bounty inventory. This is changing pre-lifecycle inventory, not
realized profit. Keeper `latest == pending == 2245`, the executor remained
undeployed with the expected CREATE2 identity/runtime, and all pinned runtime,
FWA, token, and rewards relationships matched.

The first hardened deployment was
`401ac669-ff46-42c1-8a5b-7236607fc8eb` from exact source revision
`061399a4cc97bfb0de466ef0803502f8ffd38c78`. An earlier process accumulated 88
fresh-state publication failures between 2026-08-17 04:47 and 09:39 UTC,
primarily viem's typed `ResourceNotFoundRpcError[-32001]` plus a smaller set of
classified fresh-state parameter errors and socket closures. Revision
`061399a` added the bounded typed `-32001` publication-skew retry. Its later
eight-hour history contained four isolated typed `InvalidInputRpcError[-32000]`
passes and one typed `ResourceNotFoundRpcError[-32001]` pass where exact state
remained unavailable through the one-second retry window. A stalled WebSocket
head at 20:49 UTC correctly forced one supervised restart; initialization
completed and the signer lease was reacquired in 3 ms. There was no repeating
failure, opportunity, submission, or receipt while the contract remained in
Funding.

Dashboard incident follow-up, 2026-08-17 16:38 America/Denver: revision
`061399a` bounded the ETH/USD refresh at two seconds, coalesced cold and
background refreshes, served stale data while revalidating, bounded PostgreSQL
work, counted only recently passing run IDs, and counted only the named signer
advisory lease. The new database guard then exposed a pre-existing bad plan in
the latest-receipts query: its global timestamp-index scan exceeded four
seconds and returned HTTP 500. Splitting the two event names into bounded
branches uses the existing `keeper_events_name_time_idx`; production
`EXPLAIN ANALYZE` fell to 10.5 ms. Current Railway deployment
`b04ed0fe-0aa8-4345-b888-7c30ac7c5052` runs exact revision
`463a973d73c159de4ffc820568f4883bca142544`. Its replacement initialized,
waited for the old signer, acquired the sole lease after the planned 60-second
handoff, and began current WebSocket passes with no application error. The
first cold dashboard response was HTTP 200 in 640 ms; after the overlap aged
out, a refreshed response was HTTP 200 in 79 ms with `activeRuns=1`,
`signerLeases=1`, and a fresh pass.

The predeploy exact block `25777823` remained in Funding with `10.871 ETH`
deposited, zero pulls, and zero pending syncs. At the live
`0.079266283165415355 ETH` acquisition quote, the pool could afford 135
three-bounty acquisitions and exposed `0.1215 ETH` of maximum gross bounty
inventory. Keeper `latest == pending == 2245`; the fresh reconciled account
snapshot after rollout was `0.701894109892021588 ETH` net equivalent, or
`$1,336.75814993` at the fresh `$1,904.50116491` oracle. These bounty figures
remain changing inventory, not realized profit. Continue watching through the
lock boundary and do not count any bounty until successful receipts reconcile
with the wallet.

Telemetry incident follow-up, 2026-08-17 16:59 America/Denver: production
recorded four isolated three-second `Query read timeout` failures between
18:38 and 22:45 UTC. Each affected one retained seven-event batch, and durable
events later proved that every queue drained without interrupting signing. One
immediate retry at 19:27 UTC reused the failed transaction session and produced
`current transaction is aborted`; this was a telemetry-pool recovery defect,
not an Alchemy limit or a keeper execution failure. Revision
`94038b7b6b4f88a1d6e150fc768ee9804a54c67b` gives PostgreSQL five seconds of
server execution and ten seconds of bounded client read time, allows three
seconds to connect, destroys any connection that experienced a failed
transaction, and emits an explicit recovery event after a retained batch is
persisted. TypeScript, all 420 Vitest tests, both builds, and the diff check
passed, including focused rollback/disposal and retained-queue recovery tests.

Railway deployment `c543b2eb-4f62-406c-a464-74857cc5f1b7` ran that exact
revision. Its replacement initialized read-only, waited 60.795 seconds for the
old signer, acquired the sole lease, and started consecutive WebSocket passes.
PostgreSQL then contained 78 events and nine passes from the new run through
22:58:13 UTC with zero telemetry, pass, or fatal failures; the 22:59 dashboard
reported `activeRuns=1`, `signerLeases=1`, and a fresh pass. The exact
predeploy block `25777922` remained in Funding with `11.101 ETH` deposited,
zero pulls, 138 affordable three-bounty acquisitions, `0.1242 ETH` changing
maximum gross bounty inventory, and keeper `latest == pending == 2245`.

Season 02 final outcome, 2026-08-18: exact inspection at block `25782738`
proved the pinned contract and all immutable relationships unchanged, state
`FINALIZED`, `pullsDone == 209`, `estimatedPullsRemaining == 0`, and
`pendingSyncCount == 0`. Successful receipts paid `0.0312 ETH` gross across
104 bounty units and retained exactly `0.027473321020192284 ETH` after gas and
builder payments. The wallet moved from the pre-lifecycle reconciled
`0.701894109892021588 ETH` equivalent to `0.729367430912213872 ETH`
equivalent, agreeing exactly with the receipt sum. Keeper nonces reconciled at
`latest == pending == 2252`.

The contract emitted 627 canonical `BountyPaid` units totaling `0.1881 ETH`:
209 request, 209 reveal/sync, and 209 terminal rewards. We captured the opening
request reward, no reveal/sync rewards, and 103 terminal rewards, leaving 523
distinct units to competitors. The 240 transaction-member expirations are not
240 separate economic losses. Relay delivery was healthy: all 1,715 attempts
were accepted across the seven configured paths. Exact receipt and direct
beneficiary-payment reconstruction instead identifies price competition as
the primary cause. The first lost pull paid BuilderNet
`0.000101394166973472 ETH` against its `0.0003 ETH` bounty while our 10% bid
paid about `0.00003 ETH`; the approximately 33.8% payment required to beat it remained
counterfactually profitable. A 12-transaction sample later ranged from about
8% to 93% of bounty, with mature clearing commonly near 88-93%, generally at
or beyond the gas-adjusted retained-profit boundary.

For a future runtime-compatible MegaRip, implement independent adaptive
request, reveal/sync, and terminal bid policies backed by exact competitor
payment observation and counterfactual retained-profit evidence. Escalate only
after proven losses and retain exact signed-bundle profitability as the final
boundary; do not copy the late-season 90% clearing level into a static bid.
Also test whether wrapper aggregation exposes profitable mandatory-prefix
composition. This is research for a newly verified season, not justification
to reactivate production now.

After the terminal state and nonce gate were reconfirmed, Railway deployment
`c543b2eb-4f62-406c-a464-74857cc5f1b7` was removed. The worker is offline,
PostgreSQL remains online, and the named signer lease count is zero.

The public Season 02 thread now corroborates the verified implementation. In
post `2089196795779772483`, @ripe0x described 30-minute auctions only for pulls
with more than 1 ETH of backing, immediate ETH settlement for non-auctioned
pulls, wrapped-token NFT exclusions, minimum ten-second pull pacing, and
claimable FWA epoch rewards. These are release leads only; the exact verified
runtime remains authoritative and already implements the supported lifecycle.
Canonical-deployer nonce 3471 was a successful deposit into this exact
MegaRip, and nonce 3472 was an unrelated `collectPatronEdition` call to
`0xaB48082d28049873ce54F672541D29779a3392Ef`. Neither created a successor or
changed runtime/configuration. Continue release watching from canonical
deployer transaction count 3473. The next bounded check advanced that boundary
to 3476: nonce 3473 was another successful deposit into the same MegaRip,
nonce 3474 successfully claimed from it, and nonce 3475 called the Uniswap
Universal Router after the claim. No contract creation, successor, runtime,
ownership, or configuration change was found. New public posts reported 209
pulls, `16.91 ETH` in, `17.12 ETH` out, two auctions with more than 1 ETH of
backing, and finalized results; these corroborate the exact on-chain terminal
state but introduce no new keeper implementation.

Auction bids are a different, capital-bearing strategy: they escrow ETH and
can result in NFT custody, and winning resale value cannot be guaranteed from
the protocol settlement alone. They remain intentionally excluded under the
binding no-deposit/no-bid/no-approval/no-custody invariant. The bot does pursue
the permissionless terminal bounty for each exact auction outcome that proves
rewarded, whether another bidder wins or the reserve/no-bid path resolves.

### P0 — Hypertoadz permissionless auction settlement

Status: validated and implemented fail-closed; token 4 settlement captured and
production returned offline. Every later auction requires fresh exact-state
economics and another bounded temporary lifecycle deployment.

Canonical-deployer nonce 3476 was successful transaction
`0x97c3dd48ea32bb8471da6bfc3fac98494d2440ea25c0c1e4e1390f80d043abb0`,
a `0.1 ETH` bid into verified `HypertoadzCore` at
`0x70AD2a6C7e4a54720a64f1fEC9F0ff6E64001aF4`. This was a product lead rather
than deployment provenance: no new contract creation, successor, or
configuration transaction came from the canonical FWA deployer. Exact runtime
hash `0x6f651ee67b191e3606ccf321a81b706ed1d82bd6623fe78b88e4f51b153495b6`
matches the verified Solidity 0.8.24 source. The pinned runtime exposes
permissionless `finalize()`, an immutable 24-hour auction duration, a
five-minute extension window, and a settler reward bounded at 1% of the
winning bid. The reward authority is the exact Core's
`AuctionFinalized.settlerReward`; bidding is unnecessary and remains excluded.
Continue bounded deployer release watching from transaction count 3477.

At block `25789943`, token 1's winning bid had risen to `0.2541 ETH`, its
settler reward was exactly `0.002541 ETH`, and the deadline was
2026-08-19 17:04:11 America/Denver. A fork replay at the first eligible
timestamp successfully finalized, advanced to token 2, emitted the exact
`0.002541 ETH` reward to the keeper, and consumed 1,233,719 gas. At the
replayed `3.329577542 gwei` effective gas price, gas cost
`0.004107763075538698 ETH`, so the transaction lost
`0.001566763075538698 ETH` before any builder payment. Production therefore
stayed offline. A later bid increase or lower base fee can cross the boundary;
the final exact signed-bundle simulation remains authoritative.

Post-settlement incident review, 2026-08-20: token 1 did not remain at the
`0.2541 ETH` snapshot. Late bids extended it to `1.77 ETH`, creating an exact
`0.0177 ETH` bounty that competitor transaction
`0x778855fef458caed4cc1a737ff6407f0078abb7d7a0b4e60480cd8a08cf87d8f`
captured in block `25792459`. Its receipt used 1,243,686 gas at
`0.100725918 gwei` and its trace paid the block beneficiary
`0.017572464110770467 ETH`, leaving only `0.000002264475175785 ETH` after gas.
This proves settlement is searched at effectively the full post-gas reward;
the independent requested bid is now 10,000 bps, which the exact quote caps at
the configured minimum retained profit. Replaying the clearing with our quote
would have offered `0.000001264475471457 ETH` more than the observed payment
while retaining `0.000001000000948014 ETH`, the minimum plus unavoidable
per-gas rounding.

Token 2 currently ends at 2026-08-20 17:33:11 America/Denver. At block
`25797407` its bid was `0.105 ETH` and reward was `0.00105 ETH`. Exact fork
finalization succeeded and consumed 1,292,020 gas, but the observed parent
base fee was `1.965730150 gwei`; even the 10,000-bps quote can retain the
minimum profit only below about `0.405485209 gwei`. Production therefore
remained offline at that boundary pending the terminal-window recheck.

Token 2 terminal operation, 2026-08-20: the pre-deployment exact state matched
the pinned runtime and immutable 86,400-second duration, 300-second extension,
and 100-bps maximum/current settler reward configuration. The bid rose first
to `0.11025 ETH` and then to `0.1157625 ETH`, making the exact reward
`0.001157625 ETH`; no bid extended the original deadline. Before activation,
the keeper had `latest == pending == 2252`, balance
`0.736540768907611798 ETH`, and PostgreSQL signer lease count zero. TypeScript,
all 425 tests, both builds, `git diff --check`, clean-worktree, and exact
`HEAD == origin/main == f6850e6787262a13109edbb0db50fd8b30248a67`
gates passed. Railway temporarily deployed that revision as
`491380c1-8395-49b1-b383-81c247c41129` with only Hypertoadz enabled, MegaRip
disabled, the independent 10,000-bps bid, and the `0.000001 ETH` profit floor.
Startup proved the expected source revision, exactly one signer lease, and
healthy WebSocket-headed passes.

At exact parent block `25799645`, timestamp `1787268779`, parent base fee
`0.051694113 gwei`, and gas usage `51,794,126 / 60,000,000`, the immediate
child base fee derived to `0.056388396 gwei`. The first eligible pass hit the
provider's classified `InvalidInputRpcError[-32000]` fresh-state response and
failed closed; a fresh pass on the same authoritative head succeeded about two
seconds later. Preliminary signed-bundle simulation consumed 1,293,536 gas.
The maximum-safe quote capped the requested 10,000-bps bid at
`0.837769169 gwei` priority, `0.001083684579791584 ETH` builder payment, and
`0.000001000000000160 ETH` expected retained profit. Competitive simulation
succeeded, the final nonce/balance/lease/target gate passed, and all seven
relay paths accepted the one-transaction bundle.

Titan included keeper transaction
`0x7b582156c09170fac968d8256b07e7fed6224d4a0c2cad8922a2a5c8d7f8d294`
in target block `25799646`. Its successful canonical receipt used 1,293,471
gas at `0.894157565 gwei`, paid the exact `0.001157625 ETH` reward, cost
`0.001156566879758115 ETH`, and realized
`0.000001058120241885 ETH` net. PostgreSQL stored the matching sent and receipt
rows, and the keeper wallet increased by exactly `1,058,120,241,885 wei`, from
`0.736540768907611798 ETH` to `0.736541827027853683 ETH`. The Core advanced to
fresh zero-bid token 3 and the account reconciled at
`latest == pending == 2253`. Railway deployment
`491380c1-8395-49b1-b383-81c247c41129` was then removed, Hypertoadz was
disabled again, the worker had zero active deployments, PostgreSQL remained
healthy, and signer lease count returned to zero. Routine production is
offline; token 3 or any later auction needs the same fresh runtime, auction,
economics, nonce, balance, lease, signed-simulation, and bounded-deployment
gates rather than inheriting token 2's activation.

Token 3 terminal operation, 2026-08-21: the morning boundary did not persist.
The bid rose from `0.0269 ETH` to `0.04069 ETH`, making the exact settler
reward `0.0004069 ETH`; the complete token-3 event history contained no
`AuctionExtended`, so the original 2026-08-21 17:36:11 America/Denver deadline
remained final. Before activation at block `25806692`, the pinned runtime and
100-bps reward configuration still matched, the immediate child base fee
derived to `0.211430249 gwei`, the keeper had `latest == pending == 2253` and
`0.736541827027853683 ETH`, and PostgreSQL signer lease count was zero.
TypeScript, all 425 tests, both builds, `git diff --check`, clean-worktree, and
exact `HEAD == origin/main == a414e0ce9d7e81db4f8f014394fcf7309576a4b9`
gates passed. Railway temporarily deployed that revision as
`5b550b82-0322-4753-9ef3-db56f147027c` with only Hypertoadz enabled, the
independent 10,000-bps bid, and the `0.000001 ETH` profit floor; startup proved
the expected source, healthy WebSocket-headed passes, and exactly one signer
lease.

The exact parent was block `25806838`, timestamp `1787355359`, base fee
`0.148271255 gwei`, and gas usage `34,245,608 / 60,000,000`; its immediate
child base fee derived exactly to `0.150894178 gwei`. Preliminary signed-bundle
simulation consumed 1,259,355 gas. The maximum-safe quote capped the requested
10,000-bps bid at `0.17141367 gwei` priority,
`0.00021587066238285 ETH` builder payment, and
`0.00000100000008196 ETH` expected retained profit. Competitive simulation
succeeded, the final nonce/balance/lease/target gate passed, and all seven
relay paths accepted the one-transaction bundle.

Titan included keeper transaction
`0x99a79674a27fc1237a084d3116a2044f2b284f72eebb91fb912639dfb9b678ec`
in target block `25806839`. Its successful canonical receipt used 1,259,355
gas at `0.322307848 gwei`, paid the exact `0.0004069 ETH` reward, cost
`0.00040589999991804 ETH`, and realized
`0.00000100000008196 ETH` net. PostgreSQL stored the matching sent and receipt
rows, and the keeper wallet increased by exactly `1,000,000,081,960 wei`, from
`0.736541827027853683 ETH` to `0.736542827027935643 ETH`. The Core advanced to
fresh zero-bid token 4 and the account reconciled at
`latest == pending == 2254`. Railway deployment
`5b550b82-0322-4753-9ef3-db56f147027c` was then removed, Hypertoadz was
disabled again, the worker had zero active deployments, PostgreSQL remained
healthy, and signer lease count returned to zero. Routine production is
offline; token 4 or any later auction needs the same fresh runtime, auction,
economics, nonce, balance, lease, signed-simulation, and bounded-deployment
gates rather than inheriting token 3's activation. The completed token-3
one-shot watch was deleted after this terminal handoff.

Token 4 terminal operation and retained-profit incident, 2026-08-22: late
bidding moved the auction through `0.04777`, `0.055`, `0.066`, `0.06942`, and
finally `0.111 ETH`, with repeated five-minute extensions ending at
2026-08-22 18:09:23 America/Denver. Before activation, the pinned runtime and
100-bps reward configuration still matched, the keeper had
`latest == pending == 2254`, balance `0.736542827027935643 ETH`, and the
PostgreSQL signer lease count was zero. TypeScript, all 425 tests, both builds,
`git diff --check`, clean-worktree, and exact
`HEAD == origin/main == 94f236b3f0dfdb3f3367eb1598b98469b2fc6fb1`
gates passed. Railway temporarily deployed that revision as
`ae5e7a72-e392-48a1-8196-cec2b3b96280` with only Hypertoadz enabled; startup
proved the exact source, seven private relay paths, healthy WebSocket-headed
passes, and exactly one signer lease.

At exact parent block `25814172`, preliminary signed-bundle simulation used
1,374,654 gas. The `0.00111 ETH` reward and exact child base-fee allowance of
`0.065960548 gwei` capped the maximum-safe quote at `0.740787913 gwei`
priority and `0.000001000001092506 ETH` expected retained profit. All seven
relay paths accepted the bundle. BuilderNet included keeper transaction
`0x335c2b9c070f3a8e1d86c778158324947f5aab47e51dc3e62ae76aea51a0fcf1`
in target block `25814173`, but its successful canonical receipt used
1,374,941 gas, 287 more than the signed simulation. The exact reward was
`0.00111 ETH`, gas cost was `0.001109231535715801 ETH`, and verified realized
profit was only `0.000000768464284199 ETH`. The wallet increased by that exact
amount to `0.736543595492219842 ETH`; PostgreSQL sent/receipt rows agreed,
`latest == pending == 2255`, the worker was removed, Hypertoadz was disabled,
and the signer lease count returned to zero.

Although positive, this result violated the configured `0.000001 ETH`
retained-profit floor. The cause was execution-gas drift between the builder's
successful simulation and the canonical receipt, not a reward, base-fee,
nonce, relay, or lifecycle mismatch. The repair reserves an evidence-backed
2,048 gas only in Hypertoadz retained-profit pricing while preserving the
actual simulated gas for builder-payment normalization. Replaying token 4 now
quotes `0.739587784 gwei` priority, conservatively expects at least
`0.000001000000238936 ETH`, and would have retained
`0.000002418570851588 ETH` at the observed receipt gas. The exact regression,
all 426 tests, TypeScript, both builds, and `git diff --check` pass. Production
remains offline; the reserve must be committed before any later activation.

Token 5 terminal operation, 2026-08-23: the bid progressed through `0.01`,
`0.037`, `0.03885`, and `0.0407925 ETH`, making the exact settler reward
`0.000407925 ETH`. The complete token-5 event history contained no
`AuctionExtended`, so the original 2026-08-23 18:15:23 America/Denver deadline
remained final. A fresh exact-state fork at block `25821222`, warped to that
deadline, successfully finalized token 5, advanced to token 6, emitted the
exact reward to the keeper, and consumed 1,381,153 gas. With the lane-specific
2,048-gas receipt reserve and the fork child's `0.044552936 gwei` base fee, the
independent 10,000-bps maximum-safe quote capped priority at
`0.249637857 gwei`, builder payment at `0.000344788075109121 ETH`, and
conservatively retained `0.000001000000931607 ETH`.

Before activation, the pinned runtime and 100-bps reward configuration still
matched, the keeper had `latest == pending == 2255`, balance
`0.736543595492219842 ETH`, and PostgreSQL signer lease count zero. TypeScript,
all 426 tests, both builds, `git diff --check`, clean-worktree, and exact
`HEAD == origin/main == 95402402f899a359dad9de34e95b0b88dcb96339`
gates passed. Railway temporarily deployed that revision as
`3a33ec79-ec1d-435f-af6e-0cc841212fe9` with only Hypertoadz enabled, the
independent 10,000-bps bid, and the `0.000001 ETH` profit floor. Startup proved
the exact source, seven private relay paths, healthy WebSocket-headed passes,
and exactly one signer lease.

At exact parent block `25821380`, hash
`0xf7922052d990454db2e0ad061822d6c7e1d9cbdec765001499ba950c694094a1`,
timestamp `1787530511`, parent base fee `0.073816912 gwei`, and gas usage
`26,449,589 / 60,000,000`, the immediate child base fee derived exactly to
`0.072724911 gwei`. The first eligible pass received the classified
`InvalidInputRpcError[-32000]` fresh-state response and failed closed; a fresh
pass on the same authoritative head succeeded about two seconds later.
Preliminary signed-bundle simulation consumed 1,381,208 gas. The maximum-safe
quote capped priority at `0.221454185 gwei`, builder payment at
`0.00030587429195548 ETH`, and expected retained profit at
`0.000001000000383424 ETH`. Competitive simulation succeeded, the final
nonce/balance/lease/target gate passed, and all seven relay paths accepted the
one-transaction bundle.

Titan included keeper transaction
`0xa0c020403e4b86e42ba354de51c52b29c7d60a9169f7210e9988e278ddfe7e3b`
in target block `25821381`. Its successful canonical receipt used 1,380,930
gas at `0.294179096 gwei`, paid the exact `0.000407925 ETH` reward, cost
`0.00040624073903928 ETH`, and realized `0.00000168426096072 ETH` net.
PostgreSQL stored matching sent and receipt rows, and the keeper wallet
increased by exactly `1,684,260,960,720 wei`, from
`0.736543595492219842 ETH` to `0.736545279753180562 ETH`. The Core advanced to
fresh zero-bid token 6 and the account reconciled at
`latest == pending == 2256`. Railway deployment
`3a33ec79-ec1d-435f-af6e-0cc841212fe9` was then removed, Hypertoadz was
disabled again, the worker had zero active deployments, PostgreSQL remained
healthy, and signer lease count returned to zero. Routine production is
offline; token 6 or any later auction needs the same fresh runtime, auction,
economics, nonce, balance, lease, signed-simulation, and bounded-deployment
gates rather than inheriting token 5's activation.

The disabled-by-default implementation pins address, runtime, duration,
extension, and maximum reward configuration; reads the current auction and
reward at the subscribed exact block; targets the first eligible child; uses
only private delivery; requests the independent maximum-safe bid; derives
actual reward only from the canonical event; and rejects any bundle without
positive retained profit. TypeScript, all 425 tests, both builds, an exact
read-only dry run, the fork replay, and `git diff --check` passed. Recheck the
winning bid, runtime/configuration, exact gas economics, keeper nonce/balance,
and zero-to-one signer lease immediately before any temporary activation, then
remove the worker after settlement.

Release watch, 2026-08-20: canonical-deployer nonces 3477-3481 contained no
creation, upgrade, factory, ownership, or configuration change. Nonce 3477 was
a failed self-call, 3478 used verified `MainnetSettler` for a token swap, 3479
approved the existing verified `FWAPHouseNft`, 3480 minted an unrelated
Almanac NFT, and 3481 migrated an existing position into verified
`FWAPHouseBuyout` at `0x00000000000fd7A237f1cd9AB060FcB9fC65Fe5B`.
Exact source review found its operational unwind and harvest methods are
`onlyOwner`; claims and migrations serve Merkle-authorized asset owners and
pay no external keeper bounty. It is therefore not a capital-free keeper
surface. Continue bounded deployer watching from transaction count 3482. No
new readable @ripe0x post was found through the available public index; social
absence is not treated as on-chain evidence.

Release watch, 2026-08-21: canonical-deployer nonce 3482 was successful
transaction `0xc0dd73be60e678a5511d1c15056e31d600a30d467a6e6893174f0fa2c7b06ce6`,
an ordinary zero-value `like()` call to independently deployed, verified
contract `Like` at `0xE8A21c062352Bf135971410054Ef6c4D85Fa7bEc`.
Exact source exposes only social like/unlike bookkeeping and owner-only page
metadata; it creates no contract, changes no FWA configuration or ownership,
and pays no permissionless bounty. Continue bounded deployer watching from
transaction count 3483. No new readable @ripe0x post was found through the
available public index; social absence remains non-evidence.

Release watch, 2026-08-22: canonical-deployer nonce 3483 was successful
transaction `0x700ff3b44a5dba6fdf244ab337d88e7c419ec21b1e22223cfbe4eb968f7fc5a2`,
another ordinary `migrateNfts` call into the already reviewed verified
`FWAPHouseBuyout` at `0x00000000000fd7A237f1cd9AB060FcB9fC65Fe5B` for
the deployer's own Merkle-authorized NFTs. It created no contract, changed no
runtime, ownership, factory, or keeper configuration, and exposed no external
permissionless reward. Continue bounded deployer watching from transaction
count 3484. No new readable @ripe0x post was found through the available
public index; social absence remains non-evidence.

### P0 — GroupPull subscription standing orders

Status: canonical release and first live order validated. Confirmed-head
planning and the pending order-creation backrun are live in production revision
`b035db767d704be1eb6799fdae75d40c04ce7794`. Canonical deployer
`0xCB43078C32423F5348Cab5885911C3B5faE217F9` created verified, ownerless
`GroupPullStandingOrderFactory` at
`0x2315F319c0E47AFa26c6167e0e3a4DC46585F605` in block `25683290` through
transaction
`0xc81a6e271bc35d401df8615e6c4aee63520f5b09a38882eec89cf476ee3392a4`.
Its runtime hash is
`0xb2f3058bb25e51e28915a6f0fff1dbbb9adf637a8175bc371d1e220e915b4ba8`
and immutable `GROUP()` is the pinned live GroupPull
`0xd23DCbfD47E849DAC946689E264AaD3c6bbD4187`. The factory had zero orders at
block `25683564`, so no subscription reward had yet been exposed or missed.

Verified source establishes that each permissionless `crank()` enters the
current GroupPull selling round using user-owned order funds and pays the
caller-configured `crankFee`; it requires no keeper capital, custody, or token
approval. An order owner can change that order's `groupPull`, so the keeper
accepts only factory-indexed orders whose live target still equals the pinned
canonical GroupPull. Factory runtime, immutable group, index count, and order
membership are checked fail-closed at the exact planning block. Each candidate
then receives exact fixed-block gas estimation, retained-profit gating, full
signed-bundle simulation, receipt-event accounting, and an independent 1000
bps builder policy.

The RPC-cost audit retains GroupPull because durable history contains 38
collect, 16 submit, and three standing-order opportunities with successful
profitable receipts as recently as 2026-08-09. Hot `paused`, `deprecated`,
round-index, and buying-state reads now share one exact-block Multicall3 call;
active round and collection state are likewise batched. Factory relationship,
count, and registry reads share one exact-block call, and all live order
membership/target/fee reads share one call before per-candidate estimation.
Pinned non-proxy runtime hashes are checked once per exact-state client, while
the owner-settable live pool and every other mutable field remain checked on
each head.

The release was also publicly corroborated rather than trusted as authority:
at about 17:00 America/Denver, @ripe0x posted that “group pack subscriptions”
were coming soon. The deployer and verified on-chain source are the production
identity evidence. The same deployer subsequently updated GroupPull terms in
block `25683365`; no successor GroupPull was created.

The next deployer transaction, nonce `3431` in block `25683617`, was a normal
five-ticket `enter(18,5,...)` with `0.025 ETH`, not another deployment or
configuration change. A later post said pulls per pack had been lowered to
three; that matches the already-observed canonical `setTerms` update and does
not require another keeper change.

Release follow-up, 2026-08-07: the canonical deployer advanced from nonce 3435
to 3439 without creating a successor. Nonce 3436, transaction
`0x1e04452958f50fcde7f690269f3b6899b52200d24ae5bbe59c7ae8a41e54c010`
in block `25697895`, called the existing GroupPull's `setTerms` with
`0.005 ETH` entry price, `0.0001 ETH` incentive per ticket, four pulls per
round, a one-hour entry window, 15-minute round gap, four-hour submit window,
and 2,000-ticket escalation threshold. Nonces 3437-3438 were ordinary entries
into rounds 24 and 25. Exact round snapshots corroborate that round 24 retained
three pulls while rounds 25 and 28 use four; this is expected per-round term
snapshotting, not an ABI or planner mismatch. @ripe0x's new group-pack post is
therefore a current-product activity lead only. The pinned runtime, canonical
V2 pool relationship, unpaused/non-deprecated state, and existing keeper
surface remain valid; no production compatibility change is warranted.

Release follow-up, 2026-08-08: @ripe0x previewed a separate placeholder product
shape with a 24-hour ETH pooling window, repeated FWA pulls until the pool is
empty, and one backing-reserve auction per acquired NFT. This is a research
lead only. The canonical deployer advanced from nonce 3439 through 3453 with
ordinary calls on the already pinned GroupPull: entries for rounds 29-33 and
claims for completed rounds, plus one unrelated patron-edition collection.
There was no contract creation, factory, successor, ownership change, or
configuration transaction. Exact current state keeps the supported GroupPull
unpaused/non-deprecated on canonical V2 with round 40 selling and zero buying
rounds. Do not infer a keeper ABI or deploy speculative support from the social
mockup; inspect the first canonical creation, verified runtime, funding and
auction accounting, and permissionless reward surface if the deployer ships it.

The first order was created by the canonical deployer in transaction
`0x4ef6f08bff8bc4f16089dfc343cc7184a06d918562c09ce817176db967e20d78`
at block `25685406`: one ticket per round, `0.0002 ETH` crank fee, zero pacing
interval, and `0.0212 ETH` opening value. Factory nonce 1 deterministically
created canonical order `0x78879381a9c77942536a397A2B0d1854E13de45c` with the pinned GroupPull target.
Another keeper cranked it later in the same block, before any confirmed-head
planner could discover the new address, and collected the exact fee. The
winner paid `0.000009294408856102 ETH` to Titan, normalizing to 465 bps of the
fee; the independent 1000-bps lane target was already sufficient. This was a
same-block discovery gap, not price competition or a confirmed-head defect.

The pending subscription now includes only the pinned factory in addition to
the existing canonical targets. It accepts only an exact signed mainnet
`createOrder(uint32,uint96,uint64,address)` with positive value, derives the
new order from the factory's exact parent-state CREATE nonce, verifies the
factory runtime and immutable GroupPull relationship, and simulates the
complete `[public createOrder, keeper crank]` pair twice. It prices and
accounts only the keeper crank, revalidates raw bytes, pending status,
replacement identity, nonce, balance, lease, and target deadline immediately
before submission, and never offers the creation transaction alone. The
historical transaction decodes through the new validator and factory nonce 1
reproduces the deployed order address exactly.

Release follow-up, 2026-08-05 03:12 UTC: @ripe0x publicly announced that group
pack subscriptions are live and linked Pack 020. Exact on-chain state at block
`25685982` corroborates the supported release boundary: the pinned factory still
has exactly the one canonical order above, its immutable GroupPull relationship
and runtime remain valid, and GroupPull is unpaused/non-deprecated against the
canonical V2 pool. GroupPull round 20 had completed (`liveRound=0`,
`buyingRounds=0`), so there was no current subscription crank or lifecycle call
to send. Canonical-deployer nonce `3435` was only an unrelated `mintEdition`
transaction; there was no successor, factory/configuration change, or second
subscription creation. Continue monitoring the next exact factory creation and
use it as the first live validation of the deployed atomic backrun.

Acceptance:

- deploy the exact tested source and verify one signer lease and no pass failures
- observe the next factory creation in the filtered pending feed
- require the first pending candidate's complete-pair exact simulation
- reconcile the first `Cranked` fee, receipt gas, builder payment, and wallet delta
- tune only from lane-specific competitor and retained-profit evidence

Live validation, 2026-08-05 08:02 America/Denver: production privately landed
the canonical subscription order's `crank()` for GroupPull round 21 in Titan
block `25,689,193`. The successful receipt earned exactly `0.0002 ETH`, spent
`0.000077756255484192 ETH`, and retained `0.000122243744515808 ETH`; the
wallet delta and nonce advance to `latest == pending == 2068` reconcile. All
six relay paths accepted, first acceptance arrived in 69 ms, and target-block
delivery was full success with no revert or expiration. Exact state at block
`25,689,296` had the pinned GroupPull unpaused/non-deprecated, round 21 Selling
with six tickets, and no buying round. Recent lifecycle history also disproves
a GroupPull outage: in completed round 18 our signer captured six of seven
`BountyPaid` shares (`0.0054 ETH` gross), while
`0x5476Ff2a30103b83a67E57D21C699E66352a9ffB` captured only the close share
(`0.0009 ETH`). Rounds 19 and 20 expired underfilled with no bounty-bearing
submit/collect competition. No bid or delivery change is warranted.

Second live validation, 2026-08-05 11:58 America/Denver: the same canonical
subscription order became callable for GroupPull round 22 and production won
the first target, BuilderNet block `25,690,366`. All six relay paths accepted;
the first acceptance arrived in 79 ms. The receipt earned exactly
`0.0002 ETH`, spent `0.000103744192225504 ETH`, and retained
`0.000096255807774496 ETH`. The wallet increased by that exact amount and the
signer reconciled at `latest == pending == 2069`. This is the lane's second
consecutive full win at the unchanged independent 1000-bps target. Exact state
at block `25,690,496` had round 22 Selling, zero buying rounds, and neither
`close` nor the order crank callable. No bid, reach, or construction change is
warranted.

### P1 — Rescue competitively priced standing-order suffixes

Status: active-probe blocking and cold-leading compaction risks fixed;
alternate signed ladders remain unjustified. At target block `25685871`, production
offered five independently priced standing-order cranks as a
strongest-bid-first nonce prefix ladder. All six relays accepted every offered
prefix. Eureka included the first two cranks, which retained
`0.000039309318952024 ETH`, but competitors took the next three orders. Two
were exact price losses: our effective per-order bids
were 7245 and 5252 bps versus 7853 and 7616 bps clearing payments, and their
independent controllers correctly increased to 7878 and 9504 bps.

The fifth order was different. Our effective 1573-bps payment exceeded its
competitor's exact 1179-bps payment, but it was reachable only through the two
earlier losing nonce positions. Eureka selected our two-transaction prefix and
the cheaper public competitor transaction instead. The controller correctly
held the fifth order because payment was not causal, but it cannot recover this
construction loss by raising that order's bid. This is one partial-prefix
economic outcome, not three relay-delivery failures.

The auction now places stable jobs before active price-discovery probes while
preserving strongest-price-first ordering inside each tier. This removes the
validated class where an intentionally cheaper probe blocks stable work, and
the ordering telemetry records the probe tier explicitly. It does not claim a
counterfactual win for block `25685871`: the non-probe 7245-bps price loss would
still have preceded the stable 1573-bps job. Fully rescuing that case requires
alternate nonce ladders and remains unjustified from one cluster because it
multiplies relay load and complicates deterministic receipt attribution. Do not
raise the fifth order's bid from this evidence.

Live follow-up at target `25686143`: the same five orders all landed in Quasar
after the two price-loss controllers increased. The batch retained
`0.000187114809836772 ETH`; the previously blocked fifth order won unchanged at
1573 bps, confirming its earlier miss was prefix construction rather than its
price. This establishes eventual capture but does not recover the first exposed
fee or by itself justify the complexity of alternate signed nonce ladders.
Keep the replay item open, but prioritize it below a repeated blocked-suffix
cluster or a design that proves deterministic outcome attribution.

The second cluster arrived at target block `25690602`. The planner ordered
three independent orders at 7169, 7166, and 1000 bps. Preliminary exact
simulation correctly removed the first order because its requested bid was not
individually affordable, then compacted the other two to nonces 2069 and 2070.
That compaction made the 7166-bps order the cold first pool call: competitive
simulation proved it would lose `0.000089332772229592 ETH`, and the sender
rejected the whole remaining prefix. The 1000-bps suffix was independently
profitable but therefore received no submission. Titan included competitors
for the first and third orders in the target block at exact 1699- and 1178-bps
payments; Eureka included the middle order one block later at 1519 bps. A
1000-bps rescue would not have beaten the third order's target-block price, so
this is not claimed as a counterfactual win, but the missing submission also
prevented the independent controller from learning that price.

The affordability pass now prices each newly leading retained order against
the exact cold leading-gas observation before nonce compaction. Historical
parent-block estimation gives 332454 gas for each of the three calls: both
stale high-bid orders are rejected as cold leaders, while the 1000-bps suffix
remains fully expressible and independently profitable. It is renonced to the
first signer nonce and still must pass the ordinary complete competitive
simulation, account/lease/deadline gates, and retained-profit check. This
creates one deterministic rescue ladder without extra relay variants; the
next equivalent exposure will either capture at its independent price or
produce exact learning evidence instead of a silent blocked suffix. Separately
evaluate whether stale high controller targets should make profitability-capped
probes only after replaying their prior clearing evidence; do not weaken the
per-order retained-profit boundary. That replay is now complete and does not
justify a production change. At block `25684002`, the two controllers lost at
5773/5769 bps to exact competitor clearing bounds of 8516/8514 bps, then won at
8542/8540 bps and again at their 7170/7167-bps probe levels. The much lower
1699/1519-bps clearing observed around `25690602` is therefore one contradictory
regime-shift sample, not evidence that the durable targets were arbitrary. A
profitability-capped cold probe would have beaten those two low-clearing
competitors, but after the validated 8.5k-bps competition it could also lose and
again nonce-block the stable suffix. Retain the exact requested-bid boundary and
the newly deployed cold-leading compaction. Reconsider a capped alternate only
after repeated low-clearing evidence or an isolated profitable miss proves that
it can be offered without blocking independently profitable suffixes.

### P0 — Backrun a final direct ticket purchase with `pull`

Status: live. The original deployment
`fb1ce0b3-c656-4987-bd77-7d36ab77e5f6` from exact source
`1f066085ff22f3781ad1acea5f9467ea4b3f54aa` verified one signer lease and a
hash-only filtered pending subscription covering 69 canonical targets,
including the PullPool. The current deployment retains that lane. Its first
two live pool candidates each bought one ticket for round 305 and resolved
from pending hash to validated signed transaction in `62 ms` and `33 ms`.
Seven and then six tickets were still required at their respective confirmed
heads, so exact `[purchase, pull]` simulation rejected both non-final
purchases and sent nothing. Both prerequisites succeeded in their intended
blocks, `25641803` and `25641815`, reducing the round to five tickets needed.

The eventual four-ticket final purchase in transaction
`0xf4cae59d5d107454b4fb1ac4180b556e0c231fc40eaa58a765f605dde38c661`
never appeared in the Alchemy pending feed. It landed at transaction index 4
of Bob-built block `25641820`; the established competitor wrapper pulled at
index 5. The same purchaser, wrapper, and adjacent ordering occurred in rounds
302 and 303 after the pending lane was live, and neither prerequisite has a
durable pending observation. None of those three transaction hashes appears
in Flashbots' MEV-Share event history. This is consistent with private or
exclusive order flow rather than a decoder/simulation defect.

A new read-only 20,000-block inspector reconstructed the most recent 50 pulls.
Thirty-one followed a ticket purchase in the same block, and every one used
exactly one purchase transaction; no sampled pull required accumulating
multiple pending prerequisites. This rejects a speculative multi-prerequisite
implementation. It also found round 305 was built by the registered
`bobthebuilder`, which was absent from the Flashbots multiplex list. Bob is now
included in the default builder set so any future prerequisite that is
actually observable can be delivered to that builder without changing bids,
simulation, or private-expiry safeguards.

Awaiting the first observable live final-ticket candidate, submission, and
reconciled receipt. Additional public pending providers are useful only if
they demonstrate broader propagation; they cannot recover exclusive order
flow, and MEV-Share is not justified by these three absent history entries.

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

### P0 — Measure PoolPull clearing prices independently

Status: live in Railway deployment
`e81f61ad-6b38-45c5-b4ba-4c430f2718c7` from exact source
`3645625587c47e8d57864b53b26c8301501c7e93`. The replacement acquired the
single advisory signer lease, acknowledged all 69 filtered pending targets,
and completed both its initial HTTP pass and first WebSocket pass without a
failure. PostgreSQL showed one open run, one granted advisory lock, and no
recent fatal, pass, telemetry, or pool-measurement failure.

The ordinary PoolPull lane had durable bid quotes and expiration events but no
corresponding clearing-price observation. Its only recent win was a
cross-subsidized `standing_order -> standing_order -> pool_pull` bundle that
cleared at an aggregate `2,581 bps`; that aggregate price is not evidence that
the standalone pool lane itself needed the same bid. The most recent standalone
attempts at effective `2,001 bps` and later `1,001 bps` expired without
inclusion, but the bot did not persist whether a competitor pulled in the
target block or what it paid.

A read-only reconstruction of the last 20 non-keeper pulls across rounds
281–301 found a bimodal direct-payment market. Eleven cleared at or below
`940 bps`, two narrowly cleared at `1,002` and `1,004 bps`, and the remaining
sample included `2,583`, `4,085`, `7,056`, `7,368`, and `7,739 bps`. One
`15,615 bps` transaction appears cross-subsidized or irrational because its
direct payment exceeded its PullPool reward and is not usable as standalone
price evidence. The configured `1,000 bps` quote currently becomes an
effective `1,001 bps`; raising it would be a bid-ceiling change and is not
justified from historical reconstruction alone.

After each missed ordinary pool pull, the keeper now reads the exact target
block's canonical `Pulled` and same-round `CrankBountyPaid` events, receipt,
base fee, and direct block-beneficiary transfers. It durably records the
competitor transaction, round, cranker, gross pool reward, priority payment,
direct payment, and a pool-reward-normalized winning-bid upper bound. The
measurement is deliberately record-only: a competitor transaction may contain
rewards outside PullPool, so this upper bound cannot automatically contaminate
standing-order learning or raise the pool bid.

The production-path function was also replayed read-only against the known
round-301 winner in block `25641238`. It recovered transaction
`0xa5d5cc0d543bddd43f6e48dbe8303558fc4c037498ee6080287303a0e55f00de`,
the exact `0.000801911522533836 ETH` bounty, zero priority payment,
`0.000019967596911092 ETH` direct beneficiary payment, and a `249 bps`
upper bound.

Next action: compare repeated live observations with the `1,001 bps` misses.
Only add a separate durable PoolPull controller after exact observations prove
that a bounded change improves expected retained profit across both the cheap
and aggressive regimes.

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

The exact verified contract name is `PitLpLocker`. Its permissionless
`collect(address tipTo) returns (uint256 ethTotal,uint256 pitTotal)` entrypoint
has selector `0x06ec16f8` and is deployed at
`0xDeb8d589251717e367d0f3E9dDE5D4dB63968B40`. Blockscout fully verifies
`src/PitLpLocker.sol` against unchanged Solidity 0.8.24 bytecode; the runtime
hash is
`0x339e00a9a51e99629f0f541506d3f489d865841c9c2a2d527b205a2bd8c26099`.
The user-supplied `0xe934e36a439c94017b64a3fece66af12099abf50`
is a separate verified `CollectionToken`, displayed as StonkBroker, not the
crank target or its DERP `pit` token. The locker pays `tipTo` 1% of collected
native ETH, sends the post-tip ETH 70/30 to the merchant/treasury, and refills
the green/blue mines with DERP in a 5:1 ratio. The call is nonpayable and needs
no caller token, approval, inventory, or principal.

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

The inspector was refreshed at block `23475850` on 2026-07-30. Its preceding
100,000-block window covered 10,025 seconds and found 30 successful
collections: 15 profitable and 15 unprofitable. Gross tips were
`0.000317510029095417 ETH`, successful gas was
`0.000121748509676 ETH`, and one failed race cost
`0.00000316059749 ETH`, leaving `0.000192600921929417 ETH` after all known
gas. That is about `0.00165992216 ETH/day` protocol-wide if the short sample
rate persisted, not expected profit for this keeper. One incumbent won 21 of
30 calls and retained `0.00016867380355997 ETH`, approximately 87.6% of the
sample's total net. The opportunity is active, but the 50% successful-loss
rate and incumbent concentration strengthen the case for a minimum-tip guard
and measured latency before any public submission.

A later refresh at block `23661991` materially changed the short-window
picture. The prior 100,000 blocks spanned 10,030 seconds and contained only
five successes: four profitable and one unprofitable. Tips totaled
`0.000133772263945676 ETH`, gas `0.000022397228946 ETH`, and known net
`0.000111375034999676 ETH`, about `0.0009594 ETH/day` if that short rate held.
One address won three of five. The two latest inspected winners paid zero
priority fee and made no payment outside the source-defined routing, consistent
with documented FCFS ordering rather than builder bidding.

At the same head, exact direct simulation was callable but economically
invalid: `0.000078492705890297 ETH` collected, only
`0.000000784927058902 ETH` tipped, and `0.000005726532 ETH` estimated gas,
for `-0.000004941604941098 ETH` net. Break-even required
`0.0005726532000001 ETH`, so current inventory was only 13.7% of break-even.
There is no current profitable action.

A 2026-07-31 refresh during renewed DERP trading reversed that stale snapshot.
At block `24501608`, the preceding 100,000 blocks spanned 10,018 seconds and
contained four successful collections, all profitable, with no failed crank
visible in the bounded Blockscout transaction history. They retained
`0.000257848615270174 ETH` after receipt gas. The trailing 24 hours contained
13 successful collections from 11 distinct callers, all profitable, retaining
`0.000982125191072545 ETH`; the median gap between successes was 112.84
minutes. At an approximately `$1,860.80` spot ETH price, that is a
protocol-wide opportunity pool of about `$1.83/day`, not expected capture by
this keeper. The hotter 100,000-block burst annualizes to about `$4.14/day`
but is too short and activity-dependent to use as a baseline.

The current competitor field does not resemble a mature keeper auction. The
repeat leader won only three of the 13 trailing-day calls, every recent winner
used zero priority fee, and the recent addresses mostly interleave occasional
`collect` calls with StonkPit game actions, NFT mints, or other application
activity. Several addresses also share exact gas-limit fingerprints consistent
with a common UI or wallet estimator. There is historical automation: address
`0x959133320B8fAC322c12C8648255264617155964` submitted 20 collections between
15:03 and 17:13 UTC on 2026-07-30, including thin or unprofitable work, and an
earlier 30-call window had one address win 21 times. That behavior is
automated or button-spam-like but not economically sophisticated. It had
stopped capturing the later window. Most decisively, at block `24504738`, 42
minutes after the latest collection, exact simulation still exposed
`0.005522482035202483 ETH`, a `0.000055224820352024 ETH` tip, and
`0.000049697880532024 ETH` estimated direct net profit—roughly ten times the
break-even inventory—without an incumbent taking it.

Use `$1.8-$2.0/day` only as the current gross forgone-pool estimate. Realistic
capture remains unknown because FCFS signal-to-submission latency has not been
measured; illustrative 25%, 50%, and 75% shares of the trailing-day pool are
about `$0.46`, `$0.91`, and `$1.37` per day. Do not promote those scenarios to
an EV claim until the observer labels wins, losses, and stale-race gas.

A 2026-08-01 read-only refresh at block `24824584` still found the lane live
but sparse. Exact simulation exposed `0.00359206156226602 ETH`, a
`0.00003592061562266 ETH` tip, `0.00000545877332 ETH` estimated gas, and
`0.00003046184230266 ETH` direct net profit. The break-even inventory was only
`0.0005458773320001 ETH`, so the call was safely above the static economic
threshold. The preceding 100,000 blocks contained two successful collections
from two callers, both profitable, no observed failed crank, and
`0.000126990799109869 ETH` net after known gas. The currently unclaimed
profitable state reinforces that competition is intermittent, but two episodes
remain far below the sample required to authorize a public FCFS worker.

Use `npm run inspect:robinhood` for a current read-only simulation and bounded
history/competitor sample. Optional knobs are `ROBINHOOD_RPC_URL`,
`ROBINHOOD_LOOKBACK_BLOCKS`, `ROBINHOOD_MAX_RECEIPTS`, and
`ROBINHOOD_MAX_BLOCKSCOUT_PAGES`.

Live prerequisites:

1. Add a minimal immutable guard specification that pins the verified locker
   code hash and relationships, calls it with the EOA as `tipTo`, and reverts
   unless returned `ethTotal` meets a caller-supplied minimum. Compute the
   minimum as
   `ceil((exact maximum guard gas cost + retained-profit floor) * 10,000 / 100)`.
   The helper never holds ETH or DERP. This prevents successful
   token-only/tiny-tip losses but cannot avoid gas spent losing a stale race.
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

Guard specification and a read-only observer are go; deployment and live
submission are no-go. Before proposing execution, require at least seven days
and 100 newly labeled episodes, a conservative positive race-adjusted EV, and
at least a 2x tip-to-maximum-gas ratio after the retained-profit floor.

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

The first live attempt for previously unmeasured order `9e957...` separated
price from delivery more cleanly. Target block `25655044` missed despite all
four relay paths accepting within `56–235 ms` and retaining `10.7 s` before
the block arrived. The block contained no competing crank or transaction to
the order, used only `7.24M / 60M` gas, and exposed no builder marker. The
controller correctly classified `miss_without_higher_price` and held rather
than increasing. The same nonce landed one block later in a BuilderNet block.
Exact simulation predicted the receipt's `144,432` gas exactly; the
profitability boundary converted the `8,644 bps` requested target into an
`8,584 bps` effective priority payment and retained
`0.000001000000119504 ETH`.

This is builder/proposer reach evidence, not a clearing-price observation. It
also shows the cost of seeding every new target from the aggressive global
prior: the successful retry paid almost the entire economically admissible
reward without proving that BuilderNet required it. Do not lower the global
starting bid from this single inclusion. First add durable block-delivery
classification and collect comparable outcomes grouped by reward size,
simulated gas, builder identity, and target history. A hierarchical cohort
prior may initialize unseen targets only after exact same-lane samples show it
improves expected retained profit without materially reducing eventual wins.

On 2026-07-31 the user selected the more aggressive retained-margin policy:
reset every standing-order target to a `1,000 bps` baseline and let only new,
exact same-target competition raise it. This replaces the `8,644 bps`
production default and clears the old lane's bracket/probe evidence while
retaining all historical observations in `keeper_events`. Other adaptive
scopes and every non-standing-order lane remain unchanged. Monitor eventual
rather than only first-target wins: an unopposed private miss costs no gas and
must not raise the target, while an exact higher competitor should still move
that target immediately to the measured payment plus the configured step.

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

The read-only inspector now reports the complete current round and exact
standalone-pull economics. On 2026-07-30, round 339 was open and fully covered
with 28 tickets and `0.14 ETH` escrow. Its `pull` estimated `958,891` gas and
the bounty was capped at `0.0015 ETH`; after the `1,000 bps` builder target,
the maximum profitable base fee was about `1.407876389 gwei`. The observed
next-block base fee was above `11 gwei`, making the call more than
`0.009 ETH` loss-making even before any bid increase. This is evidence to wait,
not to raise the global fee ceiling; `npm run inspect` now exposes the same
threshold for future rounds.

Round 339 was nevertheless pulled in block `25646962` by transaction
`0x5334094c9d1b69d82f123a0314c9285e65a2d611e6697e4c5331763acc0613a8`.
The exact receipt used `502,471` gas at `4.964337798 gwei`, costing
`0.002494435777698858 ETH` for a `0.0015 ETH` bounty. Its priority payment was
`0.001004942 ETH`, a `6,700 bps` pool-reward-normalized upper bound, and the
transaction retained negative `0.000994435777698858 ETH` after known costs.
This is irrational or externally subsidized behavior, not a profitable
clearing price to chase. `npm run inspect:pool-pull-block -- --block=<block>`
now reconstructs the same receipt, beneficiary payment, and retained-value
evidence for unattempted as well as missed pulls.

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

### P0 — Backrun same-block FWA VRF fulfillment

Status: production-enabled. Exact source and deployment identity are recorded
by each `keeper_started` event.

Round 355 exposed a confirmed-head state-transition blind spot. Chainlink VRF
fulfillment transaction
`0x591b4f032fe1c81803e63285c3cc4a59010a3a1d332f910ee7da6d9bb7d13b0b`
landed at index 56 of block `25648139`. Its callback moved request
`50122926248667946721162522793336820828918720156550601086430947954895331134129`
from Pending through the FWA's callback-head self-processor to Fulfilled
inside the same transaction. Competitor wrapper transaction
`0x7c855068eedef6153b03ac99d0f560931662762b70ba6c7f90ca65de79604a3f`
followed at index 57, called `syncFwaResult(355)` and `settle(355)`, earned
`0.000842620574025888 ETH`, spent `0.000061184596560148 ETH`, paid no observed
priority or direct beneficiary payment, and retained about
`0.000781435977465740 ETH`. The confirmed-head keeper could not bid for state
that never existed at a block boundary.

The canonical coordinator entry point is
`fulfillRandomWords(proof,requestCommitment,onlyPremium)`. The implementation
recovers the signed raw transaction and requires mainnet chain/type/nonce,
zero value, the coordinator returned by `FWA.vrfCoordinatorAndSubId()`, the
same FWA consumer and subscription, and the exact pool request ID derived as
`keccak256(abi.encode(keccak256(abi.encode(proof.pk)), proof.seed))`. It then
requires `ethPendingRound`, pulling/unresolved round state, matching
`fwaRequestId`, pool purchaser, and Pending acquisition at the exact parent.

The lane evaluates two mandatory full-bundle shapes after the bounded
contiguous public coordinator nonce prefix ending in the target fulfillment:
`syncFwaResult -> settle`, and
`processAcquisitions(count) -> syncFwaResult -> settle`. The exact parent FWA
queue determines `count`, including every sequence through the pool request;
it is never hard-coded to one. Preliminary and competitively priced versions
must simulate every transaction. The highest-profit valid shape is selected.
Economics include simulated gas for every keeper call but only the sync and
settle pool bounties; raw fulfillment cost/value never enters keeper P&L. The
full selected bundle is mandatory, keeper nonces are contiguous, the signer
lease/nonce/balance/head gates remain fail closed, and every raw prerequisite
must still be pending immediately before private one-block submission. The
lane starts with the 300-bps pool-ready bid because the original observed
winner paid zero ordering fee; it does not inherit the 7,250-bps ordinary
fulfilled-state policy.

Acceptance:

- deploy with the feature disabled and verify the exact source, one lease, and
  healthy confirmed-head passes
- enable only after the isolated coordinator subscription reports ready
- require a real `pending_fwa_candidate_validated` before any simulation
- inspect both exact full-bundle simulations and reconcile all selected keeper
  receipts
- treat a missed fulfillment as a lane-specific outcome; do not modify
  confirmed-head fulfilled or standing-order bidding from one observation

A local fork of parent block `25648138` exposed and validated the nonce-prefix
requirement. The target oracle transaction used nonce `107356`, while the
parent-state nonce was `107354`; fulfillment-only simulation could not execute.
Including exact public nonces `107354`, `107355`, and target `107356`, followed
by keeper sync and settle, made all five transactions succeed in one block.
The keeper calls used `556,700` gas and emitted
`0.001176131718521088 ETH` of pool bounties in that replay. Production
therefore caches separately validated coordinator transactions and rejects a
missing, replaced, mined, or greater-than-eight nonce prefix rather than
assuming the target fulfillment is independently executable.

The staged production rollout first deployed the source with the lane
disabled and confirmed an exact source revision, one signer lease, and
continuing ordinary passes. The enabled replacement then reported
`pending_fwa_subscription_ready` for connection generation 1, initialized
both pending subscriptions, waited 61 seconds for the existing signer lease,
and acquired it before arming execution. `keeper_started` records the exact
source and `pendingFwaFulfillmentBackruns=true`; the first confirmed-head
passes remained healthy.

Round 358 supplied the first real target after activation. The subscription
validated fulfillment
`0x9f99244e74aa321c4c5114b523176b211191c4a844aa4292958bd060f7f4965c`
in about 174 ms while it was still pending. The first same-block simulation
was rejected by Flashbots with `max fee per gas less than block base fee`
before that relay had published the fresh parent; the locally derived child
base fee was later proven exact. The public callback left the acquisition
Ready rather than Fulfilled. At the confirmed head, the ordinary keeper won
`processAcquisitions(1) -> syncFwaResult(358) -> settle(358)` in block
`25648507`, retaining `0.001019844144324376 ETH` after all three receipt gas
costs.

An exact fork of parent block `25648505` then proved the missing same-block
Ready variant. Round 358 was the second queued FWA sequence at that parent, so
`processAcquisitions(1)` correctly processed only the preceding request and
could not sync the pool. The exact queue-derived
`processAcquisitions(2) -> sync -> settle` bundle after the public fulfillment
succeeded completely in block `25648506`. Keeper gas was `2,642,914`,
`184,774`, and `370,411`; sync and settle emitted
`0.001194682186698385 ETH` of bounties. With the exact parent base fee, the
production 90% bounty haircut, and 300-bps bid, the conservative modeled net
was `0.000532651526749407 ETH`. The implementation now evaluates both direct
and processor variants, prices actual simulated processor gas instead of its
signing envelope, clamps that envelope to the configured Ethereum-valid
maximum, and accounts all selected receipts.

The relay race is handled narrowly: only the exact future-base-fee rejection
is retried against the same relay and target for at most 500 ms. Signed maximum
fee capacity carries one extra wei when the configured cap permits, while
economic accounting still charges the exact expected gas price. Round 359's
fulfillment arrived through the pending provider only after mining (77 ms from
hash observation to a receipt-bearing transaction), so no same-block strategy
could act. The ordinary fulfilled-state bundle then lost at 7,251 effective
bps to a competitor whose observed payment required about 7,320 bps against
our planned gross reward. This single exact loss is record-only and does not
justify raising the fulfilled bid ceiling.

Round 363 supplied the first live Ready callback after the processor expansion.
The lane validated target fulfillment
`0xab8fe0d764c158351c5103fb73453261b37aeba0ef6129c4fe24695f43bdcb21`
in about 168 ms and exact-simulated the queue-counted processor variant with
`0.000739869498494553 ETH` conservative expected profit. Its first target,
block `25648684`, arrived before final submission, so execution stopped with
no transaction or cost. The fulfillment remained pending and landed one block
later, but the candidate had already been forgotten. The confirmed-head path
won `processAcquisitions(1) -> sync -> settle` in block `25648686`, earning
`0.001202710148679 ETH`, spending `0.000300275884405472 ETH`, and retaining
`0.000902434264273528 ETH`; PostgreSQL receipt aggregation and the wallet delta
match exactly.

The pending lane now preserves a still-current candidate across that narrow
deadline case. After `target_block_arrived`, it proves every prerequisite is
still current and pending, then re-enters the complete executor against the
new exact parent. Queue count, nonce, balance, state, both full simulations,
economics, signer lease, and target deadline are all revalidated. It allows at
most three consecutive target attempts, never retargets a mined or replaced
transaction, and does not resubmit an expired keeper bundle.

Live round 364 exposed a remaining retarget defect in source `99e8749`. The
wrapper correctly re-entered three times after `target_block_arrived`, but the
executor's stale `eth_blockNumber` response derived target block `25648721` on
all three attempts even though the authoritative WebSocket head had already
advanced. No transaction was submitted and no gas was spent, so the path
remains fail-closed, but the retry currently adds no coverage. The next
maintenance change should pass the authoritative subscribed parent into each
retry, require the target to advance, and add a stale-`getBlockNumber`
regression before another deployment.

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

`WS_URL` now drives the production head wake-up. A four-head exact-state
comparison found the announcing WebSocket returned the same pinned
`roundCount()` call in `65–81 ms`, while HTTP took `225–251 ms`. The foreground
planner therefore uses the same WebSocket client for exact contract state,
simulation, nonce, and balance gates instead of waiting for a separate HTTP
backend to publish the new state. The head listener consumes and validates the
raw `newHeads` header directly; viem's `watchBlocks` helper was removed because
it implicitly fetched the same block again before invoking the callback.
There is no HTTP planning fallback; HTTP remains responsible for startup,
receipt/competition observation, and the staleness assertion. After
`HEAD_STALE_TIMEOUT_MS`, HTTP asserts liveness; if it proves the chain advanced
without a subscribed head, the worker exits for Railway to restart it. A local
three-head validation observed the subscribed heads and began their planning
passes in the same millisecond; `RUN_ONCE` and explicit shutdown both closed
the shared viem socket client without leaving a process behind.

Railway deployment `77da1ec4-51e1-4719-9876-e1666ce9f738` from exact source
`21f503baeb622f7dd2680e09b55fb81e8350c23e` validated the transport change
across 34 production passes: exact-state reads succeeded without an
availability retry, and planning measured `171.18 ms` minimum, `195.05 ms`
p50, `254.08 ms` p95, and `345.02 ms` maximum. The replaced HTTP-state
deployment's preceding 44 passes had a `979.67 ms` p50 and `1,369.66 ms` p95.
No malformed header, subscription failure, keeper-pass failure, or fatal event
occurred in the production sample.

The follow-up 300-bps lifecycle policy is live in Railway deployment
`b1239342-0e51-4439-866e-23e4f9b148e1` from exact source
`adef2c4997bb3b6d89ab43379aa15fadd27572c5`. Startup reported both ready and
fulfilled bids at 300 bps, foreground state on WebSocket, one open keeper run,
and one granted advisory signer lock. Its first subscribed pass completed
planning in `255.35 ms` on the first exact-state attempt.

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

The next production sample showed that exact Convex shortlist validation had
again become the dominant critical path: `0.77–1.59 seconds` across the first
12 subscribed passes after the header-derived fee rollout. Durable telemetry
found zero Convex opportunities, submissions, or receipts during the preceding
24 hours, while a current 577-pool read-only scan found no profitable earmark;
the best candidate remained about `0.000056998 ETH` net negative even at a
`0.13800604 gwei` provider fee quote. The hot validator was serializing its
32-gauge exact claimable multicall behind separate exact reads of the current
staker, incentive, and price feeds. The complete background snapshot already
binds its candidate claimables to the canonical staker, so hot planning now
runs the exact claimable multicall concurrently with revalidating that staker,
the live incentive, and both price feeds at the same exact head. A staker
change invalidates only the snapshot that was actually used and skips the lane
fail-closed; cached rewards, prices, gas, and calldata remain prohibited. This
removes one sequential RPC phase without reducing the 32-pool candidate set or
changing Convex economics.

That first live concurrency change alone did not materially move the
distribution: the first two warm samples remained `0.97–1.05 seconds`.
Expanded read-only inspection found the actual cause. All 32
highest-claimable gauges reverted exact `earmarkRewards(pid)` estimation with
the literal `crvChange` reason from Convex's canonical ExtraRewardStashV3
invariant. Those structurally reverting gauges both consumed repeated hot-path
estimates and starved executable lower-ranked gauges from the fixed 32-slot
cache. The discovery refresh now ranks every positive claimable, checks
candidates in bounded 32-pool batches on the separate discovery RPC, excludes
only a typed contract revert whose exact reason is `crvChange`, and continues
until it has 32 non-excluded candidates or exhausts the list. Every retained
candidate still receives exact-head claimable, incentive, price, gas,
profitability, and final bundle simulation checks. Any other revert or RPC
failure remains in the shortlist and therefore fails closed on the
authoritative hot path. The current read-only reconstruction needed 128
snapshot estimates, excluded 86 `crvChange` pools, retained 32, and found none
of those 32 above even the conservative 400,000-gas reward floor. The inspector
also now routes its bulk scan through `DISCOVERY_RPC_URL`, not the
latency-sensitive production RPC. All 233 tests, typecheck, build, and diff
checks passed. This is live in Railway deployment
`23d077a7-32b1-4e88-b297-6565c35ad4f1` from exact source
`8d412b01ffbdfcc1a82b9cae872a6e806d882345`. Its first background refresh
needed 128 snapshot estimates, excluded 87 exact `crvChange` reverts, retained
32 candidates, and completed off-path in `1,021.90 ms`. The first three warm
hot scans fell to `148–296 ms` from the preceding deployment's
`1,034.15 ms` median across 34 samples. PostgreSQL showed one open run, one
granted signer lock, and no pass failure or fatal; nonce remained `546/546`.

After that rollout, Convex expired-lock discovery became the next measured
critical path at roughly `0.49–0.98 seconds` per head. It also exposed an
exact-head correctness gap: the hot lock balances, reward parameter, price
feeds, and gas estimates were not pinned to the subscribed planning block. A
fresh reconstruction found 79 accounts with nominal unlockable balances, but
61 exact `kickExpiredLocks(account)` estimates reverted with the literal
`no exp locks` eligibility reason. Only 18 were simulatable, none was
profitable, and the best remained about `0.000011786 ETH` net negative at the
then-current `0.105873331 gwei` provider quote. Convex kick discovery now
refreshes all configured accounts every four blocks on the separate discovery
RPC, excludes only a typed contract revert whose exact reason is
`no exp locks`, and retains every other failure for authoritative hot-path
revalidation. The hot path reads and estimates only that shortlist, with every
balance, reward, oracle, and gas call pinned to the exact subscribed head.
Cached rewards, prices, gas, profitability, and calldata remain prohibited.
The bulk kick inspector also now uses `DISCOVERY_RPC_URL`.

The first live cache refresh reported 84 balance-read failures among the 85
configured candidates. This was a local address-normalization defect, not a
provider or Multicall capacity problem: `CONVEX_KICK_CANDIDATES.map(getAddress)`
passed `Array.map`'s numeric index to viem as `getAddress`'s optional chain ID,
producing 84 EIP-1191 mixed-case strings that were invalid under ordinary
Ethereum checksum validation. The list now uses an explicit one-argument
callback and a regression test requires all 85 candidates to be canonical and
unique. A read-only exact-block rerun with the normalized list returned all 85
balances successfully, found 79 nominally unlockable accounts, excluded 61
typed `no exp locks` estimates, and retained 18 accounts for hot exact
revalidation. Railway deployment
`f191f5ab-762b-4430-9fbd-cbe42ce4adf5` from exact source
`0a7d76c7886892e78dfe870c1bac46b214a1da36` reproduced those counts with
zero balance-read failures under the single signer lease.

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

The same path still contained a hidden duplicate block dependency:
viem's `estimateFeesPerGas()` unconditionally fetched `"latest"` before
reading the provider priority fee. Private submissions target only the
immediate child of the subscribed head, so the parent header already contains
everything required for a protocol-bounded fee envelope. The child base fee
cannot exceed `parentBaseFee + max(parentBaseFee / 8, 1)`. Private planning now
derives that envelope locally and does not invoke the provider estimator;
public submission retains the provider path. Exact contract state, nonce,
simulation, and receipt reads remain pinned to the authoritative HTTP RPC
because the header does not contain contract storage. A read-only scan of 100
recent parent/child pairs found zero envelope violations; the tightest observed
headroom was `5,933 wei`. At block `25641474`, the local allowance was
`124,321,540 wei`, versus viem's more expensive `132,609,643 wei` allowance,
and the eliminated provider estimate took `133 ms`. Exact relay simulation and
profitability gates are unchanged. All 232 tests, typecheck, build, and diff
checks passed. This is live in Railway deployment
`e604bf75-e56e-44bf-a6ff-80fe42a451a3` from exact source
`20cb8853a6377279b3854ba89892007193d46674`. The first subscribed production
pass, block `25641493`, reported the header-derived fee source, zero block-read
attempts, and `0.03 ms` for `head_and_fees`, versus roughly `170–500 ms` in the
preceding window. PostgreSQL showed exactly one open run and one granted signer
lock; nonce remained `532/532`.

The conservative `parentBaseFee + 12.5%` allowance was safe but unnecessarily
priced every immediate private target as if its parent were maximally
congested. The complete subscribed parent header contains `gasUsed` and
`gasLimit`, so the child's base fee is deterministic under EIP-1559. Private
planning, pending-funding backruns, and pending pool-pull bounty modeling now
use that exact next-block value. The public-submission path is unchanged, and a
private pass without the complete parent gas fields fails closed. Exact bundle
simulation, profitability floors, the `5 gwei` fee ceiling, builder-bid
ceilings, and receipt accounting are unchanged.

A replay of 128 consecutive recent parent/child pairs produced zero formula
mismatches. The old allowance overstated the actual child fee by `11.4831%` at
the median, `15.0728%` at p90, and as much as `20.3577%`. This is live in
Railway deployment `92c5cab6-21e2-4f4d-9585-8b64bcd2d7c5` from exact source
`2af634473ca67c3c4a580f980be1d5d74f4d72c8`; all 260 tests, typecheck, build,
and diff checks passed. The first active subscribed pass at parent block
`25646657` used base fee `5,171,672,604 wei`, gas used `16,579,805` of
`60,000,000`, and priced block `25646658` at exactly `4,882,485,709 wei`.
The next subscribed header confirmed that value, `16.0816%` below the old
`5,818,131,679 wei` allowance. The replacement waited for the incumbent signer
lease, then production converged to one open keeper run and one granted
advisory lock with no waiting lock.

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

Repeated rollout telemetry found a narrower deployment defect: the replacement
acquired the signer lease before completing read-only initialization. In the
`035dd04` rollout it held the lease at `00:06:30 UTC` but did not emit
`keeper_started` until `00:07:00`, creating about 30 seconds with no active
keeper. Railway now overlaps replacement containers for 60 seconds. The new
worker completes canonical contract checks and both WebSocket subscriptions
with pending execution explicitly disarmed, logs
`signer_initialization_ready`, and only then requests the advisory lock. The
old worker remains the sole signer during that initialization; after it drains,
the replacement acquires the lock, arms its queued pending-event lane, and
starts normal passes. A stale queued prerequisite still faces the unchanged
pending-status, nonce, exact-simulation, and profitability gates. The first
rollout is verified in Railway deployment
`40c9a9dc-3e3f-4941-a063-6c5a879e73f0` from exact source
`fc23193ce207b173bfba2876023da46d60552310`. The replacement completed
read-only initialization in `1.181 seconds`, then waited on the signer lease
while the old worker continued through block `25642047`. The old run recorded
its stop at `00:22:08.717 UTC`; the replacement acquired the lease at
`00:22:09.562 UTC` and emitted `keeper_started` at `00:22:09.927 UTC`.
That reduced the previous roughly 30-second blackout to about `1.21 seconds`
between the old stop record and the new active keeper, and to `365 ms` from
lease acquisition to startup. There were no pre-lease submissions, fatal
events, or failed passes. PostgreSQL showed exactly one granted advisory lock,
one open keeper run, and the expected source SHA after handoff.

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

Status: the canonical deployer suite is identified on-chain, has a fail-closed
read-only inspector, and now has concurrent V1/V2 confirmed-head adapters
inside one signer pass. Both the pool and standing-order factory have
exact-match verified source. At block `25649496` V2 remained paused with no
rounds or orders, while V1 was unpaused and actively funding. V1 therefore
remains live before and after V2 activation.

On 2026-07-28, [the pool author reported](https://x.com/ripe0x/status/2082297793478082570)
that subscriptions are filling new pools almost as soon as they open and that a
V2 pool contract is nearly finished, with higher capacity and support for
running more pools more often.

On 2026-07-30, [the author announced the V2 cutover](https://x.com/ripe0x/status/2082945402030936554):
concurrent rounds, beneficiary and referral parameters, a 4% protocol fee, and
reduced funding headroom. The post said the switch was planned for later that
day.

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
`pendingPullCount`. Exact-match verified source names the complete 36-component
`Round` tuple and the three formerly unknown config fields. The immutable FWA,
FWA rewards, and FWA token addresses exactly match V1. The configured
`0.005 ETH` ticket, `0.0015 ETH` bounty cap, `0.01 ETH` VRF allowance, and
`2 gwei` bounty tip also match V1. The deployment constructor supplied four
concurrently open rounds and four concurrent pulls, but the authoritative live
`config()` at block `25648950` is currently `1 / 1`. The owner-settable source
bounds are 16 open rounds and 64 pulls, so the cutover may change these values
again; a planner must read them at its exact parent block. The referral
carve-out is 150 bps of referred acquisition spend and comes from, rather than
on top of, the 400-bps protocol fee. Headroom is 300 bps.

Every lifecycle call remains permissionless and pays
`min((measured gas + 40,000) * (block.basefee + bountyTipWei),
crankBountyCap)` from that round's escrow. `pull` advances one named round;
`syncFwaResult` maps that round's FWA request into Claimable or Refunding; and
`settle` or `settleForcedEth` closes only that round. There is no authoritative
single lifecycle pointer. A keeper must retain an event-indexed active round
set from `RoundOpened`, remove `RoundSettled` and `RoundVoided`, and exact-read
every remaining round at the planning block.

The verified V2 standing order retains permissionless `crank()`, but adds an
owner-settable pool, owner-settable beneficiary, immutable referrer, and
`minSecondsBetweenBuys`. Its target is the pool's lowest eligible open round,
and it may self-open a round when none exists. This requires a V2-specific
decoder and pacing gate; V1's `lastRoundBought`-only prefilter is insufficient.

At block `25640704`, the pool was paused, not deprecated, and had
`roundCount == 0`, `currentOpenRound == 0`, `pendingPullCount == 0`, and zero
accounted ETH. The earlier V2-only factory had zero orders. `npm run
inspect:pull-pool-v2` originally pinned those seven deployed components; it now
also pins the later successor-aware factory, both factory relationships, all
three creation transactions, deployer ownership, immutable FWA relationships,
configuration, launch state, and event-indexed active rounds decoded against
the verified 36-component tuple. It fails closed on a relationship, bytecode,
or lifecycle-index mismatch.

A fresh inspection at block `25648898` again matched all seven pinned runtime
hashes, every relationship, and the newly verified ABI. V2 remained paused and
not deprecated, with
`roundCount == 0`, `firstOpenRound == 1`, `currentOpenRound == 0`,
`pendingPullCount == 0`, zero accounted ETH, and zero orders in the earlier
V2-only factory. No V2 execution path was justified at that snapshot; the
successor-aware factory was deployed later.

Implementation:

- startup verifies all eight V2 runtime hashes, both factory/pool links, and
  immutable FWA relationships; every planning head reads the activation signal
  alongside V1 planning and awaits it before submission
- activation adds V2 to the existing pass without another process, signer,
  restart, or nonce domain
- independent V1/V2 order plans merge into one profit-ranked nonce plan; if
  both adapters expose lifecycle chains, only the stronger complete lifecycle
  alternative can reach the generic prefix ladder
- the V2 planner incrementally indexes `RoundOpened`, removes
  `RoundSettled`/`RoundVoided`, exact-reads every active round, and validates
  `currentOpenRound` plus `pendingPullCount`
- every concurrent pulling/claimable round is considered independently and
  the lowest covered/open funding round is routed separately
- the V2 order decoder merges both pinned registries, requires each mutable
  `pool()` to remain canonical, and reads recipient, immutable referrer, buy
  interval, last-buy time, and pool-scoped last purchase before exact `crank()`
  estimation
- V1 vaults, final-ticket pending backruns, and single-pending-round FWA
  backruns stay live for V1 but are never reused with the V2 ABI
- shared non-pool lanes are owned by the V1 primary adapter so dual planning
  cannot duplicate their discovery or create same-nonce alternatives
- confirmed-head lifecycle/orders retain private complete-bundle simulation,
  lane-specific bids, nonce/balance/lease gates, and receipt accounting
- V2 fulfilled lifecycle starts at the low ready-cycle bid instead of
  inheriting V1's 72.5% fulfilled bid; raise it only from exact V2 competition
  evidence

Implemented on 2026-07-31 after investigating transaction
`0x21e10ce6223a3823b518391d9cca9d3bfb3f284f20acda6afe0c6d515ef8b00a`:
the active successor-aware order factory is
`0xFba041453dabbFE8B34409Cf88417913Cc483D1E`, not the earlier empty V2-only
factory. It was deployed by the canonical pool deployer in block `25643539`,
pins the canonical V1 and V2 pools as `LEGACY` and `SUCCESSOR`, currently
routes `pool()` to V2, and held 68 registered orders when discovered. Historic
activity contained 932 cranks and `0.1062 ETH` of gross caller fees; that is an
opportunity-size measure, not missed net profit. Production now pins the
factory's runtime hash and relationships, merges and deduplicates both V2
registries for confirmed-head planning, competition attribution, and pending
ETH-funding subscriptions, and exact-simulates every retained order.

The successor order source also proves that replay protection is the pair
`(lastPool, lastRoundBought)` and uses equality. The prefilter now reads
`lastPool` at the exact parent so a historical V1 round cannot suppress a V2
candidate after round IDs restart. Pool lifecycle competition found in the
same receipt as an order crank is retained as telemetry but excluded from the
standing-order adaptive controller because its aggregate builder payment is
not lane-normalized.

The same incident exposed a lifecycle-index invariant bug at blocks
`25655323`–`25655326`: round 55 became claimable after sync while
`pendingPullCount` correctly remained one until settlement, but the adapter
counted only pulling rounds and repeatedly aborted. The invariant now counts
both pulling and claimable rounds, with a regression covering the sync-to-
settle interval. The two expired private bundles spent no gas.

The first live sample now supports a separate pull controller. Across V2 rounds
9–21 the keeper won four pulls and competitors won nine; one competitor took
rounds 16–21. Five of those were internally funded atomic pulls and were not
independently actionable. The four ordinary losses required approximately
1,732, 5,089, 5,712, and 6,242 bps against each exact planned gross reward, and
all four counterfactuals still cleared the configured retained-profit floor.
Their combined missed counterfactual net was approximately
`0.001941712234 ETH`. In the same sample the keeper won all 13 observed V2
sync/settle cycles, so pull pricing—not general lifecycle delivery—was the
isolated defect.

Implemented on 2026-07-31: V2 pulls now use a durable `v2_pool_pull` adaptive
scope seeded from profitable exact historical evidence. A learned pull target
becomes an aggregate payment floor for any mixed bundle, without mutating the
lifecycle or standing-order policies. Any prefix containing the adaptively
priced pull ignores the ordinary max-fee ceiling and is bounded only by exact
signed-bundle profitability; the relay prefix floor includes the pull so a
builder cannot retain the high-fee lifecycle prefix while dropping it. V1 pull
pricing remains independent and static. V1 and V2 pull observations are also
grouped by canonical pool before learning.

Live validation through round 37 found five confirmed-head pull wins and one
exact ordinary loss. The round-37 target paid an effective 6,244 bps and lost
to a counterfactually profitable 6,850-bps competitor payment; the durable
controller immediately raised its target from 6,243 to 6,851 bps. The shared
controller previously treated that measured winner as a hard lower bound,
which could block downward discovery indefinitely even after repeated wins.

Implemented on 2026-07-31: the lane-agnostic controller now treats measured
competitor prices as recovery evidence rather than permanent probe floors.
After the configured full-win streak, every integrated lane bisects its fresh
win/loss bracket downward; a failed probe immediately recovers above retained
competitor evidence. Generic target naming and common adjustment telemetry
make the same controller reusable for future lanes without copying the state
machine. Exact lane-specific normalization is still required before a new
lane may feed competitor evidence.

The first production probe exposed a second feedback distinction. After three
wins at a 6,901-bps target, the controller probed 6,877 bps. It missed round 46
despite offering an effective 6,878 bps. All four relays accepted the bundle.
The observer initially attributed a 5,775-bps pull to the miss, but that pull
was for concurrent round 47 rather than attempted round 46. Production now
filters `Pulled` logs to exact missed round IDs before recording or learning
from them. Independently, the reusable state machine now recovers only when a
measured same-lane competitor paid at least our effective bid. Unmeasured
misses and cheaper winners hold the active probe for another observation
instead of overpaying to solve a delivery, timing, or state-conflict loss.

Next action: observe the current V2 6,902-bps win streak and verify that its
next downward probe holds through a non-price miss, ignores concurrent-round
pulls, and recovers only from a genuinely higher same-round winner. Implement multi-request V2
pending-FWA routing only from exact live evidence; do not re-enable either V1
pending decoder against V2.

### P0 — Reduce acquisition lifecycle latency

Status: lifecycle-first routing and the concurrent submission gate are
deployed. Processor correctness and gas economics remain deferred to mandatory
exact private bundle simulation.

The ready acquisition path has a short competitive window. `planJobs` should
read the acquisition lifecycle first and return a profitable lifecycle plan
before waiting for order registries, Liquity, Convex, buyback, and sweep scans.
The previous processor simulation and gas estimate did run concurrently, but
live calls still consumed most of a block on large queues. They are no longer
duplicated before relay simulation.

One serial RPC dependency remained after profitable planning: the keeper first
read the current head for the stale-plan gate, then began a second round trip
for the explicit-head nonce, pending nonce, and balance gates. These four
read-only checks are independent. They now start in one `Promise.all` while
preserving the same stale-head rejection, `latest == pending` requirement, and
balance reserve. An eight-sample uncached WebSocket benchmark against the
configured provider measured `224.11 ms` for the serial form and `161.16 ms`
for the concurrent form, a mean reduction of `62.96 ms` on an actionable
bundle. The existing `account_gate` timing now covers the entire concurrent
submission gate and records the observed submission head.

Railway deployment `2444a9c3-f29f-4616-a617-c0ae70592b40` runs exact source
`3c8faa0d3a62a985eae63e0f622592e98df65d42`. During its overlap handoff the
old signer stopped at `00:58:03.906Z`, the replacement acquired the advisory
lease at `00:58:04.172Z`, and `keeper_started` followed at
`00:58:04.297Z`: 266 ms from old stop to lease acquisition and another 125 ms
to active passes. PostgreSQL has exactly one open keeper run and one granted
advisory lock. Across the first 59 actionable passes, the concurrent gate
averaged `112.68 ms` including the staleness read, compared with the
pre-change path's separate uninstrumented head round trip followed by its
nonce/balance gate. There were no fatal or keeper-pass failures.

Durable target-head correlation then exposed a deeper sender-side deadline
bug. Since that deployment, 14 batches containing 34 signed transactions were
submitted after the WebSocket had already observed their target block. Seven
of 46 measured batch paths exceeded one 12-second slot; the worst took
`45.67 seconds`. In the block-`25643861` example, the strategy account gate
finished in `99.59 ms`, but a duplicate private-sender HTTP head/nonce gate
consumed about `8.4 seconds`. Exact simulations completed before the target
head arrived, then the final HTTP nonce/balance gate stalled until roughly
`21 seconds` after that head and returned the stale parent. The sender
therefore contacted relays for an already-built block despite the
authoritative WebSocket signal.

The duplicate sender gate is removed. The final gate now reads exact-parent
latest nonce and balance plus pending nonce through the foreground WebSocket
client while racing the subscribed target head. It rechecks the signal after
the state reads and immediately before relay submission. Target arrival or a
subscription wait timeout is fail-closed; a lagging RPC response can no longer
authorize a stale bundle. This preserves the earlier strategy account gate,
`latest == pending`, exact simulation, signer balance, lease, and private-only
submission invariants. `bundle_stage_timing` now records
`final_submission_gate`.

Railway deployment `1b38a4c2-715d-4a96-9772-e107cd4176c2` runs exact source
`252493ae5bd3e304c2538036b6566a8df2834c97`. The replacement waited without
signing, the old run stopped at `14:59:23.707Z`, and the new run acquired the
lease and began healthy passes within the following second. PostgreSQL then
showed one open run and one granted advisory lock; wallet nonces remained
`667/667`. All 255 tests, typecheck, build, and diff checks passed.

Fulfilled-cycle competition then supplied the repeated exact evidence that the
original low bid lacked. Seven private `syncFwaResult -> settle` attempts at
`301 bps` produced zero wins. Three decoded winners paid `7,212`, `8,429`, and
`9,384 bps` of their observed pool reward directly or in aggregate to the
block beneficiary. For round 337, our exact simulation at target block
`25645540` reported `0.00114713205625993 ETH` gross reward and `554,480` gas;
the `7,212 bps` competitor combined both calls in one helper transaction,
used `502,360` gas, and retained only about `0.000099165 ETH` after its direct
payment and gas. A `7,250 bps` target on our simulated route would still have
retained about `0.000128 ETH`. The fulfilled-only policy therefore moves to
`7,250 bps`, while the ready processor/sync/settle lane remains at `300 bps`.
The `8,429` and `9,384 bps` tails are not chased: exact bundle simulation, the
unchanged `5 gwei` ceiling, and the positive-profit gate remain mandatory and
fail closed when the target cannot be afforded.

Railway deployment `b3c7081f-fe2e-4ba2-bfb9-d58f3c76b12b` now runs exact
source `d976fb29458c4e9f0f0773b13123b186e7cf4545`. Startup confirmed fulfilled
`7,250 bps`, ready `300 bps`, exact WebSocket state, and the unchanged private
relay and fee-cap policy. The replacement waited `67.712 seconds` for the
incumbent lease, then acquired it cleanly; PostgreSQL showed one open run, one
granted signer lock, and zero waiters. The old deployment was removed, wallet
nonces remained `667/667`, and no startup, pass, lease, or telemetry failure
was observed.

The first longer production sample under this deployment recorded 15
lifecycle bundle submissions. Ten landed successfully, producing the exact
wallet gain described in the current snapshot above; five private attempts
expired without nonce movement. All 100 relay-variant submissions were
accepted, and there was no pass, fatal, or signer-lease failure.

Round 349 also exposed a trace-index correctness issue. The ready
`processAcquisitions(1) -> sync -> settle` attempt expired in block
`25647725`; the next-head fulfilled `sync -> settle` attempt offered
`0.00085483268518032 ETH` at an effective `7,251 bps` and expired in block
`25647726`. Near-head telemetry initially attributed
`0.000914401518748608 ETH` of direct beneficiary payment to the winning
wrapper. A later canonical reconstruction proved the transaction paid zero
priority fee and zero direct beneficiary payment: its effective gas price
equaled the block's `0.30209843 gwei` base fee, and the indexed internal
operations contained no transfer to the canonical beneficiary. The original
observer accepted any non-empty near-head trace response without verifying
that its internal operations belonged to the requested transaction.

Competition tracing now requires at least one operation whose `txHash` exactly
matches the requested hash and sums only matching successful operations.
Unrelated near-head responses remain unavailable and retry within the existing
bounded window instead of creating false bid evidence. The new read-only
`npm run inspect:pool-lifecycle-block -- --block=<block> --round=<round>`
command reports the canonical transaction route, gas, reward, builder
payments, and retained value. Round 349 is therefore delivery/builder-selection
evidence, not support for raising the fulfilled bid.

Acceptance:

- ready/fulfilled lifecycle behavior and minimum viable prefixes are unchanged
- typecheck, tests, build, and `git diff --check` pass
- a no-lifecycle dry run remains healthy
- deployment acquires the signer lease and continues passing
- subsequent live lifecycle logs show reduced planning latency

### P0 — Optimize marginal standing-order inclusion

Status: deployed; continue measuring aggregate prefix outcomes.

The 2026-07-30 production window added six isolated standing-order attempts.
Every quote was capped by the one-wei positive-profit rule rather than its
configured adaptive bid. Four inclusions earned `0.0006 ETH` and retained only
`0.000000000000036564 ETH` in total; two private misses cost nothing. A
`0.000001 ETH` aggregate minimum lowers those effective bids by only 33–100
bps, preserves every material lifecycle result in the same window, and ensures
an inclusion advances realized profit. Production therefore uses that floor;
the exact prefix simulation and profit-cap logic remain unchanged.

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

The last 24-hour telemetry audit found 16 decoded competitor bids but 16
additional `competitor_bid_measurement_failed` events, all with the same
top-level `Invalid parameters were provided to the RPC method` message. The
observer abandoned each one immediately because this provider publication
race lacked viem's typed RPC error chain. Read-only replay of failed target
block `25641846` through the unchanged block/log/receipt/trace path recovered
five competitor bids from `7,927` to `9,024 bps`. Competition observation now
recognizes only the two exact untyped publication-race messages and retries
the same authoritative read for the existing bounded one-second window.
Malformed requests remain terminal. Persistent failures now include a
secret-free error name, code, and cause chain so another provider defect can
be distinguished without broadening the classifier.

Deployment `cbed2686-1b71-4a4b-b81a-e73ad1f0e401` from exact source
`035dd04d854165dc959e422278d1459649a8a44b` passed the live acceptance test
at target block `25641989`: the first exact observation received the same
untyped provider error, retried six times over `500 ms`, and then decoded six
competitor bids from `2,615` to `8,843 bps`. There was no measurement failure,
and the adaptive controller durably incorporated the observations.

Acceptance:

- unit tests cover both a genuinely negative suffix and the observed
  individually-negative-but-aggregate-beneficial case
- cross-subsidized `orders -> pull` dependency floors remain intact
- logging explains excluded marginal jobs
- production has logged a bounded availability wait followed by decoded bids
  instead of an immediate measurement failure

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

At block `25642138`, a fresh exact read still returned
`operators(keeper) == false`. The service was correctly bound to the core FWA,
its available processor surplus had grown to
`30.497314996423327246 ETH`, and its reimbursement configuration allowed up
to ten acquisitions, 2.1M reimbursable gas, and `0.02 ETH`; nevertheless, an
exact keeper-address simulation reverted `OnlyOperator`. The sponsored path
remains disabled.

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

The subsequent 24-hour durable sample contained 82 successful public
processors and 82 sync receipts. Successful lifecycle receipts paid
`0.092500772128840316 ETH` gross and retained
`0.067371634907351517 ETH` after processor, sync, and settle gas. The direct
relay sample still contains no evidenced ready-cycle clearing price above the
incumbent's `250 bps`; all eight previously measured cycles won, including the
profit-capped `435 bps` bundle. Ready and fulfilled policies are therefore
reduced together from `500` to **`300 bps`**, preserving a 50-bps margin over
the incumbent. At the sampled volume, retaining the additional two percentage
points is about `0.001850015442576806 ETH` per day if inclusion is unchanged.
The separately reconstructed standalone-pull market remains at `1,000 bps`.

Round 304 provided the first direct production result at the reduced policy.
The three-call ready bundle was accepted by all four relay paths for target
block `25641777` but expired privately without state or nonce movement. The
same exact-simulated chain was resubmitted one block later at an effective
`301 bps` and all three transactions landed in block `25641778`. Its processor
used `7,028,773` gas; the complete chain used `7,577,134` gas, paid
`0.00003072997425378 ETH` through the gas-normalized builder bid, and retained
`0.000583990167628594 ETH` after every receipt. The 300-bps policy retained
about `0.000020486646392058 ETH` more than the former 500-bps quote would have
on the simulated gross reward. One miss followed by one inclusion is evidence
to hold the new quote and collect more samples, not to lower it again.

Rounds 305 and 306 exposed a submission-variant defect rather than a bid
failure. For each ready lifecycle, the exact-simulated three-call bundle was
profitable, but the sender simultaneously offered builders both
`process -> sync` and `process -> sync -> settle` with the same starting
nonce. Titan selected only the two-call variant for round 305; Quasar selected
only the two-call variant for round 306. Those prefixes still retained
`0.000114463792007881 ETH` and `0.000243819121695063 ETH`, respectively, but
both discarded an additional profitable settlement and forced a slower
standalone race. The round-306 competitor settled in the next Quasar block
with zero priority fee and no direct beneficiary payment, proving that our
standalone 301-bps miss was delivery/latency rather than a higher clearing
price.

When an exact-simulated selected prefix contains `settle` or
`settleForcedEth`, the submission floor now rises through that settlement.
Optional work after it retains the same-nonce ladder, so
`process -> sync -> settle -> crank -> pull` may still offer the settled
three-call core and every longer safe prefix. A selected two-call
`process -> sync` plan remains valid when settlement was absent or did not
survive exact simulation. This changes neither the planner's dependency floor,
the 300-bps bid, nor any exact-simulation or profit gate.

The first dense live sample after that correction supports holding the
300-bps lifecycle quote. Round 307's
`processAcquisitions(30) -> sync -> settle -> pull(308)` bundle retained
`0.000803134480853976 ETH`; round 309's corresponding four-call bundle
retained `0.001964283428878568 ETH`; and the complete round-310 and round-312
three-call chains retained `0.000536242642660129 ETH` and
`0.000759787782015036 ETH`. For fulfilled round 308, the enforced two-call
submission floor prevented a sync-only inclusion, but all four relay paths
missed. The competing wrapper settled both calls in block `25642001` with
zero priority fee and no direct beneficiary payment, so that miss remains
delivery/builder selection evidence rather than support for raising the bid.

Lifecycle-loss telemetry now closes the manual-reconstruction gap exposed by
round 308. After a missed sync or settlement it aggregates the target block's
pool `CrankBountyPaid` events by winning transaction and round, measures
priority and direct beneficiary payments, and emits a record-only
pool-reward-normalized bid upper bound. A read-only replay of block `25642001`
identified wrapper transaction
`0xea36b0dc14f24630fe4c069b5c77b52335ebb98bb1defdb00b6a5c0cd10d2a10`,
aggregated both bounties to exactly `0.000877481387112076 ETH`, and measured
zero builder payment and a zero-bps upper bound. The path deliberately does
not feed standing-order adaptive state because a lifecycle wrapper may have
other reward sources. All 248 tests, typecheck, build, and diff checks passed.
This is live in Railway deployment
`34989d08-5039-4c78-8de8-0c56929b90a4` from exact source
`f524293102fb6d1cae49374a813fe3855900af8b`; its overlap handoff again left
exactly one granted signer lock and one open keeper run.

Round 315 exposed a separate receipt-publication race. The target block and
the first two receipts were available, but the foreground provider briefly
returned viem's typed `TransactionReceiptNotFoundError` for the included
settlement. The old observer emitted a false private expiration and an
incomplete batch result even though nonce 602 succeeded and the pool advanced.
Authoritative replay decoded a `0.000790998181566408 ETH` settlement bounty,
`0.000033812672201281 ETH` gas, and
`0.000757185509365127 ETH` retained; together with processor and sync this
matches the wallet increase exactly. Private receipt reads now retry only that
typed publication-race error for the existing bounded one-second window,
persist `keeper_receipt_availability_waited` when recovery is needed, and
leave every other error terminal. This prevents false expiration from
corrupting batch P&L or competitor-loss learning.

The first 59 production receipts after deployment all reconciled through nonce
666 without another publication wait. This is healthy evidence that the fix is
non-disruptive; the next actual delayed-index occurrence remains the live
acceptance test for `keeper_receipt_availability_waited`.

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

### GachaTable battle cranks

Status: battle-24 defaults completed profitably on 2026-08-15; the temporary
worker deployment was removed after reconciliation and production is offline.

The exact-match, nonproxy `GachaTable` at
`0xA936351838d1C85003e736deA03AC6666c1F9c73` was deployed in block
`25,744,145`. Its pinned runtime hash is
`0x2cba54c281d3c5b4b940484afba18291262b7a7d07d0791485ea36f80adb14c5`;
its immutable FWA is the canonical
`0xB276F62DB0ce8CA2Ca5bc522695bE604521eAc1c`, and its pinned escrow
implementation is `0xbD361213eC3387a39D6E031d91E3C56e3662a1d0` with runtime hash
`0xc29dc6351b3ebdafff9480154fbaff49840f567100e40f7b314d161a6c2ac8e8`.
The flat bounty is `0.001 ETH`. At block `25,754,907`, the table retained a
`0.108846278402854388 ETH` fee pool, battle 23 was the only nonterminal battle,
and it was an empty OPEN table.

The permissionless paid surface is `fire`, terminal `settle`, and
`crankDefault`. Plain `settle` is unsafe for a keeper: when its bounded
`processAcquisitions(16)` push advances the FWA head but does not finish all
four requests, it returns successfully and pays no bounty. The implementation
therefore uses a deterministic owner-bound CREATE2 executor for every action.
It measures the exact ETH delta, requires the planned aggregate bounty,
forwards it to the signer, and reverts the entire target call or default batch
when the reward is short. This makes partial settlement work, stale
same-block actions, and fee-pool depletion fail closed. The executor never
joins, funds, elects, or receives an NFT.

Historical receipts through the research snapshot contained 46 bounties for
`0.046 ETH` gross. Winners spent `0.005399498859520945 ETH` on gas and paid
builders `0.023940350638373298 ETH`, retaining
`0.016660150502105757 ETH`. The prior four-leg default window was captured in
the exact eligible blocks with roughly 47.8–48.1% direct BuilderNet payments;
`GACHA_TABLE_DEFAULT_BUILDER_BID_BPS=5001` starts just above that evidence.
Recent fire/settle winners paid roughly 78–80% of gross, so the independent
`GACHA_TABLE_LIFECYCLE_BUILDER_BID_BPS=8100` starts above the observed
clearing range. Exact bundle gas, the global fee ceiling, and the retained
profit floor can still reject an unaffordable lifecycle bid.

Default timing is derived from each exact FWA listing's `allocatedAt` and live
`settlementWindow`. A deadline inside the immediate 12-second child is armed
from the parent with a funded protocol-valid gas envelope; target-block bundle
simulation must then prove callability, aggregate reward, actual gas, and
retained profit. This avoids conceding the first eligible block to an
incumbent while retaining the same fail-closed executor boundary.

`ENABLE_GACHA_TABLE` defaults to `false` and requires Flashbots-mode private
submission. `npm run inspect:gacha-table` validated all pinned relationships
and the current snapshot at block `25,754,907`. A full
`ENABLE_GACHA_TABLE=true DRY_RUN=true RUN_ONCE=true` worker pass at block
`25,754,913` scanned all 23 battles through the authoritative exact-state
transport, planned no false opportunity, signed nothing, and completed
without failure. The historical battle-21 fork additionally executed all four
defaults atomically and proved the exact `0.004 ETH` executor/fee-pool delta.
Repeat the inspector and dry-run if activation happens against materially
newer state. Add durable lane-specific competitor learning only after live
misses provide exact target-block evidence; never feed these results into the
standing-order or PullPool controllers.

The first live battle-24 fire attempt targeted block `25,757,172` as one
deploy/fire economic batch. All seven private routes accepted the exact bundle
with a `0.0008100000013641 ETH` builder payment, but both members expired. A
competitor transaction
`0x286f9dce6c31e4f1735b40d080cd59bc52bfc820bd20694a55e98cab7c059698`
captured the `0.001 ETH` fire bounty in that same block as one action inside a
much larger transaction containing several FWA operations. A separate direct
fire in the block reverted. This is cross-lane construction evidence, not
evidence that a higher isolated Gacha percentage would have won. The keeper
then won battle 24's settle in block `25,757,179`. Its deploy/settle receipts
retained exactly `0.000132751740809088 ETH`; the wallet increased by the same
amount from `0.706983584282464734` to `0.707116336023273822 ETH` while WETH was
unchanged.

At block `25,761,234`, battle 24 was SETTLED with four unresolved FWA auction
legs. Their exact default boundaries are `1786822307`, `1786822307`,
`1786822319`, and `1786822319`; all four are expected to become callable in a
single reward-gated batch on 2026-08-15 around 13:31 America/Denver. The live
fee pool is `0.118731080996386639 ETH`, so the maximum protocol-authorized
gross bounty is `0.004 ETH`. At the independent 5,001 bps default bid, the
planned builder payment is just over `0.002 ETH`; actual retained profit must
still pass exact target-block bundle simulation and gas accounting.

The exhausted Alchemy discovery/WebSocket path cannot be used for this window.
The already configured PublicNode HTTP path and its matching WebSocket were
validated read-only, but a full dormant-lane pass took 15-25 seconds. The new
default-on `ENABLE_PULL_POOL_PLANNING` and `ENABLE_STANDING_ORDERS` gates allow
a temporary Gacha-only activation without changing normal deployments. With
both disabled and the other dormant lanes off, an exact-state dry pass scanned
all 25 battles and completed planning in 440 ms. Restore the full planner only
with production-grade RPC capacity; do not use the narrow mode as a silent
permanent reduction in lane coverage.

The temporary Gacha-only worker was deployed from exact revision
`ae463d6d092f7187d9a9ad81d6e8ec95eca81d85` as Railway deployment
`01d813b4-52bc-48aa-97b7-49d34f0b03fc`. PublicNode supplies both foreground
HTTP and authoritative `newHeads`; pending subscriptions, PullPool planning,
standing orders, GroupPull, MegaRip, vaults, and buyback are intentionally
disabled for this bounded window. Startup acquired exactly one advisory signer
lease, reported the exact revision and flags, and completed nine observed
passes with 401-485 ms planning and no fatal, pass failure, or lost lease.
Immediately after rollout, `latest == pending == 2243` and verified net ETH
equivalent remained `0.699942998027875896`; no live transaction was pending.
Keep this deployment only through the battle-24 default window and its receipt
reconciliation, then shut it down again unless another exact positive-EV
Gacha opportunity is present.

Before the window, PublicNode announced exact heads before its state backend
could serve them. The unused V2 activation read still ran in Gacha-only mode;
when it rejected first, the concurrent Gacha promise could become unhandled
and crash the worker. Revision `8e2a08991ae49502b9a0cbcab0fc39f7f4fa8531`
skips that activation read whenever PullPool planning is intentionally
disabled. Typecheck, all 413 tests, and both production builds passed. Railway
deployment `83f4c00d-b487-4eb3-98f5-b22f69a932c7` acquired exactly one signer
lease and remained healthy through the default window.

Battle 24's first two legs were exact-simulated and accepted by all seven
relay paths from parent block `25,762,552`, then included together in Titan
block `25,762,553`. The second pair was exact-simulated and accepted by all
seven paths from that block, then included together in BuilderNet block
`25,762,554`. Transactions
`0x95e1ca41705f8082c238fb84eecfd9af6b91ba17a11b7e11f58aaafd1818c5d3`
and
`0x8663e19336b1c79d8fafad89d97a4d41522332e872c414b1cb508b2e83cb0c81`
emitted four canonical `BountyPaid` events and two executor
`RewardedExecution` events for `0.004 ETH` gross. Receipt gas was
`0.002048888135854308 ETH`, including exact priority/builder payment of
`0.002000400000710342 ETH`, leaving verified net realized profit of
`0.001951111864145692 ETH`. The wallet rose by exactly that amount from
`0.707116336023273822` to `0.709067447887419514 ETH`; WETH was unchanged,
PostgreSQL stored both successful receipts, and `latest == pending == 2245`.
No other successful Gacha transaction appeared in either target block.

Afterward battle 24 had no unresolved legs, battle 25 remained an empty OPEN
table, and the fee pool was `0.114731080996386639 ETH`. No exact positive-EV
Gacha action remained, so deployment
`83f4c00d-b487-4eb3-98f5-b22f69a932c7` was removed. The worker is offline and
PostgreSQL remains online. Do not restart for the residual fee pool alone.

### fwa.gg launch surfaces

Status: investigated and rejected as unpaid maintenance on 2026-08-14.

The fwa.gg soft launch announced pack battles, Cheap Pulls, Last King jackpot,
and future predictions. The live client currently pins a different battle
contract from the bounty-paying GachaTable above:
`FwaBattle` at `0xEBc1783a63939BccbE39FD1b1500f5b1beE1396d`.
Its verified source exposes permissionless `settle`, but pays no caller reward;
all resulting NFTs, bid proceeds, and refunds remain attributed to the battle
participants. It is therefore not a keeper-profit extension of the enabled
GachaTable lane.

`CheapPulls` is the verified deployment at
`0x45b44F9b602D55D4eC2867109c11420D44FF9405`. Anyone may call `poke`,
`pokeMany`, recovery methods, and `cashOut` after the six-hour player choice
window, but the exact source allocates realized value only to float recovery
and the player upside. The caller receives no bounty or fee.

The Last King jackpot is the verified `LastKingPulls` at
`0x84a33b11E771910735F8a8a684f78419B376aD40`. Its permissionless `crown`
credits the entire pot to the final king and opens the next round; `poke`,
`pokeMany`, cash-out, and recovery paths bank value only to the pot, vault, or
player. There is no caller reward. At the research snapshot the public app
showed round 1 with one ticket and a `0.2700 ETH` pot, and no completed kings.
Predictions were labeled `Soon` and exposed no live opportunity.

Do not add any of these calls to the signer without a source/runtime change
that creates an explicit, exactly measurable caller payment. Recheck the
deployed addresses and verified source if predictions launch or the app changes
its configured contracts.

### Bithook maintenance and mining

Status: investigated and rejected as unpaid maintenance on 2026-08-14.

The announced mainnet deployment is the exact-match, nonproxy
`BithookMiningHook` at `0x65DeBe0205E7c5395FBD31c894eb96AD1c92da44`,
created in block `25,753,335`. Its runtime hash is
`0xded0486804cb8d4fdf689b460dcd9efe42623a7997da8eeb64afc73e86945837`.
At block `25,757,975`, its immutable token was
`0x386c4CB30d2861AdB02eCBdFEA76f6a67eD2cddC`, its PoolManager was the
canonical Uniswap v4 deployment
`0x000000000004444c5dc75cB358380D2e3dE08A90`, and the token's finalized
minter was the hook. Mining had not started: `miningStart == 0`.

The exact deployed source exposes five permissionless maintenance actions,
none of which pays its caller. `poke` only advances TWAP checkpoints;
`finalizeBlock` either records the predetermined winner reward or mints and
burns an unawarded emission; `burnUnrevealed` burns forfeited participant
stakes; `burnFees` destroys token-denominated fee claims; and
`buybackAndBurn` spends ETH-denominated fee claims inside the sealed pool and
burns every token received. The hook never transfers any output from these
paths to `msg.sender`. The project's own live interface independently labels
the fee burns and oracle advance as callable by anyone with no reward.

This is active unpaid work rather than a dormant surface. Through block
`25,757,982`, seven distinct callers had executed nine `buybackAndBurn` calls,
using `999,608` gas and spending `0.000436519834395685 ETH`; six callers had
executed eight `burnFees` calls, using `624,256` gas and spending
`0.000300986075040324 ETH`. At the state snapshot, another
`0.123323620277754030 ETH` and `6,751.083798041047331301 BITHOOK` of fee
claims were pending, but clearing either balance still offered exactly zero
gross caller reward and therefore negative net economics at every positive gas
price.

The advertised ten-minute block reward is a mining-contest payout, not a
keeper bounty. `commit` transfers a BITHOOK stake equal to 1% of the scheduled
reward from the participant, `reveal` locks a successful stake for an era
slice, and `claimBlock` succeeds only for the address already recorded as the
closest predictor. The reward then vests for the era. Automating that path
would require buying and approving the unaudited token, accepting prediction
and reveal risk, locking capital, and competing across funded addresses. It is
outside the bot's capital-free keeper boundary and cannot be valued from the
pre-start spot price as realized profit.

Do not add a Bithook lane or call its maintenance functions. Recheck only if a
new exact deployed runtime introduces an explicit caller payment. A mining
strategy would require separate explicit authority for token acquisition,
approval, custody, and capital lock, plus live post-launch competition and
sell-liquidity evidence.

### FWAToken buyback

Status: live, exact-simulated.

Keep enabled only under the shared profitability and bundle-simulation gates.
Revisit if it becomes a material source of opportunities or repeated scan
latency.

### LiveBidAdapter sweep

Status: implemented, production-disabled after a realized same-block race.

Historical sweep winners paid nearly zero priority fee, so the lane has an
independent low builder bid and must not inherit the standing-order bid.
Bid tuning does not solve its safety problem, however.

In block `25,648,098`, transaction
`0xe79c4bc07efb64832ee2abbf305ac79f5cb105defe5aa4b5a89ab577d1855efb`
called the adapter at transaction index 56 and received the entire
`0.00007549698 ETH` reward. Our later transaction
`0x0f83d1099abc227bc04568e0cc221d61d5f6c2ecec2515edfb3cd176daccfba0`
landed at index 216, succeeded with no reward or logs, and spent
`0.000004400367499418 ETH` on gas. The exact parent-state simulations were
correct for their state, but could not predict another bundle being ordered
first in the target block.

The verified adapter returns success when its ETH balance is zero. Therefore
neither a higher bid nor another parent-state simulation can make the call
safe. `ENABLE_LIVE_BID_SWEEP` now defaults to `false`, and production is
explicitly disabled. Re-enabling requires an atomic wrapper that calls
`sweep()`, requires a nonzero or minimum reward, and forwards the reward in
the same transaction. Such a wrapper crosses the current contract deployment
and transient-custody boundary and requires explicit review before deployment.

### Liquity V2 liquidations

Status: default-off and production disabled on 2026-08-10 America/Denver.

Budget only the guaranteed fixed WETH compensation in the eligibility model;
variable collateral compensation is upside until decoded. Maintain exact batch
simulation and a lane-specific competitive bid.

The complete durable history from 2026-07-29 through 2026-08-10 contains zero
Liquity opportunities, submissions, or receipts. In the last 24 hours alone,
all three branches returned `none_liquidatable` on 7,058 passes, requiring at
least 84,696 exact contract/multicall requests. Production now explicitly sets
`ENABLE_LIQUITY_LIQUIDATIONS=false`, and the code default is also false.
Re-enable only for a validated low-call liquidation trigger or evidence of a
currently profitable trove; do not restore full three-branch enumeration on
every head merely to retain dormant coverage.

### Convex earmarks and expired-lock kicks

Status: production disabled on 2026-08-10 America/Denver.

Rewards are thin and use an independent bid. Keep contract/event decoding
current and do not treat an estimated token equivalent as realized P&L.

The preceding 24 hours contained zero Convex opportunities, submissions, or
receipts, while the four-block background refreshes ran 1,766 times per lane.
They issued approximately 226,048 earmark and 72,406 expired-lock gas
estimates, dominated by repeated `crvChange` and `no exp locks` reverts. This
was avoidable discovery cost rather than latency- or correctness-critical
foreground work. Production now explicitly sets both
`ENABLE_CONVEX_EARMARKS=false` and `ENABLE_CONVEX_KICKS=false`.

Re-enable a lane only after a low-call event/state trigger or other bounded
candidate source is validated against current mainnet rewards. Do not restore
the broad four-block estimate sweep merely to retain dormant coverage.

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

An unsigned, one-pass mainnet refresh at block `25642148` enabled this planner
locally with the production keeper address and discovery RPC. Exact planning
returned `stakedao_curve_none_profitable`; no transaction was signed or sent,
so production remains correctly disabled.

## Promising dormant opportunities

### Liquity V1 liquidations

Status: read-only inspector exists; no currently eligible trove at last scan.

Economics: exact 200 LUSD gas compensation plus 0.5% of liquidated collateral.
The 2026-07-29 refresh still found only 79 troves, with the lowest individual
collateral ratio at `442.03%`, TCR at `514.59%`, and recovery mode false. There
was no immediate action.

Next action:

- build an event/block-driven candidate watcher rather than a costly full scan
- simulate exact liquidation calls
- price LUSD and collateral conservatively
- study recent liquidation competition
- start with a lane-specific bid model around 25–35% of gross only if current
  history supports it; do not inherit another lane's bid policy

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

## Cross-chain capital-free keeper backlog — 2026-07-30 scan

Status: read-only research complete; no cross-chain signer, transaction,
deployment, or production mutation was performed. The BNB execution check
described below used an ephemeral local Anvil fork only.

The broader rejected-candidate evidence and chain-isolation requirements are
recorded in
[`research/CROSS_CHAIN_KEEPERS_2026-07-30.md`](./research/CROSS_CHAIN_KEEPERS_2026-07-30.md).
The follow-up identified three additional positive cross-chain liquidation
surfaces: Nerite on Arbitrum, Quill on Scroll, and Aesyx on Avalanche. All are
Liquity V2 friendly forks, so the existing mainnet Liquity planner provides a
useful read-only inspection shape, but none has been added to live code.
Maker/Sky still has stronger mainnet gross economics; the repository's
bark/redo inspectors found no current eligible auction at the snapshot.

This is a ranked backlog, not an exhaustive claim that no other protocol pays
keepers. The scan covered canonical explicit-bounty surfaces on Base,
Arbitrum, Optimism, Polygon, BNB Chain, Avalanche, and Robinhood Chain. An
opportunity had to be permissionless, require no principal or approval, pay
the external caller, and show recent on-chain activity.

| Rank | Chain and action | Evidence-backed conclusion |
| ---: | --- | --- |
| 1 | Nerite Liquity V2 liquidations on Arbitrum | Strongest next inspector. Complete history found 40 wins and 30 failed races; the latest 30 wins were positive, the current state set is tiny, and stale calls fail closed. |
| 2 | Quill Liquity V2 liquidations on Scroll | Three direct wins each cleared gas on fixed `0.005 WETH` alone, but cadence is sparse, no trove is currently eligible, and one bot submitted 281 failed calls. |
| 3 | PoolTogether V5 prize claims on Base, Optimism, and Arbitrum | Daily WETH-denominated fees and positive current-draw aggregate surplus, but individual margins can be tiny and raw stale batches can succeed for zero reward without a guard. |
| 4 | Aesyx Liquity V2 liquidations on Avalanche | Exact sAVAX and BTC.b liquidation payouts dwarfed gas, but only two successful events were found and the sAVAX event attracted 12 failed calls. |
| 5 | Robinhood StonkPit `collect` | The latest exact inventory is unprofitable and the newest 100,000-block window fell to five calls, despite positive aggregate history. |

Beefy, Yield Yak, Equilibria, Aura, Aerodrome, Compound III, Wombex, and the
unverified current Synthetix Base settlement surface are not part of the
positive ranking. Their rejection evidence is retained below and in the
research file.

### Rank 1 — Nerite Liquity V2 liquidations

Status: canonical deployments, permissionless payout, complete known
liquidation-event history, and current state verified; unsigned inspector is
the next implementation.

Nerite's official
[deployment page](https://docs.nerite.org/docs/technical-documentation/contracts)
lists its Arbitrum `CollateralRegistry` at
`0x7f7fbc2711c0d6e8ef757dbb82038032dd168e68` and eight branch-level
TroveManagers:

| Branch | TroveManager |
| --- | --- |
| WETH | `0x56698cd47d5194c2b7f947ac8370b3cb7359e709` |
| wstETH | `0xffd282a7184dbbe2e142156a08860f2be994fb98` |
| rETH | `0x4895d30b7e18b67872a7542d9e876ce444244311` |
| rsETH | `0x8d7b268cc6d33b460428d8e938de26573596bc85` |
| weETH | `0x76bb92e886d61da119ee8eb3fbcbc722da346550` |
| ARB | `0xbdd4ab4128c414520b3669e155b7ecfb348af7f0` |
| COMP | `0xcfc1b1098d53951811210b6b88feb6a8572267fe` |
| tBTC | `0x285b3d3813d7a132d3f1ab48bb5a585e1363cdeb` |

The reviewed ABI/source is pinned to Nerite commit
[`2076006`](https://github.com/NeriteOrg/nerite/tree/2076006c133eae54a8e1f681e1cec7fd76e81d95).
`TroveManager.batchLiquidateTroves(uint256[])` (selector `0xef49a6b4`) is
permissionless, reverts `NothingToLiquidate` when no supplied debt can be
liquidated, and pays `msg.sender` fixed WETH plus variable collateral
compensation. The fixed reserve is `0.001 WETH` per trove and the collateral
share is 0.125%, subject to the cap. No caller principal, approval, debt token,
transaction value, or Stability Pool deposit is required.

A complete `Liquidation`-topic scan found 42 events in 40 successful
transactions from 2025-09-25 through 2026-06-25. Five senders won
`15 / 10 / 10 / 4 / 1` transactions; 25 called a manager directly and 15 used
helpers. The most recent success was tBTC at block `477214808`:

- [transaction `0xa943…871c`](https://arbitrum.blockscout.com/tx/0xa943b8224459e00164d2ea2df1918363bff8d855e3683fb23485aca2d904871c)
- `0.001 WETH` fixed compensation and zero variable collateral
- `0.000021148876476 ETH` receipt cost
- `0.000978851123524 ETH` fixed-only retained value

All 40 successes paid `0.043 WETH` fixed compensation and spent
`0.074282686571337 ETH` in gas. Five old wins were economically negative
because of extreme gas bidding, including approximate losses of `$63` and
`$108`; a live lane must never copy those clearing prices. The most recent 30
were all positive under an indicative event-price/nearest-day conversion,
producing about `$158.76` reward, `$12.26` gas, and `$146.50` net. These USD
values are comparative estimates, not realized P&L.

Thirty failed direct calls burned `0.003479717830511 ETH`: 22 decoded
`NothingToLiquidate`, one `EmptyData`, and seven were unclassified. One old
outlier was `0.003221850519552 ETH`; the other 29 averaged about
`0.000008892 ETH`. A tBTC bot submitted 13 stale failures on one day. The
protocol fails closed, but public races still cost gas. Fully paginated traces
of the latest ten wins showed no separate native beneficiary payment; their
observable ordering cost was receipt gas/L1/priority fees. This does not prove
that no off-chain arrangement existed.

At pinned Arbitrum block `489358880`, the eight managers exposed 15 trove ids.
Exact full-array gas simulation found no current action: six branches reverted
`NothingToLiquidate`, while the one-trove ARB and COMP branches reverted
`OnlyOneTroveLeft`. No transaction was signed or submitted.

Recommended next inspector:

1. Add one unsigned, chain-ID-42161 Liquity-fork registry script that verifies
   all eight official AddressesRegistry/manager/feed/collateral relationships
   and deployed bytecode at startup.
2. At one exact WebSocket block, enumerate the small trove set, read
   branch-specific risk parameters, identify only unhealthy active/zombie
   troves, and exact-call/estimate the specific batch from the eventual EOA.
3. Use only fixed WETH as the conservative send-gate reward unless an exact
   trace proves variable collateral deltas. Persist live eligibility, arrival,
   competitor, success, stale-revert, token-delta, and full L1/gas telemetry.
4. Keep signing disabled until at least three new eligibility episodes and 30
   live competitor outcomes are observed. A proposed live attempt must have
   at least `0.00025 ETH` fixed-only net, reward at least 4x maximum cost, fee
   budget no more than 25% of fixed WETH, observed win probability at least
   10%, and lower-confidence race-adjusted EV at least `0.0001 ETH`.
5. Auto-disable after three consecutive stale reverts or rolling failed gas
   above 10% of realized gross. Any authorized live worker needs a separate
   Arbitrum signer, gas balance, RPC, nonce/lease domain, and bid policy.

**Go for the inspector; no-go for live submission now.** There is no current
eligible trove and no live latency/share evidence. The small candidate set,
reusable Liquity logic, protocol-native stale revert, and lack of a guard,
approval, custody, or principal make this the first cross-chain implementation
ahead of PoolTogether.

### Rank 2 — Quill Liquity V2 liquidations on Scroll

Status: canonical active deployment, reward, three direct wins, failed-call
history, and current state verified; add to the shared unsigned Liquity-fork
inspector.

Quill's official
[active contract list](https://docs.quill.finance/documentation/contract-addresses)
distinguishes its current Scroll deployment from legacy v0:

| Branch | TroveManager | AddressesRegistry |
| --- | --- | --- |
| WETH | `0x9d2ad9712f3905f3e7803c92d027a197b4c8da90` | `0xe58a321eed288c84fd0b4f6d4892d099054caebd` |
| wstETH | `0xa57aae77fbb22f9c1fb55d516e44b856614e143e` | `0xbe4b85734a046b34b24c2538cba6205c98a74aeb` |
| weETH | `0xf645d67733b76e9d69908108d2eef6bec53dd7c8` | `0x6a036d49287fd7d6808629e95f831a1addc62b95` |
| SCR | `0x862ec870184a66fd3ed6bd7e122bc18355002076` | `0x1cb0f2a6ba0c22388dd28550a90ec5d46c82cdba` |

All four managers share runtime hash
`0x252f909328ecc10871cccd0de6c49f3e1e4b3a57a97b3a71d7dde57a36007fab`.
The deployed source exposes permissionless
`batchLiquidateTroves(uint256[])`, selector `0xef49a6b4`, and pays
`msg.sender` fixed `0.005 WETH` per trove plus 0.5% of collateral capped at
two collateral tokens. It needs no value, approval, debt token, principal, or
Stability Pool deposit and reverts when nothing is liquidatable.

The active manager histories exposed three successful direct calls:

- SCR [transaction `0x343a…1e4a`](https://scrollscan.com/tx/0x343aa3a02569dc2ec804c4e78ea69cf443342b5c5ef143da828abab924be1e4a):
  `0.005 WETH + 2 SCR` reward and `0.000002362791489195 ETH` gas.
- SCR [transaction `0x7bfb…8c0d`](https://scrollscan.com/tx/0x7bfbcf757c08ef81e9e25d8d4944f46dd0cfe36a2a91226bccb38dda76ff8c0d):
  `0.005 WETH + 2 SCR` reward and `0.000000088075340347 ETH` gas.
- WETH [transaction `0x7eff…81a1`](https://scrollscan.com/tx/0x7eff03aed0cc1d11390a7925340b1a0f3a7af17146104336b6d3368c993081a1):
  `0.005457065092856536 WETH` reward and
  `0.000004250268729804 ETH` gas.

The direct SCR history also contained 281 failed calls from one address,
burning `0.000008191269552834 ETH`; speculative public retries are not safe.
At pinned Scroll block `34525512`, the four branches contained only five
troves. Exact batch simulation returned `NothingToLiquidate` for WETH, wstETH,
and weETH, and `OnlyOneTroveLeft` for SCR. There is no current action.

Add Quill to the Nerite inspector with chain ID 534352, active/v0 separation,
runtime/registry/feed/collateral validation, sequencer-sentinel state, exact
trove selection, and fixed-WETH-only conservative economics. Live remains
no-go until three new eligibility episodes and 30 labeled outcomes establish
positive race-adjusted EV, with at least `0.001 ETH` fixed-only net and a 4x
reward-to-maximum-cost ratio. Any future sender needs an independently funded
Scroll worker, signer, lease, RPC, telemetry, and explicit public-submission
authorization.

### Rank 3 — PoolTogether V5 cross-chain prize claims

Status: permissionless payout and current activity verified; inspector not yet
implemented.

Canonical deployments:

| Chain | PrizePool | Claimer | TwabController |
| --- | --- | --- | --- |
| Base | `0x45b2010d8a4f08b53c9fa7544c51dfd9733732cb` | `0xcdCE635b774DE77cdF791647601dba64a75547ba` | `0x7e63601F7e28C758Feccf8CDF02F6598694f44C6` |
| Optimism | `0xF35fE10ffd0a9672d0095c435fd8767A7fe29B55` | `0x220C9398b0Ee07472bF8906e44574Cb9FE3B8D90` | `0xCB0672dE558Ad8F122C0E081f0D35480aB3be167` |
| Arbitrum | `0x52e7910c4c287848c8828e8b17b8371f4ebc5d42` | `0xBEA38368f2A657f00f173764f18F00e841317c73` | `0x971ECc4E75c5FcFd8fc3eADc8F0c900b5914DC75` |

The addresses come from PoolTogether's official
[Base](https://dev.pooltogether.com/protocol/deployments/base/),
[Optimism](https://dev.pooltogether.com/protocol/deployments/optimism/), and
[Arbitrum](https://dev.pooltogether.com/protocol/deployments/arbitrum/)
manifests. The reviewed Claimer source is
[`0ea6b67`](https://github.com/GenerationSoftware/pt-v5-claimer/blob/0ea6b676aec4e3ea5d6f7344e5a682b850e520a2/src/Claimer.sol)
and the PrizePool reward accounting is
[`fedd70f`](https://github.com/GenerationSoftware/pt-v5-prize-pool/blob/fedd70f3b62086895ee4f0f2224f941e4cdb89b0/src/PrizePool.sol).

`Claimer.claimPrizes(vault,tier,winners,prizeIndices,feeRecipient,minFeePerClaim)`
is permissionless and needs no caller principal, value, or token approval. It
computes a per-claim auction fee, asks the prize vault to claim each candidate,
and returns `feePerClaim * successfulClaimCount`. Successful fees are credited
in the PrizePool's WETH reward ledger for the explicit recipient; only that
recipient can later call `PrizePool.withdrawRewards(...)`. The configured draw
period was `86,400` seconds, auction duration `21,600` seconds, and maximum fee
portion 10% on all three chains.

A current-draw scan on 2026-07-30 decoded every `ClaimedPrize` event in the
bounded lookback and the full receipt cost, including OP-stack L1 fees:

| Chain / draw | Claims / transactions | Gross claim reward | Receipt gas | Claim-stage surplus |
| --- | ---: | ---: | ---: | ---: |
| Base / 804 | 1,373 / 65 | `0.003400054747418055 WETH` | `0.001233210558042408 ETH` | `0.002166844189375647 ETH` |
| Optimism / 832 | 1,184 / 49 | `0.000335033603623490 WETH` | `0.000058036202122545 ETH` | `0.000276997401500945 ETH` |
| Arbitrum / 790 | 6 / 1 | `0.000063096451875876 WETH` | `0.000012452873958000 ETH` | `0.000050643577917876 ETH` |

These are protocol-wide one-draw observations, not profit available to this
keeper. They exclude the later `withdrawRewards` gas and do not imply that
every reward recipient was the transaction sender. Base showed 11 distinct
senders, Optimism four, and Arbitrum one. First claims landed 48 seconds, 310
seconds, and 14,482 seconds after the respective draw award. The Base claim
window then remained active for at least 25,880 seconds and the Optimism window
for at least 17,266 seconds. An Optimism transaction retained only
`0.000000004066399079 ETH` after execution and L1 data cost despite the
positive draw aggregate. There is real value, but transaction-level batching,
not claim count, determines profitability.

The Claimer's `_claim` loop catches individual stale/losing claims instead of
reverting the transaction. `minFeePerClaim` protects the fee auction level but
does not require any claim to succeed. A competitor can therefore consume the
candidate set first and leave a raw transaction successfully burning gas for
zero reward. Do not submit a raw cross-chain `claimPrizes` call. At the pinned
head, the three claim windows were open, but no authoritative unclaimed,
profitable account set had been derived; no current candidate is classified
eligible.

Recommended next inspector:

1. Add `scripts/inspect-crosschain-pooltogether-claims.ts` with a pinned
   chain/PrizePool/Claimer/TwabController registry for Base, Optimism, and
   Arbitrum. It must remain unsigned and use chain-specific discovery RPCs.
2. Index each `DrawAwarded`, derive winners from canonical TWAB state, and
   verify every candidate with `isWinner` and `wasClaimed`. Do not trust a
   hosted winner list without on-chain verification.
3. Reconstruct at least seven draws of `ClaimedPrize`, `ClaimError`,
   `IncreaseClaimRewards`, and `WithdrawRewards`, grouping complete competitor
   sequences and failed races by sender. Require at least 30 successful
   transactions and all observable zero-reward/failed races per chain;
   Arbitrum currently has only one successful transaction in the sample.
4. Quote batches with the live Claimer curve, exact gas, L1 data fees, and the
   final reward-withdrawal cost. Rank by conservative retained WETH, not claim
   count or the current fee alone.
5. Specify a minimal immutable guard that calls the canonical Claimer with the
   keeper EOA as `feeRecipient`, then reverts unless returned `totalFees` meets
   a caller-supplied `minTotalFees`. This rolls back a fully stale nested batch
   without the helper holding or forwarding WETH. It does not eliminate public
   stale-revert gas.

For each future candidate, `minTotalFees` must cover exact maximum success
cost, amortized withdrawal, the retained-profit floor, and at least a 2x
reward-to-cost ratio. Require lower-confidence race-adjusted EV
`p(win) * netWin - (1 - p(win)) * staleRevertCost > 0`, multiple positive
draws, and withdrawal inventory at least 10x withdrawal gas. Live prerequisites
are a reviewed guard, explicit authorization for public sequencer submission,
and separate chain-scoped workers/signers, leases, RPCs, telemetry, and gas
balances. No generally available private atomic path was verified. None of
these lanes should inherit the Ethereum standing-order builder bid.

**Go for the inspector second; no-go for guard deployment or live submission.**
Base and Optimism each provide a 30–100 transaction current-draw sample, but
seven-draw and failed-race evidence is incomplete and Arbitrum is under-sampled.

### Rank 4 — Aesyx Liquity V2 liquidations

Status: canonical deployments and positive exact payouts verified; activity is
too sparse for a live lane.

Aesyx's official
[contract page](https://aesyx.gitbook.io/welcome-to-aesyx/resources/smart-contract-addresses)
lists the Avalanche sAVAX TroveManager at
`0x0eb600fe2e9eb27b757f31f73f81a87c53e56cd1` and BTC.b TroveManager at
`0xfcdf672475f2f259746572e3a82919f05f5227a7`.

The Routescan direct-call address histories showed one successful sAVAX
liquidation with 12 failed calls and one successful BTC.b liquidation.
Contract-routed calls still require a separate event scan:

- [sAVAX transaction `0x7780…43aa`](https://routescan.io/tx/0x778024bc092c7907e46b22ff17b5360ec6e7d67c223c3d37c84d0b656efa43aa/network/mainnet/evm/43114)
  transferred `56.326041777598417524 sAVAX` to the caller and spent
  `0.021140888284669992 AVAX` in gas. The liquidation event's collateral price
  valued the reward near `$1,454`.
- [BTC.b transaction `0xba0a…aee2`](https://routescan.io/tx/0xba0a31fd18ad2da9c6d6101edc51b4ce611c445b05064dc93d9e933ac1aee2/network/mainnet/evm/43114)
  transferred `0.00004362 BTC.b` to the caller and spent
  `0.003002546919791232 AVAX` in gas, roughly `$3.35` of reward at the
  liquidation event price before gas.

The 12 failed sAVAX calls burned `0.04312220855386907 AVAX` combined. The
sampled win still dwarfed all of that race cost, but the successes occurred in
October 2025 and February 2026. Add both branches to the same read-only
Liquity-fork inspector as Nerite, validate current bytecode/parameters and
trove state, and keep Avalanche signing disabled. At pinned Avalanche block
`91613748`, sAVAX exposed one trove id and BTC.b three; both exact full-array
simulations reverted `NothingToLiquidate`.

### Rank 5 — Robinhood StonkPit collection

Status: retain the existing dedicated P0 entry as the authoritative record.

The verified `PitLpLocker`, clue token, linked transaction, 1% native-ETH tip,
273-success history, failed-race sample, and public FCFS constraint have been
reconstructed above. A later 100,000-block refresh found only five successes
over 10,030 seconds, one unprofitable, with
`0.000111375034999676 ETH` aggregate net. Current exact simulation was
unprofitable by `0.000004941604941098 ETH`. The next artifact remains the
immutable minimum-ETH guard specification plus a read-only latency/win-rate
observer. Use a separate Robinhood worker and gas-only signer if public
submission is later authorized; do not mix chain ID `4663` into the Ethereum
signer's nonce or lease domain.

### Rejected — Beefy multi-chain harvests

Status: monitored/rejected at the snapshot; quotes are not safe eligibility
signals.

Beefy's canonical vault API returned the following active strategy counts:
Base 241, Arbitrum 44, Optimism 72, Polygon 1, BNB 20, and Avalanche 8.
Permissionless `harvest(address callFeeRecipient)` exists on the reviewed
strategies, and the deployed `StrategyRewardPool` source transfers the charged
native call fee to that recipient. The source was verified through the
deployed [Arbitrum implementation](https://arbitrum.blockscout.com/address/0x95c3228308e02F4defC4e8C339907aB19a4F62Cd)
and matching [Base implementation](https://base.blockscout.com/address/0x68Ecddba8D4CfCa13923fC8d66f2678BF17aB4e1).

The important negative finding is that `callReward()` is not reliably
denominated in final wrapped-native value on these strategies. It multiplies
the underlying raw `rewardsAvailable()` units by fee percentages, while the
actual harvest first swaps the reward token to native. Exact
`ChargedFees.callFees`, native balance deltas, and receipts contradicted the
large quotes:

| Chain / sampled strategy | Actual caller reward | Receipt gas | Net |
| --- | ---: | ---: | ---: |
| Base `0x0c19E165c9e369edcC819bAD004b17cfAB30aeF5` | `0.000001932494756686 WETH` | `0.000016035532903773 ETH` | `-0.000014103038147087 ETH` |
| Optimism `0x994Afa36B085d006a911Ce28bA300E8ee71B8bc2` | `0.000000028233767560 WETH` | `0.000000033480348328 ETH` | `-0.000000005246580768 ETH` |
| Arbitrum `0x3DAfB52975faB6B02eA6Cf4ead926E409Fa23ca0` | `0.000000001292039524 WETH` | `0.000044423658212000 ETH` | `-0.000044422366172476 ETH` |

Optimism's sampled strategy was being harvested about every four to six
minutes by one incumbent. Base's sample was on an approximately daily service
cadence. The Arbitrum sample also showed contract-routed and direct
harvesters. These are protocol-maintenance patterns, not evidence of
capturable external profit.

The strongest BNB quote made the problem explicit. Strategy
`0xdC4C4bD3db8e49E41D0F427137040860e5feae` reported
`0.019321097056222255` through `callReward()`. An unsigned local Anvil fork at
BNB block `113030784` executed the exact `harvest(recipient)` state transition:
the recipient gained only `0.000046942928528168 WBNB`, while `2,133,254` gas
at `0.05 gwei` cost `0.000106662700000000 BNB`, for
`-0.000059719771471832 BNB` net. No transaction reached BNB Chain.

Do not implement from `callReward()` alone. A future Beefy inspector would
need a fork/state-diff balance delta in the final native token, exact route
execution, receipt-history validation, and a fail-closed minimum-reward helper.
Until one candidate clears those gates repeatedly, this surface remains
rejected.

### Rejected — Yield Yak Avalanche reinvests

Status: permissionless bounty verified; currently uneconomic and not safely
wrappable.

Yield Yak's official
[reinvest documentation](https://docs.yieldyak.com/for-farmers/reinvest)
describes the variable caller reward. The current
[`YakStrategy`](https://github.com/yieldyak/smart-contracts/blob/17d985e2b2270e976458cd751db2d964fdabc896/contracts/YakStrategy.sol)
exposes `estimateReinvestReward()`, and
[`BaseStrategy`](https://github.com/yieldyak/smart-contracts/blob/17d985e2b2270e976458cd751db2d964fdabc896/contracts/strategies/BaseStrategy.sol)
pays `REINVEST_REWARD_BIPS` of reward tokens to `msg.sender`.

At Avalanche block `91,606,516`, the newest 120 entries in Yield Yak's
[764-strategy subgraph registry](https://github.com/yieldyak/subgraph-strategies/blob/04c1788d99bdc6238acf69b6a29c70bee8b0ce49/config/avalanche.json)
produced 117 readable contracts, 78 deposit-enabled contracts, and 59 positive
WAVAX reward quotes. That registry snapshot was last updated in October 2025,
so this was a bounded candidate sample rather than proof of full 2026
coverage. Exact `reinvest()` gas estimation for the highest 30 found no
profitable candidate. The best was
`0x3bbae5DCb89A9fD650281e2609ACAe9055Fae491`:
`0.000188124336347297 WAVAX` against `1,185,741` gas at a
`0.255758051 gwei` max-fee quote, or
`-0.000115138470803494 AVAX` before any race allowance.

The current base implementation is `onlyEOA`, so a minimum-bounty wrapper
cannot call it. It also emits `Reinvest` when the post-conversion amount does
not clear the threshold rather than universally reverting. A stale public call
can therefore succeed without paying a useful reward. With no private
Avalanche path verified, leave this lane disabled unless a future raw-EOA
expected-value study shows enough surplus to cover both wins and stale races.

### Other rejected cross-chain screens

- Equilibria `earmarkRewards` on Arbitrum paid a permissionless token reward,
  but the exact sampled call was only approximately break-even before ordering
  cost and operational overhead.
- Aura sidechain `earmarkRewards` on Base and Optimism paid a small BAL caller
  incentive while consuming much larger cross-chain message value.
- Aerodrome `Minter.updatePeriod` is permissionless but pays the caller
  nothing.
- Compound III `Comet.absorb` records non-redeemable liquidator points; the
  economic follow-on needs principal and collateral trading.
- Wombex historically documented a 0.5% BNB-chain `voteExecute` incentive,
  but no current canonical deployment or recent execution was verified.
- Synthetix documents keeper settlement rewards, but this pass did not
  identify a current canonical Base deployment with recent externally
  capturable settlements. Legacy Andromeda examples are not implementation
  evidence.
- Polygon's bounded active Beefy surface had no positive native-denominated
  candidate.

### Research RPC and ordering notes

These credential-free endpoints were sufficient for the bounded read-only
scan. They are not production recommendations:

| Chain | Public research RPC | Submission conclusion |
| --- | --- | --- |
| Base | `https://mainnet.base.org` | Public sequencer path; no non-leaking atomic path verified. |
| Optimism | `https://mainnet.optimism.io` | Public sequencer path; no non-leaking atomic path verified. |
| Arbitrum | `https://arb1.arbitrum.io/rpc` | Public gateway with Timeboost ordering; not an Ethereum builder-bid lane. |
| Polygon | `https://polygon-bor-rpc.publicnode.com` | Public validator path; no private path verified. |
| BNB | `https://bsc-rpc.publicnode.com` | Current-state access only in this pass; historical log access required another provider. No private path verified. |
| Avalanche | `https://api.avax.network/ext/bc/C/rpc` | Public validator path; no private path verified. |
| Robinhood | `https://rpc.mainnet.chain.robinhood.com` | Documented FCFS public sequencer ordering; no private path verified. |

Production discovery needs paid, rate-isolated providers with the required
archive/log limits. A relay or sequencer endpoint must not be inferred to be
private merely because it accepts direct JSON-RPC submissions.

### Cross-chain deployment boundary

Any promoted opportunity must run outside the Ethereum production signer.
Use one chain-specific gas-only signer and PostgreSQL advisory lease domain per
chain, a dedicated paid RPC that cannot starve Ethereum discovery, chain ID in
every telemetry/adaptive-bid key, and an independent nonce gate. Start with a
read-only observer. Public submission, signer funding, helper deployment, and
any contract that temporarily receives reward tokens require separate review
and explicit authorization.

## Implemented — PullPool GroupPull packs

Status: verified new contract and separate keeper bounty lane; confirmed-head
and pending-final-entry execution implemented on 2026-08-02.

The canonical deployer created verified `GroupPull` at
`0xD170B7e75B2D658098aB8b53F5914E1C4804BA93` in block `25,668,977`.
Its runtime hash is pinned to
`0x0da3c8c1ea77e6e4e5d9927b0ceaed5382f279d36b9fcce230a492811229f339`,
and every plan also requires its live `pool()` relationship to remain the
canonical PullPool V2. The reversible `deprecated` launch hold does not disarm
already-selling or already-buying rounds; exact contract state and simulation
remain authoritative.

The two public test rounds paid `submit` callers `0.00375 ETH` and `0.010 ETH`.
After exact receipt gas and the first winner's direct beneficiary payment, the
combined observed net opportunity was `0.010554119428338197 ETH`. One winner
landed immediately after the final entry in the same block, so confirmed-head
polling alone is insufficient. The implementation therefore includes both
exact-head `close`/`submit` planning and a hash-only pending lane for signed
`enter` calls. A pending entry is bundled only when its exact value and current
round state prove it closes the sale; the exact pair
`[public enter, keeper submit]` must simulate twice, only the keeper receipt is
priced/accounted, replacements are suppressed, and the signer lease, nonce,
balance, target-head, runtime, pool relationship, and raw prerequisite are
revalidated immediately before private submission.

The independent `GROUP_PULL_BUILDER_BID_BPS` starts at `3000`, just above the
larger observed test clearing payment (about 28%). Exact retained-profit and
fee caps still bound every quote. Add lane-specific durable competitor learning
after live losses provide exact payment evidence; do not feed GroupPull results
into standing-order or PullPool lifecycle controllers.

The same deployer also created `PullStandingOrderBatcher` at
`0x63Cf8340f90a8CCb52325A17eAC695421b1230e9`. It exposes no new bounty: it only
aggregates existing standing-order `crank()` fees. The keeper's existing
deterministic batch executor is stricter, preserves per-order bidding and an
owner-return floor, and remains the selected implementation. No production
change is warranted for the deployer batcher.

Release watch, 2026-08-02: the canonical deployer created another verified
`GroupPull` at `0xd23DCbfD47E849DAC946689E264AaD3c6bbD4187` in block
`25,671,215` (transaction
`0xe4e70c01d7ad309f491e54f7336bb083d8ecf62d59d7a33b3bb0d55047a6ea0a`).
It targets the same canonical V2 pool, has runtime hash
`0x3c53349d2d4b4c59cab54e3844c17ad6dc4c1967c0329801076923fb0e1957a7`,
and was still paused with zero rounds at block `25,671,496`; the original test
deployment was deprecated and had no live or buying rounds. This is a future
GroupPull release, not a current missed keeper lane. Preserve the existing
healthy deployment until the separately owned Pack Pull integration validates
the successor's exact launch state, runtime, configuration, economics, and
pending-entry path; do not switch merely because the contract exists.

Release watch, 2026-08-03: the deployer configured the successor with a
successful `setTerms` transaction
`0x57dbcf6a31f5a06708a6f0f99c050eee2ce20ce8df3055f9271ff4f568ee41c4`
at block `25,672,816`. Sourcify now reports exact creation and runtime matches,
and the decoded/current terms are `0.005 ETH` entry price, `0.0001 ETH`
incentive per ticket, four pulls per GroupPull round, one-hour entry duration,
no round gap, a four-hour submit window, a 2,000 bps escalation threshold, and
zero escalation rate. At block `25,672,965` the contract still targeted the
canonical V2 pool and remained paused, non-deprecated, with zero rounds and no
live or buying round. This is concrete pre-launch configuration evidence, not
authorization to switch production; the separately owned successor integration
must retain the pinned runtime and fail-closed launch-state checks before it is
deployed.

The same release is now publicly scheduled: ripe0x post
`2084172796544827511` says the first four-pull group pack opens at 09:00 ET on
2026-08-03. Treat that time as a monitoring lead, not an activation signal;
require the canonical successor to unpause and expose an exact live round, and
require the separately owned integration and deployment checks to pass before
production can act.

Release watch, 2026-08-03 09:48 ET: successor round 1 launched, sold all 100
entries, and completed four PullPool rounds before the contract was deprecated
again. The winning `submit` transaction
`0x1a3e2f3677775da5c2b7d3ddd8358f46c004ea8493f7e5ac79d5ff31197f4fb0`
received four `BountyPaid` transfers of `0.001111111111111111 ETH`, for
`0.004444444444444444 ETH` gross. Its receipt used 3,806,292 gas for
`0.000943850756727480 ETH`, and an exact trace proves a
`0.000186547028587379 ETH` direct builder payment, leaving the winner about
`0.003314046659129585 ETH` before any off-chain costs. Production did not
compete because deployed revision `9fa00f1` still pins the deprecated test
GroupPull. The successor is now deprecated with no live or buying round, so
there is no safe current call to send; prioritize the separately owned
successor integration before the next activation or successor deployment.

Integration update: the keeper's pinned GroupPull identity now targets this
successor address, deployment block, and runtime hash. The existing exact
runtime/pool-relationship checks, confirmed-head `close`/`submit` planner, and
pending final-entry pair remain unchanged. A deprecated successor produces no
job; if the same contract is reactivated, exact live state and simulation can
arm it without another deployment.

Release watch, 2026-08-03 13:57 ET: ripe reported that the first round went
well but that new rounds are temporarily paused while UI bugs and reveal-flow
sequencing are corrected. Exact mainnet state at block `25,674,906`
corroborated the operational pause: the pinned successor was deprecated with
`roundCount=1`, `liveRound=0`, and `buyingRounds=0`. The canonical PullPool V2
remained independently active and healthy (`paused=false`, `deprecated=false`,
`roundCount=226`, `currentOpenRound=226`). No keeper change is warranted; keep
watching the successor for reactivation or replacement by the canonical
deployer.

Release watch, 2026-08-03 12:37 ET: ripe announced Pack 002 for 1:00 PM ET.
The canonical deployer corroborated the launch on the already pinned successor:
transaction `0x8e9dc95671259464757d872d9f28706c3129bae3440a7d9a549a043aa9120ebe`
called `setDeprecated(false)`, followed by transaction
`0x769783037e66a9bd4e6fa45c92bc2bb9510e08b8a2a3f893ec2c6667c8bca30d`
calling `openRound()` and returning round 2. At block `25,675,611`, the runtime
hash and canonical V2 pool relationship still matched, `deprecated=false`,
`liveRound=2`, and the round's `sellsFrom` was `2026-08-03T17:00:23Z`.
Production revision `f827f06` has GroupPull and pending-entry backruns enabled
and is already observing this exact round on every pass. No rollout is needed.

Pack 002 incident, 2026-08-03: the pinned successor does not share the original
test deployment's `Round` ABI or lifecycle. The stale tuple decoded the
successor's live `Selling` value as `None`, and the old planner also assumed
`bountyShares` existed before close. Pack 002's final `enter` closed round 2 in
block `25,675,783`; a competitor submitted its four underlying pulls in block
`25,675,784`, then collected all four before the repair could be deployed.
Round 2 was verified at `Distributing`, with `bought=4`, `pullsCollected=4`,
and no remaining bounty. The keeper now pins the successor's exact 24-field
round tuple and six-state enum, derives the pre-close share count, and supports
the missing bounty-paying `collect(round,maxPoolRounds)` phase. Exact
fixed-block estimation, retained-profit checks, independent GroupPull bidding,
and receipt-derived `BountyPaid` accounting apply to close, submit, and collect.

Pack 003 validation, 2026-08-03: repaired production won all four `submit`
bounties in block `25,676,061` for `0.002577190800843969 ETH` net, then won the
first two ready `collect` bounties in block `25,676,069` for
`0.001465100429899859 ETH` net. It also settled underlying pool rounds 243–246.
A competitor collected rounds 245 and 246 in transaction
`0x09fe517cb5eb949b1d1e90d1d766f2fe191f1d66d9ed4e8478a256e25fcd0fad`
in block `25,676,071`, ordered after our same-block sync/settle of round 246.
This was not an underbid on a confirmed-head collect opportunity: the bounty
became callable only after lifecycle work inside that block. The concrete next
Pack Pull improvement is an exactly simulated GroupPull `collect` suffix on a
pool lifecycle bundle when the settled round belongs to an active GroupPull;
keep its reward, gas, and builder bidding attributable to the GroupPull lane.
The separately owned Pack Pull work should implement this rather than creating
a competing integration here.

Pack 004 confirmed both gaps. Production won all four submit bounties for
`0.002419776154691820 ETH` net and the first two collect bounties for
`0.001467724288976397 ETH` net. It then selected profitable pool lifecycle
work ahead of the newly available round-249 collect, which a competitor took,
and lost the round-250 collect in Eureka-built block `25,676,311`. Our exact
quote paid `0.000333333333433870 ETH` (3,001 effective bps) and retained an
expected `0.000703506956956090 ETH`. Exact receipt and trace evidence for
competitor transaction
`0xcc112c065433d849eaf437e0814336f1fededcce84b313ed37210f0d0ffbea0d`
shows zero priority payment and `0.001009465855395564 ETH` direct payment to
the block fee recipient: 9,085 bps of the `0.001111111111111112 ETH` bounty,
still counterfactually profitable for us. GroupPull therefore needs its own
durable competitor controller, plus profitable cross-lane suffix composition;
the current static 3,000-bps quote is not competitive in this lane.

Implemented follow-up: GroupPull collection now has an independent 9,100-bps
starting bid, just above the exact Pack 004 clearing payment while retained
profit remains the final boundary. More importantly, an exact V2 pool
lifecycle plan now detects when its settlement unlocks an associated
GroupPull round and appends `collect` immediately after `settle`; the mandatory
relay prefix extends through the collect so production cannot expose the new
bounty with a lifecycle-only prefix. The planner conservatively prices only
the single bounty share guaranteed by its own settlement and treats any older
ready shares as unpriced upside. Historical replay at parent block
`25,676,309` reconstructed GroupPull round 4 with underlying rounds 247-250,
round 250 still Pulling, and the new dependent suffix selected round 250; at
parent block `25,676,310`, after settlement, the dependent path correctly no
longer armed and ordinary confirmed-head collection remained responsible.
The dependent call uses a funded Ethereum-valid envelope and requires complete
signed-bundle simulation to determine actual gas and enforce exact retained
profit before submission.

Standing-order prefix incident, 2026-08-04: target block `25,678,086` exposed a
construction flaw in the direct nonce-contiguous auction. The planner sorted
nine independently profitable orders from the lowest active bid to the
highest, then the six-job limit submitted only prefixes beginning with a
3,533-bps probe. A competitor cleared that first order at 6,327 bps, so every
longer prefix became invalid even though our later quotes exceeded several
observed competitor payments; three 9,191-10,000-bps jobs were excluded from
the submitted set entirely. All six member expirations were one economic
prefix failure, not six relay failures, and all six relays had accepted the
variants. The auction now orders strongest-priced independent work first,
leaving underpriced probes as suffixes that cannot invalidate stronger earlier
transactions. Equal-price work remains profit-first. The existing adaptive
controllers still learn per order from exact clearing evidence and retained
profit remains the final quote boundary.

Release watch, 2026-08-04 01:48 UTC: canonical deployer transaction
`0x1d4829364d6b499e31bfb6dc0fb28fc1d8e8b8ece7ee8a762943801247af583b`
entered two tickets in live GroupPull round 13 at the already pinned successor.
This is ordinary successful product participation, not a deployment,
configuration change, successor signal, or new keeper method. At block
`25,678,432`, the runtime relationship remained the canonical V2 pool,
GroupPull was unpaused and non-deprecated with round 13 still Selling
(`ticketsSold=9`, `bought=0`, `pullsCollected=0`), while PullPool V2 was
unpaused and non-deprecated with open round 295 and no pending pull. No
compatibility or production change is warranted; continue monitoring the
existing exact `close`/`submit`/`collect` lifecycle.

Release watch, 2026-08-04 02:18-02:57 UTC: three new canonical-deployer
transactions were ordinary use of already supported contracts, not a release
or configuration change. The deployer claimed its expired round-13 GroupPull
entries, created successor-factory standing order
`0x8b9967cEf76957Ecc54ef31dcbE4102Fc6683c68` for two tickets with a
`0.0003 ETH` crank fee, and entered five tickets in live GroupPull round 14.
Production discovered the new order in the first pass at its creation block
(the candidate count advanced from 213 to 214), so no integration change is
needed. At block `25,678,719`, round 14 remained Selling with 19 tickets and
no buying or collection lifecycle; the pinned runtime and canonical V2 pool
relationship remained valid.

Live follow-up, 2026-08-04 04:05-04:40 UTC: the strongest-prefix standing-order
change preserved eventual capture but did not eliminate exact price losses.
At targets `25,679,040` and `25,679,205`, ten-member private batches missed;
eight distinct orders in each target were taken by competitors whose observed
payments normalized to `5,273-8,010 bps` and `5,962-8,556 bps`, respectively.
The per-order controller increased only the exact counterfactually profitable
losses (six and four targets) and held the rest. Separately, round 299's
`processAcquisitions(1) -> syncFwaResult -> settle` chain missed a Titan block
and its remaining `sync -> settle` chain missed the following unmarked geth
block despite all six relay paths accepting both bundles. No competing
lifecycle transaction acted in either block. The same `sync -> settle` quote
then landed in the next BuilderNet block for `0.00076614205551872 ETH` net.
This remains builder construction/reach evidence rather than clearing-price
evidence; it does not justify raising the pool-ready bid or weakening exact
profitability. Continue measuring eventual wins and builder-specific delivery.

Release watch, 2026-08-04 04:06-04:12 UTC: canonical-deployer nonces
`3419-3423` were four ordinary `withdraw(uint256)` calls against existing
standing orders followed by a plain ETH funding transfer to already supported
order `0x8b9967cEf76957Ecc54ef31dcbE4102Fc6683c68`. There were no creations,
factory/configuration changes, successor relationships, or new method surface.
At block `25,679,320`, the pinned GroupPull remained unpaused and
non-deprecated; live round 15 was Selling with five tickets, no buying rounds,
and PullPool V2 had open round 300 with no pending pull. No release integration
or production change is warranted.

FWA FIFO-position incident, 2026-08-04 16:40 UTC: the full round-309
`processAcquisitions(2) -> syncFwaResult -> settle` bundle landed at target
`25,682,761` but lost `0.000283480712520420 ETH`, versus an exact-parent
simulation predicting `0.000143665045835202 ETH` profit. Actual aggregate gas
was `4,145,038`, `1,480,643` (55.57%) above the simulated `2,664,395`.
Receipt reconstruction proved the unbound processor call handled sequences
120983 and 120984; the latter was a new unrelated acquisition whose listing
was created earlier in the target block. FWA's public
`processAcquisitions(maxCount)` starts at the inclusion-time FIFO pointer, so
an earlier block transaction can advance the queue and make the same count
process newer, unpriced work even though the exact parent simulation passed.
The bounded repair uses an owner-bound CREATE2 executor that checks the exact
planned `nextSequenceToProcess` before calling FWA and the exact post-pointer
afterward. A shifted or incomplete interval reverts the private bundle, so the
keeper retries from a fresh parent instead of paying for unpriced acquisitions.
Deployment, processor, and sync form one mandatory private prefix; the pinned
singleton factory/runtime, canonical FWA constant, complete bundle simulation,
nonce/lease gates, and retained-profit boundary remain fail closed. Solidity
tests reproduce the historical pointer-shift failure and prove rollback.

Live validation, 2026-08-05: the guarded executor processed exactly sequence
`123684`, then production synced and settled V2 round 329 in Quasar block
`25686149`. The three receipts earned `0.001204263570331996 ETH`, spent
`0.000354172199090676 ETH` including the 1706-effective-bps builder payment,
and retained `0.000850091371241320 ETH`. Exact processor gas was `2,020,350`,
the mandatory prefix landed in full, and the wallet delta reconciled. This
proves the bounded executor works on the live FIFO path; continue watching for
a deliberately reverted pointer-shift bundle as evidence of the protection
activating under target-block interference.

Release watch, 2026-08-04 16:13-16:43 UTC: @ripe0x announced that GroupPull
subscriptions are coming soon and separately confirmed Pack 0016 completed.
This is a lead for a future integration boundary, not authority to enable a
new contract. Canonical-deployer nonces `3424-3426` corroborate only ordinary
current-product use: entries into the pinned GroupPull for packs 15/16 and one
`createOrder` call on the already supported successor standing-order factory.
There was no contract creation, runtime/configuration change, or subscription
deployment from the canonical deployer. Production discovered the resulting
new order automatically (candidate count advanced from 220 to 221). Monitor
the deployer for a canonical subscription creation and verified source; do not
integrate a speculative address.

Ready-processor clearing incident, 2026-08-04 17:37 UTC: the newly guarded
round-310 four-call prefix (executor deployment, exact sequences 121745-121747,
sync, settle) simulated at target `25,683,096` with `0.001255004251508178 ETH`
gross, `2,660,164` gas, and `0.000166295998840402 ETH` expected profit. All six
relays accepted its 301-effective-bps bid, but Titan selected recurring wrapper
`0xa084c33fb7a467307452898b8d58165ebd2e5d9f`, which processed sequences
121745-121748 and paid `0.000201995785995584 ETH` of priority fee. Our builder
payment was only `0.000037650128403004 ETH`; there was no pool lifecycle
competitor and the block used only `27,520,422 / 60,000,000` gas, so capacity
was not causal. This is exact price competition for the conflicting processor
state, not a builder-reach miss. The same conflict repeated at target
`25,683,265`: all six relays accepted our 301-effective-bps four-call bundle,
but Quasar selected the same wrapper at a `0.0002040034 ETH` priority payment.
That block used only `29,066,748 / 60,000,000` gas. The minimum aggregate floor
that strictly beats both observations is 1,705 bps. It would have paid
`0.000204052858321555 ETH` against the second clearing payment and retained
approximately `0.000056649464585296 ETH`, comfortably above the
`0.000001 ETH` floor; it also beats the first observation. Raise only
`POOL_BUILDER_BID_BPS` to 1,705. Exact simulation and retained-profit checks
continue to reject any ready chain that cannot safely afford it. The remaining
sync/settle prefixes won shortly afterward for `0.000955153431039312 ETH` and
`0.000943466447715844 ETH` net. Next, teach the ready lane to observe
processor-only conflicts and maintain its own durable adaptive clearing state;
the generic pool lifecycle observer currently labels these misses as no
competitor because the winning transaction never calls the pool.
