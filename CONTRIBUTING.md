# Contributing

## Setup

Requires Node 22 or later.

```sh
npm ci
npm test
npm run build
```

## Before opening a pull request

- `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` must pass.
- Keep `src/core/` free of I/O. Network, file and DOM code belongs in `src/rpc/`,
  `src/cli/` and `src/ui/`.
- Use `bigint` for every on-chain quantity. No floating point in the core.
- Every figure shown to a user carries a label: `observed`, `derived` or `assumed`.
- Commits follow Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), one
  logical change each.

## Protocol changes

Protocol facts come from the pinned upstream commit, never from memory. To move the pin:

1. Check out the new upstream commit.
2. Run `npm run abi:extract -- /path/to/continuous-clearing-auction`.
3. Re-run the differential test against that checkout (see below) and update `docs/ABI.md`.

## Differential test

`test/differential.test.ts` replays random auctions on the real contract with Foundry and
compares every fill and refund to the TypeScript engine. It is skipped unless you point it
at an upstream checkout with submodules:

```sh
git clone --recurse-submodules --branch v2.1.0 \
  https://github.com/Uniswap/continuous-clearing-auction.git /tmp/cca
CCA_UPSTREAM_DIR=/tmp/cca CCA_DIFF_CASES=300 npx vitest run test/differential.test.ts
```

Open work is tracked in GitHub issues.
