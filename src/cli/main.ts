import { readFileSync, writeFileSync } from 'node:fs';
import { type Address, getAddress } from 'viem';
import { UPSTREAM_COMMIT } from '../abi/cca.js';
import { bidCalldata } from '../core/calldata.js';
import { inspect } from '../core/inspect.js';
import { type PlannedBid, plan } from '../core/plan.js';
import { toPriceQ96, toRaw } from '../core/price.js';
import type { Arrival, DemandScenario } from '../core/scenario.js';
import type { Weighting } from '../core/schedule.js';
import { type SimulationResult, simulate } from '../core/simulate.js';
import {
  type AuctionSnapshot,
  engineFromSnapshot,
  snapshotFromJson,
  snapshotToJson,
} from '../core/snapshot.js';
import { hasCriticalFailure } from '../core/verify.js';
import { clientFor, readSnapshot } from '../rpc/read.js';
import { bool, flag, flags, type ParsedArgs, parseArgs, required, UsageError } from './args.js';
import {
  currency,
  figureLines,
  price,
  table,
  toJson,
  tokens,
  type Units,
  unitsOf,
} from './format.js';

const VERSION = '0.1.0';

export const EXIT = { ok: 0, error: 1, usage: 2, checksFailed: 3 } as const;

const HELP = `cca-bid-planner ${VERSION} - read-only bid planner for Uniswap CCA auctions

Usage
  cca-bid-planner <command> [source] [options]

Commands
  inspect    Read parameters and live state, print a labelled risk report
  plan       Build a bid schedule for a budget and simulate it under demand scenarios
  simulate   Replay a given schedule against one demand scenario
  calldata   Emit submitBid calldata (with prevTickPrice hints) for a schedule
  verify     Run parameter sanity checks; exit code 3 if a critical check fails

Source (one of)
  --auction <address> --rpc <url>   Read live state over JSON-RPC (read-only)
  --snapshot <file>                 Use a saved snapshot (see inspect --save)

Common options
  --block <n>             Read state at block n (RPC) / submit at block n (plan)
  --required-raise <raw>  requiredCurrencyRaised in raw units, if factory logs are unavailable
  --json                  Machine-readable output
  -h, --help              Show help

plan options
  --budget <amount>       Currency to commit, in whole units (e.g. 2500 for 2,500 USDC)
  --max-price <price>     Highest price you will pay, currency per token (e.g. 0.015)
  --levels <n>            Max number of price levels (default 5)
  --weighting <w>         flat | top | bottom | auto (default auto)
  --demand <amount>       Assumed currency other bidders add from now on (default: what
                          lifts clearing to your cap). Scenarios use 0, 0.5x, 1x, 2x of it.
  --demand-ceiling <p>    Highest price other bidders are assumed to bid (default 2x cap)
  --arrival <a>           early | flat | late (default flat)

simulate / calldata options
  --bid <price>:<amount>  A schedule entry (repeatable), human units
  --schedule <file>       JSON from "plan --json" (uses its schedule)
  --owner <address>       Bid owner (calldata)
  --hook-data <hex>       hookData for validation hooks (calldata, default 0x)

Every figure is labelled [obs] observed on chain, [der] derived with protocol math, or
[asm] dependent on an assumption. The demand forecast is always an assumption.
This tool never holds keys and never sends transactions.

Exit codes: 0 ok, 1 error, 2 usage error, 3 verify found a critical issue.
Protocol: Uniswap/continuous-clearing-auction @ ${UPSTREAM_COMMIT.slice(0, 7)} (v2.1.0)
`;

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${HELP}`);
    return EXIT.usage;
  }
  if (bool(args, 'version')) {
    io.out(VERSION);
    return EXIT.ok;
  }
  if (!args.command || bool(args, 'help') || args.command === 'help') {
    io.out(HELP);
    return args.command || bool(args, 'help') ? EXIT.ok : EXIT.usage;
  }
  try {
    switch (args.command) {
      case 'inspect':
        return await cmdInspect(args, io);
      case 'plan':
        return await cmdPlan(args, io);
      case 'simulate':
        return await cmdSimulate(args, io);
      case 'calldata':
        return await cmdCalldata(args, io);
      case 'verify':
        return await cmdVerify(args, io);
      default:
        throw new UsageError(`unknown command "${args.command}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`error: ${e.message}\nRun "cca-bid-planner --help" for usage.`);
      return EXIT.usage;
    }
    io.err(`error: ${(e as Error).message}`);
    return EXIT.error;
  }
}

