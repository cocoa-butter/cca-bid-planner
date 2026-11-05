# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Website with the planner, documentation and a landing page.
- Auction discovery: browse live, upcoming and ended auctions per chain, using Uniswap's
  auction index, with no chain-history scans. CLI: `cca-bid-planner list --chain <name>`.
- Robinhood Chain (4663) support, alongside Ethereum, Base, Unichain and Arbitrum.
  `--chain <name>` picks a public RPC.
- Plain-language planner: auction cards with time left and progress toward the minimum
  raise, outcome cards for quiet, expected and busy demand, and raw values moved under
  "Advanced".

### Fixed

- The auction clock now follows upstream `BlockNumberish`. On Unichain the contract counts
  flashblocks, not `eth_blockNumber`, so plans there used the wrong block before.
- The minimum raise now comes from Uniswap's auction index instead of scanning factory logs.

## [0.1.0] - 2026-11-05

### Added

- Integer-exact TypeScript model of the CCA v2.1.0 checkpoint, clearing-price and fill
  accounting. A differential test checks it against the real contract.
- `inspect`, `plan`, `simulate`, `calldata` and `verify` commands, with `--json` output.
- Read-only RPC snapshot loader. It reads the supply schedule from SSTORE2, ticks through
  CCALens or by walking the tick list, and the minimum raise from factory logs.
- Bid ladders with flat, top or bottom weighting, and four default demand scenarios.
- Risk checks taken from the upstream integration guidelines.
- `submitBid` calldata with `prevTickPrice` hints.

[Unreleased]: https://github.com/cocoa-butter/cca-bid-planner/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/cocoa-butter/cca-bid-planner/releases/tag/v0.1.0
