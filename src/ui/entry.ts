/**
 * Planner page. Lists auctions per chain from Uniswap's auction index (via this site's
 * /api/uniswap proxy), reads the chosen auction read-only over a public RPC, and runs the
 * pure core. No keys, no transactions.
 */
import { getAddress, type PublicClient } from 'viem';
import { CHAINS, type ChainInfo, chainById, findChain } from '../chains.js';
import { inspect } from '../core/inspect.js';
import { type PlanResult, plan } from '../core/plan.js';
import { formatPriceQ96, fromRaw, toPriceQ96, toRaw } from '../core/price.js';
import type { Weighting } from '../core/schedule.js';
import type { SimulationResult } from '../core/simulate.js';
import { type AuctionSnapshot, snapshotFromJson, snapshotToJson } from '../core/snapshot.js';
import { auctionClock } from '../rpc/clock.js';
import { type AuctionListing, clockRate, formatDuration, withStatus } from '../rpc/discover.js';
import { clientFor, readSnapshot } from '../rpc/read.js';
import { listAuctions } from '../rpc/uniswap-api.js';
import { demoSnapshot } from './demo-data.js';

const API = { baseUrl: '/api/uniswap' };
const DEFAULT_CHAIN = 'robinhood';

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) =>
  document.getElementById(id) as T;
const val = (id: string) => $(id).value.trim();
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface State {
  chain: ChainInfo;
  listings: AuctionListing[];
  showEnded: boolean;
  snapshot?: AuctionSnapshot | undefined;
  listing?: AuctionListing | undefined;
  msPerTick?: number | undefined;
  isExample?: boolean;
}

const state: State = {
  chain: findChain(DEFAULT_CHAIN) as ChainInfo,
  listings: [],
  showEnded: false,
};
const clients = new Map<number, PublicClient>();
const client = (c: ChainInfo) => {
  let cl = clients.get(c.id);
  if (!cl) {
    cl = clientFor(c.rpc);
    clients.set(c.id, cl);
  }
  return cl;
};

// ---------- formatting ----------

function group(s: string): string {
  const [i = '', f] = s.split('.');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
}

/** Compact number for big token amounts: 1.2M, 35.4K. */
function compact(raw: bigint, decimals: number): string {
  if (raw === 0n) return '0';
  const n = Number(fromRaw(raw, decimals, 6));
  if (!Number.isFinite(n)) return fromRaw(raw, decimals, 2);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  if (n >= 1) return group(n.toFixed(2).replace(/\.?0+$/, ''));
  return n.toPrecision(3);
}

interface Units {
  tok: string;
  cur: string;
  tdec: number;
  cdec: number;
}
const unitsOf = (s: AuctionSnapshot): Units => ({
  tok: s.token.symbol,
  cur: s.currency.symbol,
  tdec: s.token.decimals,
  cdec: s.currency.decimals,
});
const fmtPrice = (q: bigint, u: Units) => `${formatPriceQ96(q, u.tdec, u.cdec, 4)} ${u.cur}`;
const fmtCur = (r: bigint, u: Units) => `${compact(r, u.cdec)} ${u.cur}`;
const fmtTok = (r: bigint, u: Units) => `${compact(r, u.tdec)} ${u.tok}`;

function logo(symbol: string, url?: string): string {
  const letters = esc(symbol.replace(/^\$/, '').slice(0, 2).toUpperCase());
  const img = url ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()" />` : '';
  return `<span class="logo"><span>${letters}</span>${img}</span>`;
}

function statusPill(a: { status: string; msUntilStart?: number; msUntilEnd?: number }): string {
  if (a.status === 'live') {
    return `<span class="pill live">Live${a.msUntilEnd !== undefined ? ` · ends in ${formatDuration(a.msUntilEnd)}` : ''}</span>`;
  }
  if (a.status === 'upcoming') {
    return `<span class="pill upcoming">Starts in ${a.msUntilStart !== undefined ? formatDuration(a.msUntilStart) : 'soon'}</span>`;
  }
  return '<span class="pill ended">Ended</span>';
}