async function loadSnapshot(args: ParsedArgs, io: Io): Promise<AuctionSnapshot> {
  const file = flag(args, 'snapshot');
  if (file) return snapshotFromJson(readFileSync(file, 'utf8'));
  const auction = flag(args, 'auction');
  const rpc = flag(args, 'rpc') ?? process.env.CCA_RPC_URL;
  if (!auction || !rpc)
    throw new UsageError('give --snapshot <file>, or --auction <address> and --rpc <url>');
  const block = flag(args, 'block');
  const req = flag(args, 'required-raise');
  const quiet = bool(args, 'json') || bool(args, 'quiet');
  const { snapshot, notes } = await readSnapshot(clientFor(rpc), getAddress(auction), {
    ...(block && args.command === 'inspect' ? { blockNumber: BigInt(block) } : {}),
    ...(req ? { requiredCurrencyRaised: BigInt(req) } : {}),
    ...(quiet ? {} : { onProgress: (m: string) => io.err(`  ${m}`) }),
  });
  if (!quiet) for (const n of notes) io.err(`note: ${n}`);
  return snapshot;
}

async function cmdInspect(args: ParsedArgs, io: Io): Promise<number> {
  const s = await loadSnapshot(args, io);
  const save = flag(args, 'save');
  if (save) writeFileSync(save, snapshotToJson(s));
  const r = inspect(s);
  if (bool(args, 'json')) {
    io.out(toJson(r));
    return EXIT.ok;
  }
  const u = unitsOf(s);
  const lines = [
    `Auction ${s.auction} on chain ${s.chainId}`,
    '',
    'Parameters and state',
    ...figureLines(r.figures, u),
    '',
    `Demand ladder above clearing (${r.ladder.length} initialized ticks)`,
  ];
  if (r.ladder.length === 0) lines.push('  (none)');
  else {
    const rows = r.ladder
      .slice(0, 15)
      .map((t) => [price(t.price, u), currency(t.demandQ96 >> 96n, u)]);
    lines.push(...table(rows, ['max price', 'effective demand']));
    if (r.ladder.length > 15) lines.push(`  ... ${r.ladder.length - 15} more`);
  }
  lines.push('', 'Risk checks', ...checkLines(r.checks));
  if (r.consistency.length > 0) {
    lines.push(
      '',
      'Engine vs chain mismatch (please report):',
      ...r.consistency.map((c) => `  ${c}`),
    );
  }
  if (save) lines.push('', `snapshot saved to ${save}`);
  io.out(lines.join('\n'));
  return EXIT.ok;
}

function checkLines(checks: ReturnType<typeof inspect>['checks']): string[] {
  return checks.map((c) => {
    const mark =
      c.passed === null ? ' ?  ' : c.passed ? ' ok ' : c.severity === 'critical' ? 'FAIL' : 'WARN';
    return `  [${mark}] ${c.title}\n         ${c.detail}`;
  });
}

async function cmdVerify(args: ParsedArgs, io: Io): Promise<number> {
  const s = await loadSnapshot(args, io);
  const checks = inspect(s).checks;
  if (bool(args, 'json')) io.out(toJson(checks));
  else io.out(['Verify', ...checkLines(checks)].join('\n'));
  return hasCriticalFailure(checks) ? EXIT.checksFailed : EXIT.ok;
}

function parsePlanFlags(args: ParsedArgs, s: AuctionSnapshot) {
  const u = unitsOf(s);
  const weighting = (flag(args, 'weighting') ?? 'auto') as Weighting | 'auto';
  if (!['flat', 'top', 'bottom', 'auto'].includes(weighting))
    throw new UsageError('--weighting must be flat|top|bottom|auto');
  const arrival = (flag(args, 'arrival') ?? 'flat') as Arrival;
  if (!['early', 'flat', 'late'].includes(arrival))
    throw new UsageError('--arrival must be early|flat|late');
  const demand = flag(args, 'demand');
  const ceiling = flag(args, 'demand-ceiling');
  const block = flag(args, 'block');
  const levels = flag(args, 'levels');
  return {
    u,
    weighting,
    arrival,
    ...(demand !== undefined ? { forecastDemand: toRaw(demand, u.currencyDecimals) } : {}),
    ...(ceiling !== undefined
      ? { demandCeiling: toPriceQ96(ceiling, u.tokenDecimals, u.currencyDecimals) }
      : {}),
    ...(block !== undefined ? { block: BigInt(block) } : {}),
    ...(levels !== undefined ? { levels: Number(levels) } : {}),
  };
}

