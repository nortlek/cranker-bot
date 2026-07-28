# Pull Pool Keeper

A profit-aware Ethereum mainnet keeper for permissionless
`PullStandingOrder.crank()` calls. It discovers orders from the immutable factory
registry, simulates every candidate against current chain state, and only sends a
transaction when the configured keeper fee safely exceeds buffered gas cost.

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

1. Reads the factory's complete `allOrders()` registry.
2. Reads order fees in one multicall and considers higher-fee orders first.
3. Runs `eth_estimateGas` for `crank()` from the keeper account. Typed contract
   reverts are treated as ineligible orders.
4. Applies a gas-limit buffer and prices worst-case cost at the proposed
   EIP-1559 `maxFeePerGas`.
5. Requires both an absolute profit floor and a fee-relative profit floor.
6. In live mode, reads the account's `latest` and `pending` transaction counts
   and assigns an explicit contiguous nonce range.
7. By default, signs every crank locally, simulates the ordered transaction
   sequence, trims it before the first reverting nonce, and submits the valid
   prefix as an atomic private Flashbots bundle for the next block.
8. Watches that target block, then reports inclusion and realized profit. A
   bundle that misses its target expires instead of entering the public
   mempool.

Candidate gas estimates run with bounded concurrency and retain fee-ranked
ordering. The block loop polls every 250 ms by default, so slow per-order RPC
round trips no longer serialize the critical path.

There is no local state database. `lastRoundBought` and the pool's state are the
authoritative replay protection. A new batch starts only when the keeper
account has no existing pending nonce gap; after a restart, this prevents the
bot from duplicating transactions that are still in flight.

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
- `FLASHBOTS_RELAY_URLS`: comma-separated authenticated bundle relay endpoints.
  A bundle is submitted concurrently to every configured endpoint.
- `FLASHBOTS_BUILDERS`: registered builder names for relay multiplexing. The
  defaults cover several builders and can be replaced as the registry changes.
- `FLASHBOTS_AUTH_PRIVATE_KEY`: optional relay reputation key. It signs only
  relay authentication messages; when omitted, `PRIVATE_KEY` is used.
- `RELAY_TIMEOUT_MS`: timeout for relay simulation and submission calls.
- `MIN_PRIORITY_FEE_GWEI`: minimum builder tip. The configured tip floor is
  included in both the profitability check and signed transactions.
- `SIMULATION_CONCURRENCY`: maximum simultaneous per-order gas estimates.
- `BLOCK_POLL_MS`: new-head polling interval.

The private bundle contains nonce `N`, then `N+1`, and so on. Builders execute
it in that order and atomically: either the selected prefix succeeds as a
whole, or none of it lands. This avoids a nonce gap and prevents an
`AlreadyBought` loser from leaking into the public mempool. Set
`SUBMISSION_MODE=public` only if the configured relay is unavailable and you
accept revert-loss risk.

### Profit controls

- `MIN_PROFIT_ETH`: minimum worst-case profit per transaction.
- `MIN_PROFIT_BPS`: minimum profit as a fraction of the order's fee.
- `GAS_LIMIT_MULTIPLIER_BPS`: buffer applied to `eth_estimateGas`.
- `MAX_FEE_PER_GAS_GWEI`: hard ceiling for the proposed EIP-1559 max fee.
- `MAX_TRANSACTIONS_PER_PASS`: optional per-block transaction cap; `0` is
  unlimited.
- `RECEIPT_TIMEOUT_MS`: how long batch receipt monitoring waits before leaving
  unresolved transactions to pending-nonce reconciliation.

The default check uses:

```text
worstCaseProfit =
  crankFee - bufferedGasLimit * proposedMaxFeePerGas
```

and requires that value to clear both profit floors.

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
- **One-block expiry:** each private bundle targets exactly the next block. A
  missed bundle is resimulated and repriced on the next pass rather than left
  pending.
- **Ordered batch state changes:** the complete signed sequence is simulated
  in nonce order. The bot submits only the successful prefix before the first
  reverting transaction, because a reverting member invalidates an atomic
  bundle.
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
- **Subscription-only scope:** the bot cranks standing orders. It does not call
  the pool's separate `pull`, settlement, void, sweep, or claim functions.
- **Relay/RPC trust:** simulation and fee estimates are only as reliable as the
  configured RPC and relay. Use a dedicated RPC and configure the private
  relays/builders whose coverage you trust.