function progress(raised: bigint, min: bigint, cdec: number, cur: string): string {
  const pct = min > 0n ? Math.min(100, Number((raised * 1000n) / min) / 10) : 100;
  return `<div><div class="bar"><i style="width:${pct}%"></i></div><div class="bar-label"><span>${compact(raised, cdec)} ${esc(cur)} bid</span><span>${min > 0n ? `${pct.toFixed(0)}% of ${compact(min, cdec)} minimum` : 'no minimum'}</span></div></div>`;
}

function status(msg: string, isErr = false) {
  const el = $('status');
  el.textContent = msg;
  el.className = isErr ? 'status err' : 'status';
}

// ---------- auction list ----------

function renderChains() {
  $('chains').innerHTML = CHAINS.map(
    (c) =>
      `<button type="button" class="chip${c.id === state.chain.id ? ' on' : ''}" data-chain="${c.key}">${esc(c.name)}</button>`,
  ).join('');
  for (const b of $('chains').querySelectorAll<HTMLButtonElement>('button')) {
    b.addEventListener('click', () => selectChain(b.dataset.chain as string));
  }
}

async function selectChain(key: string) {
  const c = findChain(key);
  if (!c) return;
  state.chain = c;
  state.listings = [];
  renderChains();
  setUrl({ chain: c.key, auction: undefined });
  $('list').innerHTML =
    '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  $('featured').innerHTML = '';
  status('');
  try {
    const cl = client(c);
    const [auctions, clockNow, msPerTick] = await Promise.all([
      listAuctions([c.id], API),
      auctionClock(cl, c.id),
      clockRate(cl, c.id).catch(() => undefined),
    ]);
    if (state.chain.id !== c.id) return; // user switched again
    state.msPerTick = msPerTick;
    state.listings = withStatus(auctions, clockNow, msPerTick);
    renderList();
  } catch (e) {
    $('list').innerHTML =
      `<div class="empty"><h3>Couldn't load auctions</h3><p>${esc((e as Error).message)}</p><button class="btn btn-ghost btn-sm" type="button" id="retry">Try again</button></div>`;
    $('retry').addEventListener('click', () => selectChain(c.key));
  }
}

function renderList() {
  const q = val('search').toLowerCase();
  const open = state.listings.filter((a) => a.status !== 'ended');
  const ended = state.listings.filter((a) => a.status === 'ended');
  const pool = state.showEnded ? ended : open;
  const shown = pool.filter(
    (a) =>
      !q ||
      a.tokenSymbol.toLowerCase().includes(q) ||
      a.tokenName.toLowerCase().includes(q) ||
      a.address.toLowerCase().includes(q),
  );
  $('show-open').textContent = `Live & upcoming (${open.length})`;
  $('show-ended').textContent = `Ended (${ended.length})`;
  renderFeatured();

  if (shown.length === 0) {
    const name = esc(state.chain.name);
    const what = state.showEnded ? 'ended auctions' : 'live or upcoming auctions';
    $('list').innerHTML = `<div class="empty">
      <h3>${q ? `Nothing matches “${esc(q)}”` : `No ${what} on ${name} right now`}</h3>
      <p>${q ? 'Try a different name or paste the auction address below.' : 'New auctions appear here as soon as they are created.'}</p>
      ${!state.showEnded && ended.length > 0 ? '<button class="btn btn-ghost btn-sm" type="button" id="see-ended">See ended auctions</button>' : ''}
      <button class="btn btn-ghost btn-sm" type="button" id="try-example">Try an example</button>
    </div>`;
    $('see-ended')?.addEventListener('click', () => setShowEnded(true));
    $('try-example').addEventListener('click', useExample);
    return;
  }
  $('list').innerHTML = shown
    .map((a, i) => {
      const u = {
        tok: a.tokenSymbol,
        cur: a.currencySymbol,
        tdec: a.tokenDecimals,
        cdec: a.currencyDecimals,
      };
      return `<button type="button" class="acard" data-i="${i}">
        <div class="acard-top">${logo(a.tokenSymbol, a.tokenImageUrl)}<div class="acard-name">${esc(a.tokenSymbol)}<small>${esc(a.tokenName)}</small></div>${statusPill(a)}</div>
        <div class="acard-stats">
          <div><span>Current price</span>${esc(fmtPrice(a.clearingPrice, u))}</div>
          <div><span>Bidders</span>${a.uniqueBidders ?? '—'}</div>
        </div>
        ${progress(a.totalBidVolume, a.requiredCurrencyRaised, a.currencyDecimals, a.currencySymbol)}
        ${a.isFlagged ? '<div class="flag">Flagged by Uniswap: be careful</div>' : ''}
      </button>`;
    })
    .join('');
  for (const b of $('list').querySelectorAll<HTMLButtonElement>('.acard')) {
    b.addEventListener('click', () => {
      const a = shown[Number(b.dataset.i)];
      if (a) void openAuction(a.address, a);
    });
  }
}

