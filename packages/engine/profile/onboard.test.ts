import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRITERIA, type Criterion, type OpContext, type OpOutput } from '@perfect-placement/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine, tickingClock } from '../testing/index.js';
import { type CalibrationSample, deriveWeights } from './calibration.js';
import { rubricWeights } from './components.js';
import { nextSamples } from './questions.js';
import { parseResumeHeuristic } from './resume.js';
import { SYNTH_RESUME, SYNTH_RESUME_NO_YEARS, synthDocx, synthPdf } from './synthetic.js';

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
    // The instant preview never guesses: years only from the role dates, asked for confirmation.
    expect(state.next_question?.id).toBe('story.years');
    expect(state.next_question?.options).toEqual(['10', 'leave out']);
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
    expect(out.state.next_question.id).toBe('story.years');
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
