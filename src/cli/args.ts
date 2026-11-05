export interface ParsedArgs {
  command: string | undefined;
  flags: Map<string, string[]>;
  positionals: string[];
}

const BOOLEAN_FLAGS = new Set(['json', 'help', 'version', 'quiet']);

export class UsageError extends Error {
  override name = 'UsageError';
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '-h') {
      push(flags, 'help', 'true');
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) push(flags, name, a.slice(eq + 1));
      else if (BOOLEAN_FLAGS.has(name)) push(flags, name, 'true');
      else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new UsageError(`--${name} needs a value`);
        push(flags, name, v);
        i++;
      }
    } else positionals.push(a);
  }
  return { command: positionals.shift(), flags, positionals };
}

function push(m: Map<string, string[]>, k: string, v: string) {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

export function flag(a: ParsedArgs, name: string): string | undefined {
  const v = a.flags.get(name);
  return v ? v[v.length - 1] : undefined;
}

export function flags(a: ParsedArgs, name: string): string[] {
  return a.flags.get(name) ?? [];
}

export function bool(a: ParsedArgs, name: string): boolean {
  return a.flags.has(name);
}

export function required(a: ParsedArgs, name: string): string {
  const v = flag(a, name);
  if (v === undefined) throw new UsageError(`missing --${name}`);
  return v;
}
