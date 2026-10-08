import { describe, expect, it } from 'vitest';
import { fromV1, renderReport, runBacktest, type V1Data, v1ArchiveReason, v1WorkplaceFacts } from './backtest.js';

/* Synthetic v1-shaped data only. The real backtest runs via backtest-cli and writes outside the repo. */

const C = (n: number) => Object.fromEntries(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9'].map((k) => [k, n]));
const total = (n: number) => n * 20;
const role = (id: string, company: string, status: string, n: number, extra: Record<string, unknown> = {}) => ({
  pipe: { id, company, role: id, status, band: total(n) >= 75 ? 'green' : total(n) >= 55 ? 'yellow' : 'red', ...extra },
  score: { id, company, role: id, scored: '2026-08-02', criteria: C(n), total: total(n), band: total(n) >= 75 ? 'green' : 'yellow' },
});

function data(): V1Data {
  const rows = [
    role('dream-1', 'Dreamco', 'active', 5, { remote_ok: 'dream-exception', flags: ['dream-co'] }),
    role('dream-2', 'Dreamco', 'active', 4, { remote_ok: 'dream-exception', flags: ['dream-co'] }),
    role('dream-3', 'Dreamco', 'on-deck', 5, { remote_ok: 'dream-exception', flags: ['dream-co'] }),
    ...['a', 'b', 'c', 'd', 'e'].map((x, i) => role(`busy-${x}`, 'Busyco', 'active', i < 3 ? 5 : 4, { remote_ok: true })),
    role('solo', 'Soloco', 'active', 4, { workplace: 'Remote US' }),
    role('low', 'Lowco', 'archived', 3, { reason: 'Below green threshold' }),
    role('closed', 'Shutco', 'archived', 5, { flags: ['closed'] }),
  ];
  return {
    pipeline: { roles: rows.map((r) => r.pipe) as V1Data['pipeline']['roles'] },
    scores: { scores: rows.map((r) => r.score) as V1Data['scores']['scores'] },
    rubric: {
      weights: { C1: 15, C2: 15, C3: 12, C4: 12, C5: 10, C6: 12, C7: 8, C8: 8, C9: 8 },
      bands: { green_min: 75, yellow_min: 55 },
      dream_companies: ['Dreamco'],
    },
  };
}

describe('v1 import', () => {
  it('maps workplace and archive reasons', () => {
    expect(v1WorkplaceFacts({ remote_ok: 'dream-exception' })).toMatchObject({ remote_ok: false });
    expect(v1WorkplaceFacts({ remote_ok: 'verify', workplace: 'Remote (US)' })).toMatchObject({ workplace: 'remote' });
    expect(v1WorkplaceFacts({ remote_ok: 'verify', workplace: 'in-person SF' })).toMatchObject({ workplace: 'onsite' });
    expect(v1ArchiveReason({ status: 'archived', band: 'yellow', reason: 'Below threshold' })).toBe('below_threshold');
    expect(v1ArchiveReason({ status: 'archived', band: 'green', reason: 'DEALBREAKER: in-person' })).toBe('dealbreaker');
    expect(v1ArchiveReason({ status: 'archived', band: 'green', flags: ['closed'] })).toBe('closed');
    expect(fromV1(data())).toHaveLength(11);
  });
});

describe('backtest replay', () => {
  const [maxNudge, neutral] = runBacktest(data());
  if (!maxNudge || !neutral) throw new Error('two scenarios expected');

  it('archives dream-exception roles (no bypass) but keeps on-deck', () => {
    const by = new Map(maxNudge.rows.map((r) => [r.id, r]));
    expect(by.get('dream-1')).toMatchObject({ v2_status: 'archived', v2_total: 100 });
    expect(by.get('dream-3')?.v2_status).toBe('on-deck');
  });
  it('caps a company at three active', () => {
    const busy = maxNudge.rows.filter((r) => r.company === 'Busyco');
    expect(busy.filter((r) => r.v2_status === 'active')).toHaveLength(3);
    expect(busy.filter((r) => r.v2_status === 'held')).toHaveLength(2);
  });
  it('keeps closed archives and v1 totals when affinity is neutral', () => {
    expect(neutral.rows.find((r) => r.id === 'closed')?.v2_status).toBe('archived');
    for (const r of neutral.rows) expect(r.v2_total).toBe(r.v1_total);
  });
  it('summarizes mix and transitions', () => {
    const s = maxNudge.summary;
    expect(s.before).toMatchObject({ roles: 8, companies: 3, max_per_company: 5 });
    expect(s.after).toMatchObject({ roles: 4, companies: 2, max_per_company: 3, dream_share: 0 });
    expect(s.changed).toBe(4);
    expect(s.transitions['active -> held']).toBe(2);
    expect(s.transitions['active -> archived']).toBe(2);
  });
  it('the aggregate report carries no company or role names', () => {
    const md = renderReport([maxNudge, neutral], { includeRoles: false, generated: 'test' });
    for (const name of ['Dreamco', 'Busyco', 'Soloco', 'busy-a', 'dream-1']) expect(md).not.toContain(name);
    expect(renderReport([maxNudge], { includeRoles: true, generated: 'test' })).toContain('Busyco');
  });
});
