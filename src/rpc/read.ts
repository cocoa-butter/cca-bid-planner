/**
 * Read-only RPC adapter: builds an AuctionSnapshot from chain state with viem.
 * Never signs; `checkpoint()` is only simulated with eth_call.
 */
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  decodeAbiParameters,
  erc20Abi,
  http,
  type PublicClient,
  parseAbiItem,
  parseAbiParameters,
} from 'viem';
import { ccaAbi, tickDataLensAbi } from '../abi/cca.js';
import { MAX_TICK_PTR, ZERO_ADDRESS } from '../core/constants.js';
import type { Checkpoint } from '../core/engine.js';
import type { AuctionSnapshot, TokenInfo } from '../core/snapshot.js';

/** CCALens v2.0.0, canonical address (upstream README). */
export const CCA_LENS_ADDRESS = '0xc3C65F5453A3674aDb693cbdA3C842545cD30f53' as const;
/** ContinuousClearingAuctionFactory v2.0.0, canonical address (upstream README). */
export const CCA_FACTORY_ADDRESS = '0x00cCa200BF124dBfA848937c553864f4B4CE0632' as const;

const auctionCreatedEvent = parseAbiItem(
  'event AuctionCreated(address indexed auction, address indexed token, uint256 amount, bytes configData)',
);

export interface ReadOptions {
  blockNumber?: bigint;
  /** Overrides requiredCurrencyRaised when it cannot be found in factory logs. */
  requiredCurrencyRaised?: bigint;
  /** Max blocks per eth_getLogs request. Default 5000. */
  logChunk?: bigint;
  /** How far before startBlock to search for the AuctionCreated log. Default 500_000 blocks. */
  logLookback?: bigint;
  /** Hard cap on initialized ticks to read. Default 2000. */
  maxTicks?: number;
  onProgress?: (msg: string) => void;
}

export function clientFor(rpcUrl: string): PublicClient {
  return createPublicClient({
    transport: http(rpcUrl, { retryCount: 3, batch: true }),
  }) as PublicClient;
}

