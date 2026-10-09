import { RUN_ACTIVE_STATUSES, type Run, type RunStatus, type Skill } from '@perfect-placement/contracts';
import { humanize } from './format';

/*
 * Run status everywhere (#21): one place that names a run, its in-progress label, and its outcome.
 * A run row: `op` = the skill; `summary_json` = { skill, role_id?, contact_id?, outreach_id?, actor,
 * runner, ...what the skill reported (counts), error?, denied_tools?, runner_log? }.
 */

export const SKILL_LABEL: Record<Skill, string> = {
  onboard: 'Setup',
  scout: 'Scout',
  score: 'Score',
  freshness: 'Freshness',
  research: 'Research',
  tailor: 'Tailor',
  connect: 'Connect',
  fill: 'Fill',
  inbox: 'Inbox',
  learn: 'Learn',
};

/** The in-progress label a start button shows while its run is running. */
export const SKILL_ACTIVE: Record<Skill, string> = {
  onboard: 'Setting up',
  scout: 'Scouting',
  score: 'Scoring',
  freshness: 'Checking',
  research: 'Researching',
  tailor: 'Tailoring',
  connect: 'Drafting',
  fill: 'Filling',
  inbox: 'Reading inbox',
  learn: 'Learning',
};

export const isActive = (s: RunStatus) => (RUN_ACTIVE_STATUSES as readonly RunStatus[]).includes(s);

export interface RunSummary {
  skill?: string;
  role_id?: string;
  contact_id?: string;
  outreach_id?: string;
  error?: string;
  denied_tools?: string[];
  runner_log?: string;
  [k: string]: unknown;
}
export const summaryOf = (r: Run): RunSummary => (r.summary_json ?? {}) as RunSummary;

export const runLabel = (r: Run): string => SKILL_LABEL[r.op as Skill] ?? humanize(r.op);

/** Button label while the run is in flight: "Queued" or the skill's verb ("Scouting"). */
export const activeLabel = (r: Run): string =>
  r.status === 'queued' ? 'Queued' : (SKILL_ACTIVE[r.op as Skill] ?? `${runLabel(r)} running`);

/** Bookkeeping keys in summary_json that are not outcomes. */
const META = new Set(['skill', 'role_id', 'contact_id', 'outreach_id', 'actor', 'runner', 'step', 'gmail_draft_id', 'runner_log']);

/** What changed, from the numbers the skill reported: "12 added · 3 duplicates". Null when it reported none. */
export function runCounts(r: Run, max = 2): string | null {
  const s = summaryOf(r);
  let nums = Object.entries(s).filter(([k, v]) => !META.has(k) && typeof v === 'number') as Array<[string, number]>;
  // Nothing reported at the top: use the tallies the run's own ops recorded (`"roles.add": { added: 3 }`).
  if (!nums.length)
    nums = Object.entries(s)
      .filter(([k, v]) => k.includes('.') && v && typeof v === 'object' && !Array.isArray(v))
      .flatMap(([, v]) => Object.entries(v as Record<string, unknown>).filter(([, n]) => typeof n === 'number' && n > 0)) as Array<
      [string, number]
    >;
  // The headline count first (scout: added; then anything else), "queries_run" last.
  const rank = (k: string) => (k === 'added' ? 0 : k.startsWith('queries') ? 2 : 1);
  nums.sort((a, b) => rank(a[0]) - rank(b[0]));
  const parts = nums.slice(0, max).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`);
  return parts.length ? parts.join(' · ') : null;
}

/** The one-line reason a run failed. */
export function runReason(r: Run): string {
  const s = summaryOf(r);
  if (typeof s.error === 'string' && s.error.trim()) return s.error.trim().split('\n')[0] as string;
  return r.status === 'partial' ? 'partly done' : 'no reason given';
}

/** Short outcome for a row or toast: "12 added", "interrupted", "Running". */
export function runOutcome(r: Run): string {
  if (r.status === 'queued') return 'Queued';
  if (r.status === 'running') return 'Running';
  if (r.status === 'error') return runReason(r);
  const counts = runCounts(r);
  if (r.status === 'partial') return counts ? `partial · ${counts}` : 'partial';
  return counts ?? 'done';
}

/** Toast when a run ends: "Scout done · 12 added" / "Scout failed · interrupted". */
export function runToast(r: Run): { text: string; tone: 'ok' | 'error' } {
  const name = runLabel(r);
  if (r.status === 'error') return { text: `${name} failed · ${runReason(r)}`, tone: 'error' };
  const counts = runCounts(r);
  if (r.status === 'partial') return { text: `${name} partial${counts ? ` · ${counts}` : ''}`, tone: 'error' };
  return { text: `${name} done${counts ? ` · ${counts}` : ''}`, tone: 'ok' };
}

/** What a start button is scoped to: a run matches when its skill and every given scope id match. */
export interface RunScope {
  skill: Skill;
  role_id?: string;
  contact_id?: string;
  outreach_id?: string;
}
export function matches(r: Run, q: RunScope): boolean {
  if (r.op !== q.skill) return false;
  const s = summaryOf(r);
  return (
    (q.role_id === undefined || s.role_id === q.role_id) &&
    (q.contact_id === undefined || s.contact_id === q.contact_id) &&
    (q.outreach_id === undefined || s.outreach_id === q.outreach_id)
  );
}

/** The `runs.start` input that runs this again (Retry). */
export function retryInput(r: Run): RunScope | null {
  const s = summaryOf(r);
  const skill = (s.skill ?? r.op) as Skill;
  if (!(skill in SKILL_LABEL)) return null;
  if (s.outreach_id) return { skill, outreach_id: s.outreach_id };
  return {
    skill,
    ...(s.role_id ? { role_id: s.role_id } : {}),
    ...(s.contact_id ? { contact_id: s.contact_id } : {}),
  };
}

/** Elapsed or total time: "42s", "3m", "1h 5m". */
export function duration(r: Run, now: Date): string {
  const end = r.finished_at ? Date.parse(r.finished_at) : now.getTime();
  const s = Math.max(0, Math.round((end - Date.parse(r.started_at)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
