import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/*
 * A SYNTHETIC v1 Perfect Placement repo for tests. Invented companies and people only; never real data.
 * Written to a temp dir at test time (binary .docx placeholders cannot be committed).
 * Shape mirrors v1: 00_System/rubric.json, 01_Profile/*.md, 02_Pipeline/{data,<status>,runs}, 03_Applications.
 */

const role = (title: string, company: string) =>
  `# ${company}, ${title}\n\n**Found:** 2026-01-05\n**Link:** https://example.com\n\n## Snapshot\n- Synthetic role for tests.\n`;

export const SYNTHETIC_V1 = {
  rubric: {
    version: 'v1',
    updated: '2026-01-01',
    weights: { C1: 15, C2: 15, C3: 12, C4: 12, C5: 10, C6: 12, C7: 8, C8: 8, C9: 8 },
    criteria: { C1: 'decisions', C2: '0-1', C3: 'external', C4: 'data', C5: 'domain', C6: 'comp', C7: 'team', C8: 'growth', C9: 'shape' },
    bands: { green_min: 75, yellow_min: 55 },
    dealbreakers: { remote_required_unless_dream_co: true, comp_floor: 150000 },
    dream_companies: ['Globex'],
  },
  pipeline: {
    meta: {
      generated: '2026-01-10',
      counts: { active: 1, 'on-deck': 1, 'draft-ready': 0, applied: 1, interviews: 0, offers: 0, archived: 5 },
    },
    roles: [
      {
        id: 'acme-data_staff-pm-platform',
        company: 'Acme Data',
        role: 'Staff PM, Platform',
        status: 'active',
        fit_score: 82,
        band: 'green',
        url: 'https://job-boards.greenhouse.io/acmedata/jobs/111',
        workplace: 'Remote (US)',
        remote_ok: true,
        comp_min: 200000,
        comp_max: 250000,
        facing: 'external',
        flags: ['verify-comp'],
      },
      {
        id: 'acme-data-principal-pm',
        company: 'Acme Data',
        role: 'Principal PM',
        status: 'on-deck',
        url: 'https://jobs.lever.co/acmedata/abc',
        workplace: 'hybrid (Springfield)',
        remote_ok: 'verify',
        facing: 'verify',
      },
      {
        id: 'globex-pm-ai',
        company: 'Globex',
        role: 'PM, AI',
        status: 'applied',
        url: 'https://jobs.ashbyhq.com/globex/xyz',
        url_portal: 'https://jobs.ashbyhq.com/globex/xyz/application',
        workplace: 'Hybrid (dream-co exception)',
        remote_ok: 'dream-exception',
        flags: ['dream-co'],
        applied_date: '2026-01-07',
        file: '02_Pipeline/applied/2026-01-05_globex_pm-ai.md',
      },
      { id: 'globex-dataeng-mgr', company: 'Globex', role: 'Manager, Data Engineering', status: 'archived', reason: 'People-mgmt' },
      {
        id: 'initech-director-data',
        company: 'Initech',
        role: 'Director, Data',
        status: 'archived',
        reason: 'DEALBREAKER: in-person only',
        workplace: 'in-person Springfield',
        url: 'https://initech.example.com/jobs/1',
      },
      { id: 'initech_staff-pm-old', company: 'Initech', role: 'Staff PM', status: 'archived', flags: ['closed'] },
      { id: 'umbrella_gpm', company: 'Umbrella', role: 'GPM', status: 'archived', reason: 'Parked for later' },
      {
        id: 'umbrella_head-of-product',
        company: 'Umbrella',
        role: 'Head of Product',
        status: 'archived',
        url: 'https://initech.example.com/jobs/1',
      },
    ],
  },
  scores: [
    {
      id: 'acme-data_staff-pm-platform',
      scored: '2026-01-05',
      total: 70,
      band: 'yellow',
      decision: 'archived',
      c: [3, 4, 4, 4, 3, 3, 3, 3, 3],
    },
    {
      id: 'acme-data_staff-pm-platform',
      scored: '2026-01-09',
      total: 82,
      band: 'green',
      decision: 'active',
      c: [4, 4, 4, 5, 4, 4, 4, 4, 4],
    },
    { id: 'acme-data-principal-pm', scored: '2026-01-05', total: 80, band: 'green', decision: 'active', c: [4, 4, 4, 4, 4, 4, 4, 4, 4] },
    { id: 'globex-pm-ai', scored: '2026-01-05', total: 90, band: 'green', decision: 'active', c: [5, 5, 4, 4, 5, 4, 5, 4, 5] },
    { id: 'globex-dataeng-mgr', scored: '2026-01-05', total: 60, band: 'yellow', decision: 'archived', c: [3, 3, 3, 3, 3, 3, 3, 3, 3] },
    { id: 'initech-director-data', scored: '2026-01-05', total: 66, band: 'yellow', decision: 'archived', c: [3, 3, 4, 3, 3, 3, 4, 3, 3] },
    { id: 'initech_staff-pm-old', scored: '2026-01-05', total: 78, band: 'green', decision: 'active', c: [4, 4, 4, 4, 4, 4, 3, 4, 4] },
    { id: 'umbrella_gpm', scored: '2026-01-05', total: 80, band: 'green', decision: 'active', c: [4, 4, 4, 4, 4, 4, 4, 4, 4] },
  ],
  /** Expected v2 outcome per v1 id. */
  expected: {
    'acme-data_staff-pm-platform': { id: 'acme-data_staff-pm-platform', status: 'active', reason: null },
    'acme-data-principal-pm': { id: 'acme-data_principal-pm', status: 'on-deck', reason: null },
    'globex-pm-ai': { id: 'globex_pm-ai', status: 'applied', reason: null },
    'globex-dataeng-mgr': { id: 'globex_manager-data-engineering', status: 'archived', reason: 'below_threshold' },
    'initech-director-data': { id: 'initech_director-data', status: 'archived', reason: 'dealbreaker' },
    'initech_staff-pm-old': { id: 'initech_staff-pm-old', status: 'archived', reason: 'closed' },
    umbrella_gpm: { id: 'umbrella_gpm', status: 'archived', reason: 'passed' },
    'umbrella_head-of-product': { id: 'umbrella_head-of-product', status: 'archived', reason: 'legacy' },
  },
} as const;

