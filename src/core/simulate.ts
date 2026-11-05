/**
 * Replay a bid schedule against a demand scenario using the integer-exact engine.
 */
import { Q96 } from './constants.js';
import { AuctionError, type BidOutcome } from './engine.js';
import { type DemandScenario, type ExternalBid, scenarioBids } from './scenario.js';
import type { ScheduleEntry } from './schedule.js';
import { type AuctionSnapshot, engineFromSnapshot } from './snapshot.js';

export interface StepResult {
  entry: ScheduleEntry;
  /** Engine bid id, or undefined if the submission would revert. */
  bidId?: number;
  /** Revert reason if the bid could not be submitted. */
  rejected?: string;
  outcome?: BidOutcome;
  /** True when the entry received any tokens. */
  filled: boolean;
}

export interface SimulationResult {
  scenario: string;
  steps: StepResult[];
  tokensFilled: bigint;
  currencySpent: bigint;
  currencyRefunded: bigint;
  /** Average Q96 price paid, or 0 when nothing filled. */
  averagePrice: bigint;
  finalClearingPrice: bigint;
  graduated: boolean;
  currencyRaised: bigint;
  /** External demand that could not be placed because it was at or below clearing. */
  externalRejected: bigint;
  externalPlaced: bigint;
}

export interface SimulateOptions {
  /** Block from which external demand arrives. Defaults to the snapshot block. */
  fromBlock?: bigint;
}

/**
 * Simulate a schedule. `demand` is either a scenario (expanded into bids) or an explicit
 * list of external bids. Same-block ordering: the user's entries go first.
 */
export function simulate(
  snapshot: AuctionSnapshot,
  schedule: readonly ScheduleEntry[],
  demand: DemandScenario | readonly ExternalBid[],
  opts: SimulateOptions = {},
): SimulationResult {
  const engine = engineFromSnapshot(snapshot);
  const fromBlock = maxBlock(opts.fromBlock ?? snapshot.blockNumber, snapshot.startBlock);
  const name = Array.isArray(demand) ? 'custom' : (demand as DemandScenario).name;
  const external = Array.isArray(demand)
    ? [...(demand as readonly ExternalBid[])]
    : scenarioBids(demand as DemandScenario, {
        fromBlock,
        endBlock: snapshot.endBlock,
        tickSpacing: snapshot.tickSpacing,
        maxBidPrice: snapshot.maxBidPrice,
      });

  type Event = { block: bigint; order: number; own?: number; ext?: ExternalBid };
  const events: Event[] = [];
  schedule.forEach((entry, i) => {
    events.push({ block: entry.block, order: 0, own: i });
  });
  for (const ext of external) events.push({ block: ext.block, order: 1, ext });
  events.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : a.order - b.order));

  const steps: StepResult[] = schedule.map((entry) => ({ entry, filled: false }));
  let externalRejected = 0n;
  let externalPlaced = 0n;
  for (const ev of events) {
    if (ev.own !== undefined) {
      const step = steps[ev.own] as StepResult;
      try {
        step.bidId = engine.submitBid(ev.block, step.entry.maxPrice, step.entry.amount, 'self');
      } catch (e) {
        step.rejected = e instanceof AuctionError ? e.code : String(e);
      }
    } else if (ev.ext) {
      try {
        engine.submitBid(ev.block, ev.ext.maxPrice, ev.ext.amount, 'external');
        externalPlaced += ev.ext.amount;
      } catch (e) {
        if (!(e instanceof AuctionError)) throw e;
        externalRejected += ev.ext.amount;
      }
    }
  }

  engine.checkpoint(snapshot.endBlock);
  let tokensFilled = 0n;
  let currencySpent = 0n;
  let currencyRefunded = 0n;
  for (const step of steps) {
    if (step.bidId === undefined) {
      currencyRefunded += step.entry.amount;
      continue;
    }
    const outcome = engine.settle(step.bidId);
    step.outcome = outcome;
    step.filled = outcome.tokensFilled > 0n;
    tokensFilled += outcome.tokensFilled;
    currencySpent += outcome.currencySpent;
    currencyRefunded += outcome.currencyRefunded;
  }
  return {
    scenario: name,
    steps,
    tokensFilled,
    currencySpent,
    currencyRefunded,
    averagePrice: tokensFilled > 0n ? (currencySpent * Q96) / tokensFilled : 0n,
    finalClearingPrice: engine.clearingPrice,
    graduated: engine.isGraduated,
    currencyRaised: engine.currencyRaised,
    externalRejected,
    externalPlaced,
  };
}

function maxBlock(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
