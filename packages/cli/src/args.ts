/** Tiny argv parser: positionals, `--key value`, `--key=value`, repeated keys, boolean `--flag`. */
export interface Args {
  _: string[];
  flags: Map<string, string[]>;
  get(key: string): string | undefined;
  all(key: string): string[];
  has(key: string): boolean;
}

const BOOLEAN_FLAGS = new Set([
  'all',
  'dry-run',
  'help',
  'json',
  'kev',
  'fixtures',
  'yes',
  'no-kev',
  'no-mcp',
  'wait',
  'schedule',
  'no-schedules',
  'no-catch-up',
  'no-wait',
]);

export function parseArgs(argv: readonly string[]): Args {
  const _: string[] = [];
  const flags = new Map<string, string[]>();
  const put = (k: string, v: string) => flags.set(k, [...(flags.get(k) ?? []), v]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) {
      _.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) put(a.slice(2, eq), a.slice(eq + 1));
    else {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(key) || next === undefined || (next.startsWith('--') && next !== '-')) put(key, 'true');
      else {
        put(key, next);
        i++;
      }
    }
  }
  return {
    _,
    flags,
    get: (k) => flags.get(k)?.at(-1),
    all: (k) => flags.get(k) ?? [],
    has: (k) => flags.has(k),
  };
}
