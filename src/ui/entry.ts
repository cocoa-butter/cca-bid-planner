/**
 * Planner page logic. Runs entirely in the browser: loads an auction read-only over a
 * public RPC (or a pasted snapshot) and runs the pure core. No keys, no transactions.
 */
import { getAddress } from 'viem';
import { inspect } from '../core/inspect.js';
import type { Figure } from '../core/label.js';
import { plan } from '../core/plan.js';
import { formatPriceQ96, fromRaw, toPriceQ96, toRaw } from '../core/price.js';
import type { Arrival } from '../core/scenario.js';
import type { Weighting } from '../core/schedule.js';
import { type AuctionSnapshot, snapshotFromJson, snapshotToJson } from '../core/snapshot.js';
import { clientFor, readSnapshot } from '../rpc/read.js';
import { demoSnapshot } from './demo-data.js';

const RPCS: Record<string, string> = {
  '1': 'https://ethereum-rpc.publicnode.com',
  '8453': 'https://base-rpc.publicnode.com',
  '130': 'https://unichain-rpc.publicnode.com',
  '42161': 'https://arbitrum-one-rpc.publicnode.com',
};

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) =>
  document.getElementById(id) as T;
const val = (id: string) => $(id).value.trim();

let current: AuctionSnapshot | undefined;

function fmt(s: AuctionSnapshot) {
  const t = s.token;
  const c = s.currency;
  return {
    price: (q: bigint) => `${formatPriceQ96(q, t.decimals, c.decimals, 6)} ${c.symbol}`,
    cur: (r: bigint) => `${group(fromRaw(r, c.decimals, 4))} ${c.symbol}`,
    tok: (r: bigint) => `${group(fromRaw(r, t.decimals, 0))} ${t.symbol}`,
  };
}

