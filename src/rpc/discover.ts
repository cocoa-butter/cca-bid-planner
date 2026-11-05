/**
 * Auction discovery: Uniswap's auction API for the list (one indexed request, no log
 * scanning) plus a few RPC reads per chain for the live clock, so status and time left are
 * exact even when the API lags.
 */
import type { PublicClient } from 'viem';
import { auctionClock } from './clock.js';
import { type ApiAuction, type ApiOptions, listAuctions } from './uniswap-api.js';

export type AuctionStatus = 'upcoming' | 'live' | 'ended';

export interface AuctionListing extends ApiAuction {
  status: AuctionStatus;
  /** Auction clock now (see ChainInfo.clock). */
  clockNow: bigint;
  /** Estimated milliseconds until start (upcoming) or end (live). */
  msUntilStart?: number;
  msUntilEnd?: number;
}

export function statusAt(
  a: { startBlock: bigint; endBlock: bigint },
  clock: bigint,
): AuctionStatus {
  if (clock < a.startBlock) return 'upcoming';
  if (clock < a.endBlock) return 'live';
  return 'ended';
}

/**
 * Milliseconds per tick of the auction clock, measured over the last `span` RPC blocks
 * (recent state only, so non-archive RPCs work).
 */
export async function clockRate(
  client: PublicClient,
  chainId: number,
  span = 50n,
): Promise<number> {
  const head = await client.getBlock();
  const past = await client.getBlock({ blockNumber: head.number - span });
  const [c1, c0] = await Promise.all([
    auctionClock(client, chainId, head.number),
    auctionClock(client, chainId, past.number),
  ]);
  const ticks = Number(c1 - c0);
  const ms = Number(head.timestamp - past.timestamp) * 1000;
  return ticks > 0 && ms > 0 ? ms / ticks : 1000;
}

/** Add status and time estimates to API auctions, given the chain's clock now and its rate. */
export function withStatus(
  auctions: ApiAuction[],
  clockNow: bigint,
  msPerTick?: number,
): AuctionListing[] {
  return sortListings(
    auctions.map((a): AuctionListing => {
      const status = statusAt(a, clockNow);
      const l: AuctionListing = { ...a, status, clockNow };
      if (msPerTick !== undefined) {
        if (status === 'upcoming') l.msUntilStart = Number(a.startBlock - clockNow) * msPerTick;
        if (status !== 'ended') l.msUntilEnd = Number(a.endBlock - clockNow) * msPerTick;
      }
      return l;
    }),
  );
}

/**
 * List auctions on a chain with live status and time estimates. Live auctions come first
 * (ending soonest first), then upcoming (starting soonest first), then ended (newest first).
 */
export async function discoverAuctions(
  client: PublicClient,
  chainId: number,
  opts: ApiOptions & { onProgress?: (msg: string) => void; maxPages?: number } = {},
): Promise<AuctionListing[]> {
  opts.onProgress?.('Fetching auctions...');
  const [auctions, clockNow, msPerTick] = await Promise.all([
    listAuctions([chainId], opts),
    auctionClock(client, chainId),
    clockRate(client, chainId).catch(() => undefined),
  ]);
  return withStatus(auctions, clockNow, msPerTick);
}

const RANK: Record<AuctionStatus, number> = { live: 0, upcoming: 1, ended: 2 };

export function sortListings(list: AuctionListing[]): AuctionListing[] {
  const cmp = (x: bigint, y: bigint) => (x < y ? -1 : x > y ? 1 : 0);
  return [...list].sort((a, b) => {
    if (a.status !== b.status) return RANK[a.status] - RANK[b.status];
    if (a.status === 'live') return cmp(a.endBlock, b.endBlock);
    if (a.status === 'upcoming') return cmp(a.startBlock, b.startBlock);
    return cmp(b.endBlock, a.endBlock);
  });
}

/** "2d 4h", "35m", "under a minute". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'under a minute';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mm}m`;
  return `${mm}m`;
}
