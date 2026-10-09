import type { OpContext, OpOutput } from '@perfect-placement/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { rulesFromProfile, screen } from '../scout/index.js';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine, tickingClock } from '../testing/index.js';
import { detectPersona, titleVariations } from './persona.js';
import { SYNTH_RESUME, SYNTH_RESUME_ENGINEER, SYNTH_RESUME_SALES } from './synthetic.js';

/*
 * #74: the interview's persona-dependent options and the scout's titles follow the resume's persona.
 * #76: the Voice step can be skipped (neutral style). Synthetic resumes only; no live calls.
 */

type State = OpOutput<'onboard.ingest_resume'>;
type Q = NonNullable<State['next_question']>;
const clock = tickingClock();
const ctx = (actor: OpContext['actor'] = 'human'): OpContext => ctxAt(actor, {}, clock);

let e: FixtureEngine | undefined;
afterEach(() => {
  e?.cleanup();
  e = undefined;
});
const op = async (name: string, input: unknown, c: OpContext = ctx()) => okOut(await (e as FixtureEngine).runOp(name, input, c));

/** Walk a fresh onboarding from a resume: every confirm answered `edit` (so every question shows), the rest skipped. */
async function walk(resume: string): Promise<Record<string, Q>> {
  e?.cleanup();
  e = openFixtureEngine({ seed: false });
  let state = (await op('onboard.ingest_resume', { text: resume }, ctx('agent'))) as State;
  const asked: Record<string, Q> = {};
  while (state.next_question) {
    const q = state.next_question;
    asked[q.id] = q;
    state = (await op(
      'onboard.answer',
      q.kind === 'confirm' ? { question_id: q.id, value: 'edit' } : { question_id: q.id, skip: true },
    )) as State;
  }
  return asked;
}

