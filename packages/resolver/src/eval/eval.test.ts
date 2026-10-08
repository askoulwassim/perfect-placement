import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calibrationBins, expectedCalibrationError, runEval } from './harness.js';
import { renderReport } from './report.js';
import { mockBackends, syntheticCases } from './synthetic.js';
import { emailNote, loadV1InboxCases, loadV1ScoreCases, rubricInstructions, scrubRoleMarkdown } from './v1.js';

describe('calibration math', () => {
  it('perfectly calibrated bins have ECE 0', () => {
    const pairs = [
      ...Array.from({ length: 10 }, (_, i) => ({ p: 0.95, correct: i < 9 || i === 9 })),
      ...Array.from({ length: 10 }, (_, i) => ({ p: 0.55, correct: i < 5 })),
    ];
    // 0.95 bin: 10/10 correct (acc 1.0 vs 0.95); 0.55 bin: 5/10 (0.5 vs 0.55)
    expect(expectedCalibrationError(pairs)).toBeCloseTo(0.05, 5);
    expect(calibrationBins(pairs).map((b) => b.n)).toEqual([10, 10]);
    expect(expectedCalibrationError([])).toBeNull();
  });
});

describe('synthetic eval through mocked backends', () => {
  it('replays every case through Jev, Kev and the LLM and reports agreement + calibration', async () => {
    const cases = syntheticCases({ roles: 6, emails: 12 });
    expect(cases).toHaveLength(6 * 9 + 12);
    const result = await runEval({ cases, backends: mockBackends(cases), concurrency: 1 });
    expect(result.backends).toEqual(['jev', 'kev', 'llm']);
    for (const m of result.metrics) {
      expect(m.answered).toBe(cases.length);
      expect(m.accuracy).toBeGreaterThan(0.5);
      expect(m.ece).not.toBeNull();
      expect(m.latencyP50).toBeGreaterThan(0);
    }
    expect(result.agreement.jev?.jev?.rate).toBe(1);
    expect(Object.keys(result.byKind).sort()).toEqual(['inbox.classify', 'roles.criterion']);
    // medium impact inbox cases never auto below 0.90; high impact never appears in synthetic data
    const md = renderReport(result, { title: 'Synthetic', label: 'synthetic truth' });
    expect(md).toContain('## Agreement between backends');
    expect(md).not.toMatch(/—/); // no em dashes
  });

  it('records errors per backend without failing the run', async () => {
    const cases = syntheticCases({ roles: 1, emails: 0 });
    const down = {
      name: 'kev' as const,
      ask: async () => {
        throw new Error('down');
      },
      health: async () => ({ ok: false }),
    };
    const result = await runEval({ cases, backends: { kev: down } });
    expect(result.metrics[0]).toMatchObject({ answered: 0, accuracy: null });
    expect(renderReport(result, { title: 't', label: 'l' })).toContain('## Errors');
  });
});

describe('v1 loaders (synthetic v1 layout in a temp dir)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pp-v1-'));
    for (const d of ['data', 'runs', 'applied', 'archive']) mkdirSync(join(dir, d));
    writeFileSync(
      join(dir, 'data/scores.json'),
      JSON.stringify({
        meta: {},
        scores: [
          { id: 'acme-staff-pm', scored: '2026-08-01', criteria: { C1: 1, C2: 1, C3: 1, C4: 1, C5: 1, C6: 1, C7: 1, C8: 1, C9: 1 } },
          { id: 'acme-staff-pm', scored: '2026-08-02', criteria: { C1: 4, C2: 5, C3: 3, C4: 4, C5: 5, C6: 2, C7: 3, C8: 4, C9: 5 } },
          { id: 'no-file-role', scored: '2026-08-02', criteria: { C1: 3 } },
        ],
      }),
    );
    writeFileSync(
      join(dir, 'applied/2026-08-02_acme_staff-pm.md'),
      [
        '# Acme: Staff PM',
        '**Status:** applied · **Fit score:** 88/100 · **Band:** green',
        '## Snapshot',
        '- Remote, data platform, greenfield agent product, reports to the CPO.',
        '- Comp: 220 to 260k base.',
        '## Score drivers',
        'Top: 0->1 (5), domain (5).',
        '## 2026-08-03 - Confirmation received',
        'Auto email from the ATS: "Thanks for applying to Acme", sender no-reply@ats.example.',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'runs/2026-08-04_inbox.md'),
      '# inbox run\n\n## Moved\n- acme-staff-pm: confirmation (draft-ready -> applied)\n- ghost-role: rejection (x)\n',
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('scrubs score leaks from the role markdown', () => {
    const s = scrubRoleMarkdown(
      '# T\n**Fit score:** 90\n## Snapshot\n- remote\n## Score drivers\nTop: c1 (5)\n## 2026-08-02 - SUBMITTED\nsent',
    );
    expect(s).toBe('# T\n## Snapshot\n- remote');
  });

  it('loads the latest score per role as 9 grouped criterion cases', () => {
    const cases = loadV1ScoreCases(dir, '| 1 | **Proximity** | 15 | Many layers | Some influence | Direct line |');
    expect(cases).toHaveLength(9);
    expect(cases.map((c) => c.expected)).toEqual([4, 5, 3, 4, 5, 2, 3, 4, 5]);
    expect(new Set(cases.map((c) => c.group)).size).toBe(1);
    expect(String(cases[0]?.state)).not.toMatch(/fit score|score drivers|\(5\)/i);
    expect(cases[0]?.question.instructions).toContain('1: Many layers');
  });

  it('loads inbox classifications with the email note (heading removed) as state', () => {
    const cases = loadV1InboxCases(dir);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ expected: 'confirmation', kind: 'inbox.classify', impact: 'medium' });
    expect(String(cases[0]?.state)).not.toContain('Confirmation received');
  });

  it('helpers', () => {
    expect(rubricInstructions(undefined)).toEqual({});
    expect(emailNote('## Offer call\n\nThey called.', 'offer')).toBe('They called.');
    expect(emailNote('## Notes\nx', 'offer')).toBeUndefined();
  });
});
