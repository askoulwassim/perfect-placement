import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRITERIA, type Criterion, type OpContext, type OpOutput } from '@perfect-placement/contracts';
import { FIXTURE_SEED_SQL } from '@perfect-placement/fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { type CalibrationSample, deriveWeights } from './calibration.js';
import { rubricWeights } from './components.js';
import { createProfileHandlers } from './handlers.js';
import { startComponentInterview } from './onboard.js';
import { createFileOnboardStore } from './onboard-store.js';
import { parseResumeHeuristic } from './resume.js';
import { getComponents, getCurrentVersion, listDiffs } from './store.js';
import { SYNTH_RESUME } from './synthetic.js';
import { createTempDb, testDeps } from './testing.js';

type State = OpOutput<'onboard.ingest_resume'>;
let tick = 0;
const ctx = (actor: OpContext['actor'] = 'human'): OpContext => ({ actor, now: () => new Date(Date.UTC(2026, 9, 8, 12, 0, ++tick)) });

/** Deterministic answer for any question (first option / midpoint / text). */
function answerFor(q: NonNullable<State['next_question']>): string | number | string[] {
  if (q.id === 'work_mode.modes') return ['remote'];
  if (q.id === 'dealbreakers.hard_nos') return ['onsite only', 'other'];
  if (q.answer_type === 'slider') return Math.round(((q.min ?? 0) + (q.max ?? 100)) / 4);
  if (q.answer_type === 'multi_chips') return [q.options?.[0] ?? 'x'];
  if (q.answer_type === 'chips') return q.options?.[0] ?? 'x';
  return `answer for ${q.label}`;
}

let env: ReturnType<typeof createTempDb> | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

