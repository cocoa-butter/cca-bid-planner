# Library

The package exports the same functions the CLI and the planner page use.

```sh
npm install github:cocoa-butter/cca-bid-planner
```

```ts
import {
  clientFor,
  readSnapshot,
  inspect,
  plan,
  simulate,
  bidCalldata,
  toPriceQ96,
  toRaw,
} from 'cca-bid-planner';

const { snapshot, notes } = await readSnapshot(clientFor(rpcUrl), auctionAddress);

const report = inspect(snapshot); // labelled figures and risk checks

const result = plan(snapshot, {
  budget: toRaw('25000', snapshot.currency.decimals),
  maxPrice: toPriceQ96('0.02', snapshot.token.decimals, snapshot.currency.decimals),
  forecastDemand: toRaw('300000', snapshot.currency.decimals), // optional, an assumption
  arrival: 'late',
});

if (result.ok) {
  const { calls, prerequisites } = bidCalldata({
    auction: snapshot.auction,
    currency: snapshot.currency.address,
    owner: '0xYou',
    bids: result.schedule,
  });
}
```

## The pure core

`cca-bid-planner/core` has no network, file or DOM access, so it runs anywhere.

| Export                                             | Purpose                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| `AuctionEngine`                                    | Integer-exact model of the auction: `submitBid`, `checkpoint`, `settle`. |
| `plan`, `buildSchedule`, `simulate`                | Ladders and scenario replays.                                            |
| `inspect`, `verify`                                | Labelled report and risk checks.                                         |
| `toPriceQ96`, `formatPriceQ96`, `toRaw`, `fromRaw` | Unit conversions.                                                        |
| `snapshotToJson`, `snapshotFromJson`               | Snapshot (de)serialisation, with bigints as strings.                     |
| `maxBidPrice`, `Q96`, `MPS`                        | Protocol constants.                                                      |

Every on-chain quantity is a `bigint` in raw units. Prices are Q96, meaning raw currency
per raw token × 2^96.

## Running the engine directly

```ts
import { AuctionEngine, stepsFrom, maxBidPrice } from 'cca-bid-planner/core';

const engine = AuctionEngine.fresh({
  totalSupply,
  floorPrice,
  tickSpacing,
  startBlock,
  endBlock,
  requiredCurrencyRaised,
  maxBidPrice: maxBidPrice(totalSupply),
  steps: stepsFrom([{ mps: 10_000, blockDelta: 1_000 }], startBlock),
});
const id = engine.submitBid(startBlock, maxPrice, amount);
engine.checkpoint(endBlock);
engine.settle(id); // { status, tokensFilled, currencySpent, currencyRefunded }
```

The engine reverts with the contract's own error names, such as
`BidMustBeAboveClearingPrice` and `TickPriceNotAtBoundary`.
