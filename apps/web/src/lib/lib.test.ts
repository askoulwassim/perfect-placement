import type { Run } from '@perfect-placement/contracts';
import { contactLinks, contacts, decisions } from '@perfect-placement/fixtures';
import { describe, expect, it } from 'vitest';
import { probColor } from '../components/theme';
import { runStatusLabel } from '../screens/Runs';
import { cadence, lastResult, nextRun } from '../screens/Settings';
import { altsOf, pickOf, SHORT_Q, valueLabel } from './decisions';
import { bestPath, emailTag, linkedinState, type Person } from './people';
import { sourcesOf } from './role';
import {
  activeLabel,
  duration,
  isActive,
  matches,
  retryInput,
  runCounts,
  runOutcome,
  runTabs,
  runToast,
  scoreInput,
  scoreRunFor,
  triggeredBy,
  wasRetried,
} from './runs';
import { stageOf } from './stage';

describe('stageOf', () => {
  it('follows the handoff rule without an application', () => {
    expect(stageOf({ status: 'inbox' }, null)).toBe(0);
    expect(stageOf({ status: 'on-deck' }, null)).toBe(0);
    expect(stageOf({ status: 'active' }, null)).toBe(1);
    expect(stageOf({ status: 'held' }, null)).toBe(1);
    expect(stageOf({ status: 'draft-ready' }, null)).toBe(2);
    expect(stageOf({ status: 'applied' }, null)).toBe(5);
    expect(stageOf({ status: 'archived' }, null)).toBe(-1);
  });
  it('prefers the application stage', () => {
    expect(stageOf({ status: 'draft-ready' }, { stage: 'fill' })).toBe(3);
    expect(stageOf({ status: 'draft-ready' }, { stage: 'submit' })).toBe(4);
    expect(stageOf({ status: 'draft-ready' }, { stage: 'connect' }, { status: 'drafted' })).toBe(2);
    expect(stageOf({ status: 'draft-ready' }, { stage: 'connect' }, { status: 'in_gmail' })).toBe(3);
  });
  it('treats Research as done when the company has a dossier (#61)', () => {
    expect(stageOf({ status: 'on-deck' }, null, null, true)).toBe(1);
    expect(stageOf({ status: 'on-deck' }, { stage: 'research' }, null, true)).toBe(1);
    expect(stageOf({ status: 'on-deck' }, null, null, false)).toBe(0);
    expect(stageOf({ status: 'draft-ready' }, { stage: 'fill' }, null, true)).toBe(3);
    expect(stageOf({ status: 'archived' }, null, null, true)).toBe(-1);
  });
});

describe('bestPath', () => {
  const people = (roleId: string): Person[] =>
    contactLinks
      .filter((l) => l.role_id === roleId)
      .map((link) => ({ link, contact: contacts.find((c) => c.id === link.contact_id) as Person['contact'] }));
  it('picks warm hiring first', () => {
    const p = bestPath(people('linear_product-lead-insights'));
    expect(p?.path).toEqual(['You', 'Maya R.']);
  });
  it('routes a bridge through the 1st degree', () => {
    const p = bestPath(people('linear_product-lead-insights').filter((x) => x.link.tier !== 'warm_hiring'));
    expect(p?.path).toEqual(['You', 'Dev P.', 'Lina K.']);
  });
});

describe('probColor', () => {
  it('colors by policy thresholds', () => {
    const t = { auto: 0.9, second_opinion: 0.7 };
    expect(probColor(0.94, t)).toBe('#2FD39B');
    expect(probColor(0.78, t)).toBe('#E2B65A');
    expect(probColor(0.55, t)).toBe('#EF7D7D');
    expect(probColor(0.78, { auto: 0.75, second_opinion: 0.6 })).toBe('#2FD39B');
  });
});