describe('resume parsing', () => {
  it('drafts Story and Craft from the text only', () => {
    const d = parseResumeHeuristic(SYNTH_RESUME, new Date('2026-10-08T00:00:00Z'));
    expect(d.story.headline).toBe('Principal Product Manager, Data Platforms');
    expect(d.story.years).toBe(10);
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
    env = createTempDb(); // migrations only: no profile yet
    const samples: CalibrationSample[] = Array.from({ length: 12 }, (_, i) => ({
      id: `sample-${i}`,
      title: `Sample ${i}`,
      criteria: Object.fromEntries(CRITERIA.map((c) => [c, c === 'c3' ? (i % 3) + 2 : ((i * 7 + c.charCodeAt(1)) % 5) + 1])) as Record<
        Criterion,
        number
      >,
    }));
    const vault = join(env.dir, 'vault');
    mkdirSync(join(vault, 'files'), { recursive: true });
    writeFileSync(join(vault, 'files', 'resume.md'), SYNTH_RESUME);
    const deps = testDeps(env.db, { vaultDir: vault, onboardStore: createFileOnboardStore(vault), calibrationSamples: () => samples });
    const ops = createProfileHandlers(deps);

    const r0 = await ops['onboard.ingest_resume']({ file_path: 'files/resume.md' }, ctx());
    expect(r0.status).toBe('ok');
    let state = (r0 as { output: State }).output;
    expect(state.step).toBe('interview');
    expect(state.components_filled).toEqual(['story', 'craft']);

    const asked: string[] = [];
    while (state.next_question) {
      const q = state.next_question;
      asked.push(q.id);
      const r = await ops['onboard.answer']({ question_id: q.id, value: answerFor(q) }, ctx());
      expect(r.status, q.id).toBe('ok');
      state = (r as { output: State }).output;
    }
    // Skip logic: the resume answered headline, wins, function and level.
    for (const skipped of ['story.headline', 'story.win', 'craft.functions', 'craft.level']) expect(asked).not.toContain(skipped);
    // Adaptive follow-up: 'other' hard no -> asked for the other.
    expect(asked).toContain('dealbreakers.other');
    expect(asked.length).toBeGreaterThanOrEqual(15);
    expect(state.step).toBe('calibrate');

    // Bad answers are rejected.
    const bad = await ops['onboard.calibrate']({ sample_id: 'nope', choice: 'yes' }, ctx());
    expect(bad.status === 'error' && bad.code).toBe('not_found');

    let last: { weights: Record<string, number>; remaining: number } | undefined;
    for (const s of samples) {
      const choice = s.criteria.c3 >= 4 ? 'yes' : s.criteria.c3 === 3 ? 'maybe' : 'no';
      const r = await ops['onboard.calibrate']({ sample_id: s.id, choice }, ctx());
      expect(r.status).toBe('ok');
      last = (r as { output: typeof last }).output;
    }
    expect(last?.remaining).toBe(0);
    expect(Object.values(last?.weights ?? {}).reduce((a, b) => a + b, 0)).toBe(100);
    // External-facing (c3) predicted every yes: it is the top weight.
    const top = Object.entries(last?.weights ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
    expect(top).toBe('c3');

    const conf = await ops['onboard.confirm']({}, ctx());
    expect(conf.status).toBe('ok');
    const version = (conf as { output: { version: { id: string; parent_id: string | null; reason: string } } }).output.version;
    expect(version.parent_id).toBeNull();
    expect(version.reason).toBe('onboard');
    const comps = getComponents(env.db, version.id);
    expect(comps).toHaveLength(11);
    expect(rubricWeights(comps)).toEqual(last?.weights);
    const craft = comps.find((c) => c.key === 'craft');
    expect(craft?.data_json.level).toBe('principal');
    expect(craft?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(comps.find((c) => c.key === 'work_mode')?.data_json.modes).toEqual(['remote']);
    // Story markdown written with frontmatter id.
    const story = comps.find((c) => c.key === 'story');
    expect(story?.md_path).toBe('profile/story.md');
    const md = readFileSync(join(vault, 'profile', 'story.md'), 'utf8');
    expect(md).toContain(`id: "${story?.id}"`);
    expect(md).toContain('Acme Data');
    expect(existsSync(join(vault, 'onboarding.json'))).toBe(true);

    // Session is done: further answers are refused.
    const after = await ops['onboard.answer']({ question_id: 'craft.mode', value: 'ic' }, ctx());
    expect(after.status === 'error' && after.code).toBe('not_found');
  });

  it('fixtures: re-interview one component without redoing the rest', async () => {
    env = createTempDb(FIXTURE_SEED_SQL);
    const deps = testDeps(env.db);
    const ops = createProfileHandlers(deps);
    let state = startComponentInterview(deps, ['growth'], ctx());
    expect(state.next_question?.id).toBe('growth.ceiling');
    const ids: string[] = [];
    while (state.next_question) {
      ids.push(state.next_question.id);
      const r = await ops['onboard.answer']({ question_id: state.next_question.id, value: state.next_question.options?.[2] ?? 'x' }, ctx());
      state = (r as { output: State }).output;
    }
    expect(ids).toEqual(['growth.ceiling', 'growth.trajectory']);
    expect(state.step).toBe('confirm');
    const conf = await ops['onboard.confirm']({}, ctx());
    expect(conf.status).toBe('ok');
    const v = getCurrentVersion(env.db);
    expect(v?.parent_id).toBe('pv_0002');
    const comps = getComponents(env.db, v?.id ?? '');
    expect(comps.find((c) => c.key === 'growth')?.data_json.scope_ceiling).toBe('head of product');
    expect(comps.find((c) => c.key === 'growth')?.data_json.trajectory).toBe('deeper');
    // Everything else carried over unchanged.
    const prev = getComponents(env.db, 'pv_0002');
    for (const c of comps.filter((x) => x.key !== 'growth')) expect(c.data_json).toEqual(prev.find((p) => p.key === c.key)?.data_json);
  });

  it('fixtures: an agent re-onboarding cannot write filters; they become pending high diffs', async () => {
    env = createTempDb(FIXTURE_SEED_SQL);
    const deps = testDeps(env.db);
    const ops = createProfileHandlers(deps);
    let state = startComponentInterview(deps, ['work_mode', 'craft'], ctx('agent'));
    while (state.next_question) {
      const q = state.next_question;
      const value = q.id === 'work_mode.modes' ? ['remote', 'hybrid'] : q.id === 'work_mode.locations' ? 'US' : answerFor(q);
      const r = await ops['onboard.answer']({ question_id: q.id, value }, ctx('agent'));
      state = (r as { output: State }).output;
    }
    const before = listDiffs(env.db, 'pending').length;
    const conf = await ops['onboard.confirm']({}, ctx('agent'));
    expect(conf.status).toBe('ok');
    const v = getCurrentVersion(env.db);
    const comps = getComponents(env.db, v?.id ?? '');
    expect(comps.find((c) => c.key === 'work_mode')?.data_json.modes).toEqual(['remote']); // unchanged
    const pending = listDiffs(env.db, 'pending');
    expect(pending.length).toBe(before + 1);
    const wm = pending.find((d) => d.component_key === 'work_mode');
    expect(wm?.impact).toBe('high');
    expect((wm?.diff_json as { after: { modes: string[] } } | undefined)?.after.modes).toEqual(['remote', 'hybrid']);
  });

  it('refuses out-of-order steps and invalid answers', async () => {
    env = createTempDb(FIXTURE_SEED_SQL);
    const ops = createProfileHandlers(testDeps(env.db));
    expect((await ops['onboard.answer']({ question_id: 'craft.mode', value: 'ic' }, ctx())).status).toBe('error');
    expect((await ops['onboard.confirm']({}, ctx())).status).toBe('error');
    expect((await ops['onboard.ingest_resume']({}, ctx())).status).toBe('error');
    const r = await ops['onboard.ingest_resume']({ text: SYNTH_RESUME }, ctx());
    expect(r.status).toBe('ok');
    // fixtures profile already answers most questions; the first unknown one comes next
    const q = (r as { output: State }).output.next_question;
    expect(q).not.toBeNull();
    const wrong = await ops['onboard.answer']({ question_id: 'terms.floor', value: 'lots' }, ctx());
    expect(wrong.status).toBe('error');
  });
});
