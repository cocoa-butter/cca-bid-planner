/**
 * Bid schedule construction: split a budget across tick prices between the current
 * clearing price and the user's cap.
 */
import { nextTickAbove } from './price.js';

/**
 * How the budget is weighted across the ladder of prices.
 * - flat:   equal amount per price
 * - top:    more weight at higher prices (stay filled if demand is strong)
 * - bottom: more weight at lower prices (pay less if demand is weak)
 *
 * These are sometimes called "front-loaded" and "back-loaded". Here they refer to price,
 * not time: CCA already rewards bidding early, so every entry is placed at the same block.
 */
export type Weighting = 'flat' | 'top' | 'bottom';

export interface ScheduleEntry {
  /** Block to submit in. */
  block: bigint;
  /** Q96 max price, a multiple of tickSpacing, strictly above the clearing price. */
  maxPrice: bigint;
  /** Currency amount (raw units). */
  amount: bigint;
}

export interface BuildScheduleInput {
  /** Total currency to commit (raw units). */
  budget: bigint;
  /** Highest price the user will pay (Q96). Rounded down to a tick. */
  maxPrice: bigint;
  /** Clearing price at the submission block (Q96). */
  clearingPrice: bigint;
  tickSpacing: bigint;
  maxBidPrice: bigint;
  /** Block to submit in. */
  block: bigint;
  /** Maximum number of distinct prices. Default 5. */
  levels?: number;
  weighting?: Weighting;
}

export type BuildScheduleResult =
  | { ok: true; entries: ScheduleEntry[]; levels: number; weighting: Weighting }
  | { ok: false; reason: 'NoValidTicks' | 'ZeroBudget' | 'MaxPriceTooHigh'; message: string };

export function buildSchedule(input: BuildScheduleInput): BuildScheduleResult {
  const { budget, tickSpacing } = input;
  const weighting = input.weighting ?? 'flat';
  if (budget <= 0n) return { ok: false, reason: 'ZeroBudget', message: 'budget must be positive' };
  if (input.maxPrice > input.maxBidPrice) {
    return {
      ok: false,
      reason: 'MaxPriceTooHigh',
      message: 'max price exceeds the auction MAX_BID_PRICE',
    };
  }
  const lowest = nextTickAbove(input.clearingPrice, tickSpacing);
  const highest = (input.maxPrice / tickSpacing) * tickSpacing;
  if (highest < lowest) {
    return {
      ok: false,
      reason: 'NoValidTicks',
      message: 'no tick lies strictly above the clearing price and at or below the max price',
    };
  }
  const available = (highest - lowest) / tickSpacing + 1n;
  let levels = BigInt(Math.max(1, Math.floor(input.levels ?? 5)));
  if (levels > available) levels = available;
  if (levels > budget) levels = budget;
  const n = Number(levels);

  // Evenly spaced tick indices from lowest to highest, inclusive, de-duplicated.
  const prices: bigint[] = [];
  const steps = available - 1n;
  for (let i = 0; i < n; i++) {
    const idx = n === 1 ? steps : (steps * BigInt(i)) / BigInt(n - 1);
    const p = lowest + idx * tickSpacing;
    if (prices[prices.length - 1] !== p) prices.push(p);
  }

  const weights = prices.map((_, i) => {
    if (weighting === 'top') return BigInt(i + 1);
    if (weighting === 'bottom') return BigInt(prices.length - i);
    return 1n;
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0n);
  const amounts = weights.map((w) => (budget * w) / totalWeight);
  const assigned = amounts.reduce((a, b) => a + b, 0n);
  amounts[0] = (amounts[0] ?? 0n) + (budget - assigned);

  const entries: ScheduleEntry[] = [];
  prices.forEach((maxPrice, i) => {
    const amount = amounts[i] ?? 0n;
    if (amount > 0n) entries.push({ block: input.block, maxPrice, amount });
  });
  return { ok: true, entries, levels: entries.length, weighting };
}

/** Pick a weighting from forecast pressure: external demand vs demand needed to reach the cap. */
export function autoWeighting(forecastDemand: bigint, demandToReachCap: bigint): Weighting {
  if (demandToReachCap <= 0n) return 'flat';
  if (forecastDemand >= demandToReachCap) return 'top';
  if (forecastDemand * 2n < demandToReachCap) return 'bottom';
  return 'flat';
}
