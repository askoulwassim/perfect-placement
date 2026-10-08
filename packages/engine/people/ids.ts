import { randomBytes } from 'node:crypto';

// WAVE2-SHIM: lane A owns id generation; replace with its helper when merged.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Crockford base32 ULID (48-bit time + 80-bit randomness). */
export function ulid(now: number = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ALPHABET[(bytes[i] ?? 0) % 32];
  return time + rand;
}

export const defaultNewId = (prefix: string): string => `${prefix}_${ulid()}`;