describe('decision labels', () => {
  it('has a short question for every fixture decision', () => {
    for (const d of decisions) expect(SHORT_Q[d.kind].split(' ').length).toBeLessThanOrEqual(5);
  });
  it('labels picks and alternatives', () => {
    const fresh = decisions.find((d) => d.id === 'dc_0001');
    const inbox = decisions.find((d) => d.id === 'dc_0002');
    if (!fresh || !inbox) throw new Error('fixtures');
    expect(valueLabel(fresh.kind, pickOf(fresh))).toBe('Still open');
    expect(altsOf(fresh)).toEqual([false]);
    expect(valueLabel(inbox.kind, pickOf(inbox))).toBe('Interview request');
    expect(altsOf(inbox)).not.toContain('interview_request');
  });
});

describe('nextRun', () => {
  const now = new Date('2026-10-08T12:00:00.000Z'); // Thursday
  it('computes daily and weekly runs', () => {
    expect(nextRun('daily 07:30', now)).toBe('Fri 07:30');
    expect(nextRun('daily 18:00', now)).toBe('Thu 18:00');
    expect(nextRun('fri 05:30', now)).toBe('Fri 05:30');
    expect(nextRun('mon 05:30', now)).toBe('Mon 05:30');
    expect(nextRun('off', now)).toBeNull();
    expect(nextRun('weekdays 08:00', new Date('2026-10-09T09:00:00.000Z'))).toBe('Mon 08:00');
  });
  it('labels the cadence and the last scheduled run (#29)', () => {
    expect(cadence('daily 07:30')).toBe('Daily 07:30');
    expect(cadence('fri 05:30')).toBe('Weekly Fri 05:30');
    expect(cadence('weekdays 08:00')).toBe('Weekdays 08:00');
    expect(cadence('mon,thu 08:00')).toBe('Mon, Thu 08:00');
    expect(lastResult(null)).toBe('Never');
    const r = { id: 'rn_1', op: 'inbox', started_at: '2026-10-08T07:30:00.000Z', finished_at: null, summary_json: {}, log_path: null };
    expect(lastResult({ ...r, status: 'ok' })).toBe('Done');
    expect(lastResult({ ...r, status: 'error' })).toBe('Failed');
    expect(lastResult({ ...r, status: 'running' })).toBe('Running');
  });
});

