/**
 * Demo page logic. Runs entirely in the browser against a pasted snapshot; no RPC, no keys.
 */

import { inspect } from '../core/inspect.js';
import type { Figure } from '../core/label.js';
import { plan } from '../core/plan.js';
import { fromPriceQ96, fromRaw, toPriceQ96, toRaw } from '../core/price.js';
import type { Arrival } from '../core/scenario.js';
import type { Weighting } from '../core/schedule.js';
import { type AuctionSnapshot, snapshotFromJson, snapshotToJson } from '../core/snapshot.js';
import { demoSnapshot } from './demo-data.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function fmt(s: AuctionSnapshot) {
  const t = s.token;
  const c = s.currency;
  return {
    price: (q: bigint) => `${fromPriceQ96(q, t.decimals, c.decimals, 8)} ${c.symbol}`,
    cur: (r: bigint) => `${group(fromRaw(r, c.decimals, 2))} ${c.symbol}`,
    tok: (r: bigint) => `${group(fromRaw(r, t.decimals, 0))} ${t.symbol}`,
  };
}

function group(s: string): string {
  const [i = '', f] = s.split('.');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function table(header: string[], rows: string[][]): string {
  const th = header.map((h) => `<th>${esc(h)}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

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
    return [x.kind, x.label, shown + (x.note ? ` (${x.note})` : '')];
  });
}

function render() {
  const out = $('out');
  const err = $('err');
  err.textContent = '';
  try {
    const s = snapshotFromJson(($('snapshot') as HTMLTextAreaElement).value);
    const f = fmt(s);
    const val = (id: string) => ($(id) as HTMLInputElement).value.trim();
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
    const failing = report.checks.filter((c) => c.passed === false);
    let html = `<h2>Auction</h2>${table(['kind', 'figure', 'value'], figureRows(report.figures.slice(0, 1).concat(report.figures.slice(15, 21)), s))}`;
    html += `<h3>Checks needing attention</h3>${
      failing.length === 0
        ? '<p>None.</p>'
        : `<ul>${failing.map((c) => `<li><b>${esc(c.severity)}</b> ${esc(c.title)}: ${esc(c.detail)}</li>`).join('')}</ul>`
    }`;
    if (!result.ok) {
      html += `<p class="bad">Cannot plan: ${esc(result.message)}</p>`;
      out.innerHTML = html;
      return;
    }
    html += `<h2>Bid schedule</h2><p>Submit at block ${result.block}, weighting <b>${result.weighting}</b>. Send in this order.</p>`;
    html += table(
      ['#', 'max price', 'amount', 'prevTickPriceQ96'],
      result.schedule.map((b, i) => [
        String(i + 1),
        f.price(b.maxPrice),
        f.cur(b.amount),
        b.prevTickPrice.toString(),
      ]),
    );
    html += '<h2>Scenarios <span class="asm">assumed</span></h2>';
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
      result.simulations.map((sim, i) => [
        sim.scenario,
        f.cur(result.scenarios[i]?.totalDemand ?? 0n),
        f.tok(sim.tokensFilled),
        f.cur(sim.currencySpent),
        sim.tokensFilled > 0n ? f.price(sim.averagePrice) : '-',
        f.cur(sim.currencyRefunded),
        f.price(sim.finalClearingPrice),
        sim.graduated ? 'yes' : 'NO',
      ]),
    );
    html += `<h2>Summary</h2>${table(['kind', 'figure', 'value'], figureRows(result.figures, s))}`;
    const warnings = [...new Set(result.warnings)];
    if (warnings.length > 0)
      html += `<ul class="warn">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
    out.innerHTML = html;
  } catch (e) {
    err.textContent = (e as Error).message;
  }
}

function init() {
  ($('snapshot') as HTMLTextAreaElement).value = snapshotToJson(demoSnapshot());
  $('run').addEventListener('click', render);
  $('reset').addEventListener('click', () => {
    ($('snapshot') as HTMLTextAreaElement).value = snapshotToJson(demoSnapshot());
    render();
  });
  render();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
