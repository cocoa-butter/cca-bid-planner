import { MPS } from './constants.js';

/** One record of auctionStepsData, with absolute block bounds. */
export interface AuctionStep {
  /** Share of total supply released per block, in MPS (1e7 = 100%). */
  mps: number;
  /** Number of blocks in the step. */
  blockDelta: number;
  /** First block of the step (inclusive). */
  startBlock: bigint;
  /** End block of the step (exclusive). */
  endBlock: bigint;
}

/**
 * Decode packed `bytes8` step records: the high 24 bits are mps per block and the low
 * 40 bits are the block delta (StepLib.parse).
 */
export function parseSteps(data: `0x${string}` | string, startBlock: bigint): AuctionStep[] {
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  if (hex.length === 0 || hex.length % 16 !== 0) {
    throw new RangeError('auctionStepsData length must be a non-zero multiple of 8 bytes');
  }
  const steps: AuctionStep[] = [];
  let cursor = startBlock;
  for (let i = 0; i < hex.length; i += 16) {
    const word = BigInt(`0x${hex.slice(i, i + 16)}`);
    const mps = Number(word >> 40n);
    const blockDelta = Number(word & 0xffffffffffn);
    const endBlock = cursor + BigInt(blockDelta);
    steps.push({ mps, blockDelta, startBlock: cursor, endBlock });
    cursor = endBlock;
  }
  return steps;
}

/** Encode steps back into packed hex (useful for fixtures). */
export function encodeSteps(
  steps: ReadonlyArray<{ mps: number; blockDelta: number }>,
): `0x${string}` {
  let out = '0x';
  for (const s of steps) {
    if (s.mps < 0 || s.mps >= 2 ** 24) throw new RangeError('mps out of uint24 range');
    if (s.blockDelta <= 0 || s.blockDelta >= 2 ** 40)
      throw new RangeError('blockDelta out of uint40 range');
    const word = (BigInt(s.mps) << 40n) | BigInt(s.blockDelta);
    out += word.toString(16).padStart(16, '0');
  }
  return out as `0x${string}`;
}

/** Build steps from {mps, blockDelta} records and a start block. */
export function stepsFrom(
  records: ReadonlyArray<{ mps: number; blockDelta: number }>,
  startBlock: bigint,
): AuctionStep[] {
  return parseSteps(encodeSteps(records), startBlock);
}

/** Problems that StepStorage._validate would revert on. Empty array means valid. */
export function stepErrors(
  steps: readonly AuctionStep[],
  startBlock: bigint,
  endBlock: bigint,
): string[] {
  const errors: string[] = [];
  if (steps.length === 0) errors.push('no steps');
  let sumMps = 0n;
  let sumDelta = 0n;
  for (const s of steps) {
    if (s.blockDelta === 0) errors.push('a step has blockDelta 0');
    sumMps += BigInt(s.mps) * BigInt(s.blockDelta);
    sumDelta += BigInt(s.blockDelta);
  }
  if (sumMps !== MPS) errors.push(`steps sell ${sumMps} MPS, expected ${MPS}`);
  if (startBlock + sumDelta !== endBlock) {
    errors.push(`steps end at block ${startBlock + sumDelta}, expected ${endBlock}`);
  }
  return errors;
}

/** Cumulative MPS released by the schedule strictly before `block` (blocks [start, block)). */
export function cumulativeMpsAt(steps: readonly AuctionStep[], block: bigint): bigint {
  let total = 0n;
  for (const s of steps) {
    if (block <= s.startBlock) break;
    const upto = block < s.endBlock ? block : s.endBlock;
    total += BigInt(s.mps) * (upto - s.startBlock);
  }
  return total;
}

/** The step containing `block`, if any. */
export function stepAt(steps: readonly AuctionStep[], block: bigint): AuctionStep | undefined {
  return steps.find((s) => block >= s.startBlock && block < s.endBlock);
}
