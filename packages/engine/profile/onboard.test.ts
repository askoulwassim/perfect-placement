import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CRITERIA,
  type Criterion,
  type OpContext,
  type OpOutput,
  PROFILE_COMPONENT_KIND,
  type ProfileComponentKey,
} from '@perfect-placement/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine, tickingClock } from '../testing/index.js';
import { type CalibrationSample, deriveWeights } from './calibration.js';
import { rubricWeights } from './components.js';
import { questionOverlap } from './onboard.js';
import { nextSamples, QUESTION_BANK } from './questions.js';
import { parseResumeHeuristic } from './resume.js';
import { SYNTH_RESUME, SYNTH_RESUME_ENGINEER, SYNTH_RESUME_NO_YEARS, synthDocx, synthPdf } from './synthetic.js';

type State = OpOutput<'onboard.ingest_resume'>;
const clock = tickingClock();
const ctx = (actor: OpContext['actor'] = 'human'): OpContext => ctxAt(actor, {}, clock);

/** Deterministic answer for any question (first option / midpoint / text). */
function answerFor(q: NonNullable<State['next_question']>): string | number | string[] {
  if (q.id === 'work_mode.modes') return ['remote'];
  if (q.id === 'dealbreakers.hard_nos') return ['onsite only', 'other'];
  if (q.answer_type === 'slider') return Math.round(((q.min ?? 0) + (q.max ?? 100)) / 4);
  if (q.answer_type === 'multi_chips') return [q.options?.[0] ?? 'x'];
  if (q.answer_type === 'chips') return q.options?.[0] ?? 'x';
  return `answer for ${q.label}`;
}

let e: FixtureEngine | undefined;
afterEach(() => {
  e?.cleanup();
  e = undefined;
});
const op = async (name: string, input: unknown, c: OpContext = ctx()) => okOut(await (e as FixtureEngine).runOp(name, input, c));
const comps = async (version?: string) =>
  okOut(await (e as FixtureEngine).runOp('profile.get', version ? { version_id: version } : {}, ctx())) as {
    version: { id: string; parent_id: string | null; reason: string };
    components: Array<{ id: string; key: string; confidence: number; md_path: string | null; data_json: Record<string, unknown> }>;
    pending_diffs: Array<{ component_key: string; impact: string; diff_json: Record<string, unknown> }>;
  };

describe('resume parsing', () => {
  it('drafts Story and Craft from the text only', () => {
    const d = parseResumeHeuristic(SYNTH_RESUME, new Date('2026-10-08T00:00:00Z'));
    expect(d.story.headline).toBe('Principal Product Manager, Data Platforms');
    expect(d.story.years).toBe(10);
    expect(d.story.years_basis).toBe('stated');
    expect((d.story.roles as unknown[]).length).toBe(3);
    expect(d.story.wins).toContain('Self-serve analytics: Launched a self-serve analytics product used by 120 teams.');
    expect(d.craft.functions).toEqual(['PM']);
    expect(d.craft.level).toBe('principal');
    expect(d.story.skills).toEqual(['SQL, Python, dbt', 'Experimentation']);
  });
});

describe('calibration method', () => {
  const mk = (id: string, hi: Criterion, lvl: number): CalibrationSample => ({
    id,
    title: id,
    criteria: Object.fromEntries(CRITERIA.map((c) => [c, c === hi ? lvl : 3])) as Record<Criterion, number>,
  });
  it('raises the criterion that predicts yes, choices beat the prior', () => {
    const samples = Array.from({ length: 12 }, (_, i) => mk(`s${i}`, 'c4', i % 2 ? 5 : 1));
    const choices = Object.fromEntries(samples.map((s, i) => [s.id, i % 2 ? 'yes' : 'no'] as const));
    const prior = { c1: 30, c2: 10, c3: 10, c4: 5, c5: 10, c6: 10, c7: 10, c8: 10, c9: 5 };
    const { weights, correlations } = deriveWeights(prior, samples, choices);
    expect(correlations.c4).toBe(1);
    expect(weights.c4).toBeGreaterThan(prior.c4 * 3);
    expect(Object.values(weights).reduce((a, b) => a + b, 0)).toBe(100);
  });
  it('returns the prior when choices carry no signal', () => {
    const samples = Array.from({ length: 4 }, (_, i) => mk(`s${i}`, 'c1', i + 1));
    const { weights } = deriveWeights({ c1: 12, c2: 12, c3: 11, c4: 11, c5: 11, c6: 11, c7: 11, c8: 11, c9: 10 }, samples, {
      s0: 'yes',
      s1: 'yes',
    });
    expect(weights.c1).toBe(12);
  });
});

