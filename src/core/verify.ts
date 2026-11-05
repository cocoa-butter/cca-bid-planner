/**
 * Parameter sanity checks, from the upstream "Integration guidelines" and "Bidder
 * responsibilities" (docs/TechnicalDocumentation.md at v2.1.0) plus constructor reverts.
 */
import {
  MAX_TOTAL_SUPPLY,
  MIN_FLOOR_PRICE,
  MIN_TICK_SPACING,
  MPS,
  maxBidPrice,
  Q96,
  ZERO_ADDRESS,
} from './constants.js';
import { mulDivUp } from './math.js';
import type { AuctionSnapshot } from './snapshot.js';
import { snapshotSteps } from './snapshot.js';
import { stepErrors } from './steps.js';

export type Severity = 'critical' | 'warning' | 'info';

export interface Check {
  id: string;
  severity: Severity;
  /** null means the check cannot be done from chain data; the user must do it. */
  passed: boolean | null;
  title: string;
  detail: string;
}

export function verify(s: AuctionSnapshot): Check[] {
  const checks: Check[] = [];
  const add = (
    id: string,
    severity: Severity,
    passed: boolean | null,
    title: string,
    detail: string,
  ) => checks.push({ id, severity, passed, title, detail });

  const steps = snapshotSteps(s);
  const stepProblems = stepErrors(steps, s.startBlock, s.endBlock);
  add(
    'steps-valid',
    'critical',
    stepProblems.length === 0,
    'Supply schedule is well-formed',
    stepProblems.length === 0
      ? `${steps.length} steps sum to ${MPS} MPS and end at block ${s.endBlock}.`
      : stepProblems.join('; '),
  );

  add(
    'blocks-ordered',
    'critical',
    s.startBlock < s.endBlock && s.claimBlock >= s.endBlock,
    'Start < end <= claim block',
    `start ${s.startBlock}, end ${s.endBlock}, claim ${s.claimBlock}.`,
  );

  const claimDelay = s.claimBlock - s.endBlock;
  add(
    'claim-delay',
    'warning',
    claimDelay <= 50_000n,
    'Claim block is close to the end block',
    `Tokens are claimable ${claimDelay} blocks after the end. Upstream warns that extreme block settings can keep bidders from receiving tokens or refunds.`,
  );

  add(
    'total-supply',
    'critical',
    s.totalSupply > 0n && s.totalSupply <= MAX_TOTAL_SUPPLY,
    'Total supply within 2^100',
    `totalSupply = ${s.totalSupply}.`,
  );

  const expectedMax = maxBidPrice(s.totalSupply);
  add(
    'max-bid-price',
    'info',
    expectedMax === s.maxBidPrice,
    'MAX_BID_PRICE matches MaxBidPriceLib',
    `on-chain ${s.maxBidPrice}, recomputed ${expectedMax}.`,
  );

  add(
    'floor-min',
    'critical',
    s.floorPrice >= MIN_FLOOR_PRICE,
    'Floor price >= 2^32 + 1',
    `floorPrice = ${s.floorPrice}.`,
  );
  add(
    'floor-on-tick',
    'critical',
    s.tickSpacing > 0n && s.floorPrice % s.tickSpacing === 0n,
    'Floor price is a multiple of tick spacing',
    'Every tick, including the floor, must satisfy price % tickSpacing == 0.',
  );
  add(
    'tick-min',
    'critical',
    s.tickSpacing >= MIN_TICK_SPACING,
    'Tick spacing >= 2',
    `tickSpacing = ${s.tickSpacing}.`,
  );
  // Upstream: "integrators should choose a tick spacing of AT LEAST 1 basis point of the floor price".
  const bp = s.floorPrice / 10_000n;
  add(
    'tick-gas',
    'warning',
    s.tickSpacing >= bp,
    'Tick spacing is at least 1 bp of the floor',
    `spacing = ${bpOf(s.tickSpacing, s.floorPrice)} bp of floor. Smaller spacing is gas-hostile and can let an attacker stop the auction from finishing (upstream).`,
  );

  // Last-block issuance. Upstream: "the last block of the auction MUST sell a significant
  // amount of tokens" because the final price seeds a v4 pool. Threshold is ours.
  const last = steps[steps.length - 1];
  const lastMps = last ? BigInt(last.mps) : 0n;
  add(
    'last-block-supply',
    'warning',
    lastMps * 100n >= MPS,
    'Final block sells a significant share',
    `last block releases ${pct(lastMps, MPS)} of supply (threshold used here: 1%). A thin final block makes the final price, which seeds the pool, easy to manipulate.`,
  );

  const decreasing = steps.some((st, i) => i > 0 && st.mps < (steps[i - 1]?.mps ?? 0));
  add(
    'steps-monotonic',
    'info',
    !decreasing,
    'Issuance rate never decreases',
    'Upstream: steps should generally be monotonically increasing in tokens sold.',
  );

  // Graduation feasibility: raising requiredCurrencyRaised at the floor needs X% of supply sold.
  const raiseAtFloor = mulDivUp(s.totalSupply, s.floorPrice, Q96);
  const feasible = raiseAtFloor >= s.requiredCurrencyRaised;
  add(
    'graduation-floor',
    'warning',
    feasible,
    'Full sale at the floor reaches the minimum raise',
    `full sale at floor raises ${raiseAtFloor} vs required ${s.requiredCurrencyRaised} (raw currency units). ${
      feasible
        ? 'Graduation needs no price above the floor.'
        : 'Graduation needs a clearing price above the floor; until then no bid exits and the auction can fail.'
    }`,
  );
  const ratio =
    raiseAtFloor > 0n ? (s.requiredCurrencyRaised * 10_000n) / raiseAtFloor : 10n ** 18n;
  add(
    'graduation-high',
    'warning',
    ratio <= 20_000n,
    'Required raise is achievable',
    `required raise is ${Number(ratio) / 100}% of a full sale at the floor. Above 200% the auction needs the price to more than double before it graduates.`,
  );

  add(
    'decimals',
    'critical',
    s.token.decimals >= 6 && s.currency.decimals >= 6,
    'Token and currency have >= 6 decimals',
    `token ${s.token.decimals}, currency ${s.currency.decimals}. Upstream: low-decimal tokens lose significant value to rounding.`,
  );
  add(
    'tokens-received',
    'critical',
    s.tokensReceived,
    'Auction holds its token supply',
    s.tokensReceived
      ? 'onTokensReceived has been called.'
      : 'Bids revert with TokensNotReceived until the supply arrives.',
  );
  add(
    'validation-hook',
    'info',
    s.validationHook === ZERO_ADDRESS,
    'No validation hook',
    s.validationHook === ZERO_ADDRESS
      ? 'Anyone can bid with empty hookData.'
      : `Bids go through hook ${s.validationHook}. It may reject bids or require hookData this tool cannot produce.`,
  );
  add(
    'manual',
    'info',
    null,
    'Checks this tool cannot do',
    'Not checkable from the auction contract: honeypot or fee-on-transfer token behaviour, the liquidity-launcher positionRecipient (who may withdraw the pool position right after creation), and whether the floor price is above fair value. Currency sent to the auction outside submitBid cannot be recovered.',
  );
  return checks;
}

export function hasCriticalFailure(checks: readonly Check[]): boolean {
  return checks.some((c) => c.severity === 'critical' && c.passed === false);
}

function pct(part: bigint, whole: bigint): string {
  if (whole === 0n) return '0%';
  return `${(Number((part * 1_000_000n) / whole) / 10_000).toString()}%`;
}

function bpOf(spacing: bigint, floor: bigint): string {
  if (floor === 0n) return 'n/a';
  return (Number((spacing * 1_000_000n) / floor) / 100).toString();
}
