/**
 * Every figure the tool reports carries a provenance label:
 * - observed: read from chain (or the snapshot) as-is
 * - derived:  computed from observed values with protocol math
 * - assumed:  depends on a user-supplied or default assumption (e.g. demand forecast)
 */
export type FigureKind = 'observed' | 'derived' | 'assumed';

export interface Figure<T = string> {
  label: string;
  value: T;
  kind: FigureKind;
  unit?: string;
  note?: string;
}

export function observed<T>(label: string, value: T, unit?: string, note?: string): Figure<T> {
  return make('observed', label, value, unit, note);
}
export function derived<T>(label: string, value: T, unit?: string, note?: string): Figure<T> {
  return make('derived', label, value, unit, note);
}
export function assumed<T>(label: string, value: T, unit?: string, note?: string): Figure<T> {
  return make('assumed', label, value, unit, note);
}

function make<T>(
  kind: FigureKind,
  label: string,
  value: T,
  unit: string | undefined,
  note: string | undefined,
): Figure<T> {
  const f: Figure<T> = { label, value, kind };
  if (unit !== undefined) f.unit = unit;
  if (note !== undefined) f.note = note;
  return f;
}
