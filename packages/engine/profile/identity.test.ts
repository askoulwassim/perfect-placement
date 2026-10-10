import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type OpContext, type OpOutput, parseComponentData } from '@perfect-placement/contracts';
import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { nameParts } from '../ops/handlers/fill.js';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine, tickingClock } from '../testing/index.js';
import { parseContact } from './resume.js';
import { SYNTH_RESUME, SYNTH_RESUME_CONTACT } from './synthetic.js';

/*
 * #124: the user's identity (full name, preferred first name, phone, city) on Story `contact`: read from a
 * SYNTHETIC resume, confirmed or edited in onboarding, edited on You, used by Fill. No real personal data.
 */

type State = OpOutput<'onboard.ingest_resume'>;
const clock = tickingClock();
const ctx = (actor: OpContext['actor'] = 'human'): OpContext => ctxAt(actor, {}, clock);

let e: FixtureEngine | undefined;
afterEach(() => {
  e?.cleanup();
  e = undefined;
});
const ee = () => e as FixtureEngine;
const op = async (name: string, input: unknown, c: OpContext = ctx()) => okOut(await ee().runOp(name, input, c));
const story = async () =>
  ((await op('profile.get', {})) as { components: Array<{ key: string; data_json: Record<string, unknown> }> }).components.find(
    (c) => c.key === 'story',
  )?.data_json ?? {};
const draftStory = () =>
  JSON.parse(
    (ee().db.prepare('SELECT draft_json FROM onboard_session ORDER BY started_at DESC LIMIT 1').get() as { draft_json: string }).draft_json,
  ).story as Record<string, unknown>;

const CONTACT = {
  full_name: 'Avery Testperson',
  email: 'avery.testperson@example.com',
  phone: '+1 (555) 010-0142',
  city: 'Springfield, IL',
  linkedin: 'linkedin.com/in/avery-testperson',
};

/** Finish an onboarding session: confirm what the resume implies, skip the rest, calibrate, confirm. */
async function finish(state: State) {
  let s = state;
  while (s.next_question) {
    const q = s.next_question;
    s = (await op(
      'onboard.answer',
      q.kind === 'confirm' ? { question_id: q.id, value: 'yes' } : { question_id: q.id, skip: true },
    )) as State;
  }
  const cards = (await op('onboard.samples', {})) as { items: Array<{ id: string }> };
  for (const c of cards.items) await op('onboard.calibrate', { sample_id: c.id, choice: 'maybe' });
  return op('onboard.confirm', {});
}

