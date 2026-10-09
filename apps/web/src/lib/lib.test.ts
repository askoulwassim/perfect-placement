import type { Run } from '@perfect-placement/contracts';
import { contactLinks, contacts, decisions } from '@perfect-placement/fixtures';
import { describe, expect, it } from 'vitest';
import { probColor } from '../components/theme';
import { nextRun } from '../screens/Settings';
import { altsOf, pickOf, SHORT_Q, valueLabel } from './decisions';
import { bestPath, type Person } from './people';
import { activeLabel, duration, isActive, matches, retryInput, runOutcome, runToast } from './runs';
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
  it('shows duration', () => {
    expect(duration(run({ finished_at: '2026-10-08T10:00:42.000Z' }), new Date())).toBe('42s');
    expect(duration(run({}), new Date('2026-10-08T11:05:00.000Z'))).toBe('1h 5m');
  });
});
