import { describe, expect, it } from 'vitest';
import {
  atsFromUrl,
  inferArchiveReason,
  mapRemoteOk,
  mapWorkplace,
  matchRoleFiles,
  parseRoleFileName,
  type V1Role,
  type V1RoleFile,
} from './map.js';

describe('v1 mapping', () => {
  it('maps free-text workplace', () => {
    const cases: Array<[string | null, string]> = [
      [null, 'unspecified'],
      ['Remote (US)', 'remote'],
      ['Remote-first (NYC offices)', 'remote'],
      ['Remote or hybrid', 'flexible'],
      ['Seattle hybrid / remote Bay Area', 'flexible'],
      ['hybrid (Springfield)', 'hybrid'],
      ['in-person SF', 'onsite'],
      ['onsite (Mountain View)', 'onsite'],
      ['Unspecified (likely remote)', 'unspecified'],
      ['Listed SF; remote policy unconfirmed', 'unspecified'],
    ];
    for (const [raw, want] of cases) expect(mapWorkplace(raw), String(raw)).toBe(want);
  });

  it('maps remote_ok and ATS', () => {
    expect(mapRemoteOk(true)).toBe(true);
    expect(mapRemoteOk('dream-exception')).toBe(false);
    expect(mapRemoteOk('verify')).toBeNull();
    expect(atsFromUrl('https://job-boards.greenhouse.io/acme/jobs/1')).toEqual({ type: 'greenhouse', board: 'acme' });
    expect(atsFromUrl('https://jobs.ashbyhq.com/acme/x')).toEqual({ type: 'ashby', board: 'acme' });
    expect(atsFromUrl('https://www.linkedin.com/jobs/view/1')).toEqual({ type: 'other', board: null });
    expect(atsFromUrl(null)).toEqual({ type: 'unknown', board: null });
  });

  it('infers archive reasons', () => {
    const r = (o: Partial<V1Role>): V1Role => ({ id: 'a', company: 'A', role: 'PM', status: 'archived', ...o });
    expect(inferArchiveReason(r({ flags: ['closed'] }), undefined, 75).reason).toBe('closed');
    expect(inferArchiveReason(r({ reason: 'DEALBREAKER: onsite' }), { total: 90, band: 'green', decision: 'archived' }, 75).reason).toBe(
      'dealbreaker',
    );
    expect(inferArchiveReason(r({}), { total: 60, band: 'yellow', decision: 'archived' }, 75).reason).toBe('below_threshold');
    expect(inferArchiveReason(r({}), { total: 80, band: 'green', decision: 'archived' }, 75).reason).toBe('dealbreaker');
    expect(inferArchiveReason(r({ reason: 'parked' }), { total: 80, band: 'green', decision: 'active' }, 75).reason).toBe('passed');
    expect(inferArchiveReason(r({}), undefined, 75).reason).toBe('legacy');
    expect(inferArchiveReason(r({ fit_score: 50 }), undefined, 75).reason).toBe('below_threshold');
  });

  it('matches role files by file field, id, then fuzzy within a company', () => {
    const file = (folder: string, name: string): V1RoleFile => ({
      ...(parseRoleFileName(folder, name) as Omit<V1RoleFile, 'path'>),
      path: `02_Pipeline/${folder}/${name}`,
    });
    const files = [
      file('active', '2026-01-01_acme_staff-pm.md'),
      file('archive', '2026-01-01_acme_manager-data-engineering.md'),
      file('archive', '2026-01-01_acme_director-data-platform.md'),
      file('archive', '2026-01-01_other_thing.md'),
    ];
    const roles: V1Role[] = [
      { id: 'acme-staff-pm', company: 'Acme', role: 'Staff PM', status: 'active' },
      { id: 'acme-dataeng-mgr', company: 'Acme', role: 'Manager, Data Engineering', status: 'archived' },
      { id: 'acme-dir-platform', company: 'Acme', role: 'Director, Data Platform', status: 'archived' },
      { id: 'nobody', company: 'Nobody', role: 'X', status: 'archived' },
    ];
    const m = matchRoleFiles(roles, files);
    expect(m.byRole.get('acme-staff-pm')?.name).toBe('2026-01-01_acme_staff-pm.md');
    expect(m.byRole.get('acme-dataeng-mgr')?.name).toBe('2026-01-01_acme_manager-data-engineering.md');
    expect(m.byRole.get('acme-dir-platform')?.name).toBe('2026-01-01_acme_director-data-platform.md');
    expect(m.how.get('acme-dataeng-mgr')).toBe('fuzzy');
    expect(m.byRole.has('nobody')).toBe(false);
    expect(m.unmatchedFiles.map((f) => f.name)).toEqual(['2026-01-01_other_thing.md']);
  });
});