/** Write the synthetic v1 repo under `dir`. */
export function writeSyntheticV1(dir: string): void {
  const put = (rel: string, content: string | Buffer) => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  const S = SYNTHETIC_V1;
  put('00_System/rubric.json', JSON.stringify(S.rubric, null, 2));
  put('01_Profile/resume_master.md', '# Master Resume\n\n- Synthetic: built a data platform for 40 teams.\n');
  put('01_Profile/stories.md', '# Stories\n\n## Story 1\nSynthetic STAR story.\n');
  put('01_Profile/perfect_role.md', '# The Perfect Role\n\nSynthetic target: principal data product role, remote.\n');
  put('01_Profile/positioning.md', '# Positioning\n\nSynthetic hook.\n');
  put('01_Profile/application_defaults.md', '# Defaults\n\n- Start date: synthetic.\n');
  put('02_Pipeline/data/pipeline.json', JSON.stringify(S.pipeline, null, 2));
  put(
    '02_Pipeline/data/scores.json',
    JSON.stringify({
      meta: { rubric_version: 'v1', weights: S.rubric.weights, criteria: S.rubric.criteria },
      scores: S.scores.map((s) => ({
        id: s.id,
        company: 'x',
        role: 'x',
        rubric_version: 'v1',
        scored: s.scored,
        criteria: Object.fromEntries(s.c.map((v, i) => [`C${i + 1}`, v])),
        total: s.total,
        band: s.band,
        decision: s.decision,
      })),
    }),
  );
  put('02_Pipeline/active/2026-01-05_acme-data_staff-pm-platform.md', role('Staff PM, Platform', 'Acme Data'));
  put('02_Pipeline/on-deck/2026-01-05_acme-data_principal-pm.md', role('Principal PM', 'Acme Data'));
  put('02_Pipeline/applied/2026-01-05_globex_pm-ai.md', role('PM, AI', 'Globex'));
  put('02_Pipeline/archive/2026-01-05_globex_manager-data-engineering.md', role('Manager, Data Engineering', 'Globex'));
  put('02_Pipeline/archive/2026-01-05_initech_director-data.md', role('Director, Data', 'Initech'));
  put('02_Pipeline/archive/2026-01-04_initech_staff-pm-old.md', role('Staff PM', 'Initech'));
  put('02_Pipeline/archive/2026-01-05_umbrella_gpm.md', role('GPM', 'Umbrella'));
  put('02_Pipeline/archive/2026-01-05_zzz-corp_orphan-role.md', role('Orphan', 'Zzz Corp'));
  put('02_Pipeline/archive/.gitkeep', '');
  put('02_Pipeline/runs/README.md', '# Runs\n');
  put('02_Pipeline/runs/2026-01-05_scout.md', '# scout run\n\nSynthetic.\n');
  put('02_Pipeline/runs/2026-01-06_score.md', '# score run\n\nSynthetic.\n');
  put('03_Applications/README.md', '# Applications\n');
  put('03_Applications/globex/company_dossier.md', '# Globex dossier\n\nSynthetic.\n');
  for (const f of ['resume.md', 'cover_letter.md', 'fit_map.md', 'application_answers.md'])
    put(`03_Applications/globex/2026-01-06_pm-ai/${f}`, `# ${f}\n\nSynthetic.\n`);
  put('03_Applications/globex/2026-01-06_pm-ai/resume.docx', Buffer.from('synthetic-docx-bytes'));
  put('04_Interviews/_TEMPLATE_prep.md', '# Template\n');
}