describe('runs (#21)', () => {
  const run = (over: Partial<Run>): Run => ({
    id: 'rn_1',
    op: 'scout',
    started_at: '2026-10-08T10:00:00.000Z',
    finished_at: null,
    status: 'running',
    summary_json: { skill: 'scout', actor: 'human', runner: 'claude' },
    log_path: null,
    ...over,
  });
  it('labels in-flight runs by verb, queued as Queued', () => {
    expect(activeLabel(run({}))).toBe('Scouting');
    expect(activeLabel(run({ status: 'queued' }))).toBe('Queued');
    expect(activeLabel(run({ op: 'tailor' }))).toBe('Tailoring');
    expect(isActive('queued') && isActive('running') && !isActive('ok') && !isActive('error')).toBe(true);
  });
  it('toasts counts on success and the one-line reason on failure', () => {
    const ok = run({ status: 'ok', summary_json: { skill: 'scout', runner: 'claude', queries_run: 4, added: 12 } });
    expect(runToast(ok)).toEqual({ text: 'Scout done · 12 added · 4 queries run', tone: 'ok' });
    expect(runToast(run({ status: 'ok', op: 'research' }))).toEqual({ text: 'Research done', tone: 'ok' });
    // No counts reported: the run's own op tallies.
    expect(runToast(run({ status: 'ok', summary_json: { skill: 'scout', 'roles.add': { added: 3, duplicates: 0 } } })).text).toBe(
      'Scout done · 3 added',
    );
    const bad = run({ status: 'error', summary_json: { error: 'interrupted\nmore' } });
    expect(runToast(bad)).toEqual({ text: 'Scout failed · interrupted', tone: 'error' });
    expect(runOutcome(run({ status: 'error', summary_json: {} }))).toBe('no reason given');
  });
  it('matches a scope and rebuilds the start input for Retry', () => {
    const r = run({ op: 'connect', summary_json: { skill: 'connect', role_id: 'a_b', contact_id: 'ct_1' } });
    expect(matches(r, { skill: 'connect', role_id: 'a_b' })).toBe(true);
    expect(matches(r, { skill: 'connect', role_id: 'a_b', contact_id: 'ct_2' })).toBe(false);
    expect(matches(r, { skill: 'scout' })).toBe(false);
    expect(retryInput(r)).toEqual({ skill: 'connect', role_id: 'a_b', contact_id: 'ct_1' });
    expect(retryInput(run({ op: 'connect', summary_json: { outreach_id: 'or_1', role_id: 'a_b' } }))).toEqual({
      skill: 'connect',
      outreach_id: 'or_1',
    });
  });
  it('score runs (#31): one input for all inbox or one role; an all-inbox run covers every role', () => {
    expect(scoreInput()).toEqual({ skill: 'score' });
    expect(scoreInput('a_b')).toEqual({ skill: 'score', role_id: 'a_b' });
    const all = run({ id: 'rn_all', op: 'score', summary_json: { skill: 'score' } });
    const one = run({ id: 'rn_one', op: 'score', summary_json: { skill: 'score', role_id: 'a_b' } });
    expect(scoreRunFor([one])).toBeUndefined();
    expect(scoreRunFor([one], 'a_b')?.id).toBe('rn_one');
    expect(scoreRunFor([one], 'c_d')).toBeUndefined();
    expect(scoreRunFor([all], 'c_d')?.id).toBe('rn_all');
    expect(scoreRunFor([{ ...all, status: 'ok' }, run({})])).toBeUndefined();
    expect(activeLabel(all)).toBe('Scoring');
  });
  it('pipeline (#30): research matches by company; the chain is named, not counted', () => {
    const r = run({ op: 'research', summary_json: { skill: 'research', role_id: 'stripe_a', company_id: 'stripe' } });
    expect(matches(r, { skill: 'research', role_id: 'stripe_b', company_id: 'stripe' })).toBe(true);
    expect(matches(r, { skill: 'research', role_id: 'notion_a', company_id: 'notion' })).toBe(false);
    expect(matches(r, { skill: 'research', role_id: 'stripe_b' })).toBe(false);
    const chained = run({
      op: 'score',
      summary_json: { skill: 'score', triggered_by: 'rn_s', triggered_by_skill: 'scout', triggered: ['rn_r'], scored: 2 },
    });
    expect(triggeredBy(chained)).toEqual({ id: 'rn_s', label: 'Scout' });
    expect(triggeredBy(run({}))).toBeNull();
    expect(runCounts(chained)).toBe('2 scored');
  });
  it('Chrome tabs (#107): short counts, never counted as an outcome', () => {
    const r = run({
      op: 'fill',
      status: 'ok',
      summary_json: { skill: 'fill', tabs: { opened: [4, 5], closed: [5], left_open: [4], portal: 4 } },
    });
    expect(runTabs(r)).toBe('2 opened · 1 closed · 1 left open');
    expect(runTabs(run({ op: 'connect', summary_json: { tabs: { opened: [7], closed: [7], left_open: [] } } }))).toBe(
      '1 opened · 1 closed',
    );
    expect(runTabs(run({}))).toBeNull();
    expect(runCounts(r)).toBeNull();
  });
  it('a failed run the engine retried reads Retried; the attempt of a retry is not a count (#122)', () => {
    const failed = run({
      status: 'error',
      summary_json: { skill: 'inbox', error_code: 'connector_unavailable', error: 'connector_unavailable: x', retried: 'rn_2' },
    });
    expect(wasRetried(failed)).toBe(true);
    expect(runStatusLabel(failed)).toBe('Retried');
    expect(runOutcome(failed)).toBe('connector_unavailable: x');
    const retry = run({ status: 'ok', summary_json: { skill: 'inbox', retry_of: 'rn_1', attempt: 2, not_before: 'x', classified: 3 } });
    expect(wasRetried(retry)).toBe(false);
    expect(runStatusLabel(retry)).toBe('Done');
    expect(runOutcome(retry)).toBe('3 classified');
    expect(runStatusLabel(run({ status: 'error', summary_json: { error: 'boom' } }))).toBe('Failed');
  });
  it('shows duration', () => {
    expect(duration(run({ finished_at: '2026-10-08T10:00:42.000Z' }), new Date())).toBe('42s');
    expect(duration(run({}), new Date('2026-10-08T11:05:00.000Z'))).toBe('1h 5m');
  });
});

