import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';
import { ccaAbi } from '../src/abi/cca.js';
import { run } from '../src/cli/main.js';
import { bidCalldata } from '../src/core/calldata.js';
import { maxBidPrice } from '../src/core/constants.js';
import { AuctionEngine } from '../src/core/engine.js';
import {
  engineFromSnapshot,
  snapshotFromJson,
  snapshotToJson,
  stateFromEngine,
} from '../src/core/snapshot.js';
import { stepsFrom } from '../src/core/steps.js';
import { demoSnapshot } from '../src/ui/demo-data.js';
import { slopSnapshot } from './fixtures/slop.js';

const OWNER = '0x1111111111111111111111111111111111111111';

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function tmpFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cca-'));
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe('snapshot', () => {
  it('round-trips through JSON', () => {
    const s = demoSnapshot();
    expect(snapshotFromJson(snapshotToJson(s))).toEqual(s);
  });

  it('resuming from a snapshot matches an uninterrupted engine to the wei', () => {
    const config = {
      totalSupply: 10n ** 24n,
      floorPrice: 2n ** 40n * 100n,
      tickSpacing: 2n ** 40n,
      startBlock: 10n,
      endBlock: 60n,
      requiredCurrencyRaised: 0n,
      maxBidPrice: maxBidPrice(10n ** 24n),
      steps: stepsFrom([{ mps: 200_000, blockDelta: 50 }], 10n),
    };
    const bids: Array<[bigint, bigint, bigint]> = [
      [10n, 2n ** 40n * 250n, 4n * 10n ** 8n],
      [20n, 2n ** 40n * 220n, 12n * 10n ** 8n],
      [30n, 2n ** 40n * 600n, 8n * 10n ** 8n],
      [40n, 2n ** 40n * 500n, 10n * 10n ** 8n],
    ];
    const a = AuctionEngine.fresh(config);
    const b = AuctionEngine.fresh(config);
    for (const [blk, p, amt] of bids.slice(0, 2)) {
      a.submitBid(blk, p, amt);
      b.submitBid(blk, p, amt);
    }
    b.checkpoint(25n);
    const resumed = new AuctionEngine(config, b.exportState());
    a.checkpoint(25n);
    for (const [blk, p, amt] of bids.slice(2)) {
      a.submitBid(blk, p, amt);
      resumed.submitBid(blk, p, amt);
    }
    a.checkpoint(60n);
    resumed.checkpoint(60n);
    expect(resumed.clearingPrice).toBe(a.clearingPrice);
    expect(resumed.currencyRaised).toBe(a.currencyRaised);
    expect(resumed.totalCleared).toBe(a.totalCleared);
    expect(resumed.settle(0)).toMatchObject({ ...a.settle(2), id: 0 });
    expect(resumed.settle(1)).toMatchObject({ ...a.settle(3), id: 1 });
    expect(a.clearingPrice).toBeGreaterThan(config.floorPrice);
  });

  it('stateFromEngine keeps every tick at or above clearing', () => {
    const s = demoSnapshot();
    const e = engineFromSnapshot(s);
    const st = stateFromEngine(e);
    expect(st.ticks.every((t) => t.price >= st.clearingPrice)).toBe(true);
    expect(st.ticks.length).toBe(s.state.ticks.length);
  });
});

describe('calldata', () => {
  it('encodes submitBid with the prevTickPrice overload', () => {
    const res = bidCalldata({
      auction: '0x000000000000000000000000000000000000dE30',
      currency: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      owner: OWNER,
      bids: [{ maxPrice: 123n, amount: 456n, prevTickPrice: 100n }],
    });
    const call = res.calls[0];
    expect(call?.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: ccaAbi, data: call?.data ?? '0x' });
    expect(decoded.functionName).toBe('submitBid');
    expect(decoded.args).toEqual([123n, 456n, OWNER, 100n, '0x']);
    expect(res.prerequisites.join(' ')).toMatch(/Permit2/);
  });

  it('sets msg.value for native ETH auctions', () => {
    const res = bidCalldata({
      auction: '0x000000000000000000000000000000000000dE30',
      currency: '0x0000000000000000000000000000000000000000',
      owner: OWNER,
      bids: [{ maxPrice: 1n, amount: 7n, prevTickPrice: 0n }],
    });
    expect(res.calls[0]?.value).toBe(7n);
  });
});

describe('cli', () => {
  const demo = tmpFile('demo.json', snapshotToJson(demoSnapshot()));

  it('--help exits 0', async () => {
    const r = await cli('--help');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Commands/);
  });

  it('no command and unknown command are usage errors', async () => {
    expect((await cli()).code).toBe(2);
    expect((await cli('bogus')).code).toBe(2);
    expect((await cli('plan', '--snapshot', demo)).code).toBe(2); // missing --budget
  });

  it('inspect prints labelled figures', async () => {
    const r = await cli('inspect', '--snapshot', demo);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[obs\] floor price/);
    expect(r.out).toMatch(/\[der\] clearing price \(checkpointed now\)/);
  });

  it('plan --json returns a schedule that sums to the budget', async () => {
    const r = await cli(
      'plan',
      '--snapshot',
      demo,
      '--budget',
      '1000',
      '--max-price',
      '0.02',
      '--json',
    );
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { schedule: Array<{ amount: string }> };
    const total = j.schedule.reduce((s, b) => s + BigInt(b.amount), 0n);
    expect(total).toBe(1_000n * 10n ** 6n);
  });

  it('plan output from --json feeds simulate and calldata', async () => {
    const r = await cli(
      'plan',
      '--snapshot',
      demo,
      '--budget',
      '1000',
      '--max-price',
      '0.02',
      '--json',
    );
    const sched = tmpFile('plan.json', r.out);
    const sim = await cli(
      'simulate',
      '--snapshot',
      demo,
      '--schedule',
      sched,
      '--demand',
      '100000',
    );
    expect(sim.code).toBe(0);
    expect(sim.out).toMatch(/tokens filled/);
    const cd = await cli(
      'calldata',
      '--snapshot',
      demo,
      '--schedule',
      sched,
      '--owner',
      OWNER,
      '--json',
    );
    expect(cd.code).toBe(0);
    expect((JSON.parse(cd.out) as { calls: unknown[] }).calls.length).toBeGreaterThan(0);
  });

  it('verify exits 3 on a critical failure', async () => {
    const bad = tmpFile(
      'bad.json',
      snapshotToJson(slopSnapshot({ token: { ...slopSnapshot().token, decimals: 4 } })),
    );
    expect((await cli('verify', '--snapshot', bad)).code).toBe(3);
    expect((await cli('verify', '--snapshot', demo)).code).toBe(0);
  });
});