function renderFeatured() {
  if (state.chain.key !== 'robinhood') {
    $('featured').innerHTML = '';
    return;
  }
  const slop = state.listings.find(
    (a) => a.tokenSymbol.replace(/^\$/, '').toUpperCase() === 'SLOP',
  );
  $('featured').innerHTML = slop
    ? `<div class="featured"><b>SLOP (Slop Cash)</b> is ${slop.status === 'live' ? 'live' : slop.status === 'upcoming' ? 'coming up' : 'over'} on Robinhood Chain. <a href="#" id="open-slop">Plan a SLOP bid &rarr;</a></div>`
    : `<div class="featured"><b>Waiting for SLOP?</b> Umia's Slop Cash sale runs on Robinhood Chain in USDG. Reported dates: pre-bidding opens Nov 5, 17:00 UTC; bidding Nov 7&ndash;10. It will appear in this list as soon as the auction is created on chain. <a href="#" id="slop-example">Preview with example figures &rarr;</a></div>`;
  $('open-slop')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (slop) void openAuction(slop.address, slop);
  });
  $('slop-example')?.addEventListener('click', (e) => {
    e.preventDefault();
    useExample();
  });
}

function setShowEnded(v: boolean) {
  state.showEnded = v;
  $('show-open').classList.toggle('on', !v);
  $('show-ended').classList.toggle('on', v);
  renderList();
}

// ---------- one auction ----------

async function openAuction(address: string, listing?: AuctionListing) {
  let auction: `0x${string}`;
  try {
    auction = getAddress(address);
  } catch {
    status('That is not a valid auction address.', true);
    return;
  }
  status(`Reading ${listing ? listing.tokenSymbol : 'auction'}...`);
  try {
    const { snapshot } = await readSnapshot(client(state.chain), auction, {
      api: API,
      ...(listing ? { requiredCurrencyRaised: listing.requiredCurrencyRaised } : {}),
      onProgress: (m) => status(m),
    });
    state.snapshot = snapshot;
    state.listing = listing;
    state.isExample = false;
    $<HTMLTextAreaElement>('snapshot').value = snapshotToJson(snapshot);
    setUrl({ chain: state.chain.key, auction });
    status('');
    showPlan();
  } catch (e) {
    status((e as Error).message, true);
  }
}

function useExample() {
  state.snapshot = demoSnapshot();
  state.listing = undefined;
  state.isExample = true;
  $<HTMLTextAreaElement>('snapshot').value = snapshotToJson(state.snapshot);
  showPlan();
}

