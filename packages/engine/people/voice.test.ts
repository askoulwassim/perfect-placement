import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repos } from '../db/repo.js';
import { createDryRunGmail, type DryRunGmail } from '../integrations/gmail/index.js';
import { ctxAt, type FixtureEngine, okOut as ok, openFixtureEngine } from '../testing/index.js';
import {
  buildWriterPrompt,
  checkDraft,
  composeBody,
  type DraftContext,
  dossierHighlights,
  draftContext,
  jdExcerpt,
  type PeopleDeps,
  templateDraft,
  voiceNotes,
} from './index.js';

/*
 * Outreach voice: CONTEXT (JD, dossier, headline) + STORY + VOICE (style, notes, samples) reach the
 * writer together; the Gmail body reads as a natural email; the rules still refuse dashes and invented
 * numbers. Synthetic fixtures only.
 */

const R = FIXTURE_ROLE_IDS;
let v: FixtureEngine;
let gmail: DryRunGmail;

beforeEach(() => {
  gmail = createDryRunGmail();
  v = openFixtureEngine({ services: { gmail } });
});
afterEach(() => v.cleanup());

/** Read-only PeopleDeps over the fixture engine (draftContext only reads). */
const readDeps = (): PeopleDeps => ({
  repos: repos(v.db),
  vault: {
    read: (rel) => (existsSync(join(v.home, rel)) ? readFileSync(join(v.home, rel), 'utf8') : null),
    write: () => {
      throw new Error('read only');
    },
  },
  emit: () => 'ev_x',
  ask: async () => {
    throw new Error('no resolver');
  },
  record: async () => {
    throw new Error('no resolver');
  },
  config: {} as PeopleDeps['config'],
});

const DOSSIER = [
  '# Linear',
  '',
  '## Snapshot',
  '',
  'Issue tracking for software teams. Series C in 2025.',
  '',
  '## Funding',
  '',
  'Investors listed here.',
  '',
  '## Why',
  '',
  '- Insights is their bet on planning data for 2026.',
].join('\n');

const base = (over: Partial<DraftContext> = {}): DraftContext => ({
  tier: 'warm_hiring',
  contact: { name: 'Maya R.', headline: 'Head of Product, Insights' },
  via: null,
  role: { title: 'Product Lead, Insights', jd: 'Own the roadmap for a data product used by internal and external teams.' },
  company: { name: 'Linear', dossier: 'Snapshot:\nIssue tracking for software teams.' },
  story: { data: { name: 'Sam Fixture', wins: ['Launched a self-serve analytics product to 400 teams'] }, text: '- 400 teams.' },
  voice: {
    data: { style: 'punchy', samples: ['Short version: fix the questions first.', 'Two things stood out.'] },
    text: 'Punchy. No em dashes.',
  },
  ...over,
});