describe('identity from the resume (#124)', () => {
  it('reads the name line, email, phone, city and LinkedIn where the pattern is reliable', () => {
    expect(parseContact(SYNTH_RESUME_CONTACT)).toEqual(CONTACT);
    // No city on the contact line; a phone with dots.
    expect(parseContact(SYNTH_RESUME)).toEqual({
      full_name: 'Jordan Example',
      email: 'jordan@example.com',
      phone: '555.010.0000',
      linkedin: 'linkedin.com/in/jordan-example',
    });
    // A title line is not a city; a year range is not a phone; a header line that is not a name is no name.
    expect(parseContact('# Staff Engineer, Payments | Remote\n\nJan 2019 - 2023 | Example Co\n\n## Experience\n')).toEqual({});
    expect(parseContact('Ana de la Cruz\nana@example.com • Lyon, France\n\n## Experience\n')).toEqual({
      full_name: 'Ana de la Cruz',
      email: 'ana@example.com',
      city: 'Lyon, France',
    });
  });

  it('onboarding shows it to confirm; Edit asks each field pre-filled; the confirmed profile keeps it', async () => {
    e = openFixtureEngine({ seed: false });
    let state = (await op('onboard.ingest_resume', { text: SYNTH_RESUME_CONTACT }, ctx('agent'))) as State;
    expect(state.resume_drafts.find((d) => d.component === 'story')?.items[0]).toBe(
      'Contact: Avery Testperson · +1 (555) 010-0142 · Springfield, IL',
    );
    expect(state.next_question).toMatchObject({
      id: 'confirm.story',
      kind: 'confirm',
      label:
        'Looks like you are Avery Testperson (+1 (555) 010-0142, Springfield, IL), and your headline is "Senior Data Product Manager". Right?',
    });
    state = (await op('onboard.answer', { question_id: 'confirm.story', value: 'edit' })) as State;
    // Edit clears the identity fields (the email and LinkedIn stay) and asks each, pre-filled from the resume.
    expect(draftStory().contact).toEqual({ email: CONTACT.email, linkedin: CONTACT.linkedin });
    const asked: Record<string, unknown> = {};
    const answers: Record<string, string> = {
      'story.preferred_name': 'Ave',
      'story.phone': '+1 (555) 010-0142',
      'story.city': 'Springfield, IL',
      'story.name': 'Avery Q. Testperson',
    };
    while (state.next_question && state.next_question.component === 'story') {
      const q = state.next_question;
      asked[q.id] = q.suggested;
      const value = answers[q.id];
      state = (await op('onboard.answer', value ? { question_id: q.id, value } : { question_id: q.id, skip: true })) as State;
    }
    expect(asked).toMatchObject({
      'story.preferred_name': 'Avery',
      'story.phone': '+1 (555) 010-0142',
      'story.city': 'Springfield, IL',
      'story.name': 'Avery Testperson',
    });
    expect(draftStory().contact).toEqual({ ...CONTACT, full_name: 'Avery Q. Testperson', preferred_name: 'Ave' });
    await finish(state);
    expect((await story()).contact).toEqual({ ...CONTACT, full_name: 'Avery Q. Testperson', preferred_name: 'Ave' });
  });

  it('Yes keeps the resume contact and asks nothing more about it; a resume with no name line asks for it', async () => {
    e = openFixtureEngine({ seed: false });
    const state = (await op('onboard.ingest_resume', { text: SYNTH_RESUME_CONTACT }, ctx('agent'))) as State;
    const yes = (await op('onboard.answer', { question_id: 'confirm.story', value: 'yes' })) as State;
    expect(draftStory().contact).toEqual(CONTACT);
    expect(['story.name', 'story.preferred_name', 'story.phone', 'story.city']).not.toContain(yes.next_question?.id);
    expect(state.next_question?.id).toBe('confirm.story');
    e.cleanup();
    e = openFixtureEngine({ seed: false });
    let s = (await op(
      'onboard.ingest_resume',
      { text: '**Title:** Product Analyst\n\n## Experience\n\n### Sample Co — Analyst — 2019–Present\n- Built a dashboard.\n' },
      ctx('agent'),
    )) as State;
    const ids: string[] = [];
    while (s.next_question && s.next_question.component === 'story') {
      ids.push(s.next_question.id);
      s = (await op('onboard.answer', { question_id: s.next_question.id, skip: true })) as State;
    }
    expect(ids).toEqual(expect.arrayContaining(['story.preferred_name', 'story.phone', 'story.city', 'story.name']));
  });

  it('onboard.extract: the agent contact must be in the resume; an answered field beats it', async () => {
    e = openFixtureEngine({ seed: false });
    await op('onboard.ingest_resume', { text: SYNTH_RESUME_CONTACT }, ctx('agent'));
    const bad = await ee().runOp('onboard.extract', { story: { contact: { ...CONTACT, phone: '+1 555 010 9999' } } }, ctx('agent'));
    expect(bad).toMatchObject({ status: 'error', code: 'invalid_input' });
    expect((bad as { message: string }).message).toMatch(/contact phone/);
    const badEmail = await ee().runOp('onboard.extract', { story: { contact: { email: 'someone@example.org' } } }, ctx('agent'));
    expect((badEmail as { message: string }).message).toMatch(/contact email/);
    // The agent may name a preferred name only when the resume shows it; here it sends the verbatim fields.
    okOut(
      await ee().runOp('onboard.extract', { story: { contact: { full_name: 'Avery Testperson', city: 'Springfield, IL' } } }, ctx('agent')),
    );
    // The preview's email, phone and LinkedIn stay under the agent's fields.
    expect(draftStory().contact).toEqual(CONTACT);
  });
});

