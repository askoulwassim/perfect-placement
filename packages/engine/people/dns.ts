import { promises as dns } from 'node:dns';
import type { MxResolver } from './email.js';

/** The two DNS queries the domain check uses (injectable: tests pass fakes, never the network). */
export interface DnsLookups {
  resolveMx: (domain: string) => Promise<unknown[]>;
  resolve4: (domain: string) => Promise<unknown[]>;
}

const NONE = new Set(['ENOTFOUND', 'ENODATA', 'ENONAME', 'NXDOMAIN']);

/** One query: true = records, false = none (no such name or no data), null = the lookup failed. */
async function has(q: (d: string) => Promise<unknown[]>, domain: string): Promise<boolean | null> {
  try {
    return (await q(domain)).length > 0;
  } catch (e) {
    return NONE.has((e as NodeJS.ErrnoException).code ?? '') ? false : null;
  }
}

/**
 * Does the domain take mail? (#37, #99) `dns.promises.resolveMx`, falling back to an A record (the
 * implicit MX of RFC 5321): true = MX or A, false = neither, null = the lookup failed or timed out.
 * DNS only: never a connection to a mail server.
 */
export function createMailResolver(lookups: DnsLookups = dns, timeoutMs = 3000): MxResolver {
  return async (domain) => {
    const timeout = new Promise<null>((ok) => setTimeout(() => ok(null), timeoutMs).unref());
    const lookup = (async () => {
      const mx = await has(lookups.resolveMx, domain);
      if (mx !== false) return mx;
      return has(lookups.resolve4, domain);
    })();
    return Promise.race([lookup, timeout]);
  };
}

/** The default domain check (real DNS). */
export const defaultMx: MxResolver = createMailResolver();
