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
      {
        doc: 'cover_letter',
        kind: 'employer',
        claim: 'Globex',
        line: expect.stringContaining('worked at Globex'),
        decision_id: expect.stringMatching(/^dc_/),
      },
    ]);
    const fit = read(`applications/${id}/fit_map.md`);
    expect(fit).toContain('## Fact check');
    expect(fit).toContain('files/resume-synth.md');
    expect(fit).toMatch(/\| 120 \| - \*\*Self-serve analytics:\*\* Launched a self-serve analytics product used by 120 teams\. \|/);
    expect(fit).toContain('Cover letter: "Globex" (employer) not in the sources');
    expect(status(id)).toBe('draft-ready');
  });
});

describe('fact-check decisions (#54)', () => {
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
  const id = FIXTURE_ROLE_IDS.datadogActive;
  const cover =
    'Hi Datadog team,\n\nAt Acme Data I cut warehouse spend 30%.\n\nBefore that I worked at Globex on usage-based pricing.\n\nThanks.';
  const decision = (did: string) => e.db.prepare('SELECT * FROM decision WHERE id = ?').get(did) as Record<string, string>;

  async function tailor() {
    const out = okOut(await e.runOp('apply.tailor', { role_id: id, ...pkg, cover_letter_md: cover }, ctxAt()));
    return out.fact_check.needs_you[0]?.decision_id as string;
  }

  it('queues each needs-you claim in Needs you with the claim, the document and the nearest source line', async () => {
    await keepResume();
    const did = await tailor();
    const q = okOut(await e.runOp('decisions.queue', {}, ctxAt('human')));
    const d = q.pending.find((x) => x.id === did);
    expect(d).toMatchObject({ kind: 'apply.fact_check', impact: 'medium', policy_outcome: 'human', subject_type: 'role', subject_id: id });
    expect(d?.question_json).toMatchObject({
      type: 'choice',
      options: ['keep', 'remove', 'other'],
      doc: 'cover_letter',
      claim: 'Globex',
      line: 'Before that I worked at Globex on usage-based pricing.',
      source: expect.stringContaining('usage-based pricing'),
    });
    expect(d?.action_json).toMatchObject({ op: 'apply.resolve_claim', input: { role_id: id, doc: 'cover_letter', value: '$value' } });
    // Only a human resolves it (medium impact).
    expect(await e.runOp('decisions.resolve', { decision_id: did, action: 'accept' }, ctxAt('agent'))).toMatchObject({ status: 'error' });
  });

  it('remove drops the line from the vault document', async () => {
    await keepResume();
    const did = await tailor();
    const r = okOut(await e.runOp('decisions.resolve', { decision_id: did, action: 'accept' }, ctxAt('human')));
    expect(r).toMatchObject({ op_status: 'ok', decision: { status: 'applied', human_choice: 'remove' } });
    const md = read(`applications/${id}/cover_letter.md`);
    expect(md).not.toContain('Globex');
    expect(md).toContain('At Acme Data I cut warehouse spend 30%.');
    expect(md).not.toMatch(/\n\n\n/);
  });

  it('keep leaves it; edit rewrites the line', async () => {
    await keepResume();
    let did = await tailor();
    okOut(await e.runOp('decisions.resolve', { decision_id: did, action: 'change', value: 'keep' }, ctxAt('human')));
    expect(read(`applications/${id}/cover_letter.md`)).toContain('worked at Globex');
    did = await tailor();
    okOut(
      await e.runOp(
        'decisions.resolve',
        { decision_id: did, action: 'change', value: 'Before that I built billing systems.' },
        ctxAt('human'),
      ),
    );
    const md = read(`applications/${id}/cover_letter.md`);
    expect(md).toContain('Before that I built billing systems.');
    expect(md).not.toContain('Globex');
    expect(decision(did)).toMatchObject({ status: 'applied', overridden: 1 });
  });

  it('a re-tailor expires the pending claims of the documents it replaces', async () => {
    await keepResume();
    const first = await tailor();
    const second = await tailor();
    expect(second).not.toBe(first);
    expect(decision(first).status).toBe('expired');
    expect(decision(second).status).toBe('pending');
  });
});

