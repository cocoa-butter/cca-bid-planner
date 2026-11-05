/**
 * A synthetic, clearly labelled example auction for the planner page and docs, shaped like
 * the reported Slop Cash (SLOP) sale on Robinhood Chain: 45M SLOP, bids in USDG, floor about
 * 0.00889 USDG, 400k USDG minimum raise. Those figures come from third-party coverage and
 * are not a chain read. The schedule, address and prior bids are invented.
 */
import { maxBidPrice } from '../core/constants.js';
import { AuctionEngine } from '../core/engine.js';
import { toPriceQ96 } from '../core/price.js';
import { type AuctionSnapshot, stateFromEngine } from '../core/snapshot.js';
import { encodeSteps, stepsFrom } from '../core/steps.js';

export function demoSnapshot(): AuctionSnapshot {
  const totalSupply = 45_000_000n * 10n ** 18n;
  const exactFloor = toPriceQ96('0.00889', 18, 6);
  const tickSpacing = exactFloor / 100n;
  const floorPrice = tickSpacing * 100n;
  const start = 24_000_000n;
  const records = [
    { mps: 5_000, blockDelta: 1_000 },
    { mps: 49_500, blockDelta: 100 },
    { mps: 50_000, blockDelta: 1 },
  ];
  const end = start + 1_101n;
  const required = 400_000n * 10n ** 6n;
  const engine = AuctionEngine.fresh({
    totalSupply,
    floorPrice,
    tickSpacing,
    startBlock: start,
    endBlock: end,
    requiredCurrencyRaised: required,
    maxBidPrice: maxBidPrice(totalSupply),
    steps: stepsFrom(records, start),
  });
  const usdc = (n: bigint) => n * 10n ** 6n;
  const tick = (k: bigint) => floorPrice + k * tickSpacing;
  // Invented prior demand: 40 bids spread over the first 400 blocks.
  for (let i = 0n; i < 40n; i++) {
    const block = start + i * 10n;
    const price = tick(5n + ((i * 37n) % 120n));
    engine.submitBid(block, price, usdc(4_000n + ((i * 7_919n) % 11_000n)), `prior-${i}`);
  }
  const now = start + 420n;
  engine.checkpoint(now);
  return {
    version: 1,
    chainId: 4663,
    auction: '0x000000000000000000000000000000000000dE30',
    blockNumber: now,
    token: { address: '0x00000000000000000000000000000000000051a9', symbol: 'SLOP', decimals: 18 },
    // Global Dollar (USDG) on Robinhood Chain.
    currency: {
      address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      symbol: 'USDG',
      decimals: 6,
    },
    totalSupply,
    floorPrice,
    tickSpacing,
    maxBidPrice: maxBidPrice(totalSupply),
    startBlock: start,
    endBlock: end,
    claimBlock: end + 100n,
    requiredCurrencyRaised: required,
    tokensRecipient: '0x00000000000000000000000000000000000000a1',
    fundsRecipient: '0x00000000000000000000000000000000000000a2',
    validationHook: '0x0000000000000000000000000000000000000000',
    auctionStepsData: encodeSteps(records),
    tokensReceived: true,
    state: stateFromEngine(engine),
  };
}