describe('persona-dependent options (#74)', () => {
  it('a sales resume and a PM resume get different options, both with free entry', async () => {
    const pm = await walk(SYNTH_RESUME);
    const sales = await walk(SYNTH_RESUME_SALES);
    const opts = (a: Record<string, Q>, id: string) => a[id]?.options ?? [];

    expect(opts(pm, 'craft.functions')).toContain('PM');
    expect(opts(sales, 'craft.functions')[0]).toBe('Sales');
    expect(opts(sales, 'craft.functions')).not.toContain('PM');
    expect(opts(sales, 'craft.functions')).not.toContain('TPM');
    expect(opts(sales, 'craft.level')).toEqual(expect.arrayContaining(['enterprise', 'strategic']));
    expect(opts(pm, 'craft.level')).not.toContain('enterprise');
    expect(opts(sales, 'craft.titles').slice(0, 3)).toEqual([
      'Senior Enterprise Account Executive',
      'Account Executive',
      'Sales Development Rep',
    ]);
    expect(opts(sales, 'craft.titles').join(' ')).not.toMatch(/Product/);
    expect(opts(pm, 'craft.titles')).toContain('Principal Product Manager');
    expect(opts(sales, 'domain.ranked')).toContain('SaaS');
    expect(opts(sales, 'domain.ranked')[0]).toBe('fintech'); // the resume's own domain first
    expect(opts(sales, 'growth.ceiling')).toEqual(['senior AE', 'sales manager', 'director of sales', 'VP sales', 'CRO', 'founder']);
    expect(opts(pm, 'growth.ceiling')).toContain('group PM');
    expect(sales['growth.ceiling']?.suggested).toBe('sales manager');
    for (const id of ['craft.functions', 'craft.level', 'craft.titles', 'domain.ranked', 'growth.ceiling']) {
      expect(pm[id]?.other, id).toBe(true);
      expect(sales[id]?.other, id).toBe(true);
      expect(opts(pm, id)).not.toEqual(opts(sales, id));
    }
    // A question without free entry does not say so.
    expect(sales['craft.mode']?.other).toBeUndefined();
    const eng = await walk(SYNTH_RESUME_ENGINEER);
    expect(opts(eng, 'craft.functions')[0]).toBe('Engineering');
    expect(opts(eng, 'growth.ceiling')).toContain('VP engineering');
  });

  it('the agent run replaces the preview options; Other takes a free entry; dashes refused', async () => {
    e = openFixtureEngine({ seed: false });
    await op('onboard.ingest_resume', { text: SYNTH_RESUME_SALES }, ctx('agent'));
    const options = {
      persona: 'Sales',
      functions: ['Sales', 'Account Management', 'Sales Leadership'],
      levels: ['senior', 'enterprise', 'strategic', 'manager', 'director'],
      titles: ['Enterprise Account Executive', 'Strategic Account Executive', 'Regional Sales Manager'],
      domains: ['payments', 'fintech', 'banking software'],
      scopes: ['sales manager', 'director of sales', 'VP sales'],
    };
    const bad = await (e as FixtureEngine).runOp(
      'onboard.extract',
      { story: {}, options: { ...options, titles: ['Account Executive — Enterprise', 'Sales Manager'] } },
      ctx('agent'),
    );
    expect(bad).toMatchObject({ status: 'error', code: 'invalid_input' });
    await op('onboard.extract', { story: {}, options }, ctx('agent'));
    let state = (await op('onboard.state', {})) as State;
    const seen: Record<string, Q> = {};
    while (state.next_question && state.next_question.component !== 'domain') {
      const q = state.next_question;
      seen[q.id] = q;
      if (q.id === 'craft.functions') {
        // Free entry (Other) besides the options.
        state = (await op('onboard.answer', { question_id: q.id, value: ['Sales', 'Revenue Operations'] })) as State;
        continue;
      }
      state = (await op(
        'onboard.answer',
        q.kind === 'confirm' ? { question_id: q.id, value: 'edit' } : { question_id: q.id, skip: true },
      )) as State;
    }
    expect(seen['craft.functions']?.options).toEqual(options.functions);
    expect(seen['craft.titles']?.options?.slice(0, 3)).toEqual([
      'Senior Enterprise Account Executive',
      'Account Executive',
      'Sales Development Rep',
    ]);
    expect(seen['craft.titles']?.options).toEqual(expect.arrayContaining(options.titles));
    const row = (e as FixtureEngine).db
      .prepare('SELECT draft_json, interview_json FROM onboard_session ORDER BY started_at DESC LIMIT 1')
      .get() as {
      draft_json: string;
      interview_json: string;
    };
    expect(JSON.parse(row.draft_json).craft.functions).toEqual(['Sales', 'Revenue Operations']);
    expect(JSON.parse(row.interview_json).options).toMatchObject({ by: 'agent', persona: 'sales', domains: options.domains });
  });

  it('a re-interview with no resume takes the options from the profile persona; the static list is the fallback', async () => {
    e = openFixtureEngine();
    // The fixture profile is a product person: the product lists.
    let state = (await op('onboard.start', { components: ['craft'] })) as State;
    expect(state.next_question).toMatchObject({ id: 'craft.functions', other: true });
    expect(state.next_question?.options).toEqual(expect.arrayContaining(['PM', 'TPM']));
    state = (await op('onboard.answer', { question_id: 'craft.functions', value: ['Sales'] })) as State;
    // Now a seller: the level options follow.
    expect(state.next_question?.id).toBe('craft.level');
    expect(state.next_question?.options).toEqual(expect.arrayContaining(['enterprise', 'strategic', 'principal']));
    expect(await (e as FixtureEngine).runOp('onboard.answer', { question_id: 'craft.level', value: 'x'.repeat(61) }, ctx())).toMatchObject({
      code: 'invalid_input',
    });
  });

  it('personas: titles decide, unknown titles fall back', () => {
    expect(detectPersona(['Senior Enterprise Account Executive'])?.id).toBe('sales');
    expect(detectPersona(['Principal Product Manager, Analytics', 'Senior Product Manager'])?.id).toBe('product');
    expect(detectPersona(['Staff Software Engineer'])?.id).toBe('engineering');
    expect(detectPersona(['Pastry Chef'])).toBeNull();
  });
});

