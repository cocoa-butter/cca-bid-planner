import { Q96 } from './constants.js';

/** floor(x * y / d). bigint has no 512-bit overflow, so this equals Solady fullMulDiv. */
export function mulDiv(x: bigint, y: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('division by zero');
  return (x * y) / d;
}

/** ceil(x * y / d), matching Solady fullMulDivUp for non-negative inputs. */
export function mulDivUp(x: bigint, y: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('division by zero');
  const p = x * y;
  const q = p / d;
  return p % d === 0n ? q : q + 1n;
}

export function saturatingSub(a: bigint, b: bigint): bigint {
  return a > b ? a - b : 0n;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * Currency needed at `priceQ96` to buy `tokens` (raw token units). Rounds up,
 * like DemandLib.requiredDemandAtPrice.
 */
export function requiredDemand(tokens: bigint, priceQ96: bigint): bigint {
  return mulDivUp(tokens, priceQ96, Q96);
}

/** Tokens (raw units) bought by `amount` of currency at `priceQ96`. Rounds down. */
export function tokensFor(amount: bigint, priceQ96: bigint): bigint {
  if (priceQ96 <= 0n) throw new RangeError('price must be positive');
  return mulDiv(amount, Q96, priceQ96);
}

/**
 * Price at which `demand` (currency committed over the remaining schedule) exactly
 * buys `remainingSupply` tokens. Rounds up, like DemandLib.toPriceCeiling.
 *
 * Note: this is sometimes described as "the highest p that still clears" with floor
 * division. Upstream rounds up and then floors the result at the last fully
 * consumed tick, so the full clearing rule lives in engine.ts.
 */
export function clearingAfter(demand: bigint, remainingSupply: bigint): bigint {
  if (remainingSupply <= 0n) throw new RangeError('remainingSupply must be positive');
  return mulDivUp(demand, Q96, remainingSupply);
}

/** Pro-rata share of a marginal tick, in Q96 (Q96 = 100%). */
export function share(bidAmount: bigint, demandAtTick: bigint): bigint {
  if (demandAtTick <= 0n) return 0n;
  return mulDiv(bidAmount, Q96, demandAtTick);
}