function group(s: string): string {
  const [i = '', f] = s.split('.');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Cells are trusted HTML built by this file; every dynamic value goes through esc(). */
function table(header: string[], rows: string[][]): string {
  const th = header.map((h) => `<th>${esc(h)}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<div class="tbl"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

const TAG: Record<Figure['kind'], string> = {
  observed: '<span class="tag obs">obs</span>',
  derived: '<span class="tag der">der</span>',
  assumed: '<span class="tag asm">asm</span>',
};

function figureRows(figs: ReadonlyArray<Figure<unknown>>, s: AuctionSnapshot): string[][] {
  const f = fmt(s);
  return figs.map((x) => {
    const v = x.value;
    let shown = String(v);
    if (typeof v === 'bigint') {
      if (x.unit === 'priceQ96') shown = f.price(v);
      else if (x.unit === 'currency') shown = f.cur(v);
      else if (x.unit === 'token') shown = f.tok(v);
    }
    return [
      TAG[x.kind],
      esc(x.label),
      esc(shown) + (x.note ? ` <small>(${esc(x.note)})</small>` : ''),
    ];
  });
}

function status(msg: string, isErr = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
}

const AUCTION_FIGURES = new Set([
  'phase',
  'token',
  'currency',
  'floor price',
  'required currency raised',
  'clearing price (checkpointed now)',
  'currency raised (last checkpoint)',
  'graduated (now)',
  'supply released',
]);

function render() {
  const out = $('out');
  $('err').textContent = '';
  if (!current) {
    out.innerHTML = '<p>Load an auction or paste a snapshot to begin.</p>';
    return;
  }
  const s = current;
  try {
    const f = fmt(s);
    const demand = val('demand');
    const result = plan(s, {
      budget: toRaw(val('budget'), s.currency.decimals),
      maxPrice: toPriceQ96(val('maxPrice'), s.token.decimals, s.currency.decimals),
      levels: Number(val('levels')),
      weighting: val('weighting') as Weighting | 'auto',
      arrival: val('arrival') as Arrival,
      ...(demand ? { forecastDemand: toRaw(demand, s.currency.decimals) } : {}),
    });
    const report = inspect(s);
    let html = '';
    if (result.ok) {
      const sims = result.simulations;
      const base = sims.find((x) => x.scenario === 'base') ?? sims[0];
      const worst = sims.reduce((w, x) => (x.tokensFilled < w.tokensFilled ? x : w));
      const maxRefund = sims.reduce(
        (m, x) => (x.currencyRefunded > m ? x.currencyRefunded : m),
        0n,
      );
      if (base) {
        html += `<div class="kpis">
          <div class="kpi"><b>${esc(f.tok(base.tokensFilled))}</b><span>expected tokens (base) <span class="tag asm">asm</span></span></div>
          <div class="kpi"><b>${base.tokensFilled > 0n ? esc(f.price(base.averagePrice)) : '-'}</b><span>expected average price</span></div>
          <div class="kpi"><b>${esc(f.tok(worst.tokensFilled))}</b><span>worst case (${esc(worst.scenario)})</span></div>
          <div class="kpi"><b>${esc(f.cur(maxRefund))}</b><span>max refund exposure</span></div>
        </div>`;
      }
      html += `<h2>Bid schedule</h2><p>Submit at block ${result.block}, weighting <b>${result.weighting}</b>. Send in this order (ascending price) so each hint is valid.</p>`;
      html += table(
        ['#', 'max price', 'amount', 'maxPriceQ96', 'prevTickPriceQ96'],
        result.schedule.map((b, i) => [
          String(i + 1),
          esc(f.price(b.maxPrice)),
          esc(f.cur(b.amount)),
          `<code>${b.maxPrice}</code>`,
          `<code>${b.prevTickPrice}</code>`,
        ]),
      );
      html += '<h2>Scenarios <span class="tag asm">assumed</span></h2>';
      html += table(
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
        sims.map((sim, i) => [
          esc(sim.scenario),
          esc(f.cur(result.scenarios[i]?.totalDemand ?? 0n)),
          esc(f.tok(sim.tokensFilled)),
          esc(f.cur(sim.currencySpent)),
          sim.tokensFilled > 0n ? esc(f.price(sim.averagePrice)) : '-',
          esc(f.cur(sim.currencyRefunded)),
          esc(f.price(sim.finalClearingPrice)),
          sim.graduated ? 'yes' : '<b class="bad">no</b>',
        ]),
      );
      const warnings = [...new Set(result.warnings)];
      if (warnings.length > 0) {
        html += `<ul class="warn">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
      }
      html += `<h2>Summary</h2>${table(['', 'figure', 'value'], figureRows(result.figures, s))}`;
    } else {
      html += `<p class="bad">Cannot plan: ${esc(result.message)}</p>`;
    }
    html += `<h2>Auction</h2><p><code>${esc(s.auction)}</code> on chain ${s.chainId}, block ${s.blockNumber}</p>`;
    html += table(
      ['', 'figure', 'value'],
      figureRows(
        report.figures.filter((x) => AUCTION_FIGURES.has(x.label)),
        s,
      ),
    );
    const flagged = report.checks.filter((c) => c.passed !== true);
    html += `<h2>Risk checks</h2>${table(
      ['', 'check', 'detail'],
      flagged.map((c) => [
        c.passed === null
          ? '?'
          : c.severity === 'critical'
            ? '<b class="bad">FAIL</b>'
            : '<b>WARN</b>',
        esc(c.title),
        esc(c.detail),
      ]),
    )}<p><small>${report.checks.length - flagged.length} other checks passed.</small></p>`;
    if (report.consistency.length > 0) {
      html += `<p class="bad">Engine and chain disagree: ${esc(report.consistency.join('; '))}</p>`;
    }
    out.innerHTML = html;
  } catch (e) {
    $('err').textContent = (e as Error).message;
  }
}

