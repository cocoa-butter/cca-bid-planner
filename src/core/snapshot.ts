/**
 * A plain-data picture of an auction at one block. The RPC adapter produces it; the
 * core consumes it. Everything is serialisable to JSON (bigints as decimal strings).
 */
import { MPS } from './constants.js';
import { AuctionEngine, type Checkpoint, type EngineConfig } from './engine.js';
import { type AuctionStep, parseSteps } from './steps.js';

export interface TokenInfo {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
}

export interface AuctionSnapshot {
  /** Format version of this object. */
  version: 1;
  chainId: number;
  auction: `0x${string}`;
  /** Block the state was read at. */
  blockNumber: bigint;
  token: TokenInfo;
  /** address(0) means native ETH. */
  currency: TokenInfo;
  totalSupply: bigint;
  floorPrice: bigint;
  tickSpacing: bigint;
  maxBidPrice: bigint;
  startBlock: bigint;
  endBlock: bigint;
  claimBlock: bigint;
  requiredCurrencyRaised: bigint;
  tokensRecipient: `0x${string}`;
  fundsRecipient: `0x${string}`;
  validationHook: `0x${string}`;
  auctionStepsData: `0x${string}`;
  /** Whether the auction has received its tokens (bids revert with TokensNotReceived otherwise). */
  tokensReceived: boolean;
  state: {
    clearingPrice: bigint;
    sumCurrencyDemandAboveClearingQ96: bigint;
    currencyRaisedQ96X7: bigint;
    totalClearedQ96X7: bigint;
    lastCheckpointedBlock: bigint;
    latestCheckpoint: Checkpoint;
    /** Every initialized tick at or above the clearing price, with its demand. */
    ticks: Array<{ price: bigint; currencyDemandQ96: bigint }>;
    /** Optional: result of eth_call checkpoint() at blockNumber, for cross-checking. */
    simulatedCheckpoint?: Checkpoint;
  };
}

export function snapshotSteps(s: AuctionSnapshot): AuctionStep[] {
  return parseSteps(s.auctionStepsData, s.startBlock);
}

export function engineConfig(s: AuctionSnapshot): EngineConfig {
  return {
    totalSupply: s.totalSupply,
    floorPrice: s.floorPrice,
    tickSpacing: s.tickSpacing,
    startBlock: s.startBlock,
    endBlock: s.endBlock,
    requiredCurrencyRaised: s.requiredCurrencyRaised,
    maxBidPrice: s.maxBidPrice,
    steps: snapshotSteps(s),
  };
}

/** Build an engine positioned at the snapshot's last checkpoint. */
export function engineFromSnapshot(s: AuctionSnapshot): AuctionEngine {
  const ticks = new Map<bigint, bigint>();
  for (const t of s.state.ticks) ticks.set(t.price, t.currencyDemandQ96);
  return new AuctionEngine(engineConfig(s), {
    clearingPrice: s.state.clearingPrice,
    sumCurrencyDemandAboveClearingQ96: s.state.sumCurrencyDemandAboveClearingQ96,
    currencyRaisedQ96X7: s.state.currencyRaisedQ96X7,
    totalClearedQ96X7: s.state.totalClearedQ96X7,
    lastCheckpointedBlock: s.state.lastCheckpointedBlock,
    latestCheckpoint: s.state.latestCheckpoint,
    ticks,
  });
}

/** Snapshot of a freshly deployed auction with no bids, for planning ahead of the start. */
export function freshState(floorPrice: bigint): AuctionSnapshot['state'] {
  return {
    clearingPrice: floorPrice,
    sumCurrencyDemandAboveClearingQ96: 0n,
    currencyRaisedQ96X7: 0n,
    totalClearedQ96X7: 0n,
    lastCheckpointedBlock: 0n,
    latestCheckpoint: {
      clearingPrice: 0n,
      currencyRaisedAtClearingPriceQ96X7: 0n,
      cumulativeMpsPerPrice: 0n,
      cumulativeMps: 0n,
      prev: 0n,
      next: 0n,
    },
    ticks: [{ price: floorPrice, currencyDemandQ96: 0n }],
  };
}

/** Fraction of the schedule already released at the snapshot, in MPS. */
export function releasedMps(s: AuctionSnapshot): bigint {
  return s.state.latestCheckpoint.cumulativeMps > MPS
    ? MPS
    : s.state.latestCheckpoint.cumulativeMps;
}

// ----- JSON (de)serialisation -----

const BIGINT_TAG = /^-?\d+$/;

/** JSON.stringify replacer turning bigints into decimal strings. */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function snapshotToJson(s: AuctionSnapshot): string {
  return JSON.stringify(s, bigintReplacer, 2);
}

const BIGINT_FIELDS = new Set([
  'blockNumber',
  'totalSupply',
  'floorPrice',
  'tickSpacing',
  'maxBidPrice',
  'startBlock',
  'endBlock',
  'claimBlock',
  'requiredCurrencyRaised',
  'clearingPrice',
  'sumCurrencyDemandAboveClearingQ96',
  'currencyRaisedQ96X7',
  'totalClearedQ96X7',
  'lastCheckpointedBlock',
  'currencyRaisedAtClearingPriceQ96X7',
  'cumulativeMpsPerPrice',
  'cumulativeMps',
  'prev',
  'next',
  'price',
  'currencyDemandQ96',
]);

export function snapshotFromJson(text: string): AuctionSnapshot {
  const parsed = JSON.parse(text, (key, value) => {
    if (BIGINT_FIELDS.has(key) && typeof value === 'string' && BIGINT_TAG.test(value)) {
      return BigInt(value);
    }
    if (BIGINT_FIELDS.has(key) && typeof value === 'number') return BigInt(value);
    return value;
  }) as AuctionSnapshot;
  if (parsed.version !== 1)
    throw new Error(`unsupported snapshot version ${String(parsed.version)}`);
  return parsed;
}

/** Snapshot state from an engine (see AuctionEngine.exportState). */
export function stateFromEngine(engine: AuctionEngine): AuctionSnapshot['state'] {
  const st = engine.exportState();
  return {
    clearingPrice: st.clearingPrice,
    sumCurrencyDemandAboveClearingQ96: st.sumCurrencyDemandAboveClearingQ96,
    currencyRaisedQ96X7: st.currencyRaisedQ96X7,
    totalClearedQ96X7: st.totalClearedQ96X7,
    lastCheckpointedBlock: st.lastCheckpointedBlock,
    latestCheckpoint: st.latestCheckpoint,
    ticks: [...st.ticks].map(([price, currencyDemandQ96]) => ({ price, currencyDemandQ96 })),
  };
}
