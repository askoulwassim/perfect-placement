import type { Skill } from '@perfect-placement/contracts';

/*
 * What each skill's headless run may use (#20), as runner-neutral capabilities (#159). Each runner binds a
 * capability to its own tool (claude-tools.ts, codex/text.ts) and SKILL.md names them as {{placeholders}}.
 */

export const CAPABILITIES = [
  'web.search',
  'web.fetch',
  'gmail.search',
  'gmail.thread',
  'gmail.message',
  'gmail.create_draft',
  'gmail.get_draft',
  'gmail.update_draft',
  'browser.tabs',
  'browser.new_tab',
  'browser.close_tab',
  'browser.navigate',
  'browser.text',
  'browser.tree',
  'browser.find',
  'browser.fill',
  'browser.upload',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Gmail search and read (#37, #80): inbox classifies replies, connect finds addresses, voice reads sent mail. */
export const GMAIL_READ_CAPS: readonly Capability[] = ['gmail.search', 'gmail.thread', 'gmail.message'];
/**
 * Reading a page (#81, #82, #107): see the open tabs and reuse the session's one, open one, close the run's own,
 * navigate by URL, read its text or structure, find an element. Nothing that clicks, types, runs script or submits.
 */
export const BROWSER_READ_CAPS: readonly Capability[] = [
  'browser.tabs',
  'browser.new_tab',
  'browser.close_tab',
  'browser.navigate',
  'browser.text',
  'browser.tree',
  'browser.find',
];
/** The fill assist (#106): set an answer field's value, upload the rendered PDFs. Neither clicks or presses a key. */
export const FILL_ASSIST_CAPS: readonly Capability[] = ['browser.fill', 'browser.upload'];

/**
 * The single per-skill grant for headless runs (#20). Every run gets the pp MCP tools; web only where the SKILL.md
 * needs it; Gmail only for `inbox`, `voice` (search + read) and `connect` (+ create a draft, #79); the browser only
 * for `connect` and `voice` (LinkedIn, read-only) and `fill` (the portal, #81; with assist also fill and upload).
 * Nothing else: every read and write goes through ops.
 */
export const SKILL_GRANTS: Readonly<
  Record<Skill, { web: readonly Capability[]; gmail: readonly Capability[]; browser?: readonly Capability[]; why: string }>
> = {
  scout: {
    web: ['web.search', 'web.fetch'],
    gmail: [],
    why: 'runs the plan.md queries on job boards and career pages, reads each posting',
  },
  research: { web: ['web.search', 'web.fetch'], gmail: [], why: 'builds a sourced, dated company dossier from the web' },
  freshness: { web: ['web.search', 'web.fetch'], gmail: [], why: 'judges unsure postings from the live page when asked' },
  tailor: { web: ['web.fetch'], gmail: [], why: 'captures the full JD from the posting when only a title is on file' },
  score: { web: ['web.fetch'], gmail: [], why: 'captures the full JD from the posting when only a title is on file' },
  fill: {
    web: ['web.fetch'],
    gmail: [],
    browser: [...BROWSER_READ_CAPS, ...FILL_ASSIST_CAPS],
    why: 'reads the real portal questions on every tab and step in the browser (read + navigate, #81); with assist (#106) uploads the rendered PDFs and fills answer fields (no click, key or script), stops before Submit; a web fetch for a plain posting page',
  },
  inbox: { web: [], gmail: GMAIL_READ_CAPS, why: 'Gmail search + read (read-only) to classify replies, plus ops' },
  learn: { web: [], gmail: [], why: 'ops only' },
  voice: {
    web: [],
    gmail: GMAIL_READ_CAPS,
    browser: BROWSER_READ_CAPS,
    why: "Learn voice (#76): the user's own sent Gmail (search + read, read-only) and, when LinkedIn is live, their LinkedIn posts in the browser (read + navigate only); proposes the Voice with profile.propose_voice",
  },
  onboard: {
    web: [],
    gmail: [],
    why: 'ops only: reads the kept resume with vault.read, writes the extraction with onboard.extract, follow-ups with onboard.propose_questions',
  },
  connect: {
    web: [],
    gmail: [...GMAIL_READ_CAPS, 'gmail.create_draft'],
    browser: BROWSER_READ_CAPS,
    why: 'LinkedIn read-only in the browser (read + navigate only, #82); Gmail search + read for contact emails (#37); a Gmail draft to finish the draft (#79)',
  },
};

/** Skills whose browser use is reading LinkedIn: on only when config.linkedin.mode is `live` (#82, #76). */
export const LINKEDIN_SKILLS: readonly Skill[] = ['connect', 'voice'];

/** Does this skill's run use the browser? `connect` and `voice` only when LinkedIn is live; `fill` always (#81). */
export const usesBrowser = (skill: Skill, linkedin = true): boolean =>
  (!LINKEDIN_SKILLS.includes(skill) || linkedin) && (SKILL_GRANTS[skill].browser?.length ?? 0) > 0;

/**
 * The capabilities a skill's run is granted, in order (web, Gmail, browser). `linkedin: false` drops the browser for
 * `connect` and `voice`; `assist: false` drops the fill assist's for `fill`. Default: the skill's full grant.
 */
export function skillCapabilities(skill: Skill, opts: { linkedin?: boolean; assist?: boolean } = {}): Capability[] {
  const g = SKILL_GRANTS[skill];
  const browser = usesBrowser(skill, opts.linkedin !== false) ? (g.browser ?? []) : [];
  return [...g.web, ...g.gmail, ...(opts.assist === false ? browser.filter((c) => !FILL_ASSIST_CAPS.includes(c)) : browser)];
}

/** Skills granted Gmail or the browser (#122): their tools load with the session and can be late or need setup. */
export const CONNECTOR_SKILLS: readonly Skill[] = (Object.keys(SKILL_GRANTS) as Skill[]).filter(
  (s) => SKILL_GRANTS[s].gmail.length > 0 || (SKILL_GRANTS[s].browser?.length ?? 0) > 0,
);

/** A Gmail or browser capability: its tools load with the session and can be missing (#122). */
export const isConnectorCapability = (c: Capability): boolean => c.startsWith('gmail.') || c.startsWith('browser.');

/** What a run is: a skill run, or connect's Gmail draft or To step (#79, #99). */
export type RunMode = 'skill' | 'gmail_draft' | 'gmail_to';

/** The capabilities of connect's Gmail steps: create the draft, or read it and set its To. */
export const GMAIL_STEP_CAPS: Readonly<Record<Exclude<RunMode, 'skill'>, readonly Capability[]>> = {
  gmail_draft: ['gmail.create_draft'],
  gmail_to: ['gmail.get_draft', 'gmail.update_draft'],
};