async function load() {
  const chain = val('chain');
  const rpc = val('rpc');
  const auctionInput = val('auction');
  if (!rpc || !auctionInput) {
    status('Enter an RPC URL and an auction address.', true);
    return;
  }
  let auction: `0x${string}`;
  try {
    auction = getAddress(auctionInput);
  } catch {
    status('That is not a valid address.', true);
    return;
  }
  const req = val('requiredRaise');
  $('load').setAttribute('disabled', '');
  status('Reading auction state...');
  try {
    const { snapshot, notes } = await readSnapshot(clientFor(rpc), auction, {
      ...(req ? { requiredCurrencyRaised: BigInt(req) } : {}),
      onProgress: (m) => status(m),
    });
    current = snapshot;
    $<HTMLTextAreaElement>('snapshot').value = snapshotToJson(snapshot);
    status(`Loaded at block ${snapshot.blockNumber}. ${notes.join(' ')}`);
    syncToUrl({ chain, auction });
    render();
  } catch (e) {
    status((e as Error).message, true);
  } finally {
    $('load').removeAttribute('disabled');
  }
}

const FIELDS = ['budget', 'maxPrice', 'levels', 'weighting', 'demand', 'arrival'] as const;

function syncFromUrl(): { chain?: string; auction?: string; rpc?: string } {
  const q = new URLSearchParams(location.search);
  for (const f of FIELDS) {
    const v = q.get(f);
    if (v !== null) $(f).value = v;
  }
  const out: { chain?: string; auction?: string; rpc?: string } = {};
  const chain = q.get('chain');
  const auction = q.get('auction');
  const rpc = q.get('rpc');
  if (chain) out.chain = chain;
  if (auction) out.auction = auction;
  if (rpc) out.rpc = rpc;
  return out;
}

function syncToUrl(extra: { chain?: string; auction?: string } = {}) {
  const q = new URLSearchParams(location.search);
  for (const f of FIELDS) {
    const v = val(f);
    if (v) q.set(f, v);
    else q.delete(f);
  }
  if (extra.chain) q.set('chain', extra.chain);
  if (extra.auction) q.set('auction', extra.auction);
  history.replaceState(null, '', `?${q.toString()}`);
}

function setTab(tab: 'rpc' | 'paste') {
  $('tab-rpc').classList.toggle('on', tab === 'rpc');
  $('tab-paste').classList.toggle('on', tab === 'paste');
  $('src-rpc').hidden = tab !== 'rpc';
  $('src-paste').hidden = tab !== 'paste';
}

function useExample() {
  current = demoSnapshot();
  $<HTMLTextAreaElement>('snapshot').value = snapshotToJson(current);
  status('Synthetic example auction (illustrative figures, not a chain read).');
  render();
}

function init() {
  const fromUrl = syncFromUrl();
  const chainSel = $<HTMLSelectElement>('chain');
  if (fromUrl.chain && (RPCS[fromUrl.chain] || fromUrl.chain === 'custom')) {
    chainSel.value = fromUrl.chain;
  }
  $('rpc').value = fromUrl.rpc ?? RPCS[chainSel.value] ?? '';
  chainSel.addEventListener('change', () => {
    const preset = RPCS[chainSel.value];
    if (preset) $('rpc').value = preset;
  });
  $('tab-rpc').addEventListener('click', () => setTab('rpc'));
  $('tab-paste').addEventListener('click', () => setTab('paste'));
  $('load').addEventListener('click', load);
  $('example').addEventListener('click', useExample);
  $('snapshot').addEventListener('change', () => {
    try {
      current = snapshotFromJson($<HTMLTextAreaElement>('snapshot').value);
      status('Snapshot loaded.');
      render();
    } catch (e) {
      status((e as Error).message, true);
    }
  });
  $('run').addEventListener('click', () => {
    syncToUrl();
    render();
  });
  if (fromUrl.auction) {
    $('auction').value = fromUrl.auction;
    void load();
  } else {
    useExample();
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
