/**
 * Chains with CCA v2 auctions, each with a public RPC and block explorer. Factory and
 * CCALens code presence was checked on 2026-11-05.
 */
export type Clock = 'block' | 'arbitrum' | 'unichain-flashblock';

export interface ChainInfo {
  id: number;
  /** Short key for the CLI, e.g. --chain robinhood. */
  key: string;
  name: string;
  rpc: string;
  explorer: string;
  /**
   * How the auction contract counts blocks (upstream BlockNumberish):
   * - block: block.number, same as eth_blockNumber
   * - arbitrum: ArbSys.arbBlockNumber() on Arbitrum and Orbit chains
   * - unichain-flashblock: the Unichain flashblock counter, about 2x eth_blockNumber
   */
  clock: Clock;
}

export const CHAINS: readonly ChainInfo[] = [
  {
    id: 1,
    key: 'ethereum',
    name: 'Ethereum',
    rpc: 'https://ethereum-rpc.publicnode.com',
    explorer: 'https://etherscan.io',
    clock: 'block',
  },
  {
    id: 8453,
    key: 'base',
    name: 'Base',
    rpc: 'https://base-rpc.publicnode.com',
    explorer: 'https://basescan.org',
    clock: 'block',
  },
  {
    id: 130,
    key: 'unichain',
    name: 'Unichain',
    rpc: 'https://unichain-rpc.publicnode.com',
    explorer: 'https://uniscan.xyz',
    clock: 'unichain-flashblock',
  },
  {
    id: 42161,
    key: 'arbitrum',
    name: 'Arbitrum One',
    rpc: 'https://arbitrum-one-rpc.publicnode.com',
    explorer: 'https://arbiscan.io',
    clock: 'arbitrum',
  },
  {
    id: 4663,
    key: 'robinhood',
    name: 'Robinhood Chain',
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    explorer: 'https://robinhoodchain.blockscout.com',
    clock: 'arbitrum',
  },
];

export function chainById(id: number): ChainInfo | undefined {
  return CHAINS.find((c) => c.id === id);
}

/** Look up by key ("robinhood"), name ("Robinhood Chain") or id ("4663"). */
export function findChain(q: string): ChainInfo | undefined {
  const s = q.trim().toLowerCase();
  return CHAINS.find((c) => c.key === s || c.name.toLowerCase() === s || String(c.id) === s);
}

/** Unichain flashblock number contract and selector (upstream BlockNumberish). */
export const UNICHAIN_FLASHBLOCK_NUMBER = '0x3c3A8a41E095C76b03f79f70955fFf3b03cf753E' as const;
export const UNICHAIN_FLASHBLOCK_SELECTOR = '0xe5b37c5d' as const;
/** ArbSys precompile, arbBlockNumber() selector. */
export const ARB_SYS = '0x0000000000000000000000000000000000000064' as const;
export const ARB_BLOCK_NUMBER_SELECTOR = '0xa3b1b31d' as const;
