/**
 * Integer-exact model of ContinuousClearingAuction v2.1.0 state transitions.
 *
 * This ports the checkpoint, clearing-price and fill accounting logic of the upstream
 * contract so that simulations agree with on-chain behaviour to the wei, given the same
 * sequence of bids and checkpoints. It holds no keys and does no I/O.
 */
import { MAX_TICK_PTR, MPS, Q96, X7_UPPER_BOUND } from './constants.js';
import { minBig, mulDiv, mulDivUp, saturatingSub } from './math.js';
import { type AuctionStep, cumulativeMpsAt } from './steps.js';

export interface Checkpoint {
  clearingPrice: bigint;
  currencyRaisedAtClearingPriceQ96X7: bigint;
  cumulativeMpsPerPrice: bigint;
  cumulativeMps: bigint;
  prev: bigint;
  next: bigint;
}

export interface EngineBid {
  id: number;
  owner: string;
  startBlock: bigint;
  startCumulativeMps: bigint;
  maxPrice: bigint;
  amountQ96: bigint;
}

export interface BidOutcome {
  id: number;
  owner: string;
  maxPrice: bigint;
  /** Currency committed (raw units). */
  amount: bigint;
  tokensFilled: bigint;
  /** Currency spent (raw units), i.e. amount - refund. */
  currencySpent: bigint;
  currencyRefunded: bigint;
  /** 'full': maxPrice above final clearing. 'partial': at clearing. 'outbid': below. 'refunded': auction failed. */
  status: 'full' | 'partial' | 'outbid' | 'refunded';
}

/** Static auction configuration. */
export interface EngineConfig {
  totalSupply: bigint;
  floorPrice: bigint;
  tickSpacing: bigint;
  startBlock: bigint;
  endBlock: bigint;
  requiredCurrencyRaised: bigint;
  maxBidPrice: bigint;
  steps: readonly AuctionStep[];
}

/** Mutable auction state as stored by the contract. */
export interface EngineState {
  clearingPrice: bigint;
  sumCurrencyDemandAboveClearingQ96: bigint;
  currencyRaisedQ96X7: bigint;
  totalClearedQ96X7: bigint;
  lastCheckpointedBlock: bigint;
  latestCheckpoint: Checkpoint;
  /** Initialized ticks: price -> currencyDemandQ96. Must include every tick above clearing. */
  ticks: Map<bigint, bigint>;
}

export class AuctionError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'AuctionError';
  }
}

const EMPTY_CHECKPOINT: Checkpoint = {
  clearingPrice: 0n,
  currencyRaisedAtClearingPriceQ96X7: 0n,
  cumulativeMpsPerPrice: 0n,
  cumulativeMps: 0n,
  prev: 0n,
  next: 0n,
};

export class AuctionEngine {
  readonly config: EngineConfig;
  private readonly totalSupplyQ96X7: bigint;
  private readonly requiredRaisedQ96X7: bigint;
  private clearing: bigint;
  private sumAbove: bigint;
  private currencyRaisedQ96X7: bigint;
  private totalClearedQ96X7: bigint;
  private lastBlock: bigint;
  private readonly checkpoints = new Map<bigint, Checkpoint>();
  private readonly tickDemand: Map<bigint, bigint>;
  private sortedTicks: bigint[] | undefined;
  private readonly bids: EngineBid[] = [];

  constructor(config: EngineConfig, state?: EngineState) {
    this.config = config;
    this.totalSupplyQ96X7 = (config.totalSupply << 96n) * MPS;
    this.requiredRaisedQ96X7 = (config.requiredCurrencyRaised << 96n) * MPS;
    if (state) {
      this.clearing = state.clearingPrice;
      this.sumAbove = state.sumCurrencyDemandAboveClearingQ96;
      this.currencyRaisedQ96X7 = state.currencyRaisedQ96X7;
      this.totalClearedQ96X7 = state.totalClearedQ96X7;
      this.lastBlock = state.lastCheckpointedBlock;
      this.checkpoints.set(state.lastCheckpointedBlock, { ...state.latestCheckpoint });
      this.tickDemand = new Map(state.ticks);
    } else {
      this.clearing = config.floorPrice;
      this.sumAbove = 0n;
      this.currencyRaisedQ96X7 = 0n;
      this.totalClearedQ96X7 = 0n;
      this.lastBlock = 0n;
      this.checkpoints.set(0n, { ...EMPTY_CHECKPOINT });
      this.tickDemand = new Map();
    }
    if (!this.tickDemand.has(config.floorPrice)) this.tickDemand.set(config.floorPrice, 0n);
  }

