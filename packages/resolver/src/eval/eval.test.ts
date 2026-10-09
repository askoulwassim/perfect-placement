import { describe, expect, it } from 'vitest';
import { calibrationBins, expectedCalibrationError, runEval } from './harness.js';
import { renderReport } from './report.js';
import { mockBackends, syntheticCases } from './synthetic.js';

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
