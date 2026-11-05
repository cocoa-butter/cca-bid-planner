/**
 * The planner: schedule + scenario simulations + a labelled summary.
 */
import { MPS, Q96 } from './constants.js';
import { assumed, derived, type Figure } from './label.js';
import { requiredDemand, saturatingSub } from './math.js';
import type { Arrival, DemandScenario } from './scenario.js';
import { autoWeighting, buildSchedule, type ScheduleEntry, type Weighting } from './schedule.js';
import { type SimulationResult, simulate } from './simulate.js';
import { type AuctionSnapshot, engineFromSnapshot } from './snapshot.js';

export interface PlanInput {
  /** Currency to commit (raw units). */
  budget: bigint;
  /** Price cap (Q96). */
  maxPrice: bigint;
  /** Submission block. Default: max(snapshot block + 1, start block). */
  block?: bigint;
  /** Max number of price levels. Default 5. */
  levels?: number;
  /** Ladder weighting. 'auto' picks from the forecast. Default 'auto'. */
  weighting?: Weighting | 'auto';
  /**
   * Assumed currency (raw units) other bidders commit from now to the end. Default: the
   * extra demand that would lift clearing to your cap. Always an assumption.
   */
  forecastDemand?: bigint;
  /** Highest price other bidders are assumed to bid (Q96). Default: 2 x maxPrice. */
  demandCeiling?: bigint;
  arrival?: Arrival;
  /** Override the scenario set entirely. */
  scenarios?: DemandScenario[];
}

export interface PlannedBid extends ScheduleEntry {
  /** Valid prevTickPriceQ96 hint: highest tick known to be initialized below maxPrice. */
  prevTickPrice: bigint;
}

export interface PlanResult {
  ok: true;
  block: bigint;
  clearingAtBlock: bigint;
  weighting: Weighting;
  schedule: PlannedBid[];
  scenarios: DemandScenario[];
  simulations: SimulationResult[];
  figures: Figure<bigint>[];
  warnings: string[];
}

export type PlanOutcome = PlanResult | { ok: false; reason: string; message: string };

/** Currency (raw) other bidders would need to add now to lift clearing to `price`. */
export function demandToReach(snapshot: AuctionSnapshot, block: bigint, price: bigint): bigint {
  const engine = engineFromSnapshot(snapshot);
  const cp = engine.checkpoint(block);
  const remainingMps = MPS - cp.cumulativeMps;
  if (remainingMps === 0n) return 0n;
  const remainingTokens = engine.remainingSupplyQ96X7 / (Q96 * MPS);
  const needed = requiredDemand(remainingTokens, price);
  const existing = (engine.sumCurrencyDemandAboveClearingQ96 * remainingMps) / MPS / Q96;
  return saturatingSub(needed, existing);
}

export function defaultScenarios(
  base: bigint,
  clearing: bigint,
  ceiling: bigint,
  arrival: Arrival,
): DemandScenario[] {
  const mk = (name: string, totalDemand: bigint): DemandScenario => ({
    name,
    totalDemand,
    minPrice: clearing + 1n,
    maxPrice: ceiling,
    arrival,
    bidCount: 40,
  });
  return [mk('none', 0n), mk('low', base / 2n), mk('base', base), mk('high', base * 2n)];
}

