import { contactLinks, contacts, decisions } from '@perfect-placement/fixtures';
import { describe, expect, it } from 'vitest';
import { probColor } from '../components/theme';
import { nextRun } from '../screens/Settings';
import { altsOf, pickOf, SHORT_Q, valueLabel } from './decisions';
import { bestPath, type Person } from './people';
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
