import { describe, expect, it } from 'vitest';
import { MPS, maxBidPrice, Q96 } from '../src/core/constants.js';
import { AuctionEngine, AuctionError } from '../src/core/engine.js';
import { toPriceQ96 } from '../src/core/price.js';
import { stepsFrom } from '../src/core/steps.js';

const TS = 1_000_000n * 10n ** 18n;
const SPACING = toPriceQ96('0.00001', 18, 6); // 0.00001 USDC per 18-dp token, in Q96
const FLOOR = SPACING * 1000n; // ~0.01
const usdc = (n: bigint) => n * 10n ** 6n;

function engine(required = usdc(5_000n)) {
  return AuctionEngine.fresh({
    totalSupply: TS,
    floorPrice: FLOOR,
    tickSpacing: SPACING,
    startBlock: 100n,
    endBlock: 200n,
    requiredCurrencyRaised: required,
    maxBidPrice: maxBidPrice(TS),
    steps: stepsFrom([{ mps: 100_000, blockDelta: 100 }], 100n),
  });
}

describe('engine', () => {
  it('a lone bid above the floor fills in full at the floor price', () => {
    const e = engine(0n);
    const id = e.submitBid(100n, FLOOR + 10n * SPACING, usdc(1_000n));
    const o = e.settle(id);
    expect(o.status).toBe('full');
    expect(o.currencyRefunded).toBe(0n);
    expect(o.currencySpent).toBe(usdc(1_000n));
    // 1000 USDC at ~0.01 buys ~100k tokens (rounding down)
    const ideal = (usdc(1_000n) * Q96) / FLOOR;
    expect(o.tokensFilled).toBeLessThanOrEqual(ideal);
    expect(ideal - o.tokensFilled).toBeLessThan(10n ** 6n);
  });

  it('conserves currency and supply across full, partial and outbid bids', () => {
    const e = engine();
    const a = e.submitBid(100n, FLOOR + 500n * SPACING, usdc(8_000n), 'a');
    const b = e.submitBid(120n, FLOOR + 200n * SPACING, usdc(6_000n), 'b');
    const c = e.submitBid(150n, FLOOR + 800n * SPACING, usdc(10_000n), 'c');
    e.checkpoint(200n);
    const out = [a, b, c].map((id) => e.settle(id));
    for (const o of out) expect(o.currencySpent + o.currencyRefunded).toBe(o.amount);
    const spent = out.reduce((s, o) => s + o.currencySpent, 0n);
    const tokens = out.reduce((s, o) => s + o.tokensFilled, 0n);
    // Sum of spends can exceed currencyRaised only by per-bid round-up (<= 1 wei each).
    expect(spent - e.currencyRaised).toBeGreaterThanOrEqual(0n);
    expect(spent - e.currencyRaised).toBeLessThanOrEqual(3n);
    expect(tokens).toBeLessThanOrEqual(TS);
    expect(e.isGraduated).toBe(true);
  });

  it('an outbid bid fills while clearing was below its max, then refunds the rest', () => {
    // Correction to the brief: "below the clearing price fill nothing" is wrong. Outbid
    // bids keep what they bought before being outbid.
    const e = engine(0n);
    const low = e.submitBid(100n, FLOOR + 1n * SPACING, usdc(1_000n), 'low');
    // A large bid halfway through lifts clearing well above `low`.
    e.submitBid(150n, FLOOR + 900n * SPACING, usdc(50_000n), 'big');
    const o = e.settle(low);
    expect(o.status).toBe('outbid');
    expect(o.tokensFilled).toBeGreaterThan(0n);
    expect(o.currencyRefunded).toBeGreaterThan(0n);
    // It was live for half the schedule, so it spent about half.
    expect(o.currencySpent).toBeGreaterThan(usdc(490n));
    expect(o.currencySpent).toBeLessThan(usdc(510n));
  });

  it('a bid exactly at the final clearing price fills partially', () => {
    const e = engine(0n);
    const price = FLOOR + 100n * SPACING;
    // Demand far above what clears at `price` (about 1M tokens * 0.011 = 11k USDC).
    const id = e.submitBid(100n, price, usdc(30_000n));
    e.checkpoint(200n);
    expect(e.clearingPrice).toBe(price);
    const o = e.settle(id);
    expect(o.status).toBe('partial');
    expect(o.tokensFilled).toBeGreaterThan(0n);
    expect(o.currencyRefunded).toBeGreaterThan(0n);
  });

  it('refunds everything when the auction does not graduate', () => {
    const e = engine(usdc(1_000_000n));
    const id = e.submitBid(100n, FLOOR + SPACING, usdc(1_000n));
    const o = e.settle(id);
    expect(e.isGraduated).toBe(false);
    expect(o.status).toBe('refunded');
    expect(o.currencyRefunded).toBe(usdc(1_000n));
    expect(o.tokensFilled).toBe(0n);
  });

  it('mirrors submitBid reverts', () => {
    const e = engine();
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (err) {
        return (err as AuctionError).code;
      }
      return 'none';
    };
    expect(code(() => e.submitBid(99n, FLOOR + SPACING, 1n))).toBe('AuctionNotStarted');
    expect(code(() => e.submitBid(200n, FLOOR + SPACING, 1n))).toBe('AuctionIsOver');
    expect(code(() => e.submitBid(100n, FLOOR, 1n))).toBe('BidMustBeAboveClearingPrice');
    expect(code(() => e.submitBid(100n, FLOOR + SPACING + 1n, 1n))).toBe('TickPriceNotAtBoundary');
    expect(code(() => e.submitBid(100n, FLOOR + SPACING, 0n))).toBe('BidAmountTooSmall');
    expect(code(() => e.submitBid(100n, maxBidPrice(TS) + 1n, 1n))).toBe('InvalidBidPriceTooHigh');
    expect(AuctionError).toBeDefined();
  });

  it('a bid placed later is normalised over the remaining schedule', () => {
    const e = engine(0n);
    e.submitBid(150n, FLOOR + SPACING, usdc(500n));
    // Effective demand = amount * MPS / remaining MPS = 2x for a half-elapsed schedule.
    expect(e.sumCurrencyDemandAboveClearingQ96).toBe(((usdc(500n) << 96n) * MPS) / (MPS / 2n));
  });
});
