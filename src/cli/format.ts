import type { Figure } from '../core/label.js';
import { formatPriceQ96, fromRaw } from '../core/price.js';
import type { AuctionSnapshot } from '../core/snapshot.js';

const TAG: Record<Figure['kind'], string> = {
  observed: '[obs]',
  derived: '[der]',
  assumed: '[asm]',
};

export interface Units {
  tokenDecimals: number;
  currencyDecimals: number;
  tokenSymbol: string;
  currencySymbol: string;
}

export function unitsOf(s: AuctionSnapshot): Units {
  return {
    tokenDecimals: s.token.decimals,
    currencyDecimals: s.currency.decimals,
    tokenSymbol: s.token.symbol,
    currencySymbol: s.currency.symbol,
  };
}

export function price(q96: bigint, u: Units): string {
  return `${formatPriceQ96(q96, u.tokenDecimals, u.currencyDecimals)} ${u.currencySymbol}/${u.tokenSymbol}`;
}

export function currency(raw: bigint, u: Units): string {
  return `${group(fromRaw(raw, u.currencyDecimals, 6))} ${u.currencySymbol}`;
}

export function tokens(raw: bigint, u: Units): string {
  return `${group(fromRaw(raw, u.tokenDecimals, 4))} ${u.tokenSymbol}`;
}

export function group(s: string): string {
  const [i = '', f] = s.split('.');
  const neg = i.startsWith('-');
  const digits = neg ? i.slice(1) : i;
  const g = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${g}${f ? `.${f}` : ''}`;
}

export function figureValue(f: Figure<unknown>, u: Units): string {
  const v = f.value;
  if (typeof v === 'bigint') {
    switch (f.unit) {
      case 'priceQ96':
        return price(v, u);
      case 'currency':
        return currency(v, u);
      case 'token':
        return tokens(v, u);
      default:
        return v.toString();
    }
  }
  return String(v);
}

export function figureLines(figs: ReadonlyArray<Figure<unknown>>, u: Units): string[] {
  const width = Math.max(...figs.map((f) => f.label.length));
  return figs.map(
    (f) =>
      `  ${TAG[f.kind]} ${f.label.padEnd(width)}  ${figureValue(f, u)}${f.note ? `  (${f.note})` : ''}`,
  );
}

export function table(rows: string[][], header: string[]): string[] {
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(...all.map((r) => (r[c] ?? '').length)));
  const line = (r: string[]) =>
    `  ${r
      .map((cell, c) => cell.padEnd(widths[c] ?? 0))
      .join('  ')
      .trimEnd()}`;
  return [line(header), `  ${widths.map((w) => '-'.repeat(w)).join('  ')}`, ...rows.map(line)];
}

/** JSON with bigints as strings. */
export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
}
