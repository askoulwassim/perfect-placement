import { randomBytes } from 'node:crypto';
import { ID_PREFIX } from '@perfect-placement/contracts';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Minimal ULID (time-sortable, 26 chars). Stdlib only. */
export function ulid(now: number = Date.now(), rand: (n: number) => Uint8Array = randomBytes): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = rand(16);
  let r = '';
  for (let i = 0; i < 16; i++) r += CROCKFORD[(bytes[i] ?? 0) % 32];
  return time + r;
}

export const newDecisionId = (now?: number): string => `${ID_PREFIX.decision}_${ulid(now)}`;
export const newEventId = (now?: number): string => `ev_${ulid(now)}`;