  /** Construct a fresh auction, as deployed, with no bids. */
  static fresh(config: EngineConfig): AuctionEngine {
    return new AuctionEngine(config);
  }

  // ----- views -----

  get clearingPrice(): bigint {
    return this.clearing;
  }
  get lastCheckpointedBlock(): bigint {
    return this.lastBlock;
  }
  get latestCheckpoint(): Checkpoint {
    return { ...this.cp(this.lastBlock) };
  }
  get sumCurrencyDemandAboveClearingQ96(): bigint {
    return this.sumAbove;
  }
  get currencyRaised(): bigint {
    return this.currencyRaisedQ96X7 / Q96 / MPS;
  }
  get totalCleared(): bigint {
    return this.totalClearedQ96X7 / Q96 / MPS;
  }
  get remainingSupplyQ96X7(): bigint {
    return this.totalSupplyQ96X7 - this.totalClearedQ96X7;
  }
  get isGraduated(): boolean {
    return this.currencyRaisedQ96X7 >= this.requiredRaisedQ96X7;
  }
  get nextActiveTickPrice(): bigint {
    for (const t of this.ticksSorted()) if (t > this.clearing) return t;
    return MAX_TICK_PTR;
  }
  tickDemandQ96(price: bigint): bigint {
    return this.tickDemand.get(price) ?? 0n;
  }
  isTickInitialized(price: bigint): boolean {
    return this.tickDemand.has(price);
  }
  /** Highest initialized tick strictly below `price` (a valid prevTickPrice hint). */
  prevInitializedTick(price: bigint): bigint {
    let prev = this.config.floorPrice;
    for (const t of this.ticksSorted()) {
      if (t >= price) break;
      prev = t;
    }
    return prev;
  }
  checkpointAt(block: bigint): Checkpoint | undefined {
    const c = this.checkpoints.get(block);
    return c ? { ...c } : undefined;
  }
  getBids(): readonly EngineBid[] {
    return this.bids;
  }

  // ----- mutations -----

  /** Port of ContinuousClearingAuction.checkpoint(): clamps to endBlock after the auction. */
  checkpoint(block: bigint): Checkpoint {
    if (block < this.config.startBlock) throw new AuctionError('AuctionNotStarted');
    return this.checkpointAtBlock(block > this.config.endBlock ? this.config.endBlock : block);
  }

  /** Port of submitBid(maxPrice, amount, owner, prevTickPrice, hookData). Returns the bid id. */
  submitBid(block: bigint, maxPrice: bigint, amount: bigint, owner = 'self'): number {
    if (block < this.config.startBlock) throw new AuctionError('AuctionNotStarted');
    if (block >= this.config.endBlock) throw new AuctionError('AuctionIsOver');
    if (amount <= 0n) throw new AuctionError('BidAmountTooSmall');
    if (amount >= 1n << 128n) throw new AuctionError('InvalidAmount', 'amount exceeds uint128');
    if (maxPrice > this.config.maxBidPrice) throw new AuctionError('InvalidBidPriceTooHigh');
    const cp = this.checkpointAtBlock(block);
    if (MPS - cp.cumulativeMps === 0n || this.remainingSupplyQ96X7 === 0n) {
      throw new AuctionError('AuctionSoldOut');
    }
    if (maxPrice <= cp.clearingPrice) throw new AuctionError('BidMustBeAboveClearingPrice');
    if (maxPrice % this.config.tickSpacing !== 0n) throw new AuctionError('TickPriceNotAtBoundary');
    if (maxPrice === MAX_TICK_PTR) throw new AuctionError('InvalidTickPrice');
    if (!this.tickDemand.has(maxPrice)) {
      this.tickDemand.set(maxPrice, 0n);
      this.sortedTicks = undefined;
    }
    const amountQ96 = amount << 96n;
    const bid: EngineBid = {
      id: this.bids.length,
      owner,
      startBlock: block,
      startCumulativeMps: cp.cumulativeMps,
      maxPrice,
      amountQ96,
    };
    this.bids.push(bid);
    const effective = (amountQ96 * MPS) / (MPS - cp.cumulativeMps);
    this.tickDemand.set(maxPrice, (this.tickDemand.get(maxPrice) ?? 0n) + effective);
    this.sumAbove += effective;
    if (this.sumAbove >= X7_UPPER_BOUND) throw new AuctionError('InvalidBidUnableToClear');
    return bid.id;
  }