async function cmdPlan(args: ParsedArgs, io: Io): Promise<number> {
  const s = await loadSnapshot(args, io);
  const { u, ...opts } = parsePlanFlags(args, s);
  const result = plan(s, {
    budget: toRaw(required(args, 'budget'), u.currencyDecimals),
    maxPrice: toPriceQ96(required(args, 'max-price'), u.tokenDecimals, u.currencyDecimals),
    ...opts,
  });
  if (!result.ok) {
    if (bool(args, 'json')) io.out(toJson(result));
    else io.err(`cannot plan: ${result.message} (${result.reason})`);
    return EXIT.error;
  }
  if (bool(args, 'json')) {
    io.out(toJson({ ...result, simulations: result.simulations.map(simSummary) }));
    return EXIT.ok;
  }
  const lines = [
    `Plan for ${s.auction}: submit at block ${result.block}, weighting "${result.weighting}"`,
    '',
    'Bid schedule (send in this order)',
    ...table(
      result.schedule.map((b, i) => [
        String(i + 1),
        price(b.maxPrice, u),
        currency(b.amount, u),
        b.maxPrice.toString(),
        b.prevTickPrice.toString(),
      ]),
      ['#', 'max price', 'amount', 'maxPriceQ96', 'prevTickPriceQ96'],
    ),
    '',
    'Scenarios [asm]: other bidders add X currency, spread across prices up to the ceiling',
    ...table(
      result.simulations.map((sim, i) => {
        const sc = result.scenarios[i] as DemandScenario;
        return [
          sim.scenario,
          currency(sc.totalDemand, u),
          tokens(sim.tokensFilled, u),
          currency(sim.currencySpent, u),
          sim.tokensFilled > 0n ? price(sim.averagePrice, u) : '-',
          currency(sim.currencyRefunded, u),
          price(sim.finalClearingPrice, u),
          sim.graduated ? 'yes' : 'NO',
        ];
      }),
      [
        'scenario',
        'external demand',
        'tokens',
        'spent',
        'avg price',
        'refund',
        'final clearing',
        'graduates',
      ],
    ),
    '',
    'Summary',
    ...figureLines(result.figures, u),
  ];
  const warnings = [...new Set(result.warnings)];
  if (warnings.length > 0) lines.push('', 'Warnings', ...warnings.map((w) => `  ! ${w}`));
  lines.push(
    '',
    'Bids above the final clearing price fill in full; a bid at it fills partially; a bid',
    'below it is outbid: it fills only while clearing was under its max price, then refunds.',
  );
  io.out(lines.join('\n'));
  return EXIT.ok;
}

function readSchedule(args: ParsedArgs, s: AuctionSnapshot, u: Units): PlannedBid[] {
  const file = flag(args, 'schedule');
  const blockFlag = flag(args, 'block');
  const block = blockFlag
    ? BigInt(blockFlag)
    : s.blockNumber + 1n > s.startBlock
      ? s.blockNumber + 1n
      : s.startBlock;
  let entries: Array<{ block: bigint; maxPrice: bigint; amount: bigint }> = [];
  if (file) {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      schedule?: Array<{ block: string; maxPrice: string; amount: string }>;
    };
    if (!raw.schedule)
      throw new UsageError(`${file} has no "schedule" array (use plan --json output)`);
    entries = raw.schedule.map((e) => ({
      block: BigInt(e.block),
      maxPrice: BigInt(e.maxPrice),
      amount: BigInt(e.amount),
    }));
  }
  for (const b of flags(args, 'bid')) {
    const [p, a] = b.split(':');
    if (!p || !a) throw new UsageError(`--bid expects <price>:<amount>, got "${b}"`);
    entries.push({
      block,
      maxPrice: toPriceQ96(p, u.tokenDecimals, u.currencyDecimals),
      amount: toRaw(a, u.currencyDecimals),
    });
  }
  if (entries.length === 0)
    throw new UsageError('give --bid <price>:<amount> or --schedule <file>');
  // Snap prices down to ticks and compute hints in ascending order.
  entries = entries
    .map((e) => ({ ...e, maxPrice: (e.maxPrice / s.tickSpacing) * s.tickSpacing }))
    .sort((a, b) =>
      a.block === b.block ? (a.maxPrice < b.maxPrice ? -1 : 1) : a.block < b.block ? -1 : 1,
    );
  const engine = engineFromSnapshot(s);
  return entries.map((e) => {
    const prevTickPrice = engine.prevInitializedTick(e.maxPrice);
    try {
      engine.submitBid(e.block, e.maxPrice, e.amount);
    } catch {
      // Simulation reports the revert; the hint is still the best known tick.
    }
    return { ...e, prevTickPrice };
  });
}

