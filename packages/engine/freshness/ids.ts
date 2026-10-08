import { randomBytes } from 'node:crypto';

// Shim for Wave 2: lane A/B own id generation. Same format (`<prefix>_<ulid>`, contracts ID_PREFIX).
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: Date = new Date()): string {
  let t = now.getTime();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(bytes[i] ?? 0) % 32];
  return time + rand;
}

export const newId = (prefix: string, now?: Date) => `${prefix}_${ulid(now)}`;