function showPlan() {
  const s = state.snapshot;
  if (!s) return;
  $('pick').hidden = true;
  $('plan').hidden = false;
  const u = unitsOf(s);
  for (const el of document.querySelectorAll<HTMLElement>('[data-unit]')) {
    el.textContent = el.dataset.unit === 'price' ? `${u.cur} per ${u.tok}` : u.cur;
  }
  const report = inspect(s);
  const clearing = clearingNow(report);
  // New auction: suggest about $500 worth of currency, and a max price 50% above today's.
  if ($('budget').dataset.auction !== s.auction) {
    $('budget').value = defaultBudget(u.cur, state.listing?.currencyPriceUsd);
    $('budget').dataset.auction = s.auction;
  }
  if (!val('maxPrice') || $('maxPrice').dataset.auction !== s.auction) {
    $('maxPrice').value = formatPriceQ96((clearing * 3n) / 2n, u.tdec, u.cdec, 4);
    $('maxPrice').dataset.auction = s.auction;
  }
  $('price-hint').textContent =
    `Today's price is ${fmtPrice(clearing, u)}. Each bid must be above it.`;
  $('price-quick').innerHTML = [
    ['+25%', 5n, 4n],
    ['+50%', 3n, 2n],
    ['2×', 2n, 1n],
    ['3×', 3n, 1n],
  ]
    .map(
      ([label, n, d]) =>
        `<button type="button" data-v="${formatPriceQ96((clearing * (n as bigint)) / (d as bigint), u.tdec, u.cdec, 4)}">${label}</button>`,
    )
    .join('');
  for (const b of $('price-quick').querySelectorAll<HTMLButtonElement>('button')) {
    b.addEventListener('click', () => {
      $('maxPrice').value = b.dataset.v as string;
      render();
    });
  }
  renderAuctionCard(s, report, clearing);
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function defaultBudget(symbol: string, usd?: number): string {
  const price = usd && usd > 0 ? usd : /^(W?ETH)$/i.test(symbol) ? 2500 : 1;
  const units = 500 / price;
  // Two significant figures: 500 -> "500", 0.2 -> "0.2".
  return String(Number(units.toPrecision(2)));
}

function clearingNow(report: ReturnType<typeof inspect>): bigint {
  const f = report.figures.find((x) => x.label === 'clearing price (checkpointed now)');
  return typeof f?.value === 'bigint' ? f.value : 0n;
}

function renderAuctionCard(
  s: AuctionSnapshot,
  report: ReturnType<typeof inspect>,
  clearing: bigint,
) {
  const u = unitsOf(s);
  const l = state.listing;
  const raised = s.state.currencyRaisedQ96X7 / (1n << 96n) / 10_000_000n;
  const ms = state.msPerTick;
  const phase = report.phase;
  const when =
    phase === 'not-started'
      ? `Starts in ${ms ? formatDuration(Number(s.startBlock - s.blockNumber) * ms) : 'soon'}`
      : phase === 'live'
        ? `Ends in ${ms ? formatDuration(Number(s.endBlock - s.blockNumber) * ms) : '—'}`
        : 'Ended';
  const problems = report.checks.filter((c) => c.passed === false);
  $('auction-card').innerHTML = `<div class="auction-head">
    <div class="acard-top">${logo(u.tok, l?.tokenImageUrl)}<div class="acard-name"><h2>${esc(l?.tokenName ?? u.tok)}</h2><small>${esc(u.tok)} on ${esc(chainById(s.chainId)?.name ?? `chain ${s.chainId}`)}${state.isExample ? ' · example figures, not a real auction' : ''}</small></div>
    <span class="pill ${phase === 'live' ? 'live' : phase === 'not-started' ? 'upcoming' : 'ended'}">${esc(when)}</span></div>
    <div class="head-stats">
      <div><span>Price right now</span><b>${esc(fmtPrice(clearing, u))}</b></div>
      <div><span>Starting price</span><b>${esc(fmtPrice(s.floorPrice, u))}</b></div>
      <div><span>Tokens for sale</span><b>${esc(fmtTok(s.totalSupply, u))}</b></div>
      <div><span>Bidders</span><b>${l?.uniqueBidders ?? '—'}</b></div>
    </div>
    ${progress(raised, s.requiredCurrencyRaised, u.cdec, u.cur)}
    ${l?.isFlagged ? '<div class="note bad">Uniswap has flagged this token. Check it carefully before bidding.</div>' : ''}
    ${problems.length > 0 ? `<div class="note">Heads up: ${problems.map((p) => esc(plainCheck(p.id, p.title))).join(' ')}</div>` : ''}
  </div>`;
}

function plainCheck(id: string, title: string): string {
  const map: Record<string, string> = {
    'last-block-supply':
      'Very few tokens are sold at the very end, so the final price could be nudged by a small bid.',
    'graduation-floor': 'The sale needs the price to rise above the start before it can succeed.',
    'graduation-high': 'The minimum raise is very high, so the sale may fail and refund everyone.',
    'tick-gas': 'Price steps are very small, which makes bidding expensive in gas.',
    'claim-delay': 'You will wait a long time after the end before you can claim tokens.',
    decimals: 'This token or currency uses very few decimals, so rounding can cost you.',
    'tokens-received': 'The auction has not received its tokens yet, so bids will fail for now.',
    'validation-hook': 'This auction has extra bidding rules, so some bids may be rejected.',
  };
  return map[id] ?? `${title}.`;
}

// ---------- plan ----------

const SCENARIO_COPY: Record<string, [string, string]> = {
  none: ['Nobody else bids', 'Only you bid from now on'],
  low: ['Quiet', 'Half the expected demand'],
  base: ['Expected', 'Enough demand to reach your max price'],
  high: ['Busy', 'Twice the expected demand'],
  custom: ['Your guess', 'The amount you entered'],
};

function render() {
  const s = state.snapshot;
  if (!s) return;
  const u = unitsOf(s);
  $('err').textContent = '';
  try {
    const weighting = (document.querySelector('input[name=weighting]:checked') as HTMLInputElement)
      ?.value as Weighting;
    const custom =
      (document.querySelector('input[name=demandMode]:checked') as HTMLInputElement)?.value ===
      'custom';
    $('demand-wrap').hidden = !custom;
    const demand = custom ? val('demand') : '';
    const result = plan(s, {
      budget: toRaw(val('budget') || '0', u.cdec),
      maxPrice: toPriceQ96(val('maxPrice') || '0', u.tdec, u.cdec),
      levels: Number(val('levels')),
      weighting,
      ...(demand ? { forecastDemand: toRaw(demand, u.cdec) } : {}),
    });
    if (!result.ok) {
      $('out').innerHTML =
        `<div class="note bad">${esc(friendlyError(result.reason, result.message))}</div>`;
      return;
    }
    $('out').innerHTML = renderResult(result, s, u, Boolean(demand));
  } catch (e) {
    $('err').textContent = (e as Error).message;
  }
}

function friendlyError(reason: string, msg: string): string {
  switch (reason) {
    case 'NoValidTicks':
      return "Your max price is at or below today's price, so no bid would be accepted. Raise your max price.";
    case 'ZeroBudget':
      return 'Enter how much you want to spend.';
    case 'MaxPriceTooHigh':
      return 'That max price is higher than this auction allows. Lower it.';
    case 'AuctionIsOver':
      return 'This auction has ended, so you can no longer bid.';
    default:
      return msg;
  }
}

function outcomeCard(sim: SimulationResult, name: string, u: Units, main: boolean): string {
  const [title, sub] = SCENARIO_COPY[name] ?? [name, ''];
  return `<div class="outcome${main ? ' main' : ''}"><h4>${esc(title)}</h4><div class="sub">${esc(sub)}</div><dl>
    <dt>You get</dt><dd>${esc(fmtTok(sim.tokensFilled, u))}</dd>
    <dt>You pay</dt><dd>${esc(fmtCur(sim.currencySpent, u))}</dd>
    <dt>Avg price</dt><dd>${sim.tokensFilled > 0n ? esc(fmtPrice(sim.averagePrice, u)) : '—'}</dd>
    <dt>Refunded</dt><dd>${esc(fmtCur(sim.currencyRefunded, u))}</dd>
    <dt>Sale succeeds</dt><dd>${sim.graduated ? 'Yes' : '<span class="flag">No, all refunded</span>'}</dd>
  </dl></div>`;
}

function renderResult(r: PlanResult, s: AuctionSnapshot, u: Units, customDemand: boolean): string {
  const sims = r.simulations;
  const main = sims.find((x) => x.scenario === 'base') ?? sims[0];
  let html = '';
  if (main) {
    html += `<div class="headline">If demand is ${customDemand ? 'what you guessed' : 'about as expected'}, you'd get about <b>${esc(fmtTok(main.tokensFilled, u))}</b> for <b>${esc(fmtCur(main.currencySpent, u))}</b>${main.tokensFilled > 0n ? ` (about <b>${esc(fmtPrice(main.averagePrice, u))}</b> each)` : ''}, and <b>${esc(fmtCur(main.currencyRefunded, u))}</b> would come back to you.${main.graduated ? '' : ' <span class="flag">The sale would not reach its minimum, so everyone is refunded.</span>'}</div>`;
  }
  html += '<h2>What could happen</h2><div class="outcomes">';
  const order = customDemand
    ? sims
    : (['none', 'low', 'base', 'high']
        .map((n) => sims.find((x) => x.scenario === n))
        .filter(Boolean) as SimulationResult[]);
  html += order
    .map((sim) =>
      outcomeCard(
        sim,
        customDemand && sim.scenario === 'base' ? 'custom' : sim.scenario,
        u,
        sim === main,
      ),
    )
    .join('');
  html += '</div>';
  html += `<p class="hint">These are estimates, not predictions. They depend on how much others bid, which nobody knows in advance.</p>`;

  html += `<h2>Your bids</h2><p class="hint">Place them from the lowest price up. Each one only spends money while the auction price is below it.</p><ul class="bids">`;
  html += r.schedule
    .map(
      (b, i) =>
        `<li><b>Bid ${i + 1}</b><span>pay up to ${esc(fmtPrice(b.maxPrice, u))}</span><b>${esc(fmtCur(b.amount, u))}</b></li>`,
    )
    .join('');
  html += '</ul>';

  const warnings = [...new Set(r.warnings)].filter((w) => !w.includes('does not graduate'));
  if (warnings.length > 0)
    html += warnings.map((w) => `<div class="note">${esc(w)}</div>`).join('');

  html += `<h2>How this works</h2><ul class="hint" style="font-size:14px;line-height:1.7">
    <li>Everyone who gets tokens pays the same price at each moment. You never pay more than the price you set.</li>
    <li>Your money is spent gradually over the rest of the auction, so bidding early gets you more of the sale.</li>
    <li>If the price rises past one of your bids, that bid stops buying and the rest is refunded after the auction.</li>
    <li>If the auction doesn't reach its minimum, everyone gets all their money back.</li>
  </ul>`;

  html += `<details class="adv"><summary>Advanced: exact values for developers</summary>
    <p class="hint">Raw values to pass to <code>submitBid</code>, in this order. Prices are Q96 fixed-point. The CLI can encode the full calldata: <code>cca-bid-planner calldata --chain ${esc(chainById(s.chainId)?.key ?? String(s.chainId))} --auction ${esc(s.auction)} --bid ...</code></p>
    <div class="tbl"><table><thead><tr><th>#</th><th>maxPriceQ96</th><th>amount (raw)</th><th>prevTickPriceQ96</th></tr></thead><tbody>
    ${r.schedule.map((b, i) => `<tr><td>${i + 1}</td><td><code>${b.maxPrice}</code></td><td><code>${b.amount}</code></td><td><code>${b.prevTickPrice}</code></td></tr>`).join('')}
    </tbody></table></div>
    <p class="hint">Auction <code>${esc(s.auction)}</code> on chain ${s.chainId}, read at auction block ${s.blockNumber}. Submit block assumed: ${r.block}.</p>
  </details>`;
  return html;
}

// ---------- url + init ----------

function setUrl(p: { chain?: string | undefined; auction?: string | undefined }) {
  const q = new URLSearchParams(location.search);
  if (p.chain) q.set('chain', p.chain);
  if (p.auction) q.set('auction', p.auction);
  else q.delete('auction');
  history.replaceState(null, '', `?${q.toString()}`);
}

function backToList() {
  $('plan').hidden = true;
  $('pick').hidden = false;
  setUrl({ chain: state.chain.key, auction: undefined });
  if (state.listings.length === 0) void selectChain(state.chain.key);
}

function init() {
  const q = new URLSearchParams(location.search);
  const chain = findChain(q.get('chain') ?? DEFAULT_CHAIN);
  if (chain) state.chain = chain;
  renderChains();
  $('show-open').addEventListener('click', () => setShowEnded(false));
  $('show-ended').addEventListener('click', () => setShowEnded(true));
  $('search').addEventListener('input', renderList);
  $('back').addEventListener('click', backToList);
  $('example').addEventListener('click', useExample);
  $('open-addr').addEventListener('click', () => void openAuction(val('addr')));
  $('snapshot').addEventListener('change', () => {
    try {
      state.snapshot = snapshotFromJson($<HTMLTextAreaElement>('snapshot').value);
      state.listing = undefined;
      state.isExample = false;
      const c = chainById(state.snapshot.chainId);
      if (c) state.chain = c;
      showPlan();
    } catch (e) {
      status((e as Error).message, true);
    }
  });
  for (const id of ['budget', 'maxPrice', 'levels', 'demand'])
    $(id).addEventListener('change', render);
  for (const el of document.querySelectorAll('input[name=weighting], input[name=demandMode]')) {
    el.addEventListener('change', render);
  }
  $('run').addEventListener('click', render);
  void selectChain(state.chain.key).then(() => {
    const a = q.get('auction');
    if (a) {
      const listing = state.listings.find((x) => x.address.toLowerCase() === a.toLowerCase());
      void openAuction(a, listing);
    }
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
