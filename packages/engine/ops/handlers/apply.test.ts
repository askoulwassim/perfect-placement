import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_ROLE_IDS, roles as fixtureRoles } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SYNTH_RESUME } from '../../profile/synthetic.js';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine } from '../../testing/index.js';

let e: FixtureEngine;
beforeEach(() => {
  e = openFixtureEngine();
});
afterEach(() => e.cleanup());

const read = (rel: string) => readFileSync(join(e.home, rel), 'utf8');
const status = (id: string) => (e.db.prepare('SELECT status FROM role WHERE id = ?').get(id) as { status: string }).status;
const pkg = {
  resume_md: '# Resume\n\nFacts only.',
  cover_letter_md: '# Cover\n\nHook. Reframe. Close.',
  fit_map_md: '# Fit map\n\n- req -> proof',
};

describe('companies.dossier.write', () => {
  it('writes the shared dossier, sets md_path and links it into open applications', async () => {
    const out = okOut(await e.runOp('companies.dossier.write', { company_id: 'stripe', markdown: '# Stripe\n\nFresh.' }, ctxAt()));
    expect(out.md_path).toBe('companies/stripe/dossier.md');
    expect(read(out.md_path)).toMatch(/^---\nid: "stripe"\ntype: "dossier"\n---\n\n# Stripe\n\nFresh\./);
    const app = e.db.prepare('SELECT * FROM application WHERE role_id = ?').get(FIXTURE_ROLE_IDS.stripeOnDeck) as Record<string, string>;
    expect(JSON.parse(app.package_paths_json as string).dossier).toBe('companies/stripe/dossier.md');
    expect(app.stage).toBe('tailor');
    okOut(await e.runOp('companies.dossier.write', { company_id: 'plaid', markdown: '# Plaid' }, ctxAt()));
    expect((e.db.prepare(`SELECT md_path FROM company WHERE id = 'plaid'`).get() as { md_path: string }).md_path).toBe(
      'companies/plaid/dossier.md',
    );
    expect(await e.runOp('companies.dossier.write', { company_id: 'nope', markdown: 'x' }, ctxAt())).toMatchObject({ code: 'not_found' });
  });
});

describe('apply.tailor', () => {
  it('writes the package and moves on-deck to draft-ready', async () => {
    const id = FIXTURE_ROLE_IDS.stripeOnDeck;
    const out = okOut(await e.runOp('apply.tailor', { role_id: id, ...pkg }, ctxAt()));
    expect(out.application.stage).toBe('connect');
    expect(out.application.package_paths_json).toMatchObject({
      resume: `applications/${id}/resume.md`,
      cover_letter: `applications/${id}/cover_letter.md`,
      fit_map: `applications/${id}/fit_map.md`,
      dossier: 'companies/stripe/dossier.md',
    });
    expect(read(`applications/${id}/resume.md`)).toMatch(/type: "application_resume"/);
    expect(read(`applications/${id}/cover_letter.md`)).toContain('Hook. Reframe. Close.');
    expect(status(id)).toBe('draft-ready');
  });

  it('creates the application for an active role and promotes a held one', async () => {
    const id = FIXTURE_ROLE_IDS.datadogActive;
    okOut(await e.runOp('apply.tailor', { role_id: id, ...pkg }, ctxAt()));
    expect(status(id)).toBe('draft-ready');
    const held = fixtureRoles.filter((r) => r.company_id === 'datadog' && r.status === 'held');
    expect(held.filter((r) => status(r.id) === 'active')).toHaveLength(1);
  });

  it('re-tailors a draft-ready role without moving it; refuses inbox and applied roles', async () => {
    const id = FIXTURE_ROLE_IDS.linearDraft;
    const o = await e.runOp('apply.tailor', { role_id: id, ...pkg }, ctxAt());
    expect(okOut(o).application.stage).toBe('connect');
    expect(status(id)).toBe('draft-ready');
    expect(await e.runOp('apply.tailor', { role_id: FIXTURE_ROLE_IDS.notionInbox, ...pkg }, ctxAt())).toMatchObject({
      code: 'forbidden_transition',
    });
    expect(await e.runOp('apply.tailor', { role_id: FIXTURE_ROLE_IDS.stripeApplied, ...pkg }, ctxAt())).toMatchObject({
      code: 'forbidden_transition',
    });
  });
});

describe('apply.tailor fact check (#38)', () => {
  /** A kept SYNTHETIC source resume, linked from the confirmed Story (as onboarding leaves it). */
  async function keepResume() {
    mkdirSync(join(e.home, 'files'), { recursive: true });
    writeFileSync(join(e.home, 'files/resume-synth.md'), `---\nid: "resume_synth"\ntype: "resume_source"\n---\n\n${SYNTH_RESUME}`);
    const p = okOut(
      await e.runOp(
        'profile.propose_diff',
        { component: 'story', before: {}, after: { source_path: 'files/resume-synth.md' }, evidence: ['test'] },
        ctxAt('human'),
      ),
    );
    okOut(await e.runOp('profile.apply_diff', { diff_id: p.diff.id }, ctxAt('human')));
  }
  const truthful = [
    '# Jordan Example',
    '',
    'Principal Product Manager, Data Platforms. Ten years across startups and a public company.',
    '',
    '### Acme Data — Principal Product Manager, Analytics — Mar 2022–Present',
    '- Launched a self-serve analytics product used by 120 teams.',
    '- Cut warehouse spend 30% with usage-based pricing.',
  ].join('\n');

  it('an invented "26 years" is rejected with the list; the role does not move', async () => {
    await keepResume();
    const id = FIXTURE_ROLE_IDS.datadogActive;
    const o = await e.runOp(
      'apply.tailor',
      { role_id: id, ...pkg, resume_md: `${truthful}\n\nA leader with 26 years of experience.` },
      ctxAt(),
    );
    expect(o).toMatchObject({ status: 'error', code: 'invalid_input' });
    expect((o as { message: string }).message).toContain('resume "26 years" (years)');
    expect((o as { issues: unknown[] }).issues).toEqual([
      { doc: 'resume', kind: 'years', claim: '26 years', line: 'A leader with 26 years of experience.' },
    ]);
    expect(status(id)).toBe('active');
    // A guessed Story number (the fixture's years: 12, no basis) is no source either.
    const g = await e.runOp('apply.tailor', { role_id: id, ...pkg, cover_letter_md: 'I bring 12 years of experience.' }, ctxAt());
    expect(g).toMatchObject({ status: 'error', code: 'invalid_input' });
  });

  it('a grounded package passes; the fit map cites each claim; a prose employer not in the sources needs you', async () => {
    await keepResume();
    const id = FIXTURE_ROLE_IDS.datadogActive;
    const cover = 'Hi Datadog team,\n\nAt Acme Data I cut warehouse spend 30%. Before that I worked at Globex on billing.';
    const out = okOut(await e.runOp('apply.tailor', { role_id: id, ...pkg, resume_md: truthful, cover_letter_md: cover }, ctxAt()));
    expect(out.fact_check.checked).toBeGreaterThan(5);
    expect(out.fact_check.needs_you).toEqual([
      { doc: 'cover_letter', kind: 'employer', claim: 'Globex', line: expect.stringContaining('worked at Globex') },
    ]);
    const fit = read(`applications/${id}/fit_map.md`);
    expect(fit).toContain('## Fact check');
    expect(fit).toContain('files/resume-synth.md');
    expect(fit).toMatch(/\| 120 \| - \*\*Self-serve analytics:\*\* Launched a self-serve analytics product used by 120 teams\. \|/);
    expect(fit).toContain('Cover letter: "Globex" (employer) not in the sources');
    expect(status(id)).toBe('draft-ready');
  });
});

describe('apply.fill', () => {
  it('writes answers with needs-you flags and advances the stage', async () => {
    const id = FIXTURE_ROLE_IDS.linearDraft;
    const out = okOut(
      await e.runOp(
        'apply.fill',
        {
          role_id: id,
          portal_url: 'https://jobs.ashbyhq.com/linear/apply',
          answers: [
            { question: 'Why Linear?', answer: 'Speed is the product.' },
            { question: 'Visa status?', answer: 'Confirm.', needs_human: true },
          ],
        },
        ctxAt(),
      ),
    );
    expect(out.application).toMatchObject({ stage: 'submit', portal_url: 'https://jobs.ashbyhq.com/linear/apply' });
    const md = read(`applications/${id}/answers.md`);
    expect(md).toContain('## 1. Why Linear?');
    expect(md).toContain('> **Needs you**');
    expect(status(id)).toBe('draft-ready');
    expect(await e.runOp('apply.fill', { role_id: FIXTURE_ROLE_IDS.stripeOnDeck, answers: [] }, ctxAt())).toMatchObject({
      code: 'conflict',
    });
  });
});

describe('apply.mark_submitted', () => {
  it('is human only, moves draft-ready to applied and records applied_at', async () => {
    const id = FIXTURE_ROLE_IDS.vercelDraft;
    expect((await e.runOp('apply.mark_submitted', { role_id: id }, ctxAt('schedule'))).status).toBe('requires_human');
    const out = okOut(await e.runOp('apply.mark_submitted', { role_id: id }, ctxAt('human')));
    expect(out.role.status).toBe('applied');
    expect(out.application).toMatchObject({ stage: 'done', applied_at: '2026-10-08T12:00:00.000Z' });
    // idempotent once applied
    const again = okOut(await e.runOp('apply.mark_submitted', { role_id: id }, ctxAt('human')));
    expect(again.role.status).toBe('applied');
    expect(await e.runOp('apply.mark_submitted', { role_id: FIXTURE_ROLE_IDS.notionInbox }, ctxAt('human'))).toMatchObject({
      code: 'forbidden_transition',
    });
  });
});