async function cmdSimulate(args: ParsedArgs, io: Io): Promise<number> {
  const s = await loadSnapshot(args, io);
  const u = unitsOf(s);
  const schedule = readSchedule(args, s, u);
  const demandFlag = flag(args, 'demand');
  const arrival = (flag(args, 'arrival') ?? 'flat') as Arrival;
  const top = schedule.reduce((m, b) => (b.maxPrice > m ? b.maxPrice : m), 0n);
  const ceilingFlag = flag(args, 'demand-ceiling');
  const firstBlock = schedule[0]?.block ?? s.blockNumber;
  const engine = engineFromSnapshot(s);
  const clearing = engine.checkpoint(
    firstBlock < s.endBlock ? firstBlock : s.endBlock,
  ).clearingPrice;
  const scenario: DemandScenario = {
    name: demandFlag === undefined ? 'none' : 'given',
    totalDemand: demandFlag === undefined ? 0n : toRaw(demandFlag, u.currencyDecimals),
    minPrice: clearing + 1n,
    maxPrice: ceilingFlag ? toPriceQ96(ceilingFlag, u.tokenDecimals, u.currencyDecimals) : top * 2n,
    arrival,
    bidCount: 40,
  };
  const sim = simulate(s, schedule, scenario, { fromBlock: firstBlock });
  if (bool(args, 'json')) {
    io.out(toJson(simSummary(sim)));
    return EXIT.ok;
  }
  const lines = [
    `Simulation [asm]: other bidders add ${currency(scenario.totalDemand, u)} (${arrival} arrival)`,
    '',
    ...table(
      sim.steps.map((st) => [
        st.entry.block.toString(),
        price(st.entry.maxPrice, u),
        currency(st.entry.amount, u),
        st.rejected ? `reverts: ${st.rejected}` : (st.outcome?.status ?? '-'),
        st.outcome ? tokens(st.outcome.tokensFilled, u) : '-',
        st.outcome ? currency(st.outcome.currencyRefunded, u) : currency(st.entry.amount, u),
        st.filled ? 'yes' : 'no',
      ]),
      ['block', 'max price', 'amount', 'status', 'tokens', 'refund', 'filled'],
    ),
    '',
    `  tokens filled      ${tokens(sim.tokensFilled, u)}`,
    `  currency spent     ${currency(sim.currencySpent, u)}`,
    `  currency refunded  ${currency(sim.currencyRefunded, u)}`,
    `  average price      ${sim.tokensFilled > 0n ? price(sim.averagePrice, u) : '-'}`,
    `  final clearing     ${price(sim.finalClearingPrice, u)}`,
    `  graduates          ${sim.graduated ? 'yes' : 'NO (all bids refunded)'}`,
  ];
  io.out(lines.join('\n'));
  return EXIT.ok;
}

async function cmdCalldata(args: ParsedArgs, io: Io): Promise<number> {
  const s = await loadSnapshot(args, io);
  const u = unitsOf(s);
  const schedule = readSchedule(args, s, u);
  const owner = getAddress(required(args, 'owner')) as Address;
  const hookData = (flag(args, 'hook-data') ?? '0x') as `0x${string}`;
  const res = bidCalldata({
    auction: s.auction,
    currency: s.currency.address,
    owner,
    bids: schedule,
    hookData,
  });
  if (s.validationHook !== '0x0000000000000000000000000000000000000000' && hookData === '0x') {
    res.prerequisites.unshift(
      `Validation hook ${s.validationHook} is set; it may need --hook-data.`,
    );
  }
  if (bool(args, 'json')) {
    io.out(toJson(res));
    return EXIT.ok;
  }
  const lines = ['submitBid calls (not signed, not sent)', ''];
  res.calls.forEach((c, i) => {
    lines.push(
      `#${i + 1}  ${price(c.args.maxPriceQ96, u)}  ${currency(c.args.amount, u)}`,
      `    to:    ${c.to}`,
      `    value: ${c.value}`,
      `    data:  ${c.data}`,
      '',
    );
  });
  lines.push(
    `Total: ${currency(res.total, u)}`,
    '',
    'Before sending',
    ...res.prerequisites.map((p) => `  - ${p}`),
  );
  io.out(lines.join('\n'));
  return EXIT.ok;
}

function simSummary(sim: SimulationResult) {
  return {
    scenario: sim.scenario,
    tokensFilled: sim.tokensFilled,
    currencySpent: sim.currencySpent,
    currencyRefunded: sim.currencyRefunded,
    averagePrice: sim.averagePrice,
    finalClearingPrice: sim.finalClearingPrice,
    graduated: sim.graduated,
    currencyRaised: sim.currencyRaised,
    steps: sim.steps.map((st) => ({
      block: st.entry.block,
      maxPrice: st.entry.maxPrice,
      amount: st.entry.amount,
      filled: st.filled,
      ...(st.rejected ? { rejected: st.rejected } : {}),
      ...(st.outcome
        ? {
            status: st.outcome.status,
            tokensFilled: st.outcome.tokensFilled,
            currencySpent: st.outcome.currencySpent,
            currencyRefunded: st.outcome.currencyRefunded,
          }
        : {}),
    })),
  };
}