  /** Settle a bid as exitBid / exitPartiallyFilledBid would after the end block. */
  settle(bidId: number): BidOutcome {
    const bid = this.bids[bidId];
    if (!bid) throw new AuctionError('BidIdDoesNotExist');
    const final = this.checkpoint(this.config.endBlock);
    const amount = bid.amountQ96 >> 96n;
    const base = { id: bid.id, owner: bid.owner, maxPrice: bid.maxPrice, amount };
    if (!this.isGraduated) {
      return {
        ...base,
        tokensFilled: 0n,
        currencySpent: 0n,
        currencyRefunded: amount,
        status: 'refunded',
      };
    }
    const start = this.cp(bid.startBlock);
    let tokens: bigint;
    let spentQ96: bigint;
    let status: BidOutcome['status'];
    if (bid.maxPrice > final.clearingPrice) {
      [tokens, spentQ96] = this.calculateFill(bid, final, start);
      status = 'full';
    } else {
      // Walk checkpoints from the bid's start to find the last fully filled one and the
      // checkpoint where the bid stopped being fully filled.
      let lastFull = start;
      let cursor = start;
      while (cursor.next !== 0n && cursor.next !== (1n << 64n) - 1n) {
        const nxt = this.cp(cursor.next);
        if (nxt.clearingPrice >= bid.maxPrice) break;
        lastFull = nxt;
        cursor = nxt;
      }
      [tokens, spentQ96] = this.calculateFill(bid, lastFull, start);
      let upper: Checkpoint;
      if (final.clearingPrice === bid.maxPrice) {
        upper = final;
        status = 'partial';
      } else {
        // Outbid: upper is the checkpoint before the first one priced above maxPrice.
        let c = lastFull;
        while (c.next !== (1n << 64n) - 1n) {
          const nxt = this.cp(c.next);
          if (nxt.clearingPrice > bid.maxPrice) break;
          c = nxt;
        }
        upper = c;
        status = 'outbid';
      }
      if (upper.clearingPrice === bid.maxPrice) {
        const [pt, ps] = this.accountPartial(bid, this.tickDemandQ96(bid.maxPrice), upper);
        tokens += pt;
        spentQ96 += ps;
      }
    }
    const refund = saturatingSub(bid.amountQ96, spentQ96) >> 96n;
    return {
      ...base,
      tokensFilled: tokens,
      currencySpent: amount - refund,
      currencyRefunded: refund,
      status,
    };
  }

  // ----- internals -----

  private cp(block: bigint): Checkpoint {
    const c = this.checkpoints.get(block);
    if (!c) throw new AuctionError('CheckpointMissing', `no checkpoint at block ${block}`);
    return c;
  }

