/**
 * Inspect: parameters, live state and risks of one auction, every figure labelled.
 */
import { MPS, Q96 } from './constants.js';
import { derived, type Figure, observed } from './label.js';
import { mulDivUp } from './math.js';
import { type AuctionSnapshot, engineFromSnapshot, snapshotSteps } from './snapshot.js';
import { cumulativeMpsAt, stepAt } from './steps.js';
import { type Check, verify } from './verify.js';

export type Phase = 'not-started' | 'live' | 'ended' | 'claimable';

export interface InspectReport {
  phase: Phase;
  figures: Figure<bigint | string | boolean>[];
  /** Initialized ticks above clearing with demand converted to currency committed. */
  ladder: Array<{ price: bigint; demandQ96: bigint }>;
  checks: Check[];
  /** Differences between the engine's checkpoint and the chain's simulated checkpoint. */
  consistency: string[];
}

export function phaseAt(s: AuctionSnapshot, block: bigint): Phase {
  if (block < s.startBlock) return 'not-started';
  if (block < s.endBlock) return 'live';
  if (block < s.claimBlock) return 'ended';
  return 'claimable';
}

export function inspect(s: AuctionSnapshot): InspectReport {
  const phase = phaseAt(s, s.blockNumber);
  const steps = snapshotSteps(s);
  const engine = engineFromSnapshot(s);
  const consistency: string[] = [];

  let clearingNow = s.state.clearingPrice;
  let cumulativeNow = s.state.latestCheckpoint.cumulativeMps;
  if (phase !== 'not-started' && s.tokensReceived) {
    const cp = engine.checkpoint(s.blockNumber);
    clearingNow = cp.clearingPrice;
    cumulativeNow = cp.cumulativeMps;
    const sim = s.state.simulatedCheckpoint;
    if (sim) {
      if (sim.clearingPrice !== cp.clearingPrice) {
        consistency.push(`clearing price: engine ${cp.clearingPrice}, chain ${sim.clearingPrice}`);
      }
      if (sim.cumulativeMps !== cp.cumulativeMps) {
        consistency.push(`cumulative MPS: engine ${cp.cumulativeMps}, chain ${sim.cumulativeMps}`);
      }
    }
  }
  const scheduled = cumulativeMpsAt(steps, s.blockNumber < s.endBlock ? s.blockNumber : s.endBlock);
  const current = stepAt(steps, s.blockNumber);
  const raiseAtFloor = mulDivUp(s.totalSupply, s.floorPrice, Q96);
  const remainingTokens = engine.remainingSupplyQ96X7 / (Q96 * MPS);

  const figures: Figure<bigint | string | boolean>[] = [
    observed('block', s.blockNumber),
    derived('phase', phase),
    observed('token', `${s.token.symbol} ${s.token.address} (${s.token.decimals} dp)`),
    observed('currency', `${s.currency.symbol} ${s.currency.address} (${s.currency.decimals} dp)`),
    observed('total supply', s.totalSupply, 'token'),
    observed('floor price', s.floorPrice, 'priceQ96'),
    observed('tick spacing', s.tickSpacing, 'priceQ96'),
    observed('max bid price', s.maxBidPrice, 'priceQ96'),
    observed('start block', s.startBlock),
    observed('end block', s.endBlock),
    observed('claim block', s.claimBlock),
    observed('required currency raised', s.requiredCurrencyRaised, 'currency'),
    derived('full sale at floor raises', raiseAtFloor, 'currency'),
    observed('validation hook', s.validationHook),
    observed('tokens received', s.tokensReceived),
    observed('clearing price (last checkpoint)', s.state.clearingPrice, 'priceQ96'),
    derived('clearing price (checkpointed now)', clearingNow, 'priceQ96'),
    observed(
      'currency raised (last checkpoint)',
      s.state.currencyRaisedQ96X7 / Q96 / MPS,
      'currency',
    ),
    derived('graduated (now)', engine.isGraduated),
    derived('supply released', `${pct(cumulativeNow)} (schedule says ${pct(scheduled)})`),
    derived('remaining supply', remainingTokens, 'token'),
    derived(
      'current issuance',
      current ? `${current.mps} MPS/block until block ${current.endBlock}` : 'none',
    ),
    observed(
      'demand above clearing',
      s.state.sumCurrencyDemandAboveClearingQ96 / Q96,
      'currency',
      'effective demand, normalised to the full schedule',
    ),
  ];
  return {
    phase,
    figures,
    ladder: s.state.ticks
      .filter((t) => t.price > clearingNow)
      .map((t) => ({ price: t.price, demandQ96: t.currencyDemandQ96 })),
    checks: verify(s),
    consistency,
  };
}

function pct(mps: bigint): string {
  return `${(Number((mps * 10_000n) / MPS) / 100).toFixed(2)}%`;
}
