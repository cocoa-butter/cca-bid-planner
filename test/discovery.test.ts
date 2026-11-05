import { describe, expect, it } from 'vitest';
import { findChain } from '../src/chains.js';
import { formatDuration, statusAt, withStatus } from '../src/rpc/discover.js';
import { listAuctions, normaliseAuction } from '../src/rpc/uniswap-api.js';

const item = {
  auction: {
    chainId: 4663,
    address: '0x9E6EA9FEA7FCF1De8B1AAdC064c2531972b3476c',
    tokenAddress: '0x2A9398DA1C518F86C10D16bD7d68ecF2FC75BdA2',
    tokenSymbol: '$ARYA',
    tokenName: 'ARYA',
    tokenDecimals: 18,
    currency: '0x0000000000000000000000000000000000000000',
    currencyTokenSymbol: 'ETH',
    currencyTokenName: 'Ether',
    currencyTokenDecimals: 18,
    totalSupply: '50000000000000000000000000',
    startBlock: '106523777',
    endBlock: '107339177',
    claimBlock: '107339177',
    floorPrice: '1636033732018849674300',
    clearingPrice: '0',
    tickSize: '16360337320188496743',
    requiredCurrencyRaised: '1032482000000000000',
    validationHook: '0x0000000000000000000000000000000000000000',
    auctionStepsData: '0x',
    isGraduated: false,
    isFlagged: false,
    tokenProtectionInfo: { result: 'PROTECTION_RESULT_BENIGN' },
  },
  totalBidVolume: '0',
  uniqueBidderCount: 0,
};

describe('Uniswap auction API', () => {
  it('normalises records to bigints and falls back to the floor before any bids', () => {
    const a = normaliseAuction(item);
    expect(a.chainId).toBe(4663);
    expect(a.requiredCurrencyRaised).toBe(1_032_482_000_000_000_000n);
    expect(a.clearingPrice).toBe(a.floorPrice);
    expect(a.currencySymbol).toBe('ETH');
    expect(a.protection).toBe('PROTECTION_RESULT_BENIGN');
  });

  it('follows pagination and keeps only the requested chain', async () => {
    const pages = [
      { auctions: [item, { auction: { ...item.auction, chainId: 1 } }], nextPageToken: 'p2' },
      {
        auctions: [
          item,
          { auction: { ...item.auction, address: '0x0000000000000000000000000000000000000001' } },
        ],
      },
    ];
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: { body: string }) => {
      calls.push(`${url} ${init.body}`);
      return new Response(JSON.stringify(pages[calls.length - 1]), { status: 200 });
    }) as unknown as typeof fetch;
    const list = await listAuctions([4663], { fetchImpl, baseUrl: '/api/uniswap' });
    expect(list).toHaveLength(2);
    expect(calls[0]).toBe('/api/uniswap/ListTopAuctions {"chainIds":[4663]}');
    expect(calls[1]).toContain('"pageToken":"p2"');
  });
});

describe('status and time', () => {
  it('classifies by the auction clock', () => {
    const a = { startBlock: 100n, endBlock: 200n };
    expect(statusAt(a, 99n)).toBe('upcoming');
    expect(statusAt(a, 100n)).toBe('live');
    expect(statusAt(a, 200n)).toBe('ended');
  });

  it('sorts live first and estimates time left', () => {
    const base = normaliseAuction(item);
    const list = withStatus(
      [
        { ...base, startBlock: 0n, endBlock: 10n },
        { ...base, startBlock: 2000n, endBlock: 3000n },
        { ...base, startBlock: 0n, endBlock: 5000n },
      ],
      1000n,
      250,
    );
    expect(list.map((x) => x.status)).toEqual(['live', 'upcoming', 'ended']);
    expect(list[0]?.msUntilEnd).toBe(4000 * 250);
    expect(formatDuration(list[0]?.msUntilEnd ?? 0)).toBe('16m');
    expect(formatDuration(26 * 3_600_000 + 5 * 60_000)).toBe('1d 2h');
  });

  it('knows Robinhood Chain uses the Arbitrum clock', () => {
    expect(findChain('robinhood')).toMatchObject({ id: 4663, clock: 'arbitrum' });
    expect(findChain('4663')?.name).toBe('Robinhood Chain');
    expect(findChain('unichain')?.clock).toBe('unichain-flashblock');
  });
});