describe('identity on You (#124): profile.set_identity', () => {
  it('a human edit applies as v+1 without a rescore; empty clears; an agent waits for the human; a bad email is refused', async () => {
    e = openFixtureEngine();
    // Old profile: the fixture Story has no typed contact and still loads and validates.
    const old = await story();
    expect(old.contact).toBeUndefined();
    expect(() => parseComponentData('story', { contact: { email: 'x@example.com', website: 'example.com' } })).not.toThrow();
    const scores = () => (ee().db.prepare('SELECT count(*) n FROM score').get() as { n: number }).n;
    const n = scores();
    const out = await op('profile.set_identity', {
      contact: { full_name: ' Avery  Testperson ', preferred_name: 'Ave', phone: '+1 555 010 0142', city: 'Springfield, IL' },
    });
    expect(out.version).not.toBeNull();
    expect(out.contact).toEqual({
      full_name: 'Avery Testperson',
      preferred_name: 'Ave',
      phone: '+1 555 010 0142',
      city: 'Springfield, IL',
    });
    expect(scores()).toBe(n);
    expect((await story()).contact).toEqual(out.contact);
    // Same values: no new version.
    expect((await op('profile.set_identity', { contact: { preferred_name: 'Ave' } })).version).toBeNull();
    okOut(await ee().runOp('profile.set_identity', { contact: { preferred_name: '' } }, ctx()));
    expect((await story()).contact).not.toHaveProperty('preferred_name');
    expect(await ee().runOp('profile.set_identity', { contact: { email: 'not-an-email' } }, ctx())).toMatchObject({
      code: 'invalid_input',
    });
    const agent = await ee().runOp('profile.set_identity', { contact: { phone: '+1 555 010 0199' } }, ctx('agent'));
    expect(agent.status).not.toBe('ok');
    expect((await story()).contact).toMatchObject({ phone: '+1 555 010 0142' });
  });
});

describe('Fill uses the identity (#124)', () => {
  const id = FIXTURE_ROLE_IDS.linearDraft;
  const questions = [
    { question: 'Name', kind: 'autofill', field: 'name' },
    { question: 'First name', kind: 'autofill', field: 'first_name' },
    { question: 'Last name', kind: 'autofill', field: 'last_name' },
    { question: 'Preferred name', kind: 'autofill', field: 'preferred_name' },
    { question: 'Phone', kind: 'autofill', field: 'phone' },
    { question: 'City', kind: 'autofill', field: 'city' },
    { question: 'Where are you located?', kind: 'standard', field: 'location' },
  ];
  const fill = async () => {
    const out = (await op('apply.fill', { role_id: id, answers: questions }, ctx('agent'))) as OpOutput<'apply.fill'>;
    return Object.fromEntries(out.answers.map((a) => [a.question, a.answer]));
  };

  it('splits the name sensibly', () => {
    expect(nameParts('Avery Q. Testperson')).toEqual({ first: 'Avery', last: 'Testperson' });
    expect(nameParts('Ana de la Cruz')).toEqual({ first: 'Ana', last: 'de la Cruz' });
    expect(nameParts('Sam Example Jr.')).toEqual({ first: 'Sam', last: 'Example Jr.' });
    expect(nameParts('Robin Sample, PhD')).toEqual({ first: 'Robin', last: 'Sample' });
    expect(nameParts('Mononym')).toEqual({ first: 'Mononym', last: null });
  });

  it('an old profile still fills its name; after an edit on You, Name, Phone and City come from the profile', async () => {
    e = openFixtureEngine();
    const before = await fill();
    expect(before.Name).toBe('Sam Fixture');
    expect(before['First name']).toBe('Sam');
    await op('profile.set_identity', {
      contact: { full_name: 'Avery Q. Testperson', preferred_name: 'Ave', phone: '+1 (555) 010-0142', city: 'Springfield, IL' },
    });
    expect(await fill()).toEqual({
      Name: 'Avery Q. Testperson',
      'First name': 'Avery',
      'Last name': 'Testperson',
      'Preferred name': 'Ave',
      Phone: '+1 (555) 010-0142',
      City: 'Springfield',
      'Where are you located?': 'Springfield, IL',
    });
    // No preferred name saved: the first name answers it.
    await op('profile.set_identity', { contact: { preferred_name: '' } });
    expect((await fill())['Preferred name']).toBe('Avery');
  });

  it('after onboarding from a resume, Fill fills Name and Phone', async () => {
    e = openFixtureEngine();
    mkdirSync(join(ee().home, 'files'), { recursive: true });
    writeFileSync(join(ee().home, 'files/resume-contact.md'), SYNTH_RESUME_CONTACT);
    const state = (await op('onboard.start', {})) as State;
    expect(state.step).toBe('resume');
    await finish((await op('onboard.ingest_resume', { file_path: 'files/resume-contact.md' }, ctx('agent'))) as State);
    const got = await fill();
    expect(got).toMatchObject({ Name: 'Avery Testperson', Phone: '+1 (555) 010-0142', City: 'Springfield' });
  });
});
