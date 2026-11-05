/**
 * Auction listings from Uniswap's public data API (the same service app.uniswap.org uses for
 * its Auctions tab). One indexed request returns auctions with their parameters, so nothing
 * here scans chain history.
 *
 * The API does not send CORS headers for other sites, so browsers go through this project's
 * proxy (/api/uniswap/<method> on the website); Node calls it directly.
 */
import type { Address, Hex } from 'viem';

export const UNISWAP_AUCTION_API =
  'https://entry-gateway.backend-prod.api.uniswap.org/data.v1.AuctionService';

export interface ApiOptions {
  /** Base URL of the AuctionService, or of a proxy with the same method paths. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** One auction as reported by the API, normalised to bigints. */
export interface ApiAuction {
  chainId: number;
  address: Address;
  tokenAddress: Address;
  tokenSymbol: string;
  tokenName: string;
  tokenDecimals: number;
  tokenImageUrl?: string;
  currency: Address;
  currencySymbol: string;
  currencyName: string;
  currencyDecimals: number;
  /** USD price of one whole currency unit, if the API knows it. */
  currencyPriceUsd?: number;
  totalSupply: bigint;
  startBlock: bigint;
  endBlock: bigint;
  claimBlock: bigint;
  floorPrice: bigint;
  clearingPrice: bigint;
  tickSpacing: bigint;
  requiredCurrencyRaised: bigint;
  validationHook: Address;
  auctionStepsData: Hex;
  totalBidVolume: bigint;
  totalBidVolumeUsd?: number;
  uniqueBidders?: number;
  isGraduated: boolean;
  /** True when Uniswap flags the token (spam, scam reports, etc.). */
  isFlagged: boolean;
  /** Uniswap's token screening result, e.g. PROTECTION_RESULT_BENIGN. */
  protection?: string;
  createdAt?: string;
}

type Json = Record<string, unknown>;

async function call(method: string, body: Json, opts: ApiOptions): Promise<Json> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${opts.baseUrl ?? UNISWAP_AUCTION_API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'connect-protocol-version': '1' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string }).message ?? '';
    } catch {
      // body was not JSON
    }
    throw new Error(`Uniswap auction API ${method} failed: HTTP ${res.status} ${detail}`.trim());
  }
  return (await res.json()) as Json;
}

const big = (v: unknown, d = 0n): bigint => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return d;
};
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

/** Normalise one API record. Accepts both the list item shape and the bare auction shape. */
export function normaliseAuction(item: Json): ApiAuction {
  const a = (item.auction as Json | undefined) ?? item;
  const out: ApiAuction = {
    chainId: Number(a.chainId),
    address: str(a.address) as Address,
    tokenAddress: str(a.tokenAddress) as Address,
    tokenSymbol: str(a.tokenSymbol, '???'),
    tokenName: str(a.tokenName, str(a.tokenSymbol, 'Unknown token')),
    tokenDecimals: Number(a.tokenDecimals ?? 18),
    currency: str(a.currency) as Address,
    currencySymbol: str(a.currencyTokenSymbol, 'ETH'),
    currencyName: str(a.currencyTokenName, 'Ether'),
    currencyDecimals: Number(a.currencyTokenDecimals ?? 18),
    totalSupply: big(a.totalSupply ?? a.amount),
    startBlock: big(a.startBlock),
    endBlock: big(a.endBlock),
    claimBlock: big(a.claimBlock),
    floorPrice: big(a.floorPrice),
    // The index reports 0 before the first checkpoint; the contract starts at the floor.
    clearingPrice: big(a.clearingPrice) > 0n ? big(a.clearingPrice) : big(a.floorPrice),
    tickSpacing: big(a.tickSize),
    requiredCurrencyRaised: big(a.requiredCurrencyRaised),
    validationHook: str(a.validationHook, '0x0000000000000000000000000000000000000000') as Address,
    auctionStepsData: str(a.auctionStepsData, '0x') as Hex,
    totalBidVolume: big(item.totalBidVolume ?? a.totalBidVolume),
    isGraduated: Boolean(a.isGraduated),
    isFlagged: Boolean(a.isFlagged),
  };
  const image = str(a.tokenImageUrl);
  if (image) out.tokenImageUrl = image;
  const cp = num(a.currencyPriceUsd);
  if (cp !== undefined) out.currencyPriceUsd = cp;
  const vol = num(a.totalBidVolumeUsd);
  if (vol !== undefined) out.totalBidVolumeUsd = vol;
  const bidders = num(item.uniqueBidderCount);
  if (bidders !== undefined) out.uniqueBidders = bidders;
  const prot = (a.tokenProtectionInfo as Json | undefined)?.result;
  if (typeof prot === 'string') out.protection = prot;
  const created = str(a.createdAt);
  if (created) out.createdAt = created;
  return out;
}

/** List auctions on the given chains, following pagination up to `maxPages`. */
export async function listAuctions(
  chainIds: number[],
  opts: ApiOptions & { maxPages?: number } = {},
): Promise<ApiAuction[]> {
  const out: ApiAuction[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < (opts.maxPages ?? 10); page++) {
    const body: Json = { chainIds };
    if (pageToken) body.pageToken = pageToken;
    const res = await call('ListTopAuctions', body, opts);
    for (const item of (res.auctions as Json[] | undefined) ?? []) {
      const a = normaliseAuction(item);
      const key = `${a.chainId}:${a.address.toLowerCase()}`;
      if (!seen.has(key) && chainIds.includes(a.chainId)) {
        seen.add(key);
        out.push(a);
      }
    }
    pageToken =
      typeof res.nextPageToken === 'string' && res.nextPageToken ? res.nextPageToken : undefined;
    if (!pageToken) break;
  }
  return out;
}

/** One auction by chain and address. Returns undefined when the API does not know it. */
export async function getAuction(
  chainId: number,
  address: Address,
  opts: ApiOptions = {},
): Promise<ApiAuction | undefined> {
  const res = await call('GetAuction', { chainId, address }, opts);
  const items = (res.auctions as Json[] | undefined) ?? (res.auction ? [res as Json] : []);
  const first = items[0];
  return first ? normaliseAuction(first) : undefined;
}
