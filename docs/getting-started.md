# Getting started

cca-bid-planner plans bids for Uniswap Continuous Clearing Auctions (CCA). It reads an
auction, ladders a budget across prices, and simulates the result under demand
scenarios you choose. It is read-only: it never asks for keys and never sends a
transaction.

## Use it in the browser

Open the [planner](/app):

1. **Pick a network.** Robinhood Chain, Ethereum, Base, Unichain or Arbitrum.
2. **Pick an auction.** You see the live and upcoming ones, with time left and how close
   each is to its minimum raise.
3. **Say how much you want to spend and the most you'd pay per token.**

The page shows what you'd likely get, and what happens if the auction is quiet or busy.

The list comes from Uniswap's auction index. Auction state is read straight from the chain
in your browser. The page can't move your money.

Every auction has its own link, `/app?chain=robinhood&auction=0x...`, so you can share it.

## Use it from the terminal

Requires Node 22 or later.

```sh
# run without installing
npx github:cocoa-butter/cca-bid-planner --help

# or install the command
npm install -g github:cocoa-butter/cca-bid-planner
```

A typical session:

```sh
# 0. Find an auction
cca-bid-planner list --chain robinhood

# 1. Read the auction and check it for known risks; keep a snapshot
cca-bid-planner inspect --chain robinhood --auction 0x... --save auction.json

# 2. Ladder 25,000 USDC up to 0.02 USDC per token, under the default scenarios
cca-bid-planner plan --snapshot auction.json --budget 25000 --max-price 0.02

# 3. Try your own demand assumption
cca-bid-planner plan --snapshot auction.json --budget 25000 --max-price 0.02 \
  --demand 300000 --arrival late --weighting top

# 4. Get calldata for the schedule (you sign and send it yourself)
cca-bid-planner plan --snapshot auction.json --budget 25000 --max-price 0.02 --json > plan.json
cca-bid-planner calldata --snapshot auction.json --schedule plan.json --owner 0xYou
```

See the [CLI reference](/docs/cli) for every option.

## Reading the output

Every figure carries a label:

| Label            | Meaning                                                         |
| ---------------- | --------------------------------------------------------------- |
| `[obs]` observed | Read from the chain or the snapshot, unchanged.                 |
| `[der]` derived  | Computed from observed values with the protocol's own math.     |
| `[asm]` assumed  | Depends on an assumption you made, usually the demand forecast. |

A bid ends one of four ways:

| Outcome  | When                                             | What you get                                                               |
| -------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| full     | your max price is above the final clearing price | tokens for your whole amount, bought block by block at each clearing price |
| partial  | your max price equals the final clearing price   | a pro-rata share at that price, and the rest refunded                      |
| outbid   | clearing rises past your max price               | what you bought before that point, and the rest refunded                   |
| refunded | the auction does not reach its minimum raise     | everything back, no tokens                                                 |

## What it cannot tell you

- **Demand is an assumption.** Every expected fill depends on it. This is a scenario
  calculator, not a price oracle.
- **Auctions can fail.** Below the minimum raise, everyone is refunded.
- **Exits wait.**
  - Nothing exits before graduation.
  - Filled bids, and bids at the final price, exit after the end block.
  - Outbid bids can exit early once the auction has graduated.
- **Clearing can move** between planning and inclusion. A bid at or below clearing when it
  lands reverts.
- **Not checkable from the auction contract:**
  - honeypot or fee-on-transfer tokens
  - the pool's position recipient
  - whether the floor price is fair

See [bidder risks](/docs/risks).