describe('writer prompt', () => {
  it('no Voice style (the step was skipped, #76): the neutral default', () => {
    expect(buildWriterPrompt(base({ voice: { data: {}, text: '' } })).user).toContain('Style: neutral');
    expect(buildWriterPrompt(base()).user).toContain('Style: punchy');
  });
  it('carries JD, dossier, headline, Story, voice notes and every sample together, each labeled', () => {
    const p = buildWriterPrompt(base());
    expect(p.user).toContain('CONTEXT (facts about them');
    expect(p.user).toContain('Own the roadmap for a data product');
    expect(p.user).toContain('Issue tracking for software teams.');
    expect(p.user).toContain('Head of Product, Insights');
    expect(p.user).toContain('STORY (the only source of facts about the user)');
    expect(p.user).toContain('Launched a self-serve analytics product');
    expect(p.user).toContain('Style: punchy');
    expect(p.user).toContain('Punchy. No em dashes.');
    expect(p.user).toContain('[1]\nShort version: fix the questions first.');
    expect(p.user).toContain('[2]\nTwo things stood out.');
    expect(p.system).toMatch(/never reuse facts, names or numbers from samples/);
    expect(p.system).toMatch(/STORY is the ONLY source of facts about the user/);
    expect(p.system).toContain('"Thanks,\\nSam"');
  });

  it('never drops samples when voice.md has text (and does not repeat its Samples section)', () => {
    const text = '# Voice\n\n## Style\n\npunchy\n\n## Samples\n\n- Old sample in markdown.\n\n## Rules\n\n- no em dashes';
    expect(voiceNotes(text)).not.toContain('Old sample');
    expect(voiceNotes(text)).toContain('no em dashes');
    const p = buildWriterPrompt(base({ voice: { data: { samples: ['Kept sample.'] }, text } }));
    expect(p.user).toContain('Kept sample.');
    expect(p.user).not.toContain('Old sample in markdown.');
    expect(buildWriterPrompt(base({ voice: { data: {}, text: 'Notes only.' } })).user).toContain('SAMPLES: (none)');
  });

  it('trims the JD and picks dossier highlights', () => {
    const long = `# Role\n\n## JD\n\n${'Own the roadmap. '.repeat(400)}\n\n## Notes\n\n- internal note`;
    const jd = jdExcerpt(long) ?? '';
    expect(jd.length).toBeLessThanOrEqual(2010);
    expect(jd).not.toContain('internal note');
    const hi = dossierHighlights(DOSSIER) ?? '';
    expect(hi).toContain('Snapshot:\nIssue tracking');
    expect(hi).toContain('Why:\n- Insights is their bet');
    expect(hi).not.toContain('Investors listed here');
  });

  it('draftContext reads the role JD and the company dossier from the vault (fixtures)', async () => {
    ok(await v.runOp('companies.dossier.write', { company_id: 'linear', markdown: DOSSIER }, ctxAt('agent')));
    const c = draftContext(readDeps(), 'ct_0001', R.linearDraft);
    if ('error' in c) throw new Error(c.error);
    expect(c.role.jd).toContain('Own the roadmap for a data product');
    expect(c.company.dossier).toContain('Series C in 2025');
    expect(c.voice.text).toContain('Punchy');
    const p = buildWriterPrompt(c);
    // Fixture voice.md has text AND data has samples: both reach the writer.
    expect(p.user).toContain('Punchy. Hook, reframe, close.');
    expect(p.user).toContain('the questions were wrong');
    expect(p.user).toContain('Sam Fixture');
  });
});

describe('email shape and rules', () => {
  it('composes greeting, paragraphs and sign-off', () => {
    const body = composeBody({
      hook: 'Hi Maya, your insights team is shipping fast.',
      proof: 'I launched a self-serve analytics product to 400 teams. I also cut pipeline cost 38%.',
      ask: 'Up for 20 minutes next week?',
      signoff: 'Thanks,\nSam',
    });
    expect(body).toBe(
      'Hi Maya,\n\nYour insights team is shipping fast.\n\nI launched a self-serve analytics product to 400 teams. I also cut pipeline cost 38%.\n\nUp for 20 minutes next week?\n\nThanks,\nSam\n',
    );
    // No greeting in the Hook: one is added for the recipient.
    expect(
      composeBody({ hook: 'Saw the opening.', proof: 'p.', ask: 'a?' }, { recipientName: 'Dev P.' }).startsWith('Hi Dev,\n\nSaw'),
    ).toBe(true);
  });

  it('rejects dashes, invented numbers, flattery and a Proof over three sentences', () => {
    const story = 'Launched a self-serve analytics product to 400 teams';
    const d = { subject: 's', hook: 'Hi Maya, h.', proof: 'Built for 400 teams.', ask: 'a?', signoff: 'Thanks,\nSam' };
    expect(checkDraft(d, story)).toEqual([]);
    expect(checkDraft({ ...d, signoff: 'Best – Sam' }, story).map((i) => i.rule)).toEqual(['em_dash']);
    expect(checkDraft({ ...d, proof: 'Grew revenue 3x for 900 users.' }, story).map((i) => i.rule)).toEqual([
      'ungrounded_number',
      'ungrounded_number',
    ]);
    // Hook numbers may come from CONTEXT (the JD or dossier), never from nowhere.
    expect(checkDraft({ ...d, hook: 'Hi Maya, congrats on the 2025 round.' }, story).map((i) => i.rule)).toEqual(['ungrounded_number']);
    expect(checkDraft({ ...d, hook: 'Hi Maya, congrats on the 2025 round.' }, story, { context: 'Series C in 2025.' })).toEqual([]);
    expect(checkDraft({ ...d, hook: 'Hi Maya, huge fan of your work.' }, story).map((i) => i.rule)).toEqual(['flattery']);
    expect(checkDraft({ ...d, proof: 'One. Two. Three. Four.' }, story).map((i) => i.rule)).toEqual(['too_many_sentences']);
  });

  it('template fallback: natural shape, a JD theme from CONTEXT, Story facts only, passes the rules', () => {
    for (const tier of ['warm_hiring', 'warm_other', 'bridge', 'cold_hiring', 'cold_other'] as const) {
      const c = base({ tier, via: { name: 'Dev P.', headline: null } });
      const d = templateDraft(c);
      expect(d.hook).toMatch(/^Hi \w+,/);
      expect(d.signoff).toBe('Thanks,\nSam');
      expect(
        checkDraft(d, `${JSON.stringify(c.story.data)}\n${c.story.text}`, { bridge: tier === 'bridge', context: c.role.jd ?? '' }),
      ).toEqual([]);
      const body = composeBody(d);
      expect(body).toMatch(/^Hi \w+,\n\n/);
      expect(body.endsWith('\n\nThanks,\nSam\n')).toBe(true);
    }
    expect(templateDraft(base()).hook).toContain('own the roadmap for a data product');
    expect(templateDraft(base({ role: { title: 'Product Lead', jd: null } })).hook).not.toContain('JD');
  });
});

