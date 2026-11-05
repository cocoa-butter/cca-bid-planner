import { describe, expect, it } from 'vitest';
import {
  LOWER_TOTAL_SUPPLY_THRESHOLD,
  MAX_V4_PRICE,
  maxBidPrice,
  Q96,
} from '../src/core/constants.js';
import { mulDivUp, requiredDemand, tokensFor } from '../src/core/math.js';
import { fromPriceQ96, fromRaw, parseDecimal, toPriceQ96, toRaw } from '../src/core/price.js';
import { CAP_Q96, FLOOR_Q96_EXACT, MIN_RAISE, SUPPLY } from './fixtures/slop.js';

describe('brief vectors', () => {
  it('Q96 round trip: 0.00889 USDC (6 dp) per 18-dp token', () => {
    // priceQ96 = 0.00889 * 2^96 * 10^(6-18) = 889 * 2^96 / 10^17.
    // The brief wrote 889n * 2n**96n / 10n**12n, which is 10^5 too large.
    const q = toPriceQ96('0.00889', 18, 6);
    expect(q).toBe((889n * 2n ** 96n) / 10n ** 17n);
    expect(q).not.toBe((889n * 2n ** 96n) / 10n ** 12n);
    expect(fromPriceQ96(q, 18, 6, 5)).toBe('0.00888'); // truncated: q was floored
    expect(fromPriceQ96(q + 1n, 18, 6, 5)).toBe('0.00889');
  });

  it('SLOP: a full sale at the floor raises at least the minimum', () => {
    // 45e6 * 0.00889 = 400,050 USDC, not exactly 400,000 as the brief said.
    expect(45_000_000 * 0.00889).toBeCloseTo(400_050, 6);
    const raised = mulDivUp(SUPPLY, FLOOR_Q96_EXACT, Q96);
    expect(raised).toBeGreaterThanOrEqual(MIN_RAISE);
    // Within 0.0125% of the minimum: the floor was clearly set from the min raise.
    expect((raised - MIN_RAISE) * 100_000n).toBeLessThanOrEqual(MIN_RAISE * 13n);
    expect(fromRaw(raised, 6, 0)).toBe('400050');
  });

  it('cap is above floor', () => {
    expect(CAP_Q96).toBeGreaterThan(FLOOR_Q96_EXACT);
  });
});

describe('maxBidPrice (MaxBidPriceLib)', () => {
  it('small supply caps at the v4 max price', () => {
    expect(maxBidPrice(1n)).toBe(MAX_V4_PRICE);
    expect(maxBidPrice(LOWER_TOTAL_SUPPLY_THRESHOLD)).toBe(MAX_V4_PRICE);
  });
  it('large supply: min((2^154/ts)^2, 2^222/ts)', () => {
    const ts = SUPPLY;
    const a = ((1n << 154n) / ts) ** 2n;
    const b = (1n << 222n) / ts;
    expect(maxBidPrice(ts)).toBe(a < b ? a : b);
  });
  it('1e30 supply gives roughly 2^110 (upstream docs round to 2^110)', () => {
    const p = maxBidPrice(10n ** 30n);
    expect(p).toBeGreaterThan(1n << 108n);
    expect(p).toBeLessThan(1n << 111n);
  });
});

describe('math', () => {
  it('requiredDemand rounds up, tokensFor rounds down', () => {
    expect(requiredDemand(3n, Q96 / 2n)).toBe(2n);
    expect(tokensFor(3n, 2n * Q96)).toBe(1n);
  });
  it('decimal parsing', () => {
    expect(parseDecimal('0.00889')).toEqual({ num: 889n, scale: 5 });
    expect(parseDecimal('1e3')).toEqual({ num: 1000n, scale: 0 });
    expect(toRaw('2500.5', 6)).toBe(2_500_500_000n);
    expect(fromRaw(2_500_500_000n, 6)).toBe('2500.5');
    expect(() => parseDecimal('-1')).toThrow();
  });
});
