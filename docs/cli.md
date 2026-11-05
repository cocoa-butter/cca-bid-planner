# CLI reference

```sh
cca-bid-planner <command> [source] [options]
```

## Sources

Every command except `list` needs an auction, given one of three ways:

| Option                               | Meaning                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `--chain <name> --auction <address>` | Read live state from a supported chain's public RPC.                                        |
| `--auction <address> --rpc <url>`    | Read live state over your own RPC (read-only). `CCA_RPC_URL` is used if `--rpc` is missing. |
| `--snapshot <file>`                  | Use a snapshot saved by `inspect --save`.                                                   |

Supported chains: `ethereum`, `base`, `unichain`, `arbitrum` and `robinhood`. You can also
pass a chain id.

The minimum raise (`requiredCurrencyRaised`) has no view function on the contract. The tool
reads it from Uniswap's auction index. If the index doesn't know an auction, pass
`--required-raise <raw amount>`.

## list

```sh
cca-bid-planner list --chain robinhood        # live and upcoming
cca-bid-planner list --chain ethereum --all   # include ended auctions
```

Lists auctions from Uniswap's auction index with status, time left, current price and
progress toward the minimum raise. Status and time come from the chain's own block
clock, read live, so they stay right even when the index lags.

## inspect

Prints parameters, live state, the demand ladder above clearing and the risk checks.
`--save <file>` writes a snapshot for later use. `--block <n>` reads at a past block (needs
an archive RPC).

## plan

```sh
cca-bid-planner plan --snapshot a.json --budget 25000 --max-price 0.02 [options]
```

| Option                     | Default                  | Meaning                                                                           |
| -------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `--budget <amount>`        | required                 | Currency to commit, in whole units.                                               |
| `--max-price <price>`      | required                 | Highest price you will pay, in currency per token.                                |
| `--levels <n>`             | 5                        | Maximum number of price levels.                                                   |
| `--weighting <w>`          | auto                     | `flat`, `top` (more at higher prices), `bottom` (more at lower prices) or `auto`. |
| `--demand <amount>`        | demand to reach your cap | Assumed currency other bidders add from now on.                                   |
| `--demand-ceiling <price>` | 2 × cap                  | Highest price other bidders are assumed to pay.                                   |
| `--arrival <a>`            | flat                     | When that demand arrives: `early`, `flat` or `late`.                              |
| `--block <n>`              | next block               | Block you expect to submit in.                                                    |

`plan` simulates four scenarios. Other bidders add 0, ½X, X and 2X, where X is
`--demand`.

## simulate

Replays a schedule against one scenario. Pass bids with `--bid <price>:<amount>`
(repeatable) or `--schedule plan.json`. Use `--demand` and `--arrival` as in `plan`.

## calldata

Encodes `submitBid` calls for a schedule. `--owner <address>` is required. Pass
`--hook-data <hex>` if the auction has a validation hook. Calls come out in ascending price
order, so each `prevTickPriceQ96` hint is already initialized when that call lands.

For ERC20 currencies the auction pulls funds through Permit2. For native ETH each call
carries `value`.

## verify

Runs the risk checks only. Exits with code 3 if a critical check fails, which makes it
usable in scripts.

## Exit codes

| Code | Meaning                                           |
| ---- | ------------------------------------------------- |
| 0    | ok                                                |
| 1    | error (RPC, file, or a plan that cannot be built) |
| 2    | usage error                                       |
| 3    | `verify` found a critical issue                   |

## Full help

```
cca-bid-planner 0.1.0 - read-only bid planner for Uniswap CCA auctions

Usage
  cca-bid-planner <command> [source] [options]

Commands
  list       List auctions on a chain (live and upcoming first)
  inspect    Read parameters and live state, print a labelled risk report
  plan       Build a bid schedule for a budget and simulate it under demand scenarios
  simulate   Replay a given schedule against one demand scenario
  calldata   Emit submitBid calldata (with prevTickPrice hints) for a schedule
  verify     Run parameter sanity checks; exit code 3 if a critical check fails

Source (one of)
  --chain <name> --auction <address>  Read live state from a supported chain's public RPC
  --auction <address> --rpc <url>     Read live state over your own JSON-RPC (read-only)
  --snapshot <file>                   Use a saved snapshot (see inspect --save)

Chains: ethereum, base, unichain, arbitrum, robinhood (or a chain id)

Common options
  --block <n>             Read state at block n (RPC) / submit at block n (plan)
  --required-raise <raw>  Minimum raise in raw units, if Uniswap's index lacks the auction
  --all                   list: include ended auctions
  --json                  Machine-readable output
  -h, --help              Show help

plan options
  --budget <amount>       Currency to commit, in whole units (e.g. 2500 for 2,500 USDC)
  --max-price <price>     Highest price you will pay, currency per token (e.g. 0.015)
  --levels <n>            Max number of price levels (default 5)
  --weighting <w>         flat | top | bottom | auto (default auto)
  --demand <amount>       Assumed currency other bidders add from now on (default: what
                          lifts clearing to your cap). Scenarios use 0, 0.5x, 1x, 2x of it.
  --demand-ceiling <p>    Highest price other bidders are assumed to bid (default 2x cap)
  --arrival <a>           early | flat | late (default flat)

simulate / calldata options
  --bid <price>:<amount>  A schedule entry (repeatable), human units
  --schedule <file>       JSON from "plan --json" (uses its schedule)
  --owner <address>       Bid owner (calldata)
  --hook-data <hex>       hookData for validation hooks (calldata, default 0x)

Every figure is labelled [obs] observed on chain, [der] derived with protocol math, or
[asm] dependent on an assumption. The demand forecast is always an assumption.
This tool never holds keys and never sends transactions.

Exit codes: 0 ok, 1 error, 2 usage error, 3 verify found a critical issue.
Protocol: Uniswap/continuous-clearing-auction @ a56d422 (v2.1.0)

```
