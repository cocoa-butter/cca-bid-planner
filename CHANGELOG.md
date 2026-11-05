# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Website with the planner, documentation and a landing page.
- The planner loads auctions straight from a public RPC in the browser.

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