describe('onboarding end to end via ops', () => {
  it('fresh vault: resume -> interview (skipping what the resume answered) -> 12 calibrations -> confirm', async () => {
    e = openFixtureEngine({ seed: false }); // vault files, empty db: no profile yet
    // Calibration samples come from scored roles: add 12 through ops.
    const candidates = Array.from({ length: 12 }, (_, i) => ({
      company_name: `Sample Co ${i}`,
      title: `Sample ${i}`,
      source: 'link' as const,
      workplace: 'remote' as const,
    }));
    const { added } = await op('roles.add', { candidates }, ctx('agent'));
    for (const [i, role_id] of (added as string[]).entries()) {
      const criteria = Object.fromEntries(CRITERIA.map((c) => [c, c === 'c3' ? (i % 3) + 2 : ((i * 7 + c.charCodeAt(1)) % 5) + 1]));
      await op('roles.score', { role_id, criteria, facts: { workplace: 'remote', remote_ok: true } }, ctx('agent'));
    }
    expect((await op('onboard.state', {})).step).toBe('resume');

    // The resume is a vault file.
    const resumePath = 'files/resume.md';
    // An upload lands in the vault's files/ folder.
    mkdirSync(join((e as FixtureEngine).home, 'files'), { recursive: true });
    writeFileSync(join((e as FixtureEngine).home, resumePath), SYNTH_RESUME);

    let state = (await op('onboard.ingest_resume', { file_path: resumePath })) as State;
    expect(state.step).toBe('interview');
    expect(state.components_filled).toEqual(['story', 'craft']);

    const asked: string[] = [];
    while (state.next_question) {
      const q = state.next_question;
      asked.push(q.id);
      state = (await op('onboard.answer', { question_id: q.id, value: answerFor(q) })) as State;
    }
    for (const skipped of ['story.headline', 'story.win', 'craft.functions', 'craft.level']) expect(asked).not.toContain(skipped);
    expect(asked).toContain('dealbreakers.other');
    expect(asked.length).toBeGreaterThanOrEqual(15);
    expect(state.step).toBe('calibrate');
    expect((await op('onboard.state', {})).step).toBe('calibrate');

    expect(await (e as FixtureEngine).runOp('onboard.calibrate', { sample_id: 'nope', choice: 'yes' }, ctx())).toMatchObject({
      code: 'not_found',
    });

    const cards = await op('onboard.samples', {});
    expect(cards.items).toHaveLength(12);
    expect(cards.items[0]).toMatchObject({ letter: 'S', mode: 'remote', comp: 'Not listed' });
    expect(Object.values(cards.weights as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(100);

    let last: { weights: Record<string, number>; remaining: number } | undefined;
    for (const s of cards.items as Array<{ id: string; criteria: Record<Criterion, number> }>) {
      const choice = s.criteria.c3 >= 4 ? 'yes' : s.criteria.c3 === 3 ? 'maybe' : 'no';
      last = await op('onboard.calibrate', { sample_id: s.id, choice });
    }
    expect(last?.remaining).toBe(0);
    expect(Object.values(last?.weights ?? {}).reduce((a, b) => a + b, 0)).toBe(100);
    const top = Object.entries(last?.weights ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
    expect(top).toBe('c3');

    const conf = await op('onboard.confirm', {});
    expect(conf.version.parent_id).toBeNull();
    expect(conf.version.reason).toBe('onboard');
    const p = await comps();
    expect(p.components).toHaveLength(11);
    expect(rubricWeights(p.components as never)).toEqual(last?.weights);
    const craft = p.components.find((c) => c.key === 'craft');
    expect(craft?.data_json.level).toBe('principal');
    expect(craft?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(p.components.find((c) => c.key === 'work_mode')?.data_json.modes).toEqual(['remote']);
    const story = p.components.find((c) => c.key === 'story');
    expect(story?.md_path).toBe('profile/story.md');
    const md = readFileSync(join((e as FixtureEngine).home, 'profile', 'story.md'), 'utf8');
    expect(md).toContain(`id: "${story?.id}"`);
    expect(md).toContain('Acme Data');
    // The session lives in the onboard_session table (no JSON file).
    const row = (e as FixtureEngine).db.prepare('SELECT step, version_id FROM onboard_session ORDER BY started_at DESC LIMIT 1').get();
    expect(row).toEqual({ step: 'done', version_id: conf.version.id });

    expect(await (e as FixtureEngine).runOp('onboard.answer', { question_id: 'craft.mode', value: 'ic' }, ctx())).toMatchObject({
      code: 'not_found',
    });
  });

  it('fixtures: re-interview one component without redoing the rest (onboard.start with components)', async () => {
    e = openFixtureEngine();
    let state = (await op('onboard.start', { components: ['growth'] })) as State;
    expect(state.next_question?.id).toBe('growth.ceiling');
    const ids: string[] = [];
    while (state.next_question) {
      ids.push(state.next_question.id);
      state = (await op('onboard.answer', {
        question_id: state.next_question.id,
        value: state.next_question.options?.[2] ?? 'x',
      })) as State;
    }
    expect(ids).toEqual(['growth.ceiling', 'growth.trajectory']);
    expect(state.step).toBe('confirm');
    await op('onboard.confirm', {});
    const p = await comps();
    expect(p.version.parent_id).toBe('pv_0002');
    expect(p.components.find((c) => c.key === 'growth')?.data_json.scope_ceiling).toBe('head of product');
    expect(p.components.find((c) => c.key === 'growth')?.data_json.trajectory).toBe('deeper');
    const prev = await comps('pv_0002');
    for (const c of p.components.filter((x) => x.key !== 'growth'))
      expect(c.data_json).toEqual(prev.components.find((x) => x.key === c.key)?.data_json);
  });

  it('list questions take chips as an array, a comma string still parses; money sliders say so (#73, #75)', async () => {
    e = openFixtureEngine();
    let state = (await op('onboard.start', { components: ['work_mode'] })) as State;
    while (state.next_question && state.next_question.id !== 'work_mode.locations')
      state = (await op('onboard.answer', { question_id: state.next_question.id, skip: true })) as State;
    expect(state.next_question).toMatchObject({ id: 'work_mode.locations', answer_type: 'list' });
    await expect(
      (e as FixtureEngine).runOp('onboard.answer', { question_id: 'work_mode.locations', value: [] }, ctx()),
    ).resolves.toMatchObject({
      status: 'error',
    });
    state = (await op('onboard.answer', { question_id: 'work_mode.locations', value: ['New York', ' US remote ', 'New York'] })) as State;
    expect(state.next_question).toMatchObject({ id: 'work_mode.travel', answer_type: 'slider', unit: 'percent', step: 5 });
    await op('onboard.answer', { question_id: 'work_mode.travel', skip: true });
    await op('onboard.confirm', {});
    let p = await comps();
    expect(p.components.find((c) => c.key === 'work_mode')?.data_json.locations).toEqual(['New York', 'US remote']);

    state = (await op('onboard.start', { components: ['network', 'terms'] })) as State;
    expect(state.next_question).toMatchObject({ id: 'terms.floor', unit: 'money', step: 1000, min: 0, max: 600000 });
    state = (await op('onboard.answer', { question_id: 'terms.floor', value: 212500 })) as State;
    while (state.next_question && state.next_question.id !== 'network.warm')
      state = (await op('onboard.answer', { question_id: state.next_question.id, skip: true })) as State;
    expect(state.next_question?.answer_type).toBe('list');
    state = (await op('onboard.answer', { question_id: 'network.warm', value: 'Stripe, Figma\nLinear' })) as State;
    while (state.next_question) state = (await op('onboard.answer', { question_id: state.next_question.id, skip: true })) as State;
    await op('onboard.confirm', {});
    p = await comps();
    expect(p.components.find((c) => c.key === 'network')?.data_json.warm_companies).toEqual(['Stripe', 'Figma', 'Linear']);
    expect(p.components.find((c) => c.key === 'terms')?.data_json.comp_floor).toBe(212500);
  });

  it('fixtures: recalibrate (onboard.start with calibrate) starts from the current weights and saves only weighted components (#25)', async () => {
    e = openFixtureEngine();
    const prev = await comps();
    const current = rubricWeights(prev.components as never);
    const state = (await op('onboard.start', { calibrate: true })) as State;
    expect(state.step).toBe('calibrate');
    expect(state.next_question).toBeNull();
    const samples = (await op('onboard.samples', {})) as OpOutput<'onboard.samples'>;
    for (const c of CRITERIA) expect(samples.weights[c]).toBeCloseTo(current[c], 5);
    // Nothing answered yet: nothing to save.
    expect(await (e as FixtureEngine).runOp('onboard.confirm', {}, ctx())).toMatchObject({ status: 'error', code: 'conflict' });
    let last: OpOutput<'onboard.calibrate'> | undefined;
    for (const [i, s] of samples.items.entries())
      last = (await op('onboard.calibrate', { sample_id: s.id, choice: i % 2 ? 'no' : 'yes' })) as never;
    expect(last?.remaining).toBe(0);
    expect((await op('onboard.state', {})).step).toBe('confirm');
    await op('onboard.confirm', {});
    const p = await comps();
    expect(p.version.parent_id).toBe(prev.version.id);
    expect(p.version.reason).toBe('onboard: recalibrate');
    const after = rubricWeights(p.components as never);
    expect(CRITERIA.some((c) => Math.abs(after[c] - current[c]) > 0.01)).toBe(true);
    for (const c of p.components.filter((x) => PROFILE_COMPONENT_KIND[x.key as ProfileComponentKey] !== 'weighted'))
      expect(c.data_json).toEqual(prev.components.find((x) => x.key === c.key)?.data_json);
  });

  it('voice samples: several kept; a string appends, a list replaces (remove one), capped', async () => {
    expect(nextSamples(['a'], 'b')).toEqual(['a', 'b']);
    expect(nextSamples(['a', 'b'], 'a')).toEqual(['a', 'b']);
    expect(nextSamples(['a', 'b', 'c'], ['a', 'c'])).toEqual(['a', 'c']);
    expect(() => nextSamples(['1', '2', '3', '4', '5'], '6')).toThrow(/at most 5/);
    expect(() => nextSamples([], 'x'.repeat(1501))).toThrow(/over 1500/);

    const reinterview = async (value: string | string[]) => {
      let state = (await op('onboard.start', { components: ['voice'] })) as State;
      expect(state.next_question?.id).toBe('voice.style');
      state = (await op('onboard.answer', { question_id: 'voice.style', value: 'warm' })) as State;
      const q = state.next_question;
      expect(q).toMatchObject({ id: 'voice.sample', answer_type: 'text', max_items: 5, max_chars: 1500 });
      const before = q?.items ?? [];
      state = (await op('onboard.answer', { question_id: 'voice.sample', value })) as State;
      expect(state.step).toBe('confirm');
      await op('onboard.confirm', {});
      const voice = (await comps()).components.find((c) => c.key === 'voice');
      return { before, voice };
    };

    e = openFixtureEngine();
    // Append: the fixture's two samples stay, a third is added.
    const a = await reinterview('Third sample, plain and short.');
    expect(a.before).toHaveLength(2);
    expect(a.voice?.data_json.samples).toEqual([...a.before, 'Third sample, plain and short.']);
    const md = readFileSync(join((e as FixtureEngine).home, a.voice?.md_path as string), 'utf8');
    expect(md).toContain('- Third sample, plain and short.');
    // Remove one: the UI sends the list it keeps.
    const b = await reinterview([a.before[0] as string, 'Third sample, plain and short.']);
    expect(b.before).toHaveLength(3);
    expect(b.voice?.data_json.samples).toEqual([a.before[0], 'Third sample, plain and short.']);
    expect(await (e as FixtureEngine).runOp('onboard.start', { components: ['voice'] }, ctx())).toMatchObject({ status: 'ok' });
    await op('onboard.answer', { question_id: 'voice.style', value: 'warm' });
    expect(
      await (e as FixtureEngine).runOp('onboard.answer', { question_id: 'voice.sample', value: ['1', '2', '3', '4', '5', '6'] }, ctx()),
    ).toMatchObject({ status: 'error', code: 'invalid_input' });
  });

  it('fixtures: an agent re-onboarding cannot write filters; they become pending high diffs (via profile.propose_diff)', async () => {
    e = openFixtureEngine();
    let state = (await op('onboard.start', { components: ['work_mode', 'craft'] }, ctx('agent'))) as State;
    while (state.next_question) {
      const q = state.next_question;
      const value = q.id === 'work_mode.modes' ? ['remote', 'hybrid'] : q.id === 'work_mode.locations' ? 'US' : answerFor(q);
      state = (await op('onboard.answer', { question_id: q.id, value }, ctx('agent'))) as State;
    }
    const before = (await comps()).pending_diffs.length;
    const conf = await op('onboard.confirm', {}, ctx('agent'));
    expect(conf.proposed_diffs).toHaveLength(1);
    const p = await comps();
    expect(p.components.find((c) => c.key === 'work_mode')?.data_json.modes).toEqual(['remote']); // unchanged
    expect(p.pending_diffs.length).toBe(before + 1);
    const wm = p.pending_diffs.find((d) => d.component_key === 'work_mode');
    expect(wm?.impact).toBe('high');
    expect((wm?.diff_json as { after: { modes: string[] } } | undefined)?.after.modes).toEqual(['remote', 'hybrid']);
  });

  it('resumes the fixture session and refuses out-of-order steps and invalid answers', async () => {
    e = openFixtureEngine();
    // The fixture has a re-interview paused at calibration.
    expect((await op('onboard.state', {})).step).toBe('calibrate');
    // A fresh full onboarding starts at the resume step.
    expect((await op('onboard.start', {})).step).toBe('resume');
    const ee = e as FixtureEngine;
    expect((await ee.runOp('onboard.answer', { question_id: 'craft.mode', value: 'ic' }, ctx())).status).toBe('error');
    expect((await ee.runOp('onboard.confirm', {}, ctx())).status).toBe('error');
    expect((await ee.runOp('onboard.ingest_resume', {}, ctx())).status).toBe('error');
    const r = (await op('onboard.ingest_resume', { text: SYNTH_RESUME })) as State;
    expect(r.next_question).not.toBeNull();
    expect((await ee.runOp('onboard.answer', { question_id: 'terms.floor', value: 'lots' }, ctx())).status).toBe('error');
  });
});

describe('the resume is kept, parsed by an agent, and never guessed (#38)', () => {
  const upload = (name: string, bytes: Buffer) => ({ file: { name, content_base64: bytes.toString('base64') } });
  const NO_YEARS_PARAS = SYNTH_RESUME_NO_YEARS.trim().split('\n').filter(Boolean);

  it('an upload keeps the original and its text in files/, links it from Story and queues the onboard run', async () => {
    e = openFixtureEngine({ seed: false });
    const ee = e as FixtureEngine;
    const state = (await op('onboard.ingest_resume', upload('Riley Resume.docx', synthDocx(NO_YEARS_PARAS)))) as State;
    expect(state.resume?.source_path).toMatch(/^files\/resume-\d{8}-\d{6}\.md$/);
    expect(state.resume?.file_path).toMatch(/^files\/resume-\d{8}-\d{6}-original\.docx$/);
    expect(existsSync(join(ee.home, state.resume?.file_path as string))).toBe(true);
    const kept = readFileSync(join(ee.home, state.resume?.source_path as string), 'utf8');
    expect(kept).toMatch(/^---\nid: "resume_\d{8}-\d{6}"\ntype: "resume_source"\n---/);
    expect(kept).toContain('Northwind Analytics — Senior Product Manager — Jan 2019–Present');
    // Viewable: vault.read serves the kept resume (the onboarding draft links it).
    const viewed = await op('vault.read', { path: state.resume?.source_path });
    expect(viewed.markdown).toContain('Shipped a forecasting product used by 85 customers.');
    // The headless onboard run is queued and launched (fake launcher) with the extraction asset in its prompt.
    expect(state.resume?.parse_run_id).toMatch(/^rn_/);
    const run = ee.db.prepare('SELECT op, status FROM run WHERE id = ?').get(state.resume?.parse_run_id) as { op: string; status: string };
    expect(run.op).toBe('onboard');
    await new Promise((r) => setTimeout(r, 20));
    const spec = ee.launcher.specs.find((x) => x.args.join(' ').includes('extract.md'));
    expect(spec).toBeDefined();
    // The resume's headline is confirmed first (#22), then years.
    expect(state.next_question).toMatchObject({
      id: 'confirm.story',
      kind: 'confirm',
      label: 'Looks like your headline is "Senior Product Manager". Right?',
      options: ['yes', 'edit'],
    });
    const after = (await op('onboard.answer', { question_id: 'confirm.story', value: 'yes' })) as State;
    // The instant preview never guesses: years only from the role dates, asked for confirmation.
    expect(after.next_question?.id).toBe('story.years');
    expect(after.next_question?.options).toEqual(['10', 'leave out']);
    // An agent ingest (e.g. the skill in a live session) does not queue another run.
    const runs = (ee.db.prepare(`SELECT COUNT(*) AS n FROM run WHERE op = 'onboard'`).get() as { n: number }).n;
    await op('onboard.ingest_resume', upload('r.pdf', synthPdf(['Riley Sample', 'Senior Product Manager'])), ctx('agent'));
    expect((ee.db.prepare(`SELECT COUNT(*) AS n FROM run WHERE op = 'onboard'`).get() as { n: number }).n).toBe(runs);
    // Unreadable uploads are refused.
    expect(await ee.runOp('onboard.ingest_resume', upload('r.docx', Buffer.from('nope')), ctx())).toMatchObject({ code: 'invalid_input' });
  });

  it('onboard.extract: verbatim facts replace the preview; invented numbers, employers and years are refused', async () => {
    e = openFixtureEngine({ seed: false });
    const ee = e as FixtureEngine;
    await op('onboard.ingest_resume', { text: SYNTH_RESUME_NO_YEARS }, ctx('agent'));
    const roles = [
      {
        company: 'Northwind Analytics',
        title: 'Senior Product Manager',
        dates: 'Jan 2019–Present',
        bullets: ['Shipped a forecasting product used by 85 customers.'],
      },
      { company: 'Contoso Retail', title: 'Product Analyst', dates: '2016–2018', bullets: ['Built the weekly demand dashboard.'] },
    ];
    const bad = async (story: Record<string, unknown>, re: RegExp) => {
      const o = await ee.runOp('onboard.extract', { story }, ctx('agent'));
      expect(o).toMatchObject({ status: 'error', code: 'invalid_input' });
      expect((o as { message: string }).message).toMatch(re);
    };
    await bad({ headline: 'Senior Product Manager', years: 26, years_basis: 'stated', roles }, /years 26/);
    await bad({ years: 26, roles }, /years_basis/);
    await bad({ years: 12, years_basis: 'from dates', roles }, /role dates give 10/);
    await bad({ wins: ['Shipped a forecasting product used by 95 customers.'], roles }, /"95"/);
    await bad({ roles: [{ ...roles[0], company: 'Globex' }] }, /Globex/);

    const out = await op('onboard.extract', {
      story: {
        headline: 'Senior Product Manager',
        roles,
        wins: [roles[0]?.bullets[0]],
        years: 10,
        years_basis: 'from dates',
        source_path: 'x',
      },
      craft: { level: 'senior' },
    });
    expect(out.target).toBe('session');
    expect(out.state.next_question.id).toBe('confirm.story');
    expect(out.state.resume_drafts.find((d: { component: string }) => d.component === 'story')).toMatchObject({ by: 'agent' });
    const draft = (ee.db.prepare('SELECT draft_json FROM onboard_session ORDER BY started_at DESC LIMIT 1').get() as { draft_json: string })
      .draft_json;
    const story = JSON.parse(draft).story;
    expect(story).toMatchObject({ extracted_by: 'agent', roles, years: 10, years_basis: 'from dates' });
    expect(story.source_path).toMatch(/^files\/resume-/);
    expect(story.education).toBeUndefined(); // the preview is replaced, not merged
  });

  it('dictated answers are stored clean with the raw text kept; unconfirmed years are never saved', async () => {
    e = openFixtureEngine();
    let state = (await op('onboard.start', { components: ['story'] })) as State;
    expect(state.next_question?.id).toBe('story.headline');
    state = (await op('onboard.answer', { question_id: 'story.headline', value: 'Data platform product lead' })) as State;
    expect(state.next_question?.id).toBe('story.win');
    const raw = 'um, so I uh cut pipeline cost the the 38%, you know, with a usage-based redesign';
    state = (await op('onboard.answer', { question_id: 'story.win', value: raw })) as State;
    expect(state.step).toBe('confirm');
    await op('onboard.confirm', {});
    const story = (await comps()).components.find((c) => c.key === 'story')?.data_json ?? {};
    expect(story.wins).toEqual(['I cut pipeline cost the 38%, with a usage-based redesign']);
    expect(story.dictated).toEqual({ 'story.win': raw });
    // The fixture Story's years (no basis: a guess) is dropped on confirm.
    expect(story.years).toBeUndefined();
    // The UI sends the cleaned text the user confirmed plus the raw.
    await op('onboard.start', { components: ['story'] });
    await op('onboard.answer', { question_id: 'story.headline', value: 'Data platform product lead' });
    await op('onboard.answer', { question_id: 'story.win', value: 'Cut pipeline cost 38%.', raw: 'uh cut pipeline cost 38%' });
    await op('onboard.confirm', {});
    const again = (await comps()).components.find((c) => c.key === 'story')?.data_json ?? {};
    expect(again.wins).toEqual(['Cut pipeline cost 38%.']);
    expect((again.dictated as Record<string, string>)['story.win']).toBe('uh cut pipeline cost 38%');
  });
});

describe('question wording (#23)', () => {
  it('every question is a full sentence with at most a one-line example; no dashes', () => {
    for (const q of QUESTION_BANK) {
      expect(q.label.split(' ').length, q.id).toBeGreaterThanOrEqual(4);
      expect(q.label, q.id).toMatch(/^[A-Z].*[?.]$/);
      expect(q.label + (q.example ?? ''), q.id).not.toMatch(/[\u2014\u2013]/);
      if (q.example) expect(q.example, q.id).not.toMatch(/\n/);
    }
  });
  it('no two questions ask for the same thing; Company and Network are sequenced and distinct', () => {
    for (const [i, a] of QUESTION_BANK.entries())
      for (const b of QUESTION_BANK.slice(i + 1)) expect(questionOverlap(a.label, b.label), `${a.id} / ${b.id}`).toBeLessThan(0.5);
    const ids = QUESTION_BANK.map((q) => q.id);
    expect(ids.indexOf('network.warm')).toBe(ids.indexOf('company.dream') + 1);
    expect(QUESTION_BANK.find((q) => q.id === 'company.dream')?.label).toBe('Which companies would you love to work at?');
    expect(QUESTION_BANK.find((q) => q.id === 'network.warm')?.label).toMatch(/^Where do you already know people/);
    // Industries are asked once (Domain), not again as dealbreakers.
    const nos = QUESTION_BANK.find((q) => q.id === 'dealbreakers.hard_nos')?.options ?? [];
    for (const industry of QUESTION_BANK.find((q) => q.id === 'domain.avoid')?.options ?? [])
      if (industry !== 'other' && industry !== 'none') expect(nos).not.toContain(industry);
  });
  it('every question can be skipped ("I don\'t know"): the draft is unchanged', async () => {
    e = openFixtureEngine();
    let state = (await op('onboard.start', { components: ['growth'] })) as State;
    expect(state.next_question?.id).toBe('growth.ceiling');
    const ee = e as FixtureEngine;
    expect(await ee.runOp('onboard.answer', { question_id: 'growth.ceiling' }, ctx())).toMatchObject({ code: 'invalid_input' });
    state = (await op('onboard.answer', { question_id: 'growth.ceiling', skip: true })) as State;
    expect(state.next_question?.id).toBe('growth.trajectory');
    state = (await op('onboard.answer', { question_id: 'growth.trajectory', skip: true })) as State;
    expect(state.step).toBe('confirm');
    const row = ee.db.prepare('SELECT interview_json FROM onboard_session ORDER BY started_at DESC LIMIT 1').get() as {
      interview_json: string;
    };
    expect(JSON.parse(row.interview_json).skipped).toEqual(['growth.ceiling', 'growth.trajectory']);
    const before = (await comps()).components.find((c) => c.key === 'growth')?.data_json;
    await op('onboard.confirm', {});
    expect((await comps()).components.find((c) => c.key === 'growth')?.data_json).toEqual(before);
  });
});

describe('the interview adapts to the resume (#22)', () => {
  /** Walk an interview: confirm everything the resume implies, skip the rest. */
  async function walk(text: string) {
    e?.cleanup();
    e = openFixtureEngine({ seed: false });
    let state = (await op('onboard.ingest_resume', { text }, ctx('agent'))) as State;
    const drafts = state.resume_drafts;
    const asked: Array<{ id: string; label: string; kind: string; suggested?: unknown }> = [];
    while (state.next_question) {
      const q = state.next_question;
      asked.push({ id: q.id, label: q.label, kind: q.kind, suggested: q.suggested });
      state = (await op(
        'onboard.answer',
        q.kind === 'confirm' ? { question_id: q.id, value: 'yes' } : { question_id: q.id, skip: true },
      )) as State;
    }
    return { asked, drafts };
  }

  it('two different resumes produce noticeably different interviews', async () => {
    const pm = await walk(SYNTH_RESUME);
    const eng = await walk(SYNTH_RESUME_ENGINEER);
    const confirms = (a: typeof pm.asked) => a.filter((q) => q.kind === 'confirm').map((q) => q.label);
    expect(confirms(pm.asked)).toEqual([
      'Looks like your headline is "Principal Product Manager, Data Platforms". Right?',
      'Looks like you work as a principal PM, as an individual contributor. Right?',
      'Looks like your strongest domain is data platforms. Right?',
      'Looks like you write in a punchy style. Right?',
    ]);
    expect(confirms(eng.asked)).toEqual([
      'Looks like your headline is "Staff Software Engineer, Clinical Systems". Right?',
      'Looks like you work as a staff engineer, as an individual contributor. Right?',
      'Looks like your strongest domain is healthcare. Right?',
      'Looks like you write in a formal style. Right?',
    ]);
    // Different question sets: years only where the dates imply them; suggestions differ.
    const ids = (a: typeof pm.asked) => a.map((q) => q.id);
    expect(ids(pm.asked)).not.toContain('story.years'); // stated in the resume
    expect(ids(eng.asked)).toContain('story.years'); // from the role dates: confirmed or left out
    const growth = (a: typeof pm.asked) => a.find((q) => q.id === 'growth.ceiling')?.suggested;
    expect(growth(pm.asked)).toBe('group PM');
    expect(growth(eng.asked)).toBe('principal IC');
    expect(ids(pm.asked)).not.toEqual(ids(eng.asked));
    // What was pulled is shown per component, with a confidence.
    expect(pm.drafts.map((d) => d.component)).toEqual(['story', 'craft', 'domain', 'growth', 'voice']);
    expect(eng.drafts.find((d) => d.component === 'domain')?.items[0]).toMatch(/^healthcare: \d+ mentions$/);
    for (const d of [...pm.drafts, ...eng.drafts]) expect(d.confidence).toBeGreaterThan(0);
  });

  it('high confidence is confirmed, not asked; Edit asks the component with the resume pre-filled', async () => {
    e = openFixtureEngine({ seed: false });
    let state = (await op('onboard.ingest_resume', { text: SYNTH_RESUME }, ctx('agent'))) as State;
    state = (await op('onboard.answer', { question_id: 'confirm.story', value: 'yes' })) as State;
    expect(state.next_question?.id).toBe('confirm.craft');
    state = (await op('onboard.answer', { question_id: 'confirm.craft', value: 'edit' })) as State;
    expect(state.next_question).toMatchObject({ id: 'craft.functions', kind: 'ask', suggested: ['PM'] });
    state = (await op('onboard.answer', { question_id: 'craft.functions', value: ['PM'] })) as State;
    expect(state.next_question).toMatchObject({ id: 'craft.level', suggested: 'principal' });
    state = (await op('onboard.answer', { question_id: 'craft.level', value: 'group' })) as State;
    expect(state.next_question?.id).toBe('craft.mode');
    state = (await op('onboard.answer', { question_id: 'craft.mode', value: 'lead' })) as State;
    expect(state.next_question?.id).toBe('craft.facing'); // the resume is silent: asked open
    state = (await op('onboard.answer', { question_id: 'craft.facing', skip: true })) as State;
    // #74: the titles to search for, the resume's own first (suggested), free entry allowed.
    expect(state.next_question).toMatchObject({
      id: 'craft.titles',
      other: true,
      suggested: ['Principal Product Manager', 'Senior Product Manager', 'Analyst'],
    });
    expect(state.next_question?.options?.slice(0, 4)).toEqual([
      'Principal Product Manager',
      'Senior Product Manager',
      'Analyst',
      'Product Manager',
    ]);
    state = (await op('onboard.answer', { question_id: 'craft.titles', skip: true })) as State;
    expect(state.next_question?.id).toBe('confirm.domain');
    state = (await op('onboard.answer', { question_id: 'confirm.domain', value: 'yes' })) as State;
    // Domain ranked is confirmed, not asked again.
    expect(state.next_question?.id).toBe('domain.avoid');
    const draft = JSON.parse(
      (
        (e as FixtureEngine).db.prepare('SELECT draft_json FROM onboard_session ORDER BY started_at DESC LIMIT 1').get() as {
          draft_json: string;
        }
      ).draft_json,
    );
    expect(draft.craft).toMatchObject({ functions: ['PM'], level: 'group', mode: 'lead' });
    expect(draft.domain.ranked).toEqual(['data platforms']);
  });

  it('the agent run refines the drafts (with confidence) and proposes follow-ups through ops', async () => {
    e = openFixtureEngine({ seed: false });
    const ee = e as FixtureEngine;
    await op('onboard.ingest_resume', { text: SYNTH_RESUME_ENGINEER }, ctx('agent'));
    const out = await op(
      'onboard.extract',
      {
        story: { headline: 'Staff Software Engineer, Clinical Systems' },
        craft: { functions: ['Engineering'], level: 'staff', mode: 'ic' },
        drafts: {
          domain: {
            data: { ranked: ['healthcare', 'data platforms'] },
            confidence: 0.9,
            evidence: ['EHR integration', 'clinical software'],
          },
          growth: { data: { scope_ceiling: 'principal IC' }, confidence: 0.4 },
        },
      },
      ctx('agent'),
    );
    expect(out.state.resume_drafts.find((d: { component: string }) => d.component === 'domain')).toMatchObject({
      by: 'agent',
      confidence: 0.9,
      items: ['EHR integration', 'clinical software'],
    });
    const proposed = await op(
      'onboard.propose_questions',
      {
        questions: [
          {
            component: 'domain',
            label: 'Would you stay in clinical software, or move to a different part of healthcare?',
            answer_type: 'chips',
            options: ['clinical software', 'elsewhere in healthcare', 'either'],
            reason: 'Every role is clinical software.',
          },
          { component: 'company', label: 'Which companies would you really love to work at?', answer_type: 'text' },
          { component: 'craft', label: 'Lead?', answer_type: 'text' },
          { component: 'team', label: 'Do you like small teams \u2014 or big ones?', answer_type: 'text' },
          { component: 'voice', label: 'Which writing do you want us to match?', answer_type: 'chips' },
        ],
      },
      ctx('agent'),
    );
    expect(proposed.added).toEqual(['follow.1']);
    expect(proposed.rejected.map((r: { reason: string }) => r.reason)).toEqual([
      'duplicate of company.dream',
      'a question is a full sentence ending in ? or .',
      'no em or en dashes',
      'chips need at least two options',
    ]);
    const asked: string[] = [];
    let state = proposed.state as State;
    while (state.next_question) {
      const q = state.next_question;
      asked.push(q.id);
      if (q.id === 'confirm.domain') expect(q.label).toBe('Looks like your strongest domains are healthcare and data platforms. Right?');
      if (q.id === 'growth.ceiling') expect(q.suggested).toBe('principal IC');
      const value = q.kind === 'confirm' ? 'yes' : q.id === 'follow.1' ? 'either' : undefined;
      state = (await op('onboard.answer', value ? { question_id: q.id, value } : { question_id: q.id, skip: true })) as State;
    }
    // The follow-up is asked after Domain's bank questions.
    expect(asked.indexOf('follow.1')).toBe(asked.indexOf('domain.avoid') + 1);
    expect(asked).not.toContain('domain.ranked');
    const draft = JSON.parse(
      (ee.db.prepare('SELECT draft_json FROM onboard_session ORDER BY started_at DESC LIMIT 1').get() as { draft_json: string }).draft_json,
    );
    expect(draft.domain.follow_ups).toEqual([
      { question: 'Would you stay in clinical software, or move to a different part of healthcare?', answer: 'either' },
    ]);
    // Past the interview, no more follow-ups.
    expect(
      await ee.runOp(
        'onboard.propose_questions',
        { questions: [{ component: 'team', label: 'Do you want a small team?', answer_type: 'text' }] },
        ctx('agent'),
      ),
    ).toMatchObject({ code: 'conflict' });
  });
});
