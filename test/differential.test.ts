/**
 * Differential test: the TypeScript engine vs the real ContinuousClearingAuction.
 *
 * Opt-in (needs Foundry and an upstream checkout with submodules):
 *   CCA_UPSTREAM_DIR=/path/to/continuous-clearing-auction npx vitest run test/differential.test.ts
 *
 * Random cases are written as JSON, replayed by scripts/differential/Diff.t.sol inside the
 * upstream checkout with `forge test`, and every outcome is compared to the wei.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MPS, maxBidPrice } from '../src/core/constants.js';
import { AuctionEngine } from '../src/core/engine.js';
import { encodeSteps, stepsFrom } from '../src/core/steps.js';

const upstream = process.env.CCA_UPSTREAM_DIR;
const CASES = Number(process.env.CCA_DIFF_CASES ?? 40);

/** Small deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const big = (lo: bigint, hi: bigint) =>
    lo + (BigInt(Math.floor(next() * 2 ** 52)) * (hi - lo)) / 2n ** 52n;
  return { next, int, big };
}

interface Case {
  totalSupply: bigint;
  floorPrice: bigint;
  tickSpacing: bigint;
  startBlock: bigint;
  endBlock: bigint;
  requiredCurrencyRaised: bigint;
  stepRecords: Array<{ mps: number; blockDelta: number }>;
  blocks: bigint[];
  prices: bigint[];
  amounts: bigint[];
}

function genCase(seed: number): Case {
  const r = rng(seed);
  // Steps that sum exactly to MPS: split MPS into blocks with integer mps per block.
  const nSteps = r.int(1, 4);
  const stepRecords: Array<{ mps: number; blockDelta: number }> = [];
  let left = Number(MPS);
  for (let i = 0; i < nSteps; i++) {
    const last = i === nSteps - 1;
    if (last) {
      // choose a divisor of `left` as block delta
      const divisors = [1, 2, 4, 5, 8, 10, 16, 20, 25, 40, 50].filter((d) => left % d === 0);
      const d = divisors[r.int(0, divisors.length - 1)] ?? 1;
      stepRecords.push({ mps: left / d, blockDelta: d });
    } else {
      const delta = r.int(1, 30);
      const mps = r.int(1, Math.floor(left / 2 / delta));
      stepRecords.push({ mps, blockDelta: delta });
      left -= mps * delta;
    }
  }
  const duration = stepRecords.reduce((s, x) => s + x.blockDelta, 0);
  const startBlock = 1_000n;
  const endBlock = startBlock + BigInt(duration);
  const totalSupply = r.big(10n ** 18n, 10n ** 27n);
  const tickSpacing = r.big(2n ** 40n, 2n ** 80n);
  const floorPrice = tickSpacing * BigInt(r.int(2, 500));
  const nBids = r.int(1, 16);
  const blocks: bigint[] = [];
  for (let i = 0; i < nBids; i++) blocks.push(startBlock + BigInt(r.int(0, duration - 1)));
  blocks.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const prices = blocks.map(() => floorPrice + tickSpacing * BigInt(r.int(-2, 400)));
  // Size amounts against the value of the supply at the floor so clearing actually moves.
  const valueAtFloor = (totalSupply * floorPrice) >> 96n;
  const unit = valueAtFloor > 1000n ? valueAtFloor / 4n : 10n ** 15n;
  const amounts = blocks.map(() => 1n + r.big(0n, unit));
  const requiredCurrencyRaised = r.next() < 0.3 ? 0n : r.big(0n, valueAtFloor * 2n + 1n);
  return {
    totalSupply,
    floorPrice,
    tickSpacing,
    startBlock,
    endBlock,
    requiredCurrencyRaised: requiredCurrencyRaised >= 1n << 128n ? 0n : requiredCurrencyRaised,
    stepRecords,
    blocks,
    prices,
    amounts,
  };
}

function runEngine(c: Case) {
  const e = AuctionEngine.fresh({
    totalSupply: c.totalSupply,
    floorPrice: c.floorPrice,
    tickSpacing: c.tickSpacing,
    startBlock: c.startBlock,
    endBlock: c.endBlock,
    requiredCurrencyRaised: c.requiredCurrencyRaised,
    maxBidPrice: maxBidPrice(c.totalSupply),
    steps: stepsFrom(c.stepRecords, c.startBlock),
  });
  const ids: Array<number | undefined> = c.blocks.map((b, i) => {
    try {
      return e.submitBid(b, c.prices[i] as bigint, c.amounts[i] as bigint);
    } catch {
      return undefined;
    }
  });
  e.checkpoint(c.endBlock + 1n);
  return {
    finalClearingPrice: e.clearingPrice,
    currencyRaised: e.currencyRaised,
    graduated: e.isGraduated,
    accepted: ids.map((id) => (id === undefined ? 0n : 1n)),
    tokensFilled: ids.map((id) => (id === undefined ? 0n : e.settle(id).tokensFilled)),
    refunds: ids.map((id) => (id === undefined ? 0n : e.settle(id).currencyRefunded)),
  };
}

describe.skipIf(!upstream)('differential vs upstream contract', () => {
  it(`matches the contract to the wei on ${CASES} random cases`, { timeout: 600_000 }, () => {
    const root = upstream as string;
    const dir = join(root, '.forge-snapshots', 'diff');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    copyFileSync(
      new URL('../scripts/differential/Diff.t.sol', import.meta.url),
      join(root, 'test', 'Diff.t.sol'),
    );
    const cases = Array.from({ length: CASES }, (_, i) => genCase(i + 1));
    cases.forEach((c, i) => {
      const json = {
        totalSupply: c.totalSupply.toString(),
        floorPrice: c.floorPrice.toString(),
        tickSpacing: c.tickSpacing.toString(),
        startBlock: c.startBlock.toString(),
        endBlock: c.endBlock.toString(),
        requiredCurrencyRaised: c.requiredCurrencyRaised.toString(),
        steps: encodeSteps(c.stepRecords),
        blocks: c.blocks.map(String),
        prices: c.prices.map(String),
        amounts: c.amounts.map(String),
      };
      writeFileSync(join(dir, `case-${i}.json`), JSON.stringify(json));
    });
    execFileSync('forge', ['test', '--match-contract', 'DiffTest', '-q'], {
      cwd: root,
      env: { ...process.env, CCA_DIFF_IN: dir, CCA_DIFF_CASES: String(CASES) },
      stdio: 'pipe',
    });
    let accepted = 0;
    cases.forEach((c, i) => {
      const out = JSON.parse(readFileSync(join(dir, `out-${i}.json`), 'utf8'), (_k, v) =>
        typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v)) ? BigInt(v) : v,
      );
      const got = runEngine(c);
      const ctx = `case ${i}`;
      expect(got.accepted, ctx).toEqual(out.accepted);
      expect(got.finalClearingPrice, ctx).toBe(out.finalClearingPrice);
      expect(got.currencyRaised, ctx).toBe(out.currencyRaised);
      expect(got.graduated, ctx).toBe(out.graduated);
      expect(got.tokensFilled, ctx).toEqual(out.tokensFilled);
      expect(got.refunds, ctx).toEqual(out.refunds);
      accepted += got.accepted.filter((x) => x === 1n).length;
    });
    expect(accepted).toBeGreaterThan(CASES);
  });
});