describe('scout titles follow the persona (#74)', () => {
  it('title variations: PM vs sales differ; the watchlist title rule keeps sales titles for a seller', () => {
    const pm = titleVariations({ functions: ['PM', 'TPM'], level: 'principal' });
    const sales = titleVariations({ functions: ['Sales'], level: 'senior', titles: ['Senior Enterprise Account Executive'] });
    expect(pm).toEqual([
      'Principal Product Manager',
      'Group Product Manager',
      'Director of Product',
      'Head of Product',
      'Principal Technical Program Manager',
      'Product Manager',
      'Technical Program Manager',
    ]);
    expect(sales[0]).toBe('Senior Enterprise Account Executive');
    expect(sales).toEqual(expect.arrayContaining(['Senior Account Executive', 'Sales Manager', 'Account Executive']));
    expect(sales.join(' ')).not.toMatch(/Product/);
    // A function with no known titles is searched as written.
    expect(titleVariations({ functions: ['Revenue Operations'] })).toEqual(['Revenue Operations']);

    const rules = rulesFromProfile({ craft: { functions: ['Sales'], titles: ['Account Executive'], level: 'senior' } });
    const at = (title: string) => screen({ title, location: null, workplace: null }, rules).keep;
    expect(at('Enterprise Account Executive')).toBe(true);
    expect(at('Sales Manager, West')).toBe(true);
    expect(at('Senior Product Manager')).toBe(false);
  });

  it('scout.plan reads the profile: product titles for the fixture, sales titles once Craft says sales', async () => {
    e = openFixtureEngine();
    const before = await op('scout.plan', {}, ctx('agent'));
    expect(before.persona).toBe('product');
    expect(before.titles[0]).toBe('Principal Product Manager');
    expect(before.domains[0]).toBe('data infrastructure');
    const profile = await op('profile.get', {});
    const craft = profile.components.find((c: { key: string }) => c.key === 'craft').data_json;
    const { diff } = await op('profile.propose_diff', {
      component: 'craft',
      before: { functions: craft.functions, level: craft.level },
      after: { functions: ['Sales'], level: 'enterprise', titles: ['Enterprise Account Executive', 'Strategic Account Executive'] },
      evidence: ['career switch'],
    });
    await op('profile.apply_diff', { diff_id: diff.id });
    const after = await op('scout.plan', {}, ctx('agent'));
    expect(after.persona).toBe('sales');
    expect(after.titles.slice(0, 2)).toEqual(['Enterprise Account Executive', 'Strategic Account Executive']);
    expect(after.titles).toContain('Enterprise Sales Manager');
    expect(after.titles.join(' ')).not.toMatch(/Product/);
  });
});

describe('the Voice step is skippable (#76)', () => {
  it('Skip on a Voice question skips the whole step and stores the neutral style', async () => {
    e = openFixtureEngine({ seed: false });
    let state = (await op('onboard.ingest_resume', { text: SYNTH_RESUME_ENGINEER }, ctx('agent'))) as State;
    while (state.next_question && state.next_question.component !== 'voice')
      state = (await op('onboard.answer', { question_id: state.next_question.id, skip: true })) as State;
    expect(state.next_question?.id).toBe('confirm.voice');
    state = (await op('onboard.answer', { question_id: 'confirm.voice', skip: true, skip_component: true })) as State;
    expect(state.next_question?.component).not.toBe('voice');
    const row = (e as FixtureEngine).db
      .prepare('SELECT draft_json, answered_json FROM onboard_session ORDER BY started_at DESC LIMIT 1')
      .get() as {
      draft_json: string;
      answered_json: string;
    };
    expect(JSON.parse(row.draft_json).voice).toEqual({ style: 'neutral' });
    expect(JSON.parse(row.answered_json)).toEqual(expect.arrayContaining(['confirm.voice', 'voice.style', 'voice.sample']));
  });
});
