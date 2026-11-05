# ABI provenance

|                |                                                                       |
| -------------- | --------------------------------------------------------------------- |
| Upstream       | https://github.com/Uniswap/continuous-clearing-auction                |
| Pinned commit  | `a56d42231e7bf048136d9d88fa61e8518c10c5ff` (tag `v2.1.0`, 2026-07-10) |
| Generated file | `src/abi/cca.ts` (exports `UPSTREAM_COMMIT`)                          |
| Checked on     | 2026-11-05                                                            |

## Why this commit

- `v2.1.0` is the latest release tag.
- `src/` is byte-identical at all of these commits:
  - `v2.1.0` (`a56d422`)
  - current `main` (`ce78b4d`, 2026-10-22)
  - the commit behind the deployed v2.0.0 factory (`aee9bca`)
  - a branch commit, `7d7602d`, that is sometimes quoted for v2.1.0 but is not on `main`

  So one ABI and one arithmetic model cover every deployed v2 auction.
- Canonical addresses from the upstream README:
  - ContinuousClearingAuctionFactory v2.0.0: `0x00cCa200BF124dBfA848937c553864f4B4CE0632`.
    Code is present on Ethereum, Base, Unichain and Arbitrum One.
  - CCALens v2.0.0: `0xc3C65F5453A3674aDb693cbdA3C842545cD30f53`

## How it was extracted

`scripts/extract-abi.mjs` reads Solidity source only. It does not run a compiler.

1. Strip comments from `src/interfaces/{IContinuousClearingAuction,IAuctionStorage,IBidStorage,ICheckpointStorage,IStepStorage,ITickStorage}.sol`
   and `src/lens/TickDataLens.sol`.
2. Collect every `function`, `event` and `error` declaration, and the structs
   `Checkpoint`, `Bid`, `AuctionStep`, `Tick` and `TickWithData`.
3. Resolve user-defined types: `ValueX7 → uint256`, `IValidationHook → address`,
   `IContinuousClearingAuction → address`.
4. Add `MAX_BID_PRICE()`, a public immutable on the implementation that no interface
   declares.
5. Validate with viem's `parseAbi` and write `src/abi/cca.ts`.

Reproduce:

```sh
git clone https://github.com/Uniswap/continuous-clearing-auction.git /tmp/cca
git -C /tmp/cca checkout a56d42231e7bf048136d9d88fa61e8518c10c5ff
npm run abi:extract -- /tmp/cca
git diff --exit-code src/abi/cca.ts
```

## Values with no view function

| Value                    | How the tool gets it                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auctionStepsData`       | Runtime code of the SSTORE2 contract at `pointer()`, minus its leading `0x00` byte                                                                                   |
| `requiredCurrencyRaised` | `configData` of the factory's `AuctionCreated` event, decoded as `AuctionParameters`. Pass `--required-raise` if logs are unavailable.                               |
| tokens received          | Simulating `checkpoint()` with `eth_call`. A `TokensNotReceived` revert means no. Before the start block it falls back to `token.balanceOf(auction) >= totalSupply`. |

State views reflect the **last checkpoint**, which may be stale. The tool simulates
`checkpoint()` at the read block (`eth_call`, nothing sent). Its own engine then
checkpoints forward from the stored state, and `inspect` reports any disagreement.
