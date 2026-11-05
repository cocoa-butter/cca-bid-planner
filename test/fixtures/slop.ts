/**
 * Synthetic fixture modelled on the Umia $SLOP auction figures (illustrative, unverified):
 * floor 0.00889 USDC, cap 0.02196 USDC, supply 45,000,000 (18 dp), min raise 400,000 USDC.
 *
 * These figures are ASSUMED: they are not from a chain read and were not
 * independently verified. Addresses and the step schedule are invented for testing.
 */
import { maxBidPrice } from '../../src/core/constants.js';
import { toPriceQ96 } from '../../src/core/price.js';
import { type AuctionSnapshot, freshState } from '../../src/core/snapshot.js';
import { encodeSteps } from '../../src/core/steps.js';

export const TOKEN_DECIMALS = 18;
export const CURRENCY_DECIMALS = 6;
export const SUPPLY = 45_000_000n * 10n ** 18n;
export const MIN_RAISE = 400_000n * 10n ** 6n;

/** Exact Q96 of the illustrative floor, before snapping to a tick. */
export const FLOOR_Q96_EXACT = toPriceQ96('0.00889', TOKEN_DECIMALS, CURRENCY_DECIMALS);
/** Tick spacing: 1% of the floor (upstream suggests at least 1 bp). */
export const TICK_SPACING = FLOOR_Q96_EXACT / 100n;
/** Floor snapped down to a tick multiple, as an auction must use. */
export const FLOOR_Q96 = TICK_SPACING * 100n;
export const CAP_Q96 = toPriceQ96('0.02196', TOKEN_DECIMALS, CURRENCY_DECIMALS);

export const START = 1_000n;
/** 1000 blocks at 0.05%/block, 100 blocks at 0.495%/block, final block 0.5%. */
export const STEPS = [
  { mps: 5_000, blockDelta: 1_000 },
  { mps: 49_500, blockDelta: 100 },
  { mps: 50_000, blockDelta: 1 },
];
export const END = START + 1_101n;

export function slopSnapshot(overrides: Partial<AuctionSnapshot> = {}): AuctionSnapshot {
  return {
    version: 1,
    chainId: 1,
    auction: '0x000000000000000000000000000000000000c0a1',
    blockNumber: START - 1n,
    token: { address: '0x00000000000000000000000000000000000051a9', symbol: 'SLOP', decimals: 18 },
    currency: {
      address: '0x00000000000000000000000000000000000000c5',
      symbol: 'USDC',
      decimals: 6,
    },
    totalSupply: SUPPLY,
    floorPrice: FLOOR_Q96,
    tickSpacing: TICK_SPACING,
    maxBidPrice: maxBidPrice(SUPPLY),
    startBlock: START,
    endBlock: END,
    claimBlock: END,
    requiredCurrencyRaised: MIN_RAISE,
    tokensRecipient: '0x00000000000000000000000000000000000000a1',
    fundsRecipient: '0x00000000000000000000000000000000000000a2',
    validationHook: '0x0000000000000000000000000000000000000000',
    auctionStepsData: encodeSteps(STEPS),
    tokensReceived: true,
    state: freshState(FLOOR_Q96),
    ...overrides,
  };
}