export function plan(snapshot: AuctionSnapshot, input: PlanInput): PlanOutcome {
  const block =
    input.block ??
    (snapshot.blockNumber + 1n > snapshot.startBlock
      ? snapshot.blockNumber + 1n
      : snapshot.startBlock);
  if (block >= snapshot.endBlock) {
    return {
      ok: false,
      reason: 'AuctionIsOver',
      message: `block ${block} is at or after the end block`,
    };
  }
  const engine = engineFromSnapshot(snapshot);
  const clearing = engine.checkpoint(block).clearingPrice;
  const toCap = demandToReach(snapshot, block, input.maxPrice);
  const forecast = input.forecastDemand ?? toCap;
  const weighting: Weighting =
    input.weighting === undefined || input.weighting === 'auto'
      ? input.forecastDemand === undefined
        ? 'flat'
        : autoWeighting(forecast, toCap)
      : input.weighting;

  const built = buildSchedule({
    budget: input.budget,
    maxPrice: input.maxPrice,
    clearingPrice: clearing,
    tickSpacing: snapshot.tickSpacing,
    maxBidPrice: snapshot.maxBidPrice,
    block,
    ...(input.levels !== undefined ? { levels: input.levels } : {}),
    weighting,
  });
  if (!built.ok) return built;

  // prevTickPrice hints: submit in ascending price order, each hint is the highest known tick below.
  const sorted = [...built.entries].sort((a, b) => (a.maxPrice < b.maxPrice ? -1 : 1));
  const schedule: PlannedBid[] = [];
  for (const e of sorted) {
    const prevTickPrice = engine.prevInitializedTick(e.maxPrice);
    schedule.push({ ...e, prevTickPrice });
    engine.submitBid(e.block, e.maxPrice, e.amount, 'self');
  }

  const ceiling = input.demandCeiling ?? input.maxPrice * 2n;
  const scenarios =
    input.scenarios ?? defaultScenarios(forecast, clearing, ceiling, input.arrival ?? 'flat');
  const simulations = scenarios.map((sc) => simulate(snapshot, schedule, sc, { fromBlock: block }));

  const warnings: string[] = [];
  if (!snapshot.tokensReceived)
    warnings.push('Auction has not received its tokens; bids revert until it does.');
  if (snapshot.validationHook !== '0x0000000000000000000000000000000000000000') {
    warnings.push(
      `Validation hook ${snapshot.validationHook} may reject these bids or require hookData.`,
    );
  }
  for (const sim of simulations) {
    if (!sim.graduated)
      warnings.push(
        `Scenario "${sim.scenario}": auction does not graduate; every bid is refunded.`,
      );
    for (const st of sim.steps) {
      if (st.rejected)
        warnings.push(`Scenario "${sim.scenario}": a bid would revert (${st.rejected}).`);
    }
  }

  const base = simulations.find((s) => s.scenario === 'base') ?? simulations[0];
  const worstFill = simulations.reduce<SimulationResult | undefined>(
    (w, s) => (w === undefined || s.tokensFilled < w.tokensFilled ? s : w),
    undefined,
  );
  const worstPrice = simulations.reduce<SimulationResult | undefined>(
    (w, s) => (w === undefined || s.averagePrice > w.averagePrice ? s : w),
    undefined,
  );
  const maxRefund = simulations.reduce(
    (m, s) => (s.currencyRefunded > m ? s.currencyRefunded : m),
    0n,
  );

  const figures: Figure<bigint>[] = [
    derived('clearing price at submission', clearing, 'priceQ96'),
    derived('extra demand to lift clearing to cap', toCap, 'currency'),
    assumed(
      'forecast external demand',
      forecast,
      'currency',
      input.forecastDemand === undefined
        ? 'default: demand that lifts clearing to your cap'
        : 'user input',
    ),
  ];
  if (base) {
    figures.push(
      assumed(`expected tokens (${base.scenario})`, base.tokensFilled, 'token'),
      assumed(`expected spend (${base.scenario})`, base.currencySpent, 'currency'),
      assumed(`expected average price (${base.scenario})`, base.averagePrice, 'priceQ96'),
    );
  }
  if (worstFill)
    figures.push(
      assumed(`worst-case tokens (${worstFill.scenario})`, worstFill.tokensFilled, 'token'),
    );
  if (worstPrice)
    figures.push(
      assumed(
        `worst-case average price (${worstPrice.scenario})`,
        worstPrice.averagePrice,
        'priceQ96',
      ),
    );
  figures.push(
    assumed('max refund exposure', maxRefund, 'currency', 'largest refund across scenarios'),
  );

  return {
    ok: true,
    block,
    clearingAtBlock: clearing,
    weighting,
    schedule,
    scenarios,
    simulations,
    figures,
    warnings,
  };
}
