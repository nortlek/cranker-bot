# Cross-chain keeper research backlog

Snapshot: 2026-07-30 America/Denver

## Scope and decision rule

This is a research draft, not a production configuration. It deliberately
rechecks the already-investigated PoolTogether V5 and Robinhood Chain lanes,
then screens Liquity V2 friendly forks and other explicit-bounty surfaces on
Base, Optimism, Arbitrum, Polygon, BNB Chain, Avalanche, and other credible
EVM chains. The negative Beefy and Yield Yak results from `OPPORTUNITIES.md`
are summarized rather than repeated transaction by transaction.

A candidate qualifies for implementation only if an ordinary EOA can invoke
it, the caller receives a contract-enforced reward, the action requires only
native gas, and exact simulation can prove positive net economics. Calls that
need token approvals, inventory, swaps, deposits, flash loans, or custody of
user funds are rejected even when a wider arbitrage strategy could make them
profitable.

Historical amounts below are decoded on-chain amounts. USD values are rough
comparisons at the sampled block/explorer price, not realized P&L.

## Positive backlog

Only the following four candidates retained positive observed economics after
gas. This is an inspector order, not authorization to fund a signer or submit
public transactions.

| Rank | Candidate | Chain | Next action | Why |
| ---: | --- | --- | --- | --- |
| 1 | Nerite Liquity V2 liquidations | Arbitrum | Build a read-only fork-registry inspector | Complete scan found 40 wins and 30 failed races; the latest 30 wins were positive, the state set is tiny, and the protocol itself rejects stale calls |
| 2 | PoolTogether V5 prize claims | Base, Optimism, Arbitrum | Build the existing proposed read-only inspector | Current draws had positive aggregate surplus, but individual margins can be tiny and raw stale batches can succeed for zero reward without a guard |
| 3 | Aesyx Liquity V2 liquidations | Avalanche | Add to the same fork inspector | Both historical successes paid far more than gas, but only two wins were found and the sAVAX event attracted 12 failed calls |
| 4 | StonkPit `collect` | Robinhood Chain | Add the minimum-tip guard specification and latency observer | A fresh 100,000-block sample remained positive in aggregate, but half of successful calls lost money and one incumbent won 70% |

Maker/Sky and Liquity V1 remain worthwhile Ethereum research, but they are
listed in the mainnet appendix rather than used to inflate the cross-chain
ranking. Equilibria was approximately break-even. Aura, Beefy, Yield Yak,
Aerodrome, Compound III, stale Wombex voting, and the unverified current
Synthetix Base settlement surface did not pass the positive screen.

## 1. Nerite Liquity V2 liquidations on Arbitrum

### Canonical contracts, ABI, and relationships

