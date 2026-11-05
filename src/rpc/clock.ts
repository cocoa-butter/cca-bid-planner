/**
 * The block number an auction sees. Upstream BlockNumberish uses ArbSys.arbBlockNumber() on
 * Arbitrum and Orbit chains and a flashblock counter on Unichain, so eth_blockNumber is not
 * always the auction's clock.
 */
import { hexToBigInt, type PublicClient } from 'viem';
import {
  ARB_BLOCK_NUMBER_SELECTOR,
  ARB_SYS,
  chainById,
  UNICHAIN_FLASHBLOCK_NUMBER,
  UNICHAIN_FLASHBLOCK_SELECTOR,
} from '../chains.js';

/** ContinuousClearingAuctionFactory v2.0.0, canonical address (upstream README). */
export const CCA_FACTORY_ADDRESS = '0x00cCa200BF124dBfA848937c553864f4B4CE0632' as const;
/** CCALens v2.0.0, canonical address (upstream README). */
export const CCA_LENS_ADDRESS = '0xc3C65F5453A3674aDb693cbdA3C842545cD30f53' as const;

async function callUint(
  client: PublicClient,
  to: `0x${string}`,
  data: `0x${string}`,
  blockNumber?: bigint,
): Promise<bigint | undefined> {
  try {
    const res = await client.call({
      to,
      data,
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
    return res.data && res.data !== '0x' ? hexToBigInt(res.data) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Auction clock at an RPC block (default latest). Unknown chains are probed for ArbSys, the
 * same way the contract decides at deployment.
 */
export async function auctionClock(
  client: PublicClient,
  chainId: number,
  rpcBlock?: bigint,
): Promise<bigint> {
  const kind = chainById(chainId)?.clock;
  if (kind === 'unichain-flashblock' || chainId === 130) {
    const v = await callUint(
      client,
      UNICHAIN_FLASHBLOCK_NUMBER,
      UNICHAIN_FLASHBLOCK_SELECTOR,
      rpcBlock,
    );
    if (v !== undefined) return v;
  }
  if (kind === 'arbitrum' || kind === undefined) {
    const v = await callUint(client, ARB_SYS, ARB_BLOCK_NUMBER_SELECTOR, rpcBlock);
    if (v !== undefined) return v;
  }
  return rpcBlock ?? (await client.getBlockNumber());
}
