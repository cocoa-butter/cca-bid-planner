# The math

Everything in `src/core/` is integer arithmetic on `bigint`, ported from
Uniswap/continuous-clearing-auction `v2.1.0` (`a56d422`). Rounding directions match the
contract. The engine is checked against the deployed bytecode by the differential test
(`test/differential.test.ts`): 300 random auctions and 2,405 bids, with every fill and
refund equal to the wei.

Worked examples use illustrative $SLOP figures (unverified): 18-decimal token, 6-decimal
USDC, floor 0.00889 USDC, supply 45,000,000. Those figures are **assumed**. They were not
read from a chain.

## Units

| Quantity | Unit                                                |
| -------- | --------------------------------------------------- |
| price    | Q96: raw currency per raw token × 2^96              |
| amount   | raw currency units (USDC: 1e-6)                     |
| tokens   | raw token units (1e-18)                             |
| issuance | MPS: 1e7 = 100% of supply, 1000 MPS = 1 basis point |

## Prices

```
priceQ96 = human × 2^96 × 10^(currencyDecimals − tokenDecimals)
```

0.00889 USDC per token → `889 × 2^96 / 10^17` = `704338364751809` (rounded down).

Tick prices are multiples of `tickSpacing`. The floor is itself a multiple, so "floor +
k·spacing" and "k·spacing" describe the same set.

## Tokens for currency, currency for tokens

```
tokensFor(amount, p)       = floor(amount × 2^96 / p)
requiredDemand(tokens, p)  = ceil(tokens × p / 2^96)
```

- 1,000 USDC at the floor buys `112,485.939…` tokens.
- Selling all 45M tokens at the floor raises `400,050` USDC.

## Supply schedule

`auctionStepsData` is a list of packed `bytes8` records. The high 24 bits are MPS per
block and the low 40 bits are the block count. The records must sum to exactly 1e7 MPS.

```
[5000 × 1000 blocks] [49500 × 100] [50000 × 1]
= 0x00138800000003e8 00c15c0000000064 00c3500000000001
```

## How demand is counted

A bid of `amount` placed after a fraction `m/1e7` of the schedule has already been sold
spends its amount evenly over the rest. Internally it counts as _effective_ demand:

```
effective = amount × 2^96 × 1e7 / (1e7 − m)
```

A late bid therefore weighs more per block than an early one of the same size, but it
buys nothing from blocks that have already passed.

## Clearing price

At each checkpoint the contract computes:

```
price = ceil( demandAbove × remainingMps × 2^96 / remainingSupplyQ96X7 )
```

`demandAbove` is the total effective demand at ticks strictly above the current clearing
price. Then it walks up the tick list. While the demand above clears the next tick, that
tick's demand drops out of `demandAbove` and the tick becomes the new lower bound. The
result is the higher of the computed price and the last tick it walked past. The clearing
price never decreases.

Example: if 600,000 USDC of demand sat above the floor at the start and the whole supply
remained, `clearingAfter(600k, 45M)` = 0.01333333 USDC.

`clearingAfter` in `math.ts` is that first formula on its own. The full rule, with the tick
walk, is `AuctionEngine.iterate`.

## Fills

| Bid max price vs final clearing | Result                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| above                           | Filled in full, pro-rata over every block it was live, at each block's clearing price. Spend = amount.                                                |
| equal                           | Fully filled while clearing was below it. At the clearing price it shares that tick's sales pro-rata with other bids there, and the rest is refunded. |
| below (outbid)                  | Filled while clearing was below its max price, then stops. The unspent part is refunded. It does **not** fill nothing.                                |
| auction not graduated           | Full refund. No tokens.                                                                                                                               |

Tokens from fully filled periods are `amount × Δ(Σ mps/price) / (2^192 × remainingMps)`.
That sum is `cumulativeMpsPerPrice` in the checkpoints.

Spend rounds up and tokens round down, per bid, so totals can differ from
`currencyRaised` by one wei per bid. The refund is `amount − spend`, so
`spend + refund == amount` holds exactly.

## Max bid price

```
totalSupply ≤ 2^62:  2^160 − 1
otherwise:           min( (2^154 / totalSupply)^2 , 2^222 / totalSupply )
```

The division happens before squaring. 45M × 1e18 gives `149777481484170221081483417150109059297984`.

## Planning

1. Checkpoint the snapshot forward to the submission block to get the clearing price `Pc`.
2. Pick up to `levels` tick prices, evenly spaced from the first tick above `Pc` to the
   tick at or below your cap.
3. Split the budget:
   - flat: equal per level
   - top: weights 1..n, rising with price
   - bottom: weights n..1, falling with price
     Integer division leaves a remainder, which goes on the lowest price, so the amounts sum
     to the budget exactly.
4. `auto` weighting compares your assumed external demand with the demand needed to lift
   clearing to your cap (`demandToReach`):
   - forecast ≥ that demand → top
   - forecast < half of it → bottom
   - otherwise → flat
5. Each `prevTickPriceQ96` hint is the highest tick known to be initialized below the
   bid, with earlier bids in the schedule counted.

## Scenarios

A scenario is an assumption: other bidders add `X` currency from your submission block to
the end. Their bids are spread evenly across tick prices from just above clearing up to a
ceiling (default 2× your cap). Arrival can be early, flat or late. A scenario bid that
would revert, because it is at or below clearing when it lands, is dropped and counted as
`externalRejected`. Default scenarios are 0, ½X, X and 2X, where X defaults to
`demandToReach(cap)`.

## Corrections to common misreadings

These came up while specifying the tool. The code follows the contract, not these
misreadings.

- **Q96 test vector.** 0.00889 with 6/18 decimals is `889·2^96/10^17`, not `/10^12`.
- **$SLOP floor vs minimum raise.** 45M × 0.00889 = 400,050, not exactly 400,000. The
  checked invariant is that a full sale at the floor raises _at least_ the minimum.
- **MAX_BID_PRICE** is not `min(2^160, 2^310/ts^2)`. See the formula above.
- **Outbid bids** keep the tokens they bought before being outbid.
- **"Infinite demand fills fully at Pmax"** is wrong. Demand above your cap outbids you
  and you get a full refund. Demand pinned _at_ your cap fills your lower bids in full
  and your top bid partially.
- **"Zero demand refunds fully"** holds only if your own budget cannot graduate the
  auction. Otherwise your bids graduate it and fill near the floor.
- **Exits.**
  - `exitBid` always waits for the end block.
  - `exitPartiallyFilledBid` with a non-zero `outbidBlock` can exit an outbid bid
    early, once the auction has graduated.
  - A bid sitting at the final clearing price must wait for the end.
- **Pinned commit.** `7d7602d` is not on `main` and is not `v2.1.0`. The tag is
  `a56d422`. The contract source is identical in both, and in the deployed `v2.0.0` factory.