  private ticksSorted(): bigint[] {
    if (!this.sortedTicks) {
      this.sortedTicks = [...this.tickDemand.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    return this.sortedTicks;
  }

  /** Port of _iterateOverTicksAndFindClearingPrice(MAX_TICK_PTR, cumulativeMps). */
  private iterate(cumulativeMps: bigint): bigint {
    let minimumClearing = this.clearing;
    let demandAbove = this.sumAbove;
    const remainingMps = MPS - cumulativeMps;
    const remainingSupply = this.remainingSupplyQ96X7;
    if (remainingSupply === 0n || remainingMps === 0n) return minimumClearing;
    const ticks = this.ticksSorted();
    let idx = ticks.findIndex((t) => t > this.clearing);
    let nextActive = idx === -1 ? MAX_TICK_PTR : (ticks[idx] as bigint);
    const priceCeil = (d: bigint) => mulDivUp(d * remainingMps, Q96, remainingSupply);
    const canClear = (price: bigint) => demandAbove * remainingMps * Q96 >= remainingSupply * price;
    let clearing = priceCeil(demandAbove);
    while ((nextActive !== MAX_TICK_PTR && canClear(nextActive)) || clearing === nextActive) {
      demandAbove -= this.tickDemand.get(nextActive) ?? 0n;
      minimumClearing = nextActive;
      idx += 1;
      nextActive = idx < ticks.length ? (ticks[idx] as bigint) : MAX_TICK_PTR;
      clearing = priceCeil(demandAbove);
    }
    this.sumAbove = demandAbove;
    return clearing < minimumClearing ? minimumClearing : clearing;
  }

  /** Port of _checkpointAtBlock. */
  private checkpointAtBlock(block: bigint): Checkpoint {
    const last = this.lastBlock;
    if (block === last) return { ...this.cp(last) };
    if (block < last) throw new AuctionError('CheckpointBlockNotIncreasing');
    const cp: Checkpoint = { ...this.cp(last) };
    if (MPS - cp.cumulativeMps > 0n) {
      const newClearing = this.iterate(cp.cumulativeMps);
      if (newClearing !== cp.clearingPrice) {
        cp.clearingPrice = newClearing;
        cp.currencyRaisedAtClearingPriceQ96X7 = 0n;
        this.clearing = newClearing;
      }
    }
    const steps = this.config.steps;
    const deltaMps = cumulativeMpsAt(steps, block) - cumulativeMpsAt(steps, last);
    if (deltaMps > 0n) {
      const remaining = this.remainingSupplyQ96X7;
      if (remaining > 0n) {
        const price = cp.clearingPrice;
        let raisedDelta = this.sumAbove * deltaMps;
        if (price % this.config.tickSpacing === 0n) {
          const demandAt = this.tickDemand.get(price) ?? 0n;
          if (demandAt > 0n) {
            const atPrice = currencyRaisedAtPrice(
              remaining,
              demandAt,
              this.sumAbove,
              price,
              deltaMps,
              MPS - cp.cumulativeMps,
            );
            raisedDelta += atPrice;
            cp.currencyRaisedAtClearingPriceQ96X7 += atPrice;
          }
        }
        const tokensCleared = mulDivUp(raisedDelta, Q96, price);
        this.totalClearedQ96X7 = minBig(
          this.totalClearedQ96X7 + tokensCleared,
          this.totalSupplyQ96X7,
        );
        this.currencyRaisedQ96X7 += raisedDelta;
        cp.cumulativeMpsPerPrice += (deltaMps << 192n) / price;
      }
      cp.cumulativeMps += deltaMps;
    }
    cp.prev = last;
    cp.next = (1n << 64n) - 1n;
    const prevCp = this.cp(last);
    prevCp.next = block;
    this.checkpoints.set(block, cp);
    this.lastBlock = block;
    return { ...cp };
  }

  private calculateFill(bid: EngineBid, upper: Checkpoint, start: Checkpoint): [bigint, bigint] {
    const remaining = MPS - bid.startCumulativeMps;
    const mpsDelta = upper.cumulativeMps - start.cumulativeMps;
    const mppDelta = upper.cumulativeMpsPerPrice - start.cumulativeMpsPerPrice;
    const spent = mulDivUp(bid.amountQ96, mpsDelta, remaining);
    const tokens = mulDiv(bid.amountQ96, mppDelta, (1n << 192n) * remaining);
    return [tokens, spent];
  }

  private accountPartial(bid: EngineBid, tickDemand: bigint, upper: Checkpoint): [bigint, bigint] {
    if (tickDemand === 0n) return [0n, 0n];
    const denom = tickDemand * (MPS - bid.startCumulativeMps);
    const raised = upper.currencyRaisedAtClearingPriceQ96X7;
    const spent = mulDivUp(bid.amountQ96, raised, denom);
    const tokens = mulDiv(bid.amountQ96, raised, denom) / bid.maxPrice;
    return [tokens, spent];
  }
}

/** Port of DemandLib.currencyRaisedAtPrice. */
export function currencyRaisedAtPrice(
  remainingSupplyQ96X7: bigint,
  demandAtPriceQ96: bigint,
  demandAbovePriceQ96: bigint,
  priceQ96: bigint,
  deltaMps: bigint,
  remainingMps: bigint,
): bigint {
  const fromAbove = demandAbovePriceQ96 * deltaMps;
  const maxFromAt = demandAtPriceQ96 * deltaMps;
  const total = mulDivUp(remainingSupplyQ96X7, priceQ96 * deltaMps, Q96 * remainingMps);
  const complement = saturatingSub(total, fromAbove);
  return complement < maxFromAt ? complement : maxFromAt;
}
