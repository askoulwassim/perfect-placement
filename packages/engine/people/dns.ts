import { resolveMx } from 'node:dns/promises';
import type { MxResolver } from './email.js';

/** DNS MX lookup with a timeout (#37): true = records, false = none, null = lookup failed. Never SMTP. */
export const defaultMx: MxResolver = async (domain) => {
  const timeout = new Promise<null>((ok) => setTimeout(() => ok(null), 3000).unref());
  const lookup = resolveMx(domain).then(
    (r) => r.length > 0,
    (e: NodeJS.ErrnoException) => (e.code === 'ENOTFOUND' || e.code === 'ENODATA' ? false : null),
  );
  return Promise.race([lookup, timeout]);
};