describe('outreach end to end on fixtures (dry-run Gmail)', () => {
  it('context -> template draft -> outreach.draft -> outreach.get body -> outreach.to_gmail', async () => {
    ok(await v.runOp('companies.dossier.write', { company_id: 'linear', markdown: DOSSIER }, ctxAt('agent')));
    const c = draftContext(readDeps(), 'ct_0002', R.linearDraft);
    if ('error' in c) throw new Error(c.error);
    // Agent-written drafts take the same path; this one uses the template.
    const text = templateDraft(c);
    const drafted = ok(
      await v.runOp('outreach.draft', { contact_id: 'ct_0002', role_id: R.linearDraft, tier: c.tier, ...text }, ctxAt('agent')),
    );
    const md = readFileSync(join(v.home, drafted.outreach.md_path), 'utf8');
    expect(md).toContain('## Sign-off\n\nThanks,\nSam');

    const got = ok(await v.runOp('outreach.get', { outreach_id: drafted.outreach.id }, ctxAt('agent')));
    expect(got.signoff).toBe('Thanks,\nSam');
    expect(got.body).toMatch(/^Hi Dev,\n\n/);
    expect(got.body).toContain('I launched a self-serve analytics product to 400 teams. I also cut pipeline cost 38%');
    expect(got.body.endsWith('\n\nThanks,\nSam\n')).toBe(true);
    expect(got.body).not.toMatch(/—|–/);

    // #132: a Gmail draft needs an address for its recipient.
    v.db
      .prepare(`UPDATE contact SET email = 'dev@linear.example', email_source = 'gmail', email_confidence = 1 WHERE id = 'ct_0002'`)
      .run();
    const out = ok(await v.runOp('outreach.to_gmail', { outreach_id: drafted.outreach.id }, ctxAt('human')));
    expect(out.outreach.status).toBe('in_gmail');
    expect(gmail.drafts[0]?.body).toBe(got.body);
  });

  it('outreach.draft refuses an agent draft with an invented number or a dash', async () => {
    const draft = { contact_id: 'ct_0002', role_id: R.linearDraft, tier: 'warm_other', ask: 'Coffee this week?' };
    expect(
      await v.runOp('outreach.draft', { ...draft, hook: 'Hi Dev, quick one.', proof: 'I grew revenue 5x.' }, ctxAt('agent')),
    ).toMatchObject({ status: 'error', code: 'invalid_input' });
    expect(
      await v.runOp('outreach.draft', { ...draft, hook: 'Hi Dev — quick one.', proof: 'I launched it to 400 teams.' }, ctxAt('agent')),
    ).toMatchObject({ status: 'error', code: 'invalid_input' });
    expect(
      await v.runOp(
        'outreach.draft',
        { ...draft, hook: 'Hi Dev, quick one.', proof: 'I launched it to 400 teams.', signoff: 'Cheers,\nSam' },
        ctxAt('agent'),
      ),
    ).toMatchObject({ status: 'ok' });
  });

  it('old drafts without a sign-off get the profile default', async () => {
    const got = ok(await v.runOp('outreach.get', { outreach_id: 'or_0001' }, ctxAt('agent')));
    expect(got.signoff).toBe('Thanks,\nSam');
    const file = join(v.home, got.outreach.md_path);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n## Sign-off\n\nBest,\nSam F.\n`);
    expect(ok(await v.runOp('outreach.get', { outreach_id: 'or_0001' }, ctxAt('agent'))).body.endsWith('\n\nBest,\nSam F.\n')).toBe(true);
  });
});