Nerite is Liquity's licensed Arbitrum friendly fork. The official
[deployment page](https://docs.nerite.org/docs/technical-documentation/contracts)
lists the top-level `CollateralRegistry` at
`0x7f7fbc2711c0d6e8ef757dbb82038032dd168e68`. The source and ABI reviewed for
this snapshot are pinned to Nerite commit
[`2076006`](https://github.com/NeriteOrg/nerite/tree/2076006c133eae54a8e1f681e1cec7fd76e81d95),
specifically
[`TroveManager.sol`](https://github.com/NeriteOrg/nerite/blob/2076006c133eae54a8e1f681e1cec7fd76e81d95/contracts/src/TroveManager.sol),
[`ITroveManager.sol`](https://github.com/NeriteOrg/nerite/blob/2076006c133eae54a8e1f681e1cec7fd76e81d95/contracts/src/Interfaces/ITroveManager.sol),
[`ITroveEvents.sol`](https://github.com/NeriteOrg/nerite/blob/2076006c133eae54a8e1f681e1cec7fd76e81d95/contracts/src/Interfaces/ITroveEvents.sol),
[`IAddressesRegistry.sol`](https://github.com/NeriteOrg/nerite/blob/2076006c133eae54a8e1f681e1cec7fd76e81d95/contracts/src/Interfaces/IAddressesRegistry.sol),
and
[`Constants.sol`](https://github.com/NeriteOrg/nerite/blob/2076006c133eae54a8e1f681e1cec7fd76e81d95/contracts/src/Dependencies/Constants.sol).

The complete official branch registry is:

| Branch | AddressesRegistry | TroveManager | PriceFeed | Collateral |
| --- | --- | --- | --- | --- |
| WETH | `0xbb6c6b994409b320e25e7de129e0db5da60ae89b` | `0x56698cd47d5194c2b7f947ac8370b3cb7359e709` | `0x8483efa691ce3f20edcc9f8453f85b64f9872fcb` | `0x82af49447d8a07e3bd95bd0d56f35241523fbab1` |
| wstETH | `0x5176fdd77fdef5b7f1edd457d02a8ec1cfebbb34` | `0xffd282a7184dbbe2e142156a08860f2be994fb98` | `0x2148affe49a44a15d6bc71a0a8f302d43cf99d52` | `0x5979d7b546e38e414f7e9822514be443a4800529` |
| rETH | `0x51253ae341f6dd1c4ff5692de0ee69492743895e` | `0x4895d30b7e18b67872a7542d9e876ce444244311` | `0x28d0931811b956366f86164d1c088fcbeb0711d5` | `0xec70dcb4a1efa46b8f2d97c310c9c4790ba5ffa8` |
| rsETH | `0xcbf5786902487c1165a98f48ebc65fa0e62739c6` | `0x8d7b268cc6d33b460428d8e938de26573596bc85` | `0x95e9327e6abf146570cd24402bdbcb56a9a5ba8a` | `0x4186bfc76e2e237523cbc30fd220fe055156b41f` |
| weETH | `0xc23928fd7d93ccb61ca60f09311de2dda66c02e4` | `0x76bb92e886d61da119ee8eb3fbcbc722da346550` | `0x39c2a023b8aed406671a0bed1b02fe548f0d2098` | `0x35751007a407ca6feffe80b3cb397736d2cf4dbe` |
| ARB | `0x7900b65266e157d9fce97e92ac3879cb712ded31` | `0xbdd4ab4128c414520b3669e155b7ecfb348af7f0` | `0xc2a8b601947beaf2efe650a39de3e3e0b5c95721` | `0x912ce59144191c1204e64559fe8253a0e49e6548` |
| COMP | `0xfe75add51a119e556acd53676b12f865a6737177` | `0xcfc1b1098d53951811210b6b88feb6a8572267fe` | `0x375bbb7cfc3b438d9d4a0f745569017f47eb55d8` | `0x354a6da3fcde098f8389cad84b0182725c6c91de` |
| tBTC | `0xf329fb0e818bd92395785a4f863636bc0d85e1df` | `0x285b3d3813d7a132d3f1ab48bb5a585e1363cdeb` | `0x993d4ed0ec1936bd86d765666dfb96bef6fdad10` | `0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40` |

A future inspector must verify those relationships and deployed bytecode at
startup rather than trusting addresses copied into configuration. It must read
branch-specific risk parameters through each `AddressesRegistry`; mainnet
Liquity constants are not authoritative for this fork.

### Permissionless entrypoint and exact caller reward

The entrypoint is
`batchLiquidateTroves(uint256[])`, selector `0xef49a6b4`. It is public and
permissionless. An empty array reverts `EmptyData`; a batch with no debt
decrease reverts `NothingToLiquidate`; and a branch can revert
`OnlyOneTroveLeft`. After a successful batch the manager emits `Liquidation`
and sends gas compensation to `msg.sender`:

- fixed compensation is `0.001 WETH` per liquidated trove;
- collateral compensation is 0.125% (`1 / 800`), subject to the protocol cap;
- WETH is transferred from the protocol gas pool and variable collateral from
  the active pool.

The caller supplies no Stability Pool deposit, debt token, approval, principal,
or transaction value. Rewards remain WETH and, when present, the branch
collateral in the caller account. Unwrapping or selling them is optional and
outside this lane.

### Complete event sample, competition, and economics

A topic-filtered scan of all eight managers found 42 `Liquidation` events in
40 successful transactions from 2025-09-25 through 2026-06-25: 15 WETH, two
wstETH, ten rETH, ten ARB, and five tBTC events. No success appeared for rsETH,
weETH, or COMP. Five senders won the sample with counts `15 / 10 / 10 / 4 / 1`;
25 wins called a manager directly and 15 routed through helper contracts. All
40 top-level transactions had zero value.

The most recent success was a helper-routed tBTC liquidation at block
477,214,808 on 2026-06-25:

- [transaction `0xa943…871c`](https://arbitrum.blockscout.com/tx/0xa943b8224459e00164d2ea2df1918363bff8d855e3683fb23485aca2d904871c)
- `790,494` gas and `0.000021148876476 ETH` receipt cost
- `0.001 WETH` fixed compensation and zero variable collateral compensation
- `0.000978851123524 ETH` fixed-only net before optional WETH withdrawal

The 40 successes paid `0.043 WETH` of fixed compensation and spent
`0.074282686571337 ETH` in gas. That lifetime fixed-only aggregate is negative
because five old winners paid extreme fees. Using the protocol event's
collateral price and a nearest-day ETH/USD price only as an indicative,
non-realized conversion, the sample produced approximately `$306.27` of reward,
`$276.92` of gas, and `$29.35` net; 35 transactions were positive and five
negative. The five losses ranged from about `-$0.81` to `-$108.24`. The two
largest burned about `0.03124 ETH` and `0.02998 ETH` of gas. A lane must impose
a hard reward-relative fee cap and must never copy those historical clearing
prices.

The recent regime was much better:

| Sample | Approx. reward | Approx. gas | Approx. net | Positive |
| --- | ---: | ---: | ---: | ---: |
| Most recent 30 successes | `$158.76` | `$12.26` | `$146.50` | 30 / 30 |
| Most recent 20 successes | `$96.27` | `$9.13` | `$87.14` | 20 / 20 |

These USD figures haircut neither liquidity nor exit cost and are not realized
keeper P&L. The all-40 indicative median net was about `$2.90`, with a range
from `-$108.24` to `+$45.65`.

Fully paginated internal traces for the latest ten successful transactions
showed no positive native-value transfer. For that bounded sample, the complete
observable ordering cost was the receipt's execution, L1 data, and priority
fee; no separate sequencer-beneficiary payment was found. This does not prove
that no older winner used an off-chain arrangement. Arbitrum's beneficiary was
the sequencer address, and this lane must not infer an Ethereum builder bid.

The same history contained 30 failed direct calls from 2025-10-10 through
2026-07-01, burning `0.003479717830511 ETH`: 22 decoded
`NothingToLiquidate`, one `EmptyData`, and seven were unclassified. One early
outlier accounted for `0.003221850519552 ETH`; the other 29 failures cost
`0.000257867310959 ETH` in aggregate, about `0.000008892 ETH` each. One tBTC
bot submitted 13 failed calls on 2026-05-16. Protocol-level stale protection
therefore prevents a false success but does not protect the caller's gas.

At pinned Arbitrum block 489,358,880, the eight managers exposed only 15 trove
ids: WETH 5, wstETH 1, rETH 3, rsETH 1, weETH 1, ARB 1, COMP 1, and tBTC 2.
Exact full-array simulation found no action. Six branches reverted
`NothingToLiquidate`; the one-trove ARB and COMP branches reverted
`OnlyOneTroveLeft`. No transaction was signed or submitted.

### Safe inspector and possible lane

The first artifact should be a chain-isolated, unsigned Arbitrum inspector:

1. Pin chain ID 42161 and one exact block from an Arbitrum WebSocket client.
   Verify the CollateralRegistry, every registry/manager/feed/collateral
   relationship, and expected deployed bytecode before inspecting candidates.
2. Enumerate the small current trove set, retain only active or zombie troves,
   read each branch's price and MCR/SCR parameters at the pinned block, and
   compute exact ICR and the one-trove invariant.
3. Build only the exact unhealthy IDs. Run `eth_call` and gas estimation from
   the eventual keeper EOA at the same block. Do not send a full-array
   speculative batch.
4. Price the fixed `0.001 WETH` per trove as the conservative floor. Ignore
   variable collateral for the send gate unless a provider trace or state-diff
   proves the exact token delta and it is valued with a liquidity haircut.
5. Record observed eligibility, competitor arrival, successful and stale
   receipts, fixed/variable token deltas, L1 and execution fees, and latency
   from the same chain-scoped worker. Use receipt and balance deltas for
   realized P&L.
6. If a live lane is later authorized, use an independent signer, gas balance,
   nonce/lease domain, RPC, and failure circuit breaker. Public Arbitrum
   sequencing and Timeboost are not Flashbots and must not inherit any
   Ethereum bid controller.

No guard helper is needed: the protocol already reverts a stale candidate.
That keeps the lane capital-free and approval-free, although failed races
still consume gas.

### Explicit go/no-go thresholds

**Inspector: go first. Live lane: no-go now.** There is no current eligible
trove, no live latency/share measurement, and no authorization to fund or
submit on Arbitrum.

Before proposing signing, require:

- at least three newly observed eligibility episodes and at least 30 labeled
  live competitor outcomes;
- exact simulated fixed-only net of at least the configured minimum or
  `0.00025 ETH`, whichever is greater;
- fixed reward at least 4x total maximum receipt cost, with the maximum fee
  budget capped at 25% of fixed WETH unless exact variable collateral is traced
  and conservatively valued;
- a lower-confidence expected value
  `p(win) * netWin - (1 - p(win)) * failedGas` of at least
  `0.0001 ETH` per attempt and an observed win probability of at least 10%;
- automatic disable after three consecutive stale reverts or when rolling
  failed-race gas exceeds 10% of realized gross reward.

The complete history is strong enough to justify the inspector, not a live
public sender. **This remains the first implementation choice** because the
candidate set is tiny, the existing Liquity V2 planner is reusable, stale
calls fail closed, and no helper, custody, approval, or principal is required.

## 2. PoolTogether V5 claims on Base, Optimism, and Arbitrum

### Canonical contracts, ABI, and runtime pins

PoolTogether's official
[Base](https://dev.pooltogether.com/protocol/deployments/base/),
[Optimism](https://dev.pooltogether.com/protocol/deployments/optimism/), and
[Arbitrum](https://dev.pooltogether.com/protocol/deployments/arbitrum/)
manifests identify the live contracts:

| Chain | PrizePool | Claimer | TwabController | Prize token |
| --- | --- | --- | --- | --- |
| Base | `0x45b2010d8a4f08b53c9fa7544c51dfd9733732cb` | `0xcdCE635b774DE77cdF791647601dba64a75547ba` | `0x7e63601F7e28C758Feccf8CDF02F6598694f44C6` | WETH `0x4200000000000000000000000000000000000006` |
| Optimism | `0xF35fE10ffd0a9672d0095c435fd8767A7fe29B55` | `0x220C9398b0Ee07472bF8906e44574Cb9FE3B8D90` | `0xCB0672dE558Ad8F122C0E081f0D35480aB3be167` | WETH `0x4200000000000000000000000000000000000006` |
| Arbitrum | `0x52e7910c4c287848c8828e8b17b8371f4ebc5d42` | `0xBEA38368f2A657f00f173764f18F00e841317c73` | `0x971ECc4E75c5FcFd8fc3eADc8F0c900b5914DC75` | WETH `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |

The reviewed ABI and behavior are pinned to Claimer commit
[`0ea6b676`](https://github.com/GenerationSoftware/pt-v5-claimer/blob/0ea6b676aec4e3ea5d6f7344e5a682b850e520a2/src/Claimer.sol)
and PrizePool commit
[`fedd70f3`](https://github.com/GenerationSoftware/pt-v5-prize-pool/blob/fedd70f3b62086895ee4f0f2224f941e4cdb89b0/src/PrizePool.sol).
The official
[claim-bot guide](https://dev.pooltogether.com/protocol/guides/bots/claiming-prizes/)
describes the intended permissionless workflow.

Pinned runtime calls verified that every Claimer's immutable `prizePool()`
matched the table. All three used a one-day draw period, a six-hour auction
time-to-maximum, and a 10% maximum fee portion. A future inspector should pin
these code hashes:

| Chain | PrizePool runtime hash | Claimer runtime hash |
| --- | --- | --- |
| Base | `0x431957ea10f05778f0be1c017a5569dd4d3a3222948b2535b8a22d2c5e8b4e53` | `0x735301cccf58dc61eef97f8986631537f030d3d615d137c6403b8e2ab69dccc7` |
| Optimism | `0xa217d20c0599f86dac553983952f92cf49b861f0581690ec39026f31802e46ee` | `0xef4415a842bec77d2e783a3f235272f144e4e2380c800c003bc551eb09bfb5d5` |
| Arbitrum | `0x5f40b1d568beab955e7e18ba6bacdb77383939e71ceaaac5afd19257f9c7adb1` | `0x47e6336b8271bc3769745105e7cd57c65bc8e38744940cc4f36b90340f8a6fe6` |

### Exact entrypoint, reward, and race behavior

`Claimer.claimPrizes(vault,tier,winners,prizeIndices,feeRecipient,minFeePerClaim)`
is nonpayable and permissionless. It needs no caller principal or token
approval. It computes one fee per claim, asks the vault to claim every
candidate, catches each individual revert, and returns
`feePerClaim * successfulClaimCount`.

That catch is the critical race hazard: `minFeePerClaim` protects the auction
price but not aggregate success. A competitor can consume every candidate and
leave the transaction successful with `totalFees == 0`. A head-state
simulation cannot eliminate this public-sequencer race.

Successful fees are not immediately transferred. `PrizePool.claimPrize`
credits `_rewards[feeRecipient]` in WETH accounting; only that recipient can
later call `PrizePool.withdrawRewards(to,amount)`. There is no approval or
principal requirement, but withdrawal gas must be amortized. Direct calls are
zero-value and the canonical Claimer has no direct-beneficiary or builder
payment path. Base and Optimism use public sequencers; Arbitrum uses public
sequencing/Timeboost. Their execution/L1/priority fees are not an Ethereum
builder bid.

### Current-draw transactions and economics

The pinned 2026-07-30 reconstruction decoded every `ClaimedPrize` event and
the full cost of each successful receipt:

| Chain / draw | Award transaction | Claims / successful transactions | Gross WETH fee | Full receipt cost | Claim-stage surplus |
| --- | --- | ---: | ---: | ---: | ---: |
| Base / 804 | `0x2b5e35c268b84e88105a2066733463fb0dc4d4882ac564da02c0cda9dc51eb29` | 1,373 / 65 | `0.003400054747418055` | `0.001233210558042408 ETH` | `0.002166844189375647 ETH` |
| Optimism / 832 | `0xde89ce99ee229fb6d6e1e0aff4b12e9d8defe16e6abb8abcb23839d717539e0c` | 1,184 / 49 | `0.000335033603623490` | `0.000058036202122545 ETH` | `0.000276997401500945 ETH` |
| Arbitrum / 790 | `0x2d342a99297e88e21ce0d7226032d4cca60d6ebfbf3db7ce1b8d6fdb16b33e21` | 6 / 1 | `0.000063096451875876` | `0.000012452873958000 ETH` | `0.000050643577917876 ETH` |

This provides 65 Base and 49 Optimism competitor transactions, satisfying the
requested 30–100 successful-transaction inspection for those chains.
Arbitrum had only one and remains especially under-sampled. The totals are
protocol-wide one-draw economics, not profit available to a new keeper, do not
include a later withdrawal, and do not mean every transaction was profitable.

OP-stack receipt cost includes L1 data. For example,
[Optimism transaction `0x8cfa…0538`](https://optimism.blockscout.com/tx/0x8cfa5897b7d0e5d9920035712a77e07323e6a354a776f20dd11eb5141ada0538)
paid `280,906,141,040 wei` of execution plus `1,454,815,737 wei` of L1 data,
while earning `286,427,355,856 wei`. It retained only `4,066,399,079 wei`
before withdrawal. This is why draw-level aggregate surplus cannot authorize
a transaction.

At the pinned head, draws 804/832/790 were not finalized, had claim counts
1,373/1,184/6 and 6/7/4 tiers, and shared a claim deadline of
2026-07-30 22:00 UTC. That proved only that the window was open. It did not
produce an authoritative, unclaimed, profitable account set. **No current
candidate is classified eligible** until local winner derivation plus current
`isWinner` and `wasClaimed` reads prove it.

### Stateless minimum-total-fee guard

Do not submit the raw Claimer entrypoint. A minimal immutable wrapper can
enforce the missing postcondition:

```solidity
uint256 totalFees = canonicalClaimer.claimPrizes(
    vault,
    tier,
    winners,
    prizeIndices,
    rewardEOA,
    minFeePerClaim
);
require(totalFees >= minTotalFees, "INSUFFICIENT_FEES");
```

The wrapper should pin the canonical Claimer/PrizePool and verify the vault's
`prizePool()` and `claimer()` relationships. Passing the keeper EOA directly
as `rewardEOA` means the wrapper never holds or forwards WETH. If the aggregate
floor is missed, the outer revert atomically rolls back every nested claim.
It converts a zero-reward success into a bounded stale revert, but it cannot
make the public race free.

Atomic claim-and-withdraw would require making the helper the reward recipient,
which would cross the project's custody/contract-deployment boundary and is
unnecessary. Let the EOA accumulate rewards and withdraw only when doing so is
economically amortized.

### Safe inspector and explicit thresholds

The read-only inspector should:

1. Verify chain ID, runtime hashes, Claimer/PrizePool/TwabController/prize-token
   relationships, and an allowlist of canonical vaults at startup.
2. Index active accounts and vaults from canonical events/TWAB state, recompute
   winners locally, then require `isWinner == true` and
   `wasClaimed == false` at one pinned head.
3. Rank each vault/tier batch using live `computeFeePerClaim`, exact guard
   simulation, signed calldata size, OP-stack L1 data fee, and amortized
   `withdrawRewards`. Never rank on claim count or draw aggregate alone.
4. Persist `ClaimedPrize`, `ClaimError`, successful-zero-reward calls, outer
   guard reverts, full sequencer/L1 fees, reward recipient, ledger balance, and
   later withdrawals.
5. Keep separate chain workers, signers, leases, gas balances, RPCs, and race
   statistics. Do not inherit any Ethereum builder bid.

**Inspector: go second. Guard deployment and live submission: no-go.** Before
dry-run promotion, reconstruct at least seven draws per chain, at least 30
successful transactions per chain, and all observable zero-reward/failed
races, including L1 and withdrawal costs. Arbitrum is far below that sample
today.

For every future candidate require:

- `minTotalFees` to cover the exact maximum success cost, amortized withdrawal,
  configured retained-profit floor, and a 2x reward-to-cost ratio;
- a conservative lower-confidence expected value
  `p(win) * (rewardFloor - successCost - amortizedWithdrawal)
  - (1 - p(win)) * staleRevertCost > 0`;
- multiple draws with positive transaction-level EV and explicit user
  authorization for public sequencer submission;
- withdrawal only when the accrued ledger reward is at least 10x its exact gas
  cost.

No generally available private atomic route was verified. PoolTogether remains
second because the reward flow is frequent and the guard is stateless, but its
winner-indexing surface, transaction-level margin, and withdrawal accounting
are materially more complex than Nerite's small, protocol-fail-closed trove
set.

## 3. Aesyx Liquity V2 liquidations on Avalanche

### Canonical contracts and exact payouts

Aesyx's official
[contract page](https://aesyx.gitbook.io/welcome-to-aesyx/resources/smart-contract-addresses)
lists the Avalanche sAVAX TroveManager at
`0x0eb600fe2e9eb27b757f31f73f81a87c53e56cd1` and BTC.b TroveManager at
`0xfcdf672475f2f259746572e3a82919f05f5227a7`. Both expose the same
permissionless Liquity V2 batch liquidation entry.

Routescan's direct-call address histories contained one successful sAVAX
liquidation and 12 failed calls, plus one successful BTC.b liquidation.
Contract-routed calls would require a separate event scan:

- [sAVAX transaction `0x7780…43aa`](https://routescan.io/tx/0x778024bc092c7907e46b22ff17b5360ec6e7d67c223c3d37c84d0b656efa43aa/network/mainnet/evm/43114):
  `56.326041777598417524 sAVAX` transferred to the caller against
  `0.021140888284669992 AVAX` gas. At the liquidation event's
  `$25.81214414` collateral price, the caller reward was about `$1,454`.
- [BTC.b transaction `0xba0a…aee2`](https://routescan.io/tx/0xba0a31fd18ad2da9c6d6d6101edc51b4ce611c445b05064dc93d9e933ac1aee2/network/mainnet/evm/43114):
  `0.00004362 BTC.b` transferred to the caller against
  `0.003002546919791232 AVAX` gas. The event priced BTC at `$76,707.85`,
  making the caller reward about `$3.35` before gas.

The 12 observed failed sAVAX calls burned `0.04312220855386907 AVAX`
combined. The successful reward still dwarfed the whole sampled race cost,
but the success occurred in October 2025 and the BTC.b success in February
2026. No newer successful liquidation appeared by this snapshot.

At pinned Avalanche block 91,613,748, sAVAX exposed one trove id and BTC.b
three. Exact full-array gas simulation reverted `NothingToLiquidate` for both
branches, proving there was no current action. No transaction was signed or
submitted.

**Verdict: positive but third priority.** Add both managers to the same
read-only Liquity-fork inspector as Nerite. Verify deployed bytecode/source
relationships, current trove counts and oracle semantics, then replay the
complete history with reward-token prices at each block. Avalanche submission
is public and no private path was verified, so historical profitability is
not authority to fund or run a signer.

## 4. Robinhood StonkPit collection

Robinhood's official
[chain overview](https://docs.robinhood.com/chain/) confirms strict
first-come-first-served sequencer ordering and ETH gas. Its
[connection guide](https://docs.robinhood.com/chain/connecting/) identifies
chain ID 4663 and warns that the public RPC is rate-limited and not intended
for production.

The permissionless target is
`StonkPitLocker.collect(address tipTo)` at
`0xDeb8d589251717e367d0f3E9dDE5D4dB63968B40`, not the user-supplied
`0xe934e36a439c94017b64a3fece66af12099abf50` collection token. It pays
`tipTo` 1% of collected native ETH. Because token-only collections can succeed,
raw execution has a successful-loss mode.

`npm run inspect:robinhood` was rerun at block 23,475,850. In the preceding
100,000 blocks, spanning 10,025 seconds, it found:

- 30 successful collections: 15 profitable and 15 unprofitable after gas
- `0.000317510029095417 ETH` gross tips
- `0.000121748509676 ETH` successful-call gas
- one failed race costing `0.00000316059749 ETH`
- `0.000192600921929417 ETH` net after all known gas, an unclaimed
  protocol-wide rate of about `0.00165992216 ETH/day`

One incumbent won 21 of the 30 calls and retained
`0.00016867380355997 ETH`, about 87.6% of the whole sampled net. This confirms
that the opportunity remains real but latency dominated.

**Verdict: keep behind Nerite, PoolTogether, and Aesyx.** The next artifact is
an immutable minimum-ETH guard specification plus a read-only observer using a
production-grade WebSocket/sequencer path. Measure notification-to-inclusion
latency, incumbent share, and expected profit including failed races. Public
submission and a dedicated Robinhood signer still require explicit
authorization.

## Mainnet appendix

## 5. Maker/Sky Liquidation 2.0

### Contract and call

- Ethereum `Dog`: [`0x135954d155898D42C90D2a57824C690e0c7BEf1B`](https://etherscan.io/address/0x135954d155898D42C90D2a57824C690e0c7BEf1B)
- Permissionless entry: `bark(bytes32 ilk, address urn, address kpr)`
- Per-ilk `Clipper`: `redo(uint256 id, address kpr)`
- Canonical behavior: [Liquidation 2.0 technical documentation](https://docs.makerdao.com/smart-contract-modules/dog-and-clipper-detailed-documentation),
  [Dog source](https://github.com/sky-ecosystem/dss/blob/master/src/dog.sol),
  and [Clipper source](https://github.com/sky-ecosystem/dss/blob/master/src/clip.sol)

`kpr` receives a fixed DAI `tip` plus a percentage `chip` of the auction tab.
The five sampled active collateral clippers all reported `tip = 250 DAI`,
`chip = 0.1%`, and `stopped = 0`:

- ETH-A: `0xc67963a226eddd77B91aD8c421630A1b0AdFF270`
- ETH-B: `0x71eb894330e8a4b96b8d6056962e7F116F50e06F`
- ETH-C: `0xc2b12567523e3f3CBd9931492b91fe65b240bc47`
- WSTETH-A: `0x49A33A28C4C7D9576ab28898F4C9ac7e52EA457A`
- WBTC-A: `0x0227b54AdbFAEec5f1eD1dFa11f54dcff9076e2C`

The incentive first lands as internal Vat DAI. Realization as ERC-20 DAI needs
a second canonical `DaiJoin.exit` transaction. That exit needs no token
approval or initial capital, but its gas and balance transition must be
accounted for explicitly.

### Cadence and recent competition

A `Bark` log scan over Ethereum blocks 23,646,656 through 25,646,656 found 88
liquidations. They were clustered rather than evenly distributed. The latest
in that sample was ETH-B at block 25,402,262:

- [transaction `0xf90d…8915`](https://etherscan.io/tx/0xf90d3823922867d66b67084556894e6e092813f2508e2b3dad9543b0acde8915)
- 177,447.328 DAI of reported `due`, 150.7138 ETH collateral, auction id 110
- 649,290 gas used
- 0.00122504858406018 ETH total gas cost, roughly $2.35 at the sampled ETH price
- position 0 in its block

The reward floor implied by that event is approximately 250 DAI plus 0.1% of
the auction tab. Even using `due` rather than the larger post-penalty auction
tab gives about 427 DAI gross. Exact simulation must read the actual tab.

Recent winners route through helper contracts, often at transaction index 0 or
1. The sampled transaction calls `Dog.bark` with the helper itself as `kpr`.
That is evidence of mature searchers and private ordering, not an uncontested
public gas race.

At the research snapshot, the five clippers above had no active auction ids.
The repository's existing `npm run inspect:maker-barks` scan was rerun at the
2026-07-30 handoff: it read 32,021 vault ids, found 839 active vaults across
eight configured ilks, and found zero unsafe vaults. This is an event-driven
lane, not a continuously callable crank.

### Infrastructure and implementation shape

- Reuse the existing Ethereum private relay and exact-prefix simulation stack.
- Build a durable urn/collateral index from canonical events; scanning every
  vault on the hot path is not viable.
- Pin ilk configuration, oracle state, urn state, `Hole`/`hole`, and clip
  capacity to the planning parent.
- Simulate `bark` with the keeper EOA as `kpr`, decode the Vat DAI increase,
  include the eventual `DaiJoin.exit` cost, and enforce a lane-specific bid.
- Treat `redo` separately. It has the same incentive formula but is eligible
  only when an auction price is stale enough and `needsRedo(id)` is true.
- Keep `take` and any collateral purchase out of scope: those require DAI
  inventory or a flash-loan/swap strategy.

**Verdict: extend the existing read-only inspector into a candidate indexer.**
This has the best observed gross-to-gas ratio and fits the current Ethereum
deployment, but it should not sign until internal-Vat-DAI exit accounting,
`redo` eligibility, and the inventory cache are tested against historical
barks.

## 6. Liquity V1 liquidations

### Contract and call

- Ethereum `TroveManager`:
  [`0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2`](https://etherscan.io/address/0xA39739EF8b0231DbFA0DcdA07d7e29faAbCf4bb2)
- Permissionless entries:
  `liquidate(address)`, `liquidateTroves(uint256)`, and
  `batchLiquidateTroves(address[])`
- Supporting `SortedTroves`:
  `0x8FdD3fbFEb32b28fb73555518f8b361bCeA741A6`
- Canonical addresses: [Liquity V1 resources](https://docs.liquity.org/liquity-v1/documentation/resources)
- Reward rule: [Liquity V1 liquidations](https://docs.liquity.org/liquity-v1/faq/stability-pool-and-liquidations)

Anyone may liquidate an eligible trove. Per liquidated trove, the caller
receives the 200 LUSD liquidation reserve plus 0.5% of its collateral.
No Stability Pool deposit, approval, or repayment capital is required.

### Cadence and recent competition

A `TroveLiquidated` scan over the same 2,000,000-block Ethereum window found
only three liquidations, at blocks 23,728,188, 23,729,818, and 24,279,024.
The latest was:

- [transaction `0xf0ff…aa42`](https://etherscan.io/tx/0xf0ff87d15ec6ef9c2d81a225fa2f20655ab52f47007ac37ef26344fc58d5aa42)
- 80,999.9999 LUSD debt and 30.3062735137 ETH collateral
- 589,339 gas and 0.00122770786 ETH total gas cost
- 0.15153136756855412 ETH plus 200 LUSD gross caller reward
- 0.060027905532346666 ETH paid directly to the block beneficiary
- 0.0915034661087624 ETH plus 200 LUSD retained by the winning route before
  the originating EOA's gas charge

The winner used a helper contract and a direct beneficiary payment. The event
is therefore lucrative but already competitively bundled.

At block 25,646,653, the lowest sorted trove had an approximately 441.65% ICR
at a sampled protocol price near $1,916/ETH, while system TCR was about
514.20%. There was no near-term liquidation candidate in the exact sampled
state.

### Infrastructure and implementation shape

- Reuse the existing Liquity V2 discovery/simulation components where the
  V1 data model permits, but keep addresses, recovery-mode rules, rewards, and
  bidding independent.
- Track the tail of `SortedTroves` and re-evaluate on oracle-price changes.
- Exact simulation must select the safest single/batch entry, decode both ETH
  and LUSD rewards, and account for direct builder payment.
- Private Ethereum submission is required; the sampled winner already used a
  helper and explicit beneficiary transfer.

**Verdict: retain the existing read-only inspector and add a low-overhead
monitor later, not a high-priority live build.** The payoff can be large, but
only three events appeared in roughly nine months of sampled blocks and
current collateralization is far from eligibility.

## Rejected and monitor-only screens

## 7. Equilibria Pendle Booster on Arbitrum

### Contract and call

- Arbitrum `PendleBooster` proxy:
  [`0x4D32C8Ff2fACC771eC7Efc70d6A8468bC30C26bF`](https://arbiscan.io/address/0x4D32C8Ff2fACC771eC7Efc70d6A8468bC30C26bF)
- Current sampled implementation: `0x73d705f524E71DD050EcF474D704fE4E7e1F57Ac`
- Permissionless entry: `earmarkRewards(uint256 pid)`
- Canonical deployment list:
  [Equilibria Arbitrum contracts](https://docs.equilibria.fi/integration/deployed-contracts/arbitrum)

The call harvests a Pendle market and emits `EarmarkIncentiveSent` for caller
incentives. The reward can span PENDLE and pool-specific external reward
tokens; this is materially more complex to value than a fixed-token bounty.

### Cadence and recent competition

Sampled successful call:

- [transaction `0xf5b4…edf8`](https://arbiscan.io/tx/0xf5b43e94c9b56824db604261a454eaf835c9a00d8c0c9b9c7f6a6ec90597edf8)
- block 431,732,416, pool id 28
- 1,094,658 gas
- 0.0000222719 ETH fee, roughly $0.04
- caller incentive transfers of approximately 0.19538175 PNP and
  0.00428468 PENDLE, also roughly $0.04 in the explorer snapshot

Recent calls were concentrated among a small set of repeat callers and arrived
in pool-specific bursts. The sampled execution was approximately break-even
before any ordering premium or operational overhead.

### Infrastructure and implementation shape

- Requires an Arbitrum RPC/WebSocket, chain-specific ETH balance, nonce lease,
  receipts, reorg policy, and sequencer-aware delivery; the Ethereum private
  relay implementation is not portable as-is.
- Discovery must enumerate active pools, every reward token, claimable amounts,
  and trusted price routes without caching a stale profitable job.
- Use a separate signer/process boundary or a chain-keyed lease. Never let an
  Arbitrum submission block the Ethereum head loop.

**Verdict: monitor only.** Build no signing lane until a read-only scan
demonstrates repeated opportunities with at least 2x gas-cost coverage after
conservative token haircuts.

## 8. Aura sidechain `earmarkRewards`

### Contract and call

- Base `BoosterLite`:
  [`0x98Ef32edd24e2c92525E59afc4475C1242a30184`](https://basescan.org/address/0x98Ef32edd24e2c92525E59afc4475C1242a30184)
- Payable permissionless entry:
  `earmarkRewards(uint256 pid, address zroPaymentAddress)`
- Canonical references:
  [Aura keeper FAQ](https://docs.aura.finance/developers/frequently-asked-questions)
  and [sidechain deployments](https://docs.aura.finance/developers/deployed-addresses/sidechain-deployment-addresses)

Aura documents that anyone may call `earmarkRewards` and receives the
configured `earmarkIncentive`. On sidechains, however, the call also pays for
cross-chain reward coordination.

### Cadence and sampled economics

Base sample:

- [transaction `0xf4ac…2eab`](https://basescan.org/tx/0xf4acf803bdedafd59073d5044bc1a55024f3582529af5494dd91ac5453022eab)
- block 45,554,110, pool id 28
- about 96.146663 BAL harvested
- about 0.096146663 BAL sent to the caller, exactly 0.1% of sampled BAL
- 395,259 gas and approximately 0.000003166 ETH transaction fee
- **0.001454486705008788 ETH transaction value** forwarded into the
  cross-chain coordination path, roughly $2.79 in the sampled explorer price

The caller reward was only around one cent while the required message value
was several dollars. Optimism samples showed the same structure: for example,
[transaction `0x8c82…`](https://optimistic.etherscan.io/tx/0x8c8282a8880c8e7e3ea678b110ada98985b6c272a822d97b833fff69beb035b3)
sent about 0.00085 ETH and only partially refunded it.

Calls appear every few weeks and are already handled by repeat addresses.

### Infrastructure and verdict

Each sidechain needs its own RPC, funded native balance, nonce coordination,
and cross-chain-message quote. A static gas-only profitability gate is
incorrect because `msg.value - refund` is the dominant cost.

**Verdict: reject sidechain execution under the current contracts.** Retain
the evidence as a reusable rule: every payable keeper must price consumed
message value, not merely gas. Aura mainnet has no sidechain-message cost and
could be screened separately, but it is not a cross-chain expansion.

## 9. Aerodrome weekly emissions crank

### Contract and call

- Base `Minter`:
  [`0xeB018363F0a9Af8f91F06FEe6613a751b2A33FE5`](https://basescan.org/address/0xeB018363F0a9Af8f91F06FEe6613a751b2A33FE5)
- Permissionless entry: `updatePeriod()`
- Canonical address: [Aerodrome security and deployments](https://aerodrome.finance/security)
- Canonical implementation: [Minter source](https://github.com/aerodrome-finance/contracts/blob/main/contracts/Minter.sol)

The source permits anyone to call after `activePeriod + 1 week`. It mints AERO,
sends team emissions to `team`, growth to `rewardsDistributor`, and emissions
to `voter`. `msg.sender` is recorded in the `Mint` event but receives no
transfer.

### Cadence and recent caller

The address history shows a stable weekly call shortly after Thursday
00:00 UTC by the same repeat address. A representative call:

- [transaction `0x8194…bda1`](https://basescan.org/tx/0x81944a08b2d8a2b3520bd6c414c956cd5da0009e174e1ea24849a3a3c893bda1)
- 23,576 gas
- approximately 0.0000005196 ETH total fee
- zero native value and no caller token reward

**Verdict: reject.** It is a textbook permissionless crank but not an income
opportunity. Cheap gas does not make a zero-reward call profitable.

## 10. Compound III `Comet.absorb`

### Contract and call

- Base USDC `Comet`:
  [`0xb125E6687d4313864e53df431d5425969c15Eb2F`](https://basescan.org/address/0xb125E6687d4313864e53df431d5425969c15Eb2F)
- Permissionless entry: `absorb(address absorber, address[] accounts)`
- Canonical references:
  [Compound III liquidation documentation](https://docs.compound.finance/liquidation/)
  and [Comet source](https://github.com/compound-finance/comet/blob/main/contracts/Comet.sol)

`absorb` takes underwater accounts into protocol reserves and increments
`liquidatorPoints[absorber]`, including `numAbsorbs`, `numAbsorbed`, and an
approximation of gas spent. The official documentation says these points
could be compensated by governance in the future. There is no current
contract-enforced token or native payment.

Compound's reference liquidator becomes economically interesting only by
following `absorb` with discounted `buyCollateral` and selling the collateral.
That path requires base-token capital or a flash loan, token transfers,
slippage controls, and swaps, placing it outside this bot's gas-only risk
boundary.

### Infrastructure and verdict

The same no-reward structure applies to Comet markets on Base and other EVM
deployments. Cheap L2 gas only reduces the uncompensated cost. A future
governance decision to make liquidator points redeemable would warrant
re-screening.

**Verdict: reject.** Do not spend gas to accumulate a speculative,
non-redeemable score and do not expand into inventory-backed collateral
arbitrage without explicit authorization.

## Additional explicit rejects

- **Beefy harvests on Base, Optimism, Arbitrum, Polygon, BNB, and
  Avalanche:** decoded caller transfers contradicted optimistic
  `callReward()` quotes. The sampled Base, Optimism, and Arbitrum receipts
  were net negative, and an unsigned BNB Anvil execution lost
  `0.000059719771471832 BNB`. A quote in raw reward-token units is not an
  eligibility proof.
- **Yield Yak reinvests on Avalanche:** none of the 30 highest quoted WAVAX
  candidates in the bounded registry slice covered exact gas. The best lost
  `0.000115138470803494 AVAX`, and `onlyEOA` prevents a fail-closed
  minimum-reward wrapper.
- **Wombex `voteExecute` on BNB:** Wombex's historical
  [bribe-market description](https://medium.com/wombex/a-deep-dive-into-the-wombex-bribe-market-94848d240625)
  documented a permissionless call and a 0.5% bribe-value executor incentive.
  The evidence is from 2023; the current canonical deployment documentation
  was unavailable and no recent execution was verified. Treat it as
  dormant/unverified, not a candidate.
- **Synthetix Perps V3 settlement on Base:** official
  [Perps V3 documentation](https://docs.synthetix.io/developer-docs/for-perp-integrators/perps-v3)
  documents settlement rewards to keepers, but this pass did not recover a
  current canonical Base deployment with recent externally capturable
  settlements. Do not implement from legacy Andromeda examples.
- **Polygon remainder:** the bounded Beefy registry had one active strategy
  and no positive native-denominated candidate. No other explicit
  principal-free caller reward survived canonical deployment and recent
  activity verification.

## Recommended next implementation order

1. Add one unsigned Liquity-fork inspector covering the eight canonical Nerite
   managers and two canonical Aesyx managers. Pin state, verify deployed
   relationships and bytecode, replay all liquidation receipts, decode fixed
   and collateral compensation, and report stale-race expected value by
   branch/caller.
2. Build the already-specified PoolTogether claim inspector and reconstruct at
   least seven draws on each chain before designing a guard.
3. Extend `inspect:robinhood` with durable read-only latency, incumbent-share,
   and expected-value observation. Specify the guard, but do not deploy it.
4. Continue the Maker active-urn/auction cache on Ethereum independently; it
   remains the strongest mainnet research lane.
5. Stop unless one cross-chain observer proves current repeatable surplus. Do
   not create general multi-chain signing infrastructure for rejected or
   merely historical candidates.

## Design implication for future cross-chain work

The correct expansion unit is a chain-isolated worker, not another provider
inside the Ethereum signer loop. A future profitable L2 lane should have:

- a separate chain id, RPC/WebSocket, funded native-gas budget, nonce domain,
  signer lease, and realized-P&L baseline;
- chain-specific delivery and ordering logic rather than Flashbots assumptions;
- reward-token valuation and consumed `msg.value` accounting;
- durable events tagged by chain id and canonical transaction hash;
- a deployment failure boundary that cannot stall or restart the Ethereum
  keeper.

That architecture should be built only after a candidate survives read-only
economics and current-state observation. Nerite and Aesyx justify inspectors,
not a signer deployment. The evidence does not justify operational cost for
Equilibria, Aura, Beefy, Yield Yak, Aerodrome, Compound III, Wombex, or the
unverified Synthetix surface.