export async function readSnapshot(
  client: PublicClient,
  auction: Address,
  opts: ReadOptions = {},
): Promise<{ snapshot: AuctionSnapshot; notes: string[] }> {
  const notes: string[] = [];
  const blockNumber = opts.blockNumber ?? (await client.getBlockNumber());
  const chainId = await client.getChainId();
  const at = { blockNumber } as const;
  const c = { address: auction, abi: ccaAbi } as const;

  const code = await client.getCode({ address: auction, ...at });
  if (!code || code === '0x') throw new Error(`no contract at ${auction} on chain ${chainId}`);

  const [
    token,
    currency,
    totalSupply,
    floorPrice,
    tickSpacing,
    maxBidPrice,
    startBlock,
    endBlock,
    claimBlock,
    tokensRecipient,
    fundsRecipient,
    validationHook,
    pointer,
    clearingPrice,
    sumAbove,
    currencyRaisedQ96X7,
    totalClearedQ96X7,
    lastCheckpointedBlock,
    latestCheckpoint,
    nextActiveTickPrice,
  ] = await Promise.all([
    client.readContract({ ...c, functionName: 'token', ...at }),
    client.readContract({ ...c, functionName: 'currency', ...at }),
    client.readContract({ ...c, functionName: 'totalSupply', ...at }),
    client.readContract({ ...c, functionName: 'floorPrice', ...at }),
    client.readContract({ ...c, functionName: 'tickSpacing', ...at }),
    client.readContract({ ...c, functionName: 'MAX_BID_PRICE', ...at }),
    client.readContract({ ...c, functionName: 'startBlock', ...at }),
    client.readContract({ ...c, functionName: 'endBlock', ...at }),
    client.readContract({ ...c, functionName: 'claimBlock', ...at }),
    client.readContract({ ...c, functionName: 'tokensRecipient', ...at }),
    client.readContract({ ...c, functionName: 'fundsRecipient', ...at }),
    client.readContract({ ...c, functionName: 'validationHook', ...at }),
    client.readContract({ ...c, functionName: 'pointer', ...at }),
    client.readContract({ ...c, functionName: 'clearingPrice', ...at }),
    client.readContract({ ...c, functionName: 'sumCurrencyDemandAboveClearingQ96', ...at }),
    client.readContract({ ...c, functionName: 'currencyRaisedQ96X7', ...at }),
    client.readContract({ ...c, functionName: 'totalClearedQ96X7', ...at }),
    client.readContract({ ...c, functionName: 'lastCheckpointedBlock', ...at }),
    client.readContract({ ...c, functionName: 'latestCheckpoint', ...at }),
    client.readContract({ ...c, functionName: 'nextActiveTickPrice', ...at }),
  ]);

  // Steps live in an SSTORE2 data contract: runtime code is 0x00 followed by the data.
  const stepsCode = await client.getCode({ address: pointer, ...at });
  if (!stepsCode || stepsCode.length < 4) throw new Error('could not read auctionStepsData');
  const auctionStepsData = `0x${stepsCode.slice(4)}` as `0x${string}`;

  const [tokenInfo, currencyInfo] = await Promise.all([
    tokenMeta(client, token, blockNumber),
    currency === ZERO_ADDRESS
      ? Promise.resolve<TokenInfo>({ address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 })
      : tokenMeta(client, currency, blockNumber),
  ]);

  // Simulate checkpoint() to learn whether tokens arrived and to cross-check the engine.
  let tokensReceived = true;
  let simulatedCheckpoint: Checkpoint | undefined;
  try {
    const sim = await client.simulateContract({
      ...c,
      functionName: 'checkpoint',
      account: ZERO_ADDRESS,
      ...at,
    });
    simulatedCheckpoint = toCheckpoint(sim.result);
  } catch (e) {
    const reason = revertName(e);
    if (reason === 'TokensNotReceived') tokensReceived = false;
    else if (reason === 'AuctionNotStarted') {
      const bal = await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [auction],
        ...at,
      });
      tokensReceived = bal >= totalSupply;
      notes.push('auction not started: tokensReceived inferred from token balance');
    } else notes.push(`checkpoint() simulation failed: ${reason}`);
  }

  // Initialized ticks from the next active tick upward, plus the clearing tick itself.
  const ticks = await readTicks(client, auction, nextActiveTickPrice, blockNumber, opts, notes);
  if (clearingPrice % tickSpacing === 0n) {
    const t = await client.readContract({
      ...c,
      functionName: 'ticks',
      args: [clearingPrice],
      ...at,
    });
    if (t.next !== 0n)
      ticks.unshift({ price: clearingPrice, currencyDemandQ96: t.currencyDemandQ96 });
  }

  const required = await findRequiredRaise(client, auction, startBlock, blockNumber, opts, notes);

  const snapshot: AuctionSnapshot = {
    version: 1,
    chainId,
    auction,
    blockNumber,
    token: tokenInfo,
    currency: currencyInfo,
    totalSupply,
    floorPrice,
    tickSpacing,
    maxBidPrice,
    startBlock,
    endBlock,
    claimBlock,
    requiredCurrencyRaised: required,
    tokensRecipient,
    fundsRecipient,
    validationHook,
    auctionStepsData,
    tokensReceived,
    state: {
      clearingPrice,
      sumCurrencyDemandAboveClearingQ96: sumAbove,
      currencyRaisedQ96X7,
      totalClearedQ96X7,
      lastCheckpointedBlock,
      latestCheckpoint: toCheckpoint(latestCheckpoint),
      ticks,
      ...(simulatedCheckpoint ? { simulatedCheckpoint } : {}),
    },
  };
  return { snapshot, notes };
}

async function tokenMeta(
  client: PublicClient,
  address: Address,
  blockNumber: bigint,
): Promise<TokenInfo> {
  const at = { blockNumber } as const;
  const [symbol, decimals] = await Promise.all([
    client
      .readContract({ address, abi: erc20Abi, functionName: 'symbol', ...at })
      .catch(() => '???'),
    client.readContract({ address, abi: erc20Abi, functionName: 'decimals', ...at }),
  ]);
  return { address, symbol, decimals };
}

