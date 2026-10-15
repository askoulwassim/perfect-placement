import { join } from 'node:path';
import type { Skill } from '@perfect-placement/contracts';
import type { Capability } from '../grants.js';

/*
 * One browser policy per run (#161): the PP browser adapter (`pp_browser`, packages/mcp/src/browser.ts) enforces
 * it, and the runner's MCP config and prompt are derived from the same object. The engine builds it at dispatch.
 */

/** The PP browser adapter's MCP server name in a run's config (#157). */
export const BROWSER_SERVER = 'pp_browser';
/** The adapter's read tools, and the fill assist's two (in grant order). */
export const BROWSER_READ_TOOLS = ['list_pages', 'new_page', 'close_page', 'navigate_page', 'take_snapshot'] as const;
export const BROWSER_FILL_TOOLS = ['fill_form', 'upload_file'] as const;

export interface BrowserRunPolicy {
  /** The adapter tools the run may call (Chrome DevTools MCP names), in grant order. */
  tools: string[];
  /** Absolute paths of the rendered PDFs the run may upload. Empty: no uploads. */
  uploads: string[];
  /** Sites the run may open: each a host, allowing that host and its subdomains. */
  sites: string[];
}

/** The adapter's (Chrome DevTools MCP's) tool for each browser capability. */
export const ADAPTER_TOOL: Readonly<Record<Extract<Capability, `browser.${string}`>, string>> = {
  'browser.tabs': 'list_pages',
  'browser.new_tab': 'new_page',
  'browser.close_tab': 'close_page',
  'browser.navigate': 'navigate_page',
  'browser.text': 'take_snapshot',
  'browser.tree': 'take_snapshot',
  'browser.find': 'take_snapshot',
  'browser.fill': 'fill_form',
  'browser.upload': 'upload_file',
};
export const ADAPTER_TOOLS: readonly string[] = [...new Set(Object.values(ADAPTER_TOOL))];

/**
 * Applicant tracking systems a portal or an Apply link commonly lands on. A fill run may open these besides the
 * posting's, the portal's and the company's own sites. Keep sorted; add one when a real portal needs it.
 */
export const ATS_SITES: readonly string[] = [
  'adp.com',
  'applytojob.com',
  'ashbyhq.com',
  'bamboohr.com',
  'breezy.hr',
  'dayforcehcm.com',
  'gem.com',
  'greenhouse.io',
  'icims.com',
  'jazzhr.com',
  'jobvite.com',
  'lever.co',
  'myworkdayjobs.com',
  'myworkdaysite.com',
  'oraclecloud.com',
  'personio.com',
  'personio.de',
  'pinpointhq.com',
  'recruitee.com',
  'rippling.com',
  'smartrecruiters.com',
  'successfactors.com',
  'successfactors.eu',
  'taleo.net',
  'teamtailor.com',
  'ultipro.com',
  'workable.com',
  'workday.com',
];

/** Sign-in pages a portal may send the user through. Hosts, not their parent domains (no google.com at large). */
export const SIGN_IN_SITES: readonly string[] = ['accounts.google.com', 'appleid.apple.com', 'login.live.com', 'login.microsoftonline.com'];

/** LinkedIn skills (connect, voice) read LinkedIn only. */
export const LINKEDIN_SITES: readonly string[] = ['linkedin.com'];

const PUBLIC_SECOND_LEVEL = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org']);

/**
 * The site a URL belongs to: its registrable domain by a small heuristic (`jobs.acme.co.uk` -> `acme.co.uk`,
 * `careers.acme.com` -> `acme.com`); an IP address or single-label host as is. Null for a non-web URL.
 */
export function siteOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    host = u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return host || null;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const last = labels.at(-1) as string;
  const second = labels.at(-2) as string;
  return labels.slice(last.length === 2 && PUBLIC_SECOND_LEVEL.has(second) ? -3 : -2).join('.');
}

/** May a run with these sites open `url`? Web URLs on a listed host or its subdomains, and `about:blank`. */
export function siteAllowed(url: string, sites: readonly string[]): boolean {
  if (url === 'about:blank') return true;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    host = u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
}

/**
 * The sites a skill's run may open. `fill`: the posting's and portal's sites, the company's domain, applicant
 * tracking and sign-in sites. `connect`, `voice`: LinkedIn. Other skills use no browser.
 */
export function skillSites(
  skill: Skill,
  known: { urls?: ReadonlyArray<string | null | undefined>; companyDomain?: string | null } = {},
): string[] {
  if (skill === 'connect' || skill === 'voice') return [...LINKEDIN_SITES];
  if (skill !== 'fill') return [];
  const own = [...(known.urls ?? []).map(siteOf), known.companyDomain ? siteOf(`https://${known.companyDomain}`) : null];
  return [...new Set([...own.filter((s): s is string => Boolean(s)), ...ATS_SITES, ...SIGN_IN_SITES])];
}

/** The run's policy from its granted capabilities, the rendered-files folder and its sites. */
export function browserPolicy(opts: { caps: readonly Capability[]; filesDir?: string; sites: readonly string[] }): BrowserRunPolicy {
  const browser = opts.caps.filter((c): c is keyof typeof ADAPTER_TOOL => c.startsWith('browser.'));
  const uploads =
    browser.includes('browser.upload') && opts.filesDir
      ? ['resume.pdf', 'cover_letter.pdf'].map((f) => join(opts.filesDir as string, f))
      : [];
  return {
    tools: [...new Set(browser.filter((c) => c !== 'browser.upload' || uploads.length).map((c) => ADAPTER_TOOL[c]))],
    uploads,
    sites: [...opts.sites],
  };
}

/** Read a policy passed on the adapter's command line; throws on anything malformed. */
export function parseBrowserPolicy(json: string): BrowserRunPolicy {
  const p = JSON.parse(json) as Partial<BrowserRunPolicy>;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);
  if (
    !p ||
    typeof p !== 'object' ||
    !strings(p.tools) ||
    !strings(p.sites) ||
    !Array.isArray(p.uploads) ||
    !p.uploads.every((x) => typeof x === 'string')
  )
    throw new Error('The browser policy must have tools, uploads and sites');
  const unknown = p.tools.filter((t) => !ADAPTER_TOOLS.includes(t));
  if (unknown.length) throw new Error(`The browser policy names unknown tools: ${unknown.join(', ')}`);
  if (p.uploads.some((f) => !f.startsWith('/'))) throw new Error('The browser policy uploads must be absolute paths');
  if (p.uploads.length && !p.tools.includes('upload_file')) throw new Error('The browser policy has uploads but no upload tool');
  if (p.sites.some((s) => s.includes('/') || s.includes(' '))) throw new Error('The browser policy sites must be hosts');
  return { tools: p.tools, uploads: p.uploads, sites: p.sites };
}
