/**
 * submitBid calldata. Encoding only: nothing is signed or sent.
 */
import { type Address, encodeFunctionData, type Hex } from 'viem';
import { ccaAbi } from '../abi/cca.js';
import { PERMIT2_ADDRESS, ZERO_ADDRESS } from './constants.js';

export interface BidCall {
  to: Address;
  /** msg.value: equals amount for native ETH auctions, otherwise 0. */
  value: bigint;
  data: Hex;
  args: {
    maxPriceQ96: bigint;
    amount: bigint;
    owner: Address;
    prevTickPriceQ96: bigint;
    hookData: Hex;
  };
}

export interface CalldataInput {
  auction: Address;
  currency: Address;
  owner: Address;
  bids: ReadonlyArray<{ maxPrice: bigint; amount: bigint; prevTickPrice: bigint }>;
  hookData?: Hex;
}

export interface CalldataResult {
  calls: BidCall[];
  /** Total currency the owner must provide. */
  total: bigint;
  /** Steps the bidder must do before sending, e.g. Permit2 approval. */
  prerequisites: string[];
}

export function bidCalldata(input: CalldataInput): CalldataResult {
  if (input.owner === ZERO_ADDRESS) throw new Error('owner cannot be the zero address');
  const hookData = input.hookData ?? '0x';
  const native = input.currency === ZERO_ADDRESS;
  const calls: BidCall[] = input.bids.map((b) => {
    if (b.amount <= 0n || b.amount >= 1n << 128n)
      throw new RangeError('amount must fit in uint128 and be > 0');
    const args = {
      maxPriceQ96: b.maxPrice,
      amount: b.amount,
      owner: input.owner,
      prevTickPriceQ96: b.prevTickPrice,
      hookData,
    };
    const data = encodeFunctionData({
      abi: ccaAbi,
      functionName: 'submitBid',
      args: [args.maxPriceQ96, args.amount, args.owner, args.prevTickPriceQ96, args.hookData],
    });
    return { to: input.auction, value: native ? b.amount : 0n, data, args };
  });
  const total = input.bids.reduce((a, b) => a + b.amount, 0n);
  const prerequisites: string[] = [];
  if (native) {
    prerequisites.push('Native ETH auction: send each call with value equal to its amount.');
  } else {
    prerequisites.push(
      `ERC20 currency: submitBid pulls funds through Permit2 (${PERMIT2_ADDRESS}). Approve the currency to Permit2 and grant the auction a Permit2 allowance covering ${total} before sending.`,
    );
  }
  prerequisites.push(
    'Send the calls in the listed order (ascending price) so each prevTickPriceQ96 hint is already initialized.',
    'Each bid must stay strictly above the clearing price at the block it lands in, or it reverts with BidMustBeAboveClearingPrice.',
    'Never transfer currency to the auction directly; only submitBid credits it.',
  );
  return { calls, total, prerequisites };
}