async function readTicks(
  client: PublicClient,
  auction: Address,
  nextActive: bigint,
  blockNumber: bigint,
  opts: ReadOptions,
  notes: string[],
): Promise<Array<{ price: bigint; currencyDemandQ96: bigint }>> {
  if (nextActive === MAX_TICK_PTR) return [];
  const lensCode = await client
    .getCode({ address: CCA_LENS_ADDRESS, blockNumber })
    .catch(() => undefined);
  if (lensCode && lensCode !== '0x') {
    try {
      const data = await client.readContract({
        address: CCA_LENS_ADDRESS,
        abi: tickDataLensAbi,
        functionName: 'getInitializedTickData',
        args: [auction],
        blockNumber,
      });
      if (data.length < 1000) {
        return data.map((t) => ({ price: t.priceQ96, currencyDemandQ96: t.currencyDemandQ96 }));
      }
      notes.push('lens returned its 1000-tick maximum; walking the tick list instead');
    } catch {
      notes.push('CCALens call failed; walking the tick list');
    }
  }
  const out: Array<{ price: bigint; currencyDemandQ96: bigint }> = [];
  const max = opts.maxTicks ?? 2000;
  let price = nextActive;
  while (price !== MAX_TICK_PTR && out.length < max) {
    const t = await client.readContract({
      address: auction,
      abi: ccaAbi,
      functionName: 'ticks',
      args: [price],
      blockNumber,
    });
    out.push({ price, currencyDemandQ96: t.currencyDemandQ96 });
    price = t.next;
  }
  if (price !== MAX_TICK_PTR) notes.push(`tick list truncated at ${max} ticks`);
  return out;
}

async function findRequiredRaise(
  client: PublicClient,
  auction: Address,
  startBlock: bigint,
  head: bigint,
  opts: ReadOptions,
  notes: string[],
): Promise<bigint> {
  if (opts.requiredCurrencyRaised !== undefined) {
    notes.push('requiredCurrencyRaised taken from --required-raise');
    return opts.requiredCurrencyRaised;
  }
  // requiredCurrencyRaised has no view; it is in the factory's AuctionCreated configData.
  const chunk = opts.logChunk ?? 5000n;
  const lookback = opts.logLookback ?? 500_000n;
  const top = startBlock < head ? startBlock : head;
  const floor = top > lookback ? top - lookback : 0n;
  for (let to = top; to >= floor; to -= chunk) {
    const from = to - chunk + 1n > floor ? to - chunk + 1n : floor;
    opts.onProgress?.(`searching AuctionCreated in blocks ${from}-${to}`);
    const logs = await client
      .getLogs({
        address: CCA_FACTORY_ADDRESS,
        event: auctionCreatedEvent,
        args: { auction },
        fromBlock: from,
        toBlock: to,
      })
      .catch(() => []);
    const log = logs[0];
    if (log?.args.configData) {
      const params = decodeParams(log.args.configData);
      notes.push(`requiredCurrencyRaised read from AuctionCreated at block ${log.blockNumber}`);
      return params;
    }
    if (from === floor) break;
  }
  throw new Error(
    'requiredCurrencyRaised not found in factory logs; pass --required-raise <raw amount> (it has no on-chain view)',
  );
}

/** configData is abi.encode(AuctionParameters), as the factory abi.decodes it. */
const auctionParametersType = parseAbiParameters(
  '(address currency, address tokensRecipient, address fundsRecipient, uint64 startBlock, uint64 endBlock, uint64 claimBlock, uint256 tickSpacing, address validationHook, uint256 floorPrice, uint128 requiredCurrencyRaised, bytes auctionStepsData)',
);

function decodeParams(configData: `0x${string}`): bigint {
  const [params] = decodeAbiParameters(auctionParametersType, configData);
  return params.requiredCurrencyRaised;
}

function toCheckpoint(c: {
  clearingPrice: bigint;
  currencyRaisedAtClearingPriceQ96X7: bigint;
  cumulativeMpsPerPrice: bigint;
  cumulativeMps: number;
  prev: bigint;
  next: bigint;
}): Checkpoint {
  return {
    clearingPrice: c.clearingPrice,
    currencyRaisedAtClearingPriceQ96X7: c.currencyRaisedAtClearingPriceQ96X7,
    cumulativeMpsPerPrice: c.cumulativeMpsPerPrice,
    cumulativeMps: BigInt(c.cumulativeMps),
    prev: c.prev,
    next: c.next,
  };
}

function revertName(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError)
      return r.data?.errorName ?? r.reason ?? 'reverted';
    return e.shortMessage;
  }
  return String(e);
}
