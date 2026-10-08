import { createHash, randomBytes } from 'node:crypto';
import { ID_PREFIX } from '@perfect-placement/contracts';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number): string {
  let out = '';
  let t = Math.max(0, Math.floor(ms));
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 16 chars x 5 bits = 80 bits.
  let out = '';
  let acc = 0;
  let bits = 0;
  let i = 0;
  while (out.length < 16) {
    if (bits < 5) {
      acc = (acc << 8) | (bytes[i++] ?? 0);
      bits += 8;
    }
    out += CROCKFORD[(acc >> (bits - 5)) & 31];
    bits -= 5;
  }
  return out;
}

/** A ULID. Pass `seed` for a deterministic one (same time + seed = same id); used by the idempotent v1 importer. */
export function ulid(timeMs: number = Date.now(), seed?: string): string {
  const rand = seed === undefined ? randomBytes(10) : createHash('sha256').update(seed).digest().subarray(0, 10);
  return encodeTime(timeMs) + encodeRandom(rand);
}

export type IdTable = keyof typeof ID_PREFIX;

/** `<prefix>_<ulid>` for a table (see ID_PREFIX). */
export function newId(table: IdTable, timeMs?: number, seed?: string): string {
  return `${ID_PREFIX[table]}_${ulid(timeMs, seed)}`.toLowerCase();
}

/** kebab-case slug matching the contracts `Slug` regex. */
export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Role id `<company-slug>_<title-slug>`, with `-2`, `-3` on collision. */
export function roleId(companySlug: string, titleSlug: string, taken: (id: string) => boolean = () => false): string {
  const base = `${companySlug}_${titleSlug}`;
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

/** ISO 8601 UTC now. */
export const nowIso = (): string => new Date().toISOString();
