import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Q96 } from '../src/core/constants.js';
import { plan } from '../src/core/plan.js';
import { buildSchedule } from '../src/core/schedule.js';
import { simulate } from '../src/core/simulate.js';
import { encodeSteps } from '../src/core/steps.js';
import {
  CAP_Q96,
  END,
  FLOOR_Q96,
  MIN_RAISE,
  START,
  slopSnapshot,
  TICK_SPACING,
} from './fixtures/slop.js';

const usdc = (n: number) => BigInt(n) * 10n ** 6n;
const snap = slopSnapshot();

const budgetArb = fc.bigInt({ min: 1n, max: usdc(2_000_000) });
const levelsArb = fc.integer({ min: 1, max: 12 });
const weightArb = fc.constantFrom('flat', 'top', 'bottom') as fc.Arbitrary<
  'flat' | 'top' | 'bottom'
>;
const capArb = fc.bigInt({ min: FLOOR_Q96 + TICK_SPACING, max: CAP_Q96 * 3n });

describe('schedule properties', () => {
  it('spends exactly the budget, only on ticks strictly above clearing and at or below the cap', () => {
    fc.assert(
      fc.property(budgetArb, levelsArb, weightArb, capArb, (budget, levels, weighting, cap) => {
        const r = buildSchedule({
          budget,
          maxPrice: cap,
          clearingPrice: FLOOR_Q96,
          tickSpacing: TICK_SPACING,
          maxBidPrice: snap.maxBidPrice,
          block: START,
          levels,
          weighting,
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const total = r.entries.reduce((s, e) => s + e.amount, 0n);
        expect(total).toBe(budget);
        for (const e of r.entries) {
          expect(e.amount).toBeGreaterThan(0n);
          expect(e.maxPrice).toBeGreaterThan(FLOOR_Q96);
          expect(e.maxPrice).toBeLessThanOrEqual(cap);
          expect(e.maxPrice % TICK_SPACING).toBe(0n);
          // floor + k * spacing (the floor is itself a tick multiple)
          expect((e.maxPrice - FLOOR_Q96) % TICK_SPACING).toBe(0n);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('simulation properties', () => {
  it('refund + spend == budget, and spend never exceeds budget', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: usdc(1), max: usdc(500_000) }),
        levelsArb,
        weightArb,
        fc.bigInt({ min: 0n, max: usdc(3_000_000) }),
        fc.constantFrom('early', 'flat', 'late') as fc.Arbitrary<'early' | 'flat' | 'late'>,
        (budget, levels, weighting, demand, arrival) => {
          const r = buildSchedule({
            budget,
            maxPrice: CAP_Q96,
            clearingPrice: FLOOR_Q96,
            tickSpacing: TICK_SPACING,
            maxBidPrice: snap.maxBidPrice,
            block: START,
            levels,
            weighting,
          });
          if (!r.ok) throw new Error(r.message);
          const sim = simulate(snap, r.entries, {
            name: 'p',
            totalDemand: demand,
            minPrice: FLOOR_Q96 + 1n,
            maxPrice: CAP_Q96 * 2n,
            arrival,
            bidCount: 12,
          });
          expect(sim.currencySpent + sim.currencyRefunded).toBe(budget);
          expect(sim.currencySpent).toBeLessThanOrEqual(budget);
          for (const st of sim.steps) {
            expect(st.rejected).toBeUndefined();
            if (st.outcome)
              expect(st.outcome.currencySpent + st.outcome.currencyRefunded).toBe(st.entry.amount);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it('unbounded demand above the cap at the start outbids the schedule: full refund', () => {
    // Correction to a common claim, "infinite demand fills fully at Pmax": demand above your cap
    // lifts clearing past every bid you placed, so you are outbid, not filled.
    fc.assert(
      fc.property(budgetArb, levelsArb, (budget, levels) => {
        const r = buildSchedule({
          budget,
          maxPrice: CAP_Q96,
          clearingPrice: FLOOR_Q96,
          tickSpacing: TICK_SPACING,
          maxBidPrice: snap.maxBidPrice,
          block: START,
          levels,
        });
        if (!r.ok) throw new Error(r.message);
        const sim = simulate(snap, r.entries, [
          {
            block: START,
            maxPrice: CAP_Q96 * 4n - ((CAP_Q96 * 4n) % TICK_SPACING),
            amount: usdc(10_000_000_000),
          },
        ]);
        expect(sim.finalClearingPrice).toBeGreaterThan(CAP_Q96);
        expect(sim.tokensFilled).toBe(0n);
        expect(sim.currencyRefunded).toBe(budget);
      }),
      { numRuns: 50 },
    );
  });

  it('unbounded demand exactly at the cap fills the schedule fully below the cap', () => {
    // What "infinite demand" can give you: clearing pinned at your cap, so every lower bid fills.
    const r = buildSchedule({
      budget: usdc(100_000),
      maxPrice: CAP_Q96,
      clearingPrice: FLOOR_Q96,
      tickSpacing: TICK_SPACING,
      maxBidPrice: snap.maxBidPrice,
      block: START,
      levels: 3,
    });
    if (!r.ok) throw new Error(r.message);
    const capTick = (CAP_Q96 / TICK_SPACING) * TICK_SPACING;
    const sim = simulate(snap, r.entries, [
      { block: START, maxPrice: capTick, amount: usdc(10_000_000_000) },
    ]);
    expect(sim.finalClearingPrice).toBe(capTick);
    const top = sim.steps.find((s) => s.entry.maxPrice === capTick);
    expect(top?.outcome?.status).toBe('partial');
    // Spend rounds up and tokens round down, so allow a 1e-6 relative rounding margin.
    expect(sim.averagePrice).toBeLessThanOrEqual(capTick + capTick / 1_000_000n);
  });

  it('zero external demand and a budget under the minimum raise: no graduation, full refund', () => {
    // Correction: "zero demand refunds fully" holds only when your own budget cannot graduate
    // the auction. Otherwise your bids graduate it and fill.
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: MIN_RAISE - 1n }), levelsArb, (budget, levels) => {
        const r = buildSchedule({
          budget,
          maxPrice: CAP_Q96,
          clearingPrice: FLOOR_Q96,
          tickSpacing: TICK_SPACING,
          maxBidPrice: snap.maxBidPrice,
          block: START,
          levels,
        });
        if (!r.ok) throw new Error(r.message);
        const sim = simulate(snap, r.entries, []);
        expect(sim.graduated).toBe(false);
        expect(sim.currencyRefunded).toBe(budget);
        expect(sim.tokensFilled).toBe(0n);
      }),
      { numRuns: 50 },
    );
  });

  it('zero external demand and a budget that graduates the auction: everything fills', () => {
    const budget = MIN_RAISE + usdc(1_000);
    const r = buildSchedule({
      budget,
      maxPrice: CAP_Q96,
      clearingPrice: FLOOR_Q96,
      tickSpacing: TICK_SPACING,
      maxBidPrice: snap.maxBidPrice,
      block: START,
      levels: 4,
    });
    if (!r.ok) throw new Error(r.message);
    const sim = simulate(snap, r.entries, []);
    expect(sim.graduated).toBe(true);
    expect(sim.currencyRefunded).toBe(0n);
    // About 401k USDC over 45M tokens clears right around the floor.
    expect(sim.averagePrice).toBeLessThan(FLOOR_Q96 + 2n * TICK_SPACING);
    expect((sim.averagePrice * 45_000_000n * 10n ** 18n) / Q96).toBeGreaterThan(0n);
  });
});

describe('edge cases', () => {
  it('single-block auction', () => {
    const s = slopSnapshot({
      endBlock: START + 1n,
      claimBlock: START + 1n,
      auctionStepsData: encodeSteps([{ mps: 10_000_000, blockDelta: 1 }]),
    });
    const r = plan(s, { budget: usdc(500_000), maxPrice: CAP_Q96, levels: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.block).toBe(START);
    const none = r.simulations.find((x) => x.scenario === 'none');
    // 500k USDC of demand for a 400k-at-floor supply in one block: the whole supply sells.
    expect(none?.graduated).toBe(true);
    expect(none?.currencySpent).toBeGreaterThanOrEqual(MIN_RAISE);
    expect((none?.currencySpent ?? 0n) + (none?.currencyRefunded ?? 0n)).toBe(usdc(500_000));
    expect(none?.tokensFilled).toBeLessThanOrEqual(s.totalSupply);
    expect((none?.tokensFilled ?? 0n) * 1000n).toBeGreaterThanOrEqual(s.totalSupply * 999n);
  });

  it('budget smaller than the number of levels uses fewer levels', () => {
    const r = buildSchedule({
      budget: 3n,
      maxPrice: CAP_Q96,
      clearingPrice: FLOOR_Q96,
      tickSpacing: TICK_SPACING,
      maxBidPrice: snap.maxBidPrice,
      block: START,
      levels: 10,
    });
    expect(r.ok && r.entries.length).toBe(3);
    expect(r.ok && r.entries.every((e) => e.amount === 1n)).toBe(true);
  });

  it('Pmax == Pc has no valid tick', () => {
    const r = buildSchedule({
      budget: usdc(10),
      maxPrice: FLOOR_Q96,
      clearingPrice: FLOOR_Q96,
      tickSpacing: TICK_SPACING,
      maxBidPrice: snap.maxBidPrice,
      block: START,
    });
    expect(r).toMatchObject({ ok: false, reason: 'NoValidTicks' });
  });

  it('plan refuses after the end block', () => {
    const r = plan(slopSnapshot({ blockNumber: END }), { budget: usdc(10), maxPrice: CAP_Q96 });
    expect(r).toMatchObject({ ok: false, reason: 'AuctionIsOver' });
  });
});
