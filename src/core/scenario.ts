/**
 * Demand scenarios: assumptions about what other bidders will do. A scenario becomes a
 * list of external bids that the simulator replays alongside the user's schedule.
 * Nothing here is a forecast; every scenario is an assumption the user owns.
 */
import { nextTickAbove } from './price.js';

export type Arrival = 'early' | 'flat' | 'late';

export interface DemandScenario {
  name: string;
  /** Total currency (raw units) other bidders commit over the rest of the auction. */
  totalDemand: bigint;
  /** Lowest max-price other bidders use (Q96). Values at or below clearing are lifted to the next tick. */
  minPrice: bigint;
  /** Highest max-price other bidders use (Q96). */
  maxPrice: bigint;
  /** When the demand arrives across the remaining blocks. */
  arrival: Arrival;
  /** Number of external bids to split the demand into. */
  bidCount: number;
}

export interface ExternalBid {
  block: bigint;
  maxPrice: bigint;
  amount: bigint;
}

/**
 * Spread a scenario into concrete bids. Prices are evenly spaced tick multiples in
 * [minPrice, maxPrice]; amounts are equal with the remainder on the first bid; blocks
 * follow the arrival profile between `fromBlock` and `endBlock - 1`.
 */
export function scenarioBids(
  scenario: DemandScenario,
  opts: { fromBlock: bigint; endBlock: bigint; tickSpacing: bigint; maxBidPrice: bigint },
): ExternalBid[] {
  const n = Math.max(0, Math.floor(scenario.bidCount));
  if (n === 0 || scenario.totalDemand <= 0n) return [];
  const lastBlock = opts.endBlock - 1n;
  if (lastBlock < opts.fromBlock) return [];
  const count = BigInt(n);
  if (scenario.totalDemand < count) {
    return scenarioBids({ ...scenario, bidCount: Number(scenario.totalDemand) }, opts);
  }
  const lo = nextTickAbove(scenario.minPrice - 1n, opts.tickSpacing);
  let hi = (scenario.maxPrice / opts.tickSpacing) * opts.tickSpacing;
  const cap = (opts.maxBidPrice / opts.tickSpacing) * opts.tickSpacing;
  if (hi > cap) hi = cap;
  if (hi < lo) hi = lo;
  const span = lastBlock - opts.fromBlock;
  const each = scenario.totalDemand / count;
  const rem = scenario.totalDemand - each * count;
  const tickSteps = (hi - lo) / opts.tickSpacing;
  // Interleave prices over time with a deterministic permutation, so high and low
  // bidders arrive throughout the window rather than in price order.
  const stride = coprimeStride(n);
  const out: ExternalBid[] = [];
  for (let i = 0; i < n; i++) {
    const p = (i * stride) % n;
    const frac = n === 1 ? 0 : p / (n - 1);
    const price = lo + BigInt(Math.round(frac * Number(tickSteps))) * opts.tickSpacing;
    const pos = arrivalPosition(scenario.arrival, (i + 0.5) / n);
    const block = opts.fromBlock + BigInt(Math.floor(pos * Number(span)));
    out.push({ block, maxPrice: price, amount: each + (i === 0 ? rem : 0n) });
  }
  return out;
}

function coprimeStride(n: number): number {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  let k = Math.max(1, Math.floor(n * 0.618));
  while (gcd(k, n) !== 1) k += 1;
  return k;
}

function arrivalPosition(arrival: Arrival, t: number): number {
  switch (arrival) {
    case 'early':
      return t * t;
    case 'late':
      return 1 - (1 - t) * (1 - t);
    default:
      return t;
  }
}
