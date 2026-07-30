# Cross-chain keeper research backlog

Snapshot: 2026-07-30 America/Denver

## Scope and decision rule

This is a research draft, not a production configuration. It deliberately
excludes the already-investigated PoolTogether V5 lanes on Base, Optimism, and
Arbitrum and the known Robinhood Chain crank around
`0xe934e36a439c94017b64a3fece66af12099abf50`. Beefy and Yield Yak are also
already covered in `OPPORTUNITIES.md` and are not repeated here.

A candidate qualifies for implementation only if an ordinary EOA can invoke
it, the caller receives a contract-enforced reward, the action requires only
native gas, and exact simulation can prove positive net economics. Calls that
need token approvals, inventory, swaps, deposits, flash loans, or custody of
user funds are rejected even when a wider arbitrage strategy could make them
profitable.

Historical amounts below are decoded on-chain amounts. USD values are rough
comparisons at the sampled block/explorer price, not realized P&L.

## Ranked result

| Rank | Candidate | Chain | Status | Why |
| ---: | --- | --- | --- | --- |
| 1 | Maker/Sky `Dog.bark` and `Clipper.redo` | Ethereum | Extend existing inspector | Large, explicit DAI keeper incentive; 88 barks in the sampled 2,000,000-block window |
| 2 | Liquity V1 liquidation | Ethereum | Keep existing inspector; add low-overhead monitor later | Explicit 200 LUSD + 0.5% collateral reward and one sampled win retained hundreds of dollars; events are rare |
| 3 | Equilibria `earmarkRewards` | Arbitrum | Monitor only | Permissionless token reward, but the sampled call was only approximately break-even and reward-token coverage is broad |
| 4 | Aura sidechain `earmarkRewards` | Base/Optimism | Reject live lane | The sampled 0.1% BAL caller reward was dwarfed by mandatory cross-chain messaging value |
| 5 | Aerodrome `Minter.updatePeriod` | Base | Reject | A real weekly permissionless crank, but the caller receives no reward |
| 6 | Compound III `Comet.absorb` | Base and other EVMs | Reject | Caller receives non-redeemable accounting points, not assets; profitable follow-on collateral purchase requires capital and swaps |

The strongest additional lane is Maker/Sky. This repository already has a
read-only `Dog.bark` inspector, so the remaining work is a durable
event-driven candidate cache, `Clipper.redo` coverage, and historically
replayed exact execution/accounting rather than another full-scan script. The
strongest genuinely cross-chain candidate is Equilibria on Arbitrum, but
current evidence does not justify live implementation.

## 1. Maker/Sky Liquidation 2.0

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

## 2. Liquity V1 liquidations

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

## 3. Equilibria Pendle Booster on Arbitrum

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

## 4. Aura sidechain `earmarkRewards`

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

## 5. Aerodrome weekly emissions crank

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

## 6. Compound III `Comet.absorb`

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

## Recommended next implementation order

1. Extend the existing Maker bark inspector with a durable active-urn cache,
   `Clipper.redo` eligibility, and exact historical replay of the last 20
   keeper actions. Do not add a second full-scan inspector.
2. Convert the existing Liquity V1 inspector into tail/price monitoring beside
   the V2 discovery, without enabling signing.
3. Run a one-week read-only Equilibria Arbitrum harvest study. Persist
   claimable caller tokens, gas, repeat caller, and counterfactual net for
   every active pool.
4. Stop there unless the study proves a repeatable surplus. Do not create
   general multi-chain signing infrastructure merely to support a
   break-even candidate.

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
economics. The evidence above does not yet justify its operational cost for
Equilibria, Aura, Aerodrome, or Compound III.
