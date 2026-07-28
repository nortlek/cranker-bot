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
6. In live mode, broadcasts one transaction at a time and waits for its receipt
   before evaluating the next order.

There is no local state database. `lastRoundBought` and the pool's state are the
authoritative replay protection, so the keeper can restart safely.

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
```

Never use the subscriber/owner key. The bot only needs a gas-paying keeper key;
successful `crank` fees are sent to that keeper address.

### Profit controls

- `MIN_PROFIT_ETH`: minimum worst-case profit per transaction.
- `MIN_PROFIT_BPS`: minimum profit as a fraction of the order's fee.
- `GAS_LIMIT_MULTIPLIER_BPS`: buffer applied to `eth_estimateGas`.
- `MAX_FEE_PER_GAS_GWEI`: hard ceiling for the proposed EIP-1559 max fee.
- `MAX_TRANSACTIONS_PER_PASS`: optional per-block transaction cap; `0` is
  unlimited.

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

- **Public-mempool race:** another keeper can land first after this bot's
  simulation. The losing transaction can revert and still consume gas.
- **Mutable fee:** the order owner can change `crankFee` at any time, and
  `crank()` has no keeper-supplied minimum-fee argument. A fee change between
  simulation and inclusion cannot be made atomic by this bot.
- **Mutable funding:** the owner can withdraw the order balance at any time.
- **Registry scope:** the bot deliberately executes only orders returned by
  this factory. Set both factory and expected pool addresses when targeting a
  different deployment.
- **Subscription-only scope:** the bot cranks standing orders. It does not call
  the pool's separate `pull`, settlement, void, sweep, or claim functions.
- **RPC trust:** simulation and fee estimates are only as reliable as the
  configured RPC. A private transaction relay can reduce mempool races, but no
  relay-specific integration is included.