describe('apply.fill (#42)', () => {
  const id = FIXTURE_ROLE_IDS.linearDraft;
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
  const portal = [
    { question: 'Full name', kind: 'autofill', field: 'name' },
    { question: 'Email', kind: 'autofill', field: 'email' },
    { question: 'LinkedIn profile', kind: 'autofill', field: 'linkedin' },
    { question: 'Resume', kind: 'autofill', field: 'resume' },
    { question: 'Will you now or in the future require sponsorship?', kind: 'standard', field: 'sponsorship' },
    {
      question: 'Are you legally authorized to work in the United States?',
      kind: 'standard',
      field: 'work_authorization',
      country: 'United States',
    },
    { question: 'Are you legally authorized to work in Canada?', kind: 'standard', field: 'work_authorization', country: 'Canada' },
    { question: 'What are your salary expectations?', kind: 'standard', field: 'comp_expectation' },
    { question: 'How many days a week can you come in?', kind: 'standard', field: 'in_office' },
    { question: 'Gender', kind: 'standard', field: 'eeo' },
    {
      question: 'Why Linear?',
      kind: 'written',
      answer: 'At Acme Data I launched a self-serve analytics product used by 120 teams. Speed is the product.',
    },
    { question: 'Open source?', kind: 'written', answer: 'I maintained a billing library at Globex.' },
    { question: 'Anything else?', kind: 'written', answer: 'Happy to talk.', confidence: 0.4 },
    { question: 'Have you been convicted of a felony?', kind: 'written', answer: '', needs_human: true, reason: 'legal attestation' },
  ] as const;

  it('flags only what needs you, each with a reason; portal fills are listed with profile values, never as answers', async () => {
    await keepResume();
    const out = okOut(
      await e.runOp('apply.fill', { role_id: id, portal_url: 'https://jobs.ashbyhq.com/linear/apply', answers: [...portal] }, ctxAt()),
    );
    expect(out.application).toMatchObject({ stage: 'submit', portal_url: 'https://jobs.ashbyhq.com/linear/apply' });
    expect(out.counts).toEqual({ needs_you: 6, written: 4, standard: 6, autofill: 4 });
    const by = Object.fromEntries(out.answers.map((a) => [a.question, a]));
    // Portal fills: never flagged.
    expect(by['Full name']).toMatchObject({ kind: 'autofill', answer: 'Sam Fixture', needs_human: false });
    expect(by.Email).toMatchObject({ answer: 'jordan@example.com', needs_human: false });
    expect(by['LinkedIn profile']?.answer).toBe('linkedin.com/in/jordan-example');
    expect(by.Resume?.answer).toBe(`applications/${id}/resume.md`);
    // Standard: from the profile (Work mode remote only, Terms target), EEO defaults; no saved answer needs you.
    expect(by['What are your salary expectations?']).toMatchObject({ answer: expect.stringContaining('$240,000'), needs_human: false });
    expect(by['How many days a week can you come in?']).toMatchObject({
      answer: 'I am looking for fully remote work.',
      needs_human: false,
    });
    expect(by.Gender).toMatchObject({ answer: 'Prefer not to say', needs_human: false });
    expect(by['Will you now or in the future require sponsorship?']).toMatchObject({
      needs_human: true,
      reason: 'no saved answer for visa sponsorship',
    });
    expect(by['Are you legally authorized to work in Canada?']?.reason).toBe('no saved work authorization for Canada');
    // Written: grounded passes; an unsupported employer, low confidence and a legal question need you.
    expect(by['Why Linear?']).toMatchObject({ needs_human: false });
    expect(by['Open source?']).toMatchObject({ needs_human: true, reason: '"Globex" is not in your Story' });
    expect(by['Anything else?']?.reason).toBe('low confidence (0.40)');
    expect(by['Have you been convicted of a felony?']?.reason).toBe('legal attestation');
    // Needs you first.
    expect(out.answers.slice(0, out.counts.needs_you).every((a) => a.needs_human)).toBe(true);
    // The unsupported claim is a decision in Needs you.
    expect(out.fact_check.needs_you).toEqual([
      expect.objectContaining({
        doc: 'answers',
        claim: 'Globex',
        line: 'I maintained a billing library at Globex.',
        decision_id: expect.any(String),
      }),
    ]);
    const md = read(`applications/${id}/answers.md`);
    expect(md).toMatch(/## Needs you[\s\S]*## Written[\s\S]*## Standard[\s\S]*## Portal fills/);
    expect(md).toContain('> no saved answer for visa sponsorship');
    expect(md).toContain('- Email: jordan@example.com');
    expect(md).not.toContain('### Email');
    expect(status(id)).toBe('draft-ready');
    // Removing the claim edits the answers file.
    const did = out.fact_check.needs_you[0]?.decision_id as string;
    okOut(await e.runOp('decisions.resolve', { decision_id: did, action: 'accept' }, ctxAt('human')));
    expect(read(`applications/${id}/answers.md`)).not.toContain('I maintained a billing library at Globex.');
  });

  it('standard answers are set once in the profile and reused; saving them does not rescore', async () => {
    const scores = () => (e.db.prepare('SELECT count(*) n FROM score').get() as { n: number }).n;
    const n = scores();
    const s = okOut(
      await e.runOp(
        'profile.set_defaults',
        { defaults: { sponsorship: 'no', authorized_countries: ['US'], notice_period: '2 weeks' } },
        ctxAt('human'),
      ),
    );
    expect(s.version).not.toBeNull();
    expect(scores()).toBe(n);
    const out = okOut(
      await e.runOp(
        'apply.fill',
        { role_id: id, answers: [...portal.slice(4, 7), { question: 'Start date?', kind: 'standard', field: 'start_date' }] },
        ctxAt(),
      ),
    );
    const by = Object.fromEntries(out.answers.map((a) => [a.question, a]));
    expect(by['Will you now or in the future require sponsorship?']).toMatchObject({
      answer: 'No, I will not require visa sponsorship.',
      needs_human: false,
    });
    expect(by['Are you legally authorized to work in the United States?']).toMatchObject({
      answer: 'Yes, I am authorized to work in US.',
      needs_human: false,
    });
    expect(by['Are you legally authorized to work in Canada?']).toMatchObject({
      needs_human: true,
      reason: 'no saved work authorization for Canada',
    });
    expect(by['Start date?']?.answer).toBe('I can start 2 weeks after an offer.');
    // An empty value clears a field; an agent's change waits for the human.
    okOut(await e.runOp('profile.set_defaults', { defaults: { notice_period: '' } }, ctxAt('human')));
    const terms = okOut(await e.runOp('profile.get', {}, ctxAt())).components.find((c) => c.key === 'terms');
    expect(terms?.data_json.application_defaults).toEqual({ sponsorship: 'no', authorized_countries: ['US'] });
    expect((await e.runOp('profile.set_defaults', { defaults: { relocation: 'yes' } }, ctxAt('agent'))).status).toBe('requires_human');
  });

  it('a drafter flag needs a reason; fill needs a draft-ready role', async () => {
    expect(
      await e.runOp('apply.fill', { role_id: id, answers: [{ question: 'Visa?', answer: 'x', needs_human: true }] }, ctxAt()),
    ).toMatchObject({ code: 'invalid_input' });
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