describe('sourcesOf (#40)', () => {
  const base = { c1: 4, c2: 4, c3: 5, c4: 4, c5: 4, c6: 4, c7: 4, c8: 4, c9: 4 } as const;
  it('reads the source and confidence per criterion and marks Kev splits', () => {
    const criteria_source = Object.fromEntries(
      ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'].map((c) => [c, { backend: c === 'c6' ? 'human' : 'agent', p: 0.75 }]),
    );
    const s = { ...base, facts_json: { criteria_source, disagreements: [{ criterion: 'c3', agent: 5, kev: 2 }] } };
    const v = sourcesOf(s as never);
    expect(v).toHaveLength(9);
    expect(v[0]).toEqual({ id: 'C1', label: 'Agent', pct: 75, kev: null });
    expect(v[2]).toMatchObject({ id: 'C3', kev: 2 });
    expect(v[5]?.label).toBe('You');
  });
  it('is empty for scores from before #40', () => {
    expect(sourcesOf({ ...base, facts_json: {} } as never)).toEqual([]);
  });
});

describe('emailTag (#37)', () => {
  it('shows the source in one word and the confidence below 100%', () => {
    expect(emailTag({ email: null, email_source: null, email_confidence: null })).toBeNull();
    expect(emailTag({ email: 'a.b@example.com', email_source: 'pattern', email_confidence: 0.45 })).toEqual({
      address: 'a.b@example.com',
      tag: 'Guess 45%',
      sure: false,
    });
    expect(emailTag({ email: 'a.b@example.com', email_source: 'gmail', email_confidence: 1 })).toEqual({
      address: 'a.b@example.com',
      tag: 'Gmail',
      sure: true,
    });
    expect(emailTag({ email: 'a.b@example.com', email_source: 'public', email_confidence: 0.9 })?.tag).toBe('Public 90%');
    expect(valueLabel('people.email', 'a.b@example.com')).toBe('a.b@example.com');
  });
});

describe('linkedinState (#82)', () => {
  const find = (id: string, started: string, summary: Record<string, unknown>) =>
    ({
      id,
      op: 'people.find',
      status: 'ok',
      started_at: started,
      finished_at: started,
      summary_json: { role_id: 'r_1', ...summary },
    }) as unknown as Run;
  it('reads the latest people.find run for the role: agent = people, anything else = not read with a reason', () => {
    expect(linkedinState([], 'r_1')).toEqual({ read: false, label: 'LinkedIn not read', reason: 'Not run' });
    const old = find('rn_1', '2026-10-08T00:00:00Z', { linkedin_mode: 'agent', linkedin_people: 4 });
    expect(linkedinState([old], 'r_1')).toEqual({ read: true, label: 'LinkedIn: 4 people', people: 4 });
    const later = find('rn_2', '2026-10-09T00:00:00Z', { linkedin_mode: 'dry-run', linkedin_reason: 'no_browser' });
    expect(linkedinState([old, later], 'r_1')).toMatchObject({ read: false, reason: 'No browser' });
    // Runs from before #82 carry only linkedin_mode.
    expect(linkedinState([find('rn_3', '2026-10-09T00:00:00Z', { linkedin_mode: 'dry-run' })], 'r_1')).toMatchObject({ reason: 'Dry run' });
    expect(linkedinState([find('rn_4', '2026-10-09T00:00:00Z', { linkedin_mode: 'off', linkedin_reason: 'off' })], 'r_1')).toMatchObject({
      reason: 'Off',
    });
    expect(linkedinState([later], 'other')).toMatchObject({ reason: 'Not run' });
    expect(linkedinState([find('rn_5', '2026-10-09T00:00:00Z', { linkedin_mode: 'agent', linkedin_people: 1 })], 'r_1').label).toBe(
      'LinkedIn: 1 person',
    );
  });
});
