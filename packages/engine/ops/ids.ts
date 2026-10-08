import { randomBytes } from 'node:crypto';
import { ID_PREFIX } from '@perfect-placement/contracts';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID (26 chars, Crockford base32): 48-bit ms time + 80 random bits. */
export function ulid(now: Date = new Date()): string {
  let t = now.getTime();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(bytes[i] as number) % 32];
  return time + rand;
}

/** `<prefix>_<ulid>` for every table except role and company. */
export function newId(table: keyof typeof ID_PREFIX, now?: Date): string {
  return `${ID_PREFIX[table]}_${ulid(now)}`;
}

/** kebab-case slug, matching the fixtures and v1 ids. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Role id = `<company-slug>_<title-slug>`, `-2`, `-3` on collision. */
export function roleIdFor(companySlug: string, title: string, exists: (id: string) => boolean): string {
  const base = `${companySlug}_${slugify(title) || 'role'}`;
  if (!exists(base)) return base;
  for (let n = 2; ; n++) if (!exists(`${base}-${n}`)) return `${base}-${n}`;
}
