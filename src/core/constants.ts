/**
 * Protocol constants, mirrored from Uniswap/continuous-clearing-auction v2.1.0
 * (src/libraries/ConstantsLib.sol, FixedPoint96.sol, MaxBidPriceLib.sol, TickStorage.sol).
 */

/** 2^96, the fixed-point base for prices and currency amounts. */
export const Q96 = 1n << 96n;

/** Milli-basis points: 1e7 = 100% of supply. 1000 MPS = 1 basis point. */
export const MPS = 10_000_000n;

/** Largest totalSupply an auction accepts (2^100 wei of token). */
export const MAX_TOTAL_SUPPLY = 1n << 100n;

/** Smallest floor price an auction accepts. */
export const MIN_FLOOR_PRICE = (1n << 32n) + 1n;

/** Smallest tick spacing an auction accepts. */
export const MIN_TICK_SPACING = 2n;

/** Sentinel for "no next tick" in the tick linked list (type(uint256).max). */
export const MAX_TICK_PTR = (1n << 256n) - 1n;

/** Uniswap v4 max price, the ceiling of MAX_BID_PRICE (type(uint160).max). */
export const MAX_V4_PRICE = (1n << 160n) - 1n;

/** Supplies at or below this get MAX_V4_PRICE as max bid price. */
export const LOWER_TOTAL_SUPPLY_THRESHOLD = 1n << 62n;

/** Upper bound on aggregate demand (type(uint256).max / 1e7). */
export const X7_UPPER_BOUND = MAX_TICK_PTR / MPS;

/** Canonical Permit2 address. ERC20 bids pull currency through Permit2. */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/**
 * MAX_BID_PRICE as computed by MaxBidPriceLib.maxBidPrice.
 *
 * Note: a commonly quoted form, `min(2**160, 2**310 / totalSupply**2)`, is not what
 * upstream computes. Upstream is:
 * - totalSupply <= 2^62  -> 2^160 - 1
 * - otherwise            -> min((2^154 / totalSupply)^2, 2^222 / totalSupply)
 * with integer division applied before squaring.
 */
export function maxBidPrice(totalSupply: bigint): bigint {
  if (totalSupply <= 0n) throw new RangeError('totalSupply must be positive');
  if (totalSupply <= LOWER_TOTAL_SUPPLY_THRESHOLD) return MAX_V4_PRICE;
  const liquidityBound = ((1n << 154n) / totalSupply) ** 2n;
  const currencyBound = (1n << 222n) / totalSupply;
  return liquidityBound < currencyBound ? liquidityBound : currencyBound;
}
