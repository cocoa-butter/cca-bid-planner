/**
 * A synthetic, clearly-labelled example auction for the demo page and docs. It reuses the
 * illustrative $SLOP figures (floor 0.00889 USDC, 45M supply, 400k USDC minimum
 * raise). Those figures are assumptions, not a chain read. Prior bids are invented.
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
    chainId: 1,
    auction: '0x000000000000000000000000000000000000dE30',
    blockNumber: now,
    token: { address: '0x00000000000000000000000000000000000051a9', symbol: 'SLOP', decimals: 18 },
    currency: {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
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
