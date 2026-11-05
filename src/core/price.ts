import { Q96 } from './constants.js';

/** Parse a non-negative decimal string ("0.00889", "12", "1e-3") into numerator / 10^scale. */
export function parseDecimal(input: string): { num: bigint; scale: number } {
  const s = input.trim();
  const m = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] === undefined || m[2] === ''))) {
    throw new SyntaxError(`not a non-negative decimal: "${input}"`);
  }
  const intPart = m[1] ?? '';
  const frac = m[2] ?? '';
  const exp = m[3] === undefined ? 0 : Number(m[3]);
  let num = BigInt(`${intPart}${frac}` || '0');
  let scale = frac.length - exp;
  if (scale < 0) {
    num *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { num, scale };
}

/**
 * Human price (currency per whole token) -> Q96 price in raw units.
 * priceQ96 = human * 2^96 * 10^(currencyDecimals - tokenDecimals), rounded down.
 */
export function toPriceQ96(human: string, tokenDecimals: number, currencyDecimals: number): bigint {
  const { num, scale } = parseDecimal(human);
  const numer = num * Q96 * 10n ** BigInt(currencyDecimals);
  const denom = 10n ** BigInt(scale + tokenDecimals);
  return numer / denom;
}

/** Q96 price -> human price string with `digits` fractional digits (truncated). */
export function fromPriceQ96(
  priceQ96: bigint,
  tokenDecimals: number,
  currencyDecimals: number,
  digits = 8,
): string {
  // human = priceQ96 * 10^(tokenDecimals - currencyDecimals) / 2^96
  const scaled = priceQ96 * 10n ** BigInt(tokenDecimals + digits);
  const v = scaled / (Q96 * 10n ** BigInt(currencyDecimals));
  return formatFixed(v, digits);
}

/** Decimal string -> raw integer amount with `decimals`, truncating extra precision. */
export function toRaw(human: string, decimals: number): bigint {
  const { num, scale } = parseDecimal(human);
  if (scale <= decimals) return num * 10n ** BigInt(decimals - scale);
  return num / 10n ** BigInt(scale - decimals);
}

/** Raw integer amount -> decimal string with `decimals`, trimming trailing zeros. */
export function fromRaw(raw: bigint, decimals: number, maxFraction = decimals): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0').slice(0, maxFraction);
  frac = frac.replace(/0+$/, '');
  const s = frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${s}` : s;
}

function formatFixed(v: bigint, digits: number): string {
  if (digits === 0) return v.toString();
  const s = v.toString().padStart(digits + 1, '0');
  const out = `${s.slice(0, -digits)}.${s.slice(-digits)}`.replace(/\.?0+$/, '');
  return out === '' ? '0' : out;
}

/** Round a Q96 price down to a multiple of tickSpacing. */
export function floorToTick(priceQ96: bigint, tickSpacing: bigint): bigint {
  return (priceQ96 / tickSpacing) * tickSpacing;
}

/** Smallest multiple of tickSpacing strictly greater than priceQ96. */
export function nextTickAbove(priceQ96: bigint, tickSpacing: bigint): bigint {
  return (priceQ96 / tickSpacing + 1n) * tickSpacing;
}
