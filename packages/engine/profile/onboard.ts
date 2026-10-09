import {
  type Criterion,
  cleanDictation,
  type OpContext,
  type OpInput,
  type OpOutput,
  PROFILE_COMPONENT_KEYS,
  PROFILE_COMPONENT_KIND,
  type ProfileComponentKey,
  type ProfileDiff,
  vaultPath,
} from '@perfect-placement/contracts';
import { renderMarkdown, stripFrontmatter } from '../ops/vault.js';
import { CALIBRATION_SIZE, type CalibrationSample, deriveWeights, samplesFromDb, statedPrior } from './calibration.js';
import { parseComponentData, rubricWeights, weightsByComponent } from './components.js';
import { newId, type ProfileDeps } from './deps.js';
import { OpError } from './errors.js';
import { checkFacts, describeClaims, inSource, storySourceText } from './facts.js';
import { clone, deepEqual } from './json.js';
import { componentMdPath, MD_COMPONENTS, renderComponentMd } from './markdown.js';
import type { FillSource, OnboardSession, OnboardStore } from './onboard-store.js';
import { profileProposeDiff } from './profile-ops.js';
import { type AnswerValue, checkAnswer, type Draft, findQuestion, nextQuestion, optionsOf } from './questions.js';
import { parseResumeHeuristic, statedYears, yearsFromDates } from './resume.js';
import { extractResumeText, resumeKind } from './resume-text.js';
import { type ComponentDraft, getComponents, getCurrentVersion, insertVersion } from './versions.js';

/*
 * Onboarding protocol (blueprint.md): resume in -> interview by component -> calibrate -> confirm.
 * Ops: onboard.ingest_resume, onboard.answer, onboard.calibrate, onboard.confirm.
 * Plus startComponentInterview(): re-interview one component without redoing the rest
 * (no op in the contract yet; CONTRACT_CHANGES lane E).
 */

type OnboardState = OpOutput<'onboard.ingest_resume'>;

function store(deps: ProfileDeps): OnboardStore {
  return deps.onboardStore;
}

/** Seed a draft from the current profile so known components are skipped. */
function draftFromProfile(deps: ProfileDeps): { draft: Draft; sources: OnboardSession['sources'] } {
  const v = getCurrentVersion(deps.repos);
  const draft: Draft = {};
  const sources: OnboardSession['sources'] = {};
  if (!v) return { draft, sources };
  for (const c of getComponents(deps.repos, v.id)) {
    if (Object.keys(c.data_json).length) {
      draft[c.key] = clone(c.data_json);
      sources[c.key] = ['profile'];
    }
  }
  return { draft, sources };
}

function newSession(deps: ProfileDeps, now: Date, scope: ProfileComponentKey[] | null): OnboardSession {
  const { draft, sources } = draftFromProfile(deps);
  // The latest session is the live one: never tie with the previous start.
  const prev = store(deps).load();
  const at = prev && prev.started_at >= now.toISOString() ? new Date(Date.parse(prev.started_at) + 1) : now;
  return {
    id: newId('ob', at),
    started_at: at.toISOString(),
    updated_at: at.toISOString(),
    step: 'resume',
    scope,
    draft,
    sources,
    answered: [],
    calibration: { sample_ids: [], choices: {} },
    version_id: null,
  };
}

function activeSession(deps: ProfileDeps): OnboardSession {
  const s = store(deps).load();
  if (!s || s.step === 'done') throw new OpError('not_found', 'no onboarding in progress: start with onboard.ingest_resume');
  return s;
}

function addSource(s: OnboardSession, key: ProfileComponentKey, src: FillSource) {
  const list = s.sources[key] ?? [];
  if (!list.includes(src)) list.push(src);
  s.sources[key] = list;
}

function filled(d: Draft): ProfileComponentKey[] {
  return PROFILE_COMPONENT_KEYS.filter((k) => d[k] && Object.keys(d[k] as object).length > 0);
}

export function stateOf(s: OnboardSession, parseRunId: string | null = null): OnboardState {
  const q = s.step === 'interview' ? nextQuestion(s.draft, s.answered, s.scope) : null;
  const options = q ? optionsOf(q, s.draft) : undefined;
  const story = s.draft.story ?? {};
  return {
    ...(typeof story.source_path === 'string'
      ? {
          resume: {
            source_path: story.source_path,
            file_path: typeof story.source_file === 'string' ? story.source_file : null,
            parse_run_id: parseRunId,
          },
        }
      : {}),
    step: s.step,
    components_filled: filled(s.draft),
    next_question: q
      ? {
          id: q.id,
          component: q.component,
          label: q.label,
          answer_type: q.answer_type,
          ...(options ? { options } : {}),
          ...(q.min != null ? { min: q.min } : {}),
          ...(q.max != null ? { max: q.max } : {}),
          ...(q.max_items != null ? { max_items: q.max_items } : {}),
          ...(q.max_chars != null ? { max_chars: q.max_chars } : {}),
          ...(q.items ? { items: q.items(s.draft) } : {}),
        }
      : null,
  };
}

/** After the interview ends: full onboarding calibrates; a scoped re-interview goes straight to confirm. */
function advance(s: OnboardSession): void {
  if (s.step === 'interview' && !nextQuestion(s.draft, s.answered, s.scope)) s.step = s.scope ? 'confirm' : 'calibrate';
}

// ------------------------------------------------------------------ ops

/** Largest resume upload kept (bytes). */
export const RESUME_MAX_BYTES = 10 * 1024 * 1024;

/** `20261008-120000`: the stamp in a kept resume's file names. */
const stampOf = (now: Date) => now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

/** Read the upload (or the vault file) and keep it: the original in files/ and its text as vault markdown. */
async function keepResume(
  deps: ProfileDeps,
  input: OpInput<'onboard.ingest_resume'>,
  now: Date,
): Promise<{ text: string; source_path: string | null; file_path: string | null }> {
  const stamp = stampOf(now);
  let text = input.text ?? '';
  let file_path: string | null = null;
  if (input.file) {
    const bytes = Buffer.from(input.file.content_base64, 'base64');
    if (!bytes.length) throw new OpError('invalid_input', 'empty file');
    if (bytes.length > RESUME_MAX_BYTES) throw new OpError('invalid_input', `resume over ${RESUME_MAX_BYTES / 1024 / 1024} MB`);
    const got = await extractResumeText(input.file.name, bytes).catch((e: unknown) => {
      throw new OpError('invalid_input', e instanceof Error ? e.message : String(e));
    });
    text = got.text;
    if ((got.kind === 'pdf' || got.kind === 'docx') && deps.vault?.writeBytes) {
      file_path = vaultPath.resumeFile(stamp, got.kind);
      deps.vault.writeBytes(file_path, bytes);
    }
  } else if (!text && input.file_path) {
    if (!deps.vault) throw new OpError('invalid_input', 'file_path needs a vault');
    const kind = resumeKind(input.file_path);
    if (kind === 'pdf' || kind === 'docx') {
      const bytes = deps.vault.readBytes?.(input.file_path) ?? null;
      if (!bytes) throw new OpError('not_found', `cannot read ${input.file_path}`);
      text = (
        await extractResumeText(input.file_path, bytes).catch((e: unknown) => {
          throw new OpError('invalid_input', e instanceof Error ? e.message : String(e));
        })
      ).text;
    } else {
      let raw: string | null = null;
      try {
        raw = deps.vault.read(input.file_path);
      } catch {
        raw = null;
      }
      if (raw === null) throw new OpError('not_found', `cannot read ${input.file_path}`);
      text = stripFrontmatter(raw);
    }
    file_path = input.file_path;
  }
  if (!text.trim()) throw new OpError('invalid_input', 'resume text, file or file_path required');
  // The source is kept (#38): every later fact is checked against this text.
  let source_path: string | null = null;
  if (deps.vault) {
    source_path = vaultPath.resumeText(stamp);
    deps.vault.write(source_path, renderMarkdown({ id: `resume_${stamp}`, type: 'resume_source' }, text));
  }
  return { text, source_path, file_path };
}

export async function onboardIngestResume(
  deps: ProfileDeps,
  input: OpInput<'onboard.ingest_resume'>,
  ctx: OpContext,
): Promise<OnboardState> {
  const now = ctx.now();
  const { text, source_path, file_path } = await keepResume(deps, input, now);

  const prev = store(deps).load();
  const s = prev && prev.step !== 'done' && !prev.scope ? prev : newSession(deps, now, null);
  // The instant preview: copied from the text, never an inferred number. The agent run replaces it.
  const parsed = deps.llm?.parseResume ? await deps.llm.parseResume(text) : parseResumeHeuristic(text, now);
  for (const key of ['story', 'craft'] as const) {
    const fromResume = parsed[key];
    if (!fromResume || !Object.keys(fromResume).length) continue;
    // Resume facts fill gaps; they never overwrite an explicit interview answer.
    const existing = { ...(s.draft[key] ?? {}) };
    // A years figure with no basis was guessed by an older parser: never keep it.
    if (key === 'story' && existing.years !== undefined && !existing.years_basis) delete existing.years;
    s.draft[key] = s.sources[key]?.includes('interview') ? { ...fromResume, ...existing } : { ...existing, ...fromResume };
    addSource(s, key, 'resume');
  }
  s.draft.story ??= {};
  const story = s.draft.story;
  delete story.source_path;
  delete story.source_file;
  if (source_path) story.source_path = source_path;
  if (file_path) story.source_file = file_path;
  if (s.step === 'resume') s.step = 'interview';
  advance(s);
  s.updated_at = now.toISOString();
  if (!ctx.dryRun) store(deps).save(s);

  // A person uploaded it: queue the headless onboard run that extracts the facts verbatim (onboard.extract).
  let runId: string | null = null;
  if (ctx.actor === 'human' && !ctx.dryRun && source_path && deps.runOp && !deps.llm?.parseResume) {
    const o = await deps.runOp('runs.start', { skill: 'onboard' }, { ...ctx, decisionId: undefined });
    if (o.status === 'ok') runId = (o.output as { run: { id: string } }).run.id;
  }
  return stateOf(s, runId);
}

/** Story fields an interview question sets (an answer beats an extraction). */
const ANSWER_FIELDS: Record<string, string[]> = {
  'story.headline': ['headline'],
  'story.win': ['wins'],
  'story.years': ['years', 'years_basis'],
};

/** Fields an agent never sets through onboard.extract (provenance and links are code's). */
const EXTRACT_RESERVED = ['source_path', 'source_file', 'dictated', 'extracted_by', 'criterion_weights'];

/**
 * onboard.extract (#38): the facts an agent extracted from the kept resume. Each value must be in the
 * resume text (checkFacts, every claim hard); years only stated or derived from the role dates.
 */
export async function onboardExtract(
  deps: ProfileDeps,
  input: OpInput<'onboard.extract'>,
  ctx: OpContext,
): Promise<OpOutput<'onboard.extract'>> {
  const now = ctx.now();
  const s = store(deps).load();
  const live = s && s.step !== 'done' && !s.scope ? s : null;
  const current = getCurrentVersion(deps.repos);
  const prevStory = current ? (getComponents(deps.repos, current.id).find((c) => c.key === 'story')?.data_json ?? null) : null;
  const sourcePath = (live?.draft.story?.source_path ?? prevStory?.source_path) as string | undefined;
  if (!sourcePath || !deps.vault) throw new OpError('conflict', 'no kept resume: run onboard.ingest_resume first');
  const raw = deps.vault.read(sourcePath);
  if (raw === null) throw new OpError('not_found', `cannot read ${sourcePath}`);
  const text = stripFrontmatter(raw);

  const story: Record<string, unknown> = { ...input.story };
  for (const k of EXTRACT_RESERVED) delete story[k];
  let craft: Record<string, unknown> = {};
  try {
    parseComponentData('story', story);
    if (input.craft) craft = parseComponentData('craft', input.craft);
  } catch (e) {
    throw new OpError('invalid_input', 'story or craft: invalid data', e);
  }

  // Verbatim: every number, date, title, employer and degree must be in the resume.
  const problems: string[] = [];
  const { unsupported } = checkFacts(storySourceText(story), text, { headings: false });
  if (unsupported.length) problems.push(`not in the resume: ${describeClaims(unsupported)}`);
  for (const r of (Array.isArray(story.roles) ? story.roles : []) as Array<Record<string, unknown>>) {
    for (const f of ['company', 'title'] as const)
      if (typeof r[f] === 'string' && !inSource(text, r[f] as string)) problems.push(`role ${f} "${r[f]}" is not in the resume`);
  }
  if (story.years !== undefined) {
    const y = story.years;
    if (story.years_basis === 'stated') {
      if (statedYears(text) !== y) problems.push(`years ${String(y)}: the resume does not state it`);
    } else if (story.years_basis === 'from dates') {
      const d = yearsFromDates((story.roles ?? []) as Array<{ dates?: string }>, now);
      if (d !== y) problems.push(`years ${String(y)}: the role dates give ${d ?? 'nothing'}`);
    } else problems.push('years needs years_basis "stated" or "from dates" (never a guess)');
  } else delete story.years_basis;
  if (problems.length) throw new OpError('invalid_input', `extraction not verbatim: ${problems.join('; ')}`, problems);

  const links = { source_path: sourcePath, ...(live?.draft.story?.source_file ? { source_file: live.draft.story.source_file } : {}) };
  if (live) {
    const existing = live.draft.story ?? {};
    const keep: Record<string, unknown> = {};
    for (const q of live.answered) for (const f of ANSWER_FIELDS[q] ?? []) if (f in existing) keep[f] = existing[f];
    if (existing.dictated) keep.dictated = existing.dictated;
    const next: Record<string, unknown> = { ...story, extracted_by: 'agent', ...keep, ...links };
    if (
      !live.answered.includes('story.years') &&
      next.years_basis === 'from dates' &&
      live.step !== 'interview' &&
      live.step !== 'resume'
    ) {
      // Past the interview nobody can confirm it: leave it out.
      delete next.years;
      delete next.years_basis;
    }
    live.draft.story = next;
    live.draft.craft = { ...craft, ...(live.draft.craft ?? {}) };
    addSource(live, 'story', 'resume');
    if (Object.keys(craft).length) addSource(live, 'craft', 'resume');
    if (live.step === 'resume') live.step = 'interview';
    advance(live);
    live.updated_at = now.toISOString();
    if (!ctx.dryRun) store(deps).save(live);
    return { target: 'session', state: stateOf(live) };
  }

  // Onboarding is done: the extraction is a Story diff for the user to accept.
  if (!prevStory) throw new OpError('conflict', 'no onboarding in progress and no profile: start with onboard.ingest_resume');
  const after: Record<string, unknown> = { ...story, extracted_by: 'agent' };
  if (after.years_basis === 'from dates') {
    delete after.years;
    delete after.years_basis;
  }
  const keys = Object.keys(after).filter((k) => !deepEqual(prevStory[k], after[k]));
  if (!keys.length) return { target: 'diff' };
  const diffInput = {
    component: 'story' as const,
    before: Object.fromEntries(keys.filter((k) => k in prevStory).map((k) => [k, prevStory[k]])),
    after: Object.fromEntries(keys.map((k) => [k, after[k]])),
    evidence: [`extracted verbatim from ${sourcePath}`],
  };
  if (deps.runOp) {
    const o = await deps.runOp('profile.propose_diff', diffInput, ctx);
    if (o.status !== 'ok')
      throw new OpError(o.status === 'error' ? o.code : 'internal', `propose story: ${o.status === 'error' ? o.message : o.status}`);
    return { target: 'diff', diff_id: (o.output as { diff: ProfileDiff }).diff.id };
  }
  return { target: 'diff', diff_id: profileProposeDiff(deps, diffInput, ctx).output.diff.id };
}

/** Start a re-interview of one or more components (seeded from the current profile). */
export function startComponentInterview(deps: ProfileDeps, components: ProfileComponentKey[], ctx: OpContext): OnboardState {
  if (!getCurrentVersion(deps.repos)) throw new OpError('not_found', 'no profile yet: run full onboarding');
  const s = newSession(deps, ctx.now(), components);
  s.step = 'interview';
  advance(s);
  if (!ctx.dryRun) store(deps).save(s);
  return stateOf(s);
}

export function onboardAnswer(deps: ProfileDeps, input: OpInput<'onboard.answer'>, ctx: OpContext): OnboardState {
  const s = activeSession(deps);
  if (s.step !== 'interview') throw new OpError('conflict', `onboarding is at '${s.step}', not 'interview'`);
  const q = findQuestion(input.question_id);
  if (!q) throw new OpError('not_found', `unknown question ${input.question_id}`);
  if (s.scope && !s.scope.includes(q.component)) throw new OpError('invalid_input', `${q.id} is outside this re-interview`);
  let value = input.value as AnswerValue;
  // A dictated free-text answer is kept clean (fillers out, meaning kept); the raw text is provenance.
  const dictation = q.answer_type === 'text' && !q.max_items && typeof value === 'string';
  const raw = dictation ? (input.raw ?? (value as string)) : null;
  if (dictation) value = cleanDictation(value as string);
  try {
    checkAnswer(q, value, s.draft);
    q.apply(s.draft, value);
  } catch (e) {
    throw new OpError('invalid_input', e instanceof Error ? e.message : String(e));
  }
  if (raw !== null && raw.trim() !== value) {
    s.draft[q.component] ??= {};
    const c = s.draft[q.component] as Record<string, unknown>;
    c.dictated = { ...((c.dictated as Record<string, string> | undefined) ?? {}), [q.id]: raw.trim() };
  }
  if (!s.answered.includes(q.id)) s.answered.push(q.id);
  addSource(s, q.component, 'interview');
  advance(s);
  s.updated_at = ctx.now().toISOString();
  if (!ctx.dryRun) store(deps).save(s);
  return stateOf(s);
}

function samplesFor(deps: ProfileDeps, s: OnboardSession): CalibrationSample[] {
  const all = deps.calibrationSamples ? deps.calibrationSamples() : samplesFromDb(deps.repos, CALIBRATION_SIZE);
  if (!s.calibration.sample_ids.length) s.calibration.sample_ids = all.slice(0, CALIBRATION_SIZE).map((x) => x.id);
  return all.filter((x) => s.calibration.sample_ids.includes(x.id));
}

function priorFor(deps: ProfileDeps, s: OnboardSession): Record<Criterion, number> {
  const v = getCurrentVersion(deps.repos);
  const base = v ? rubricWeights(getComponents(deps.repos, v.id)) : null;
  return statedPrior(base, s.draft);
}

/** The current calibration sample set (for the UI to render the 12 cards). */
export function calibrationSamples(deps: ProfileDeps): CalibrationSample[] {
  const s = activeSession(deps);
  const out = samplesFor(deps, s);
  store(deps).save(s);
  return out;
}

export function onboardCalibrate(deps: ProfileDeps, input: OpInput<'onboard.calibrate'>, ctx: OpContext): OpOutput<'onboard.calibrate'> {
  const s = activeSession(deps);
  if (s.step === 'resume') throw new OpError('conflict', 'ingest a resume first');
  const samples = samplesFor(deps, s);
  if (!s.calibration.sample_ids.includes(input.sample_id)) throw new OpError('not_found', `${input.sample_id} is not a calibration sample`);
  s.calibration.choices[input.sample_id] = input.choice;
  const { weights } = deriveWeights(priorFor(deps, s), samples, s.calibration.choices);
  const remaining = s.calibration.sample_ids.filter((id) => !s.calibration.choices[id]).length;
  if (remaining === 0 && s.step === 'calibrate') s.step = 'confirm';
  s.updated_at = ctx.now().toISOString();
  if (!ctx.dryRun) store(deps).save(s);
  return { weights, remaining };
}

/** Confidence by how a component was filled. Calibrated weighted components gain 0.1. */
function confidenceFor(s: OnboardSession, key: ProfileComponentKey, prevConfidence: number | undefined, calibrated: boolean): number {
  const src = s.sources[key] ?? [];
  let c = 0.2;
  if (src.includes('profile')) c = prevConfidence ?? 0.5;
  if (src.includes('resume')) c = Math.max(c, 0.7);
  if (src.includes('interview')) c = Math.max(c, 0.8);
  if (calibrated && PROFILE_COMPONENT_KIND[key] === 'weighted') c += 0.1;
  return Math.min(1, Math.round(c * 100) / 100);
}

/**
 * Save the onboarded profile as a new version.
 * Safety: when a profile already exists and the actor is not a human, changed filter
 * components (work_mode, terms, dealbreakers) are NOT written; they become pending
 * high-impact diffs for a human (never auto-apply a filter or dealbreaker change).
 */
export async function onboardConfirm(
  deps: ProfileDeps,
  _input: OpInput<'onboard.confirm'>,
  ctx: OpContext,
): Promise<OpOutput<'onboard.confirm'> & { proposed_diffs: ProfileDiff[] }> {
  const s = activeSession(deps);
  if (s.step === 'resume') throw new OpError('conflict', 'ingest a resume first');
  if (s.step === 'interview' && nextQuestion(s.draft, s.answered, s.scope)) throw new OpError('conflict', 'interview not finished');
  const now = ctx.now();
  const current = getCurrentVersion(deps.repos);
  const prevComps = current ? getComponents(deps.repos, current.id) : [];

  const calibrated = Object.keys(s.calibration.choices).length > 0;
  const samples = calibrated ? samplesFor(deps, s) : [];
  const weights = calibrated ? deriveWeights(priorFor(deps, s), samples, s.calibration.choices).weights : priorFor(deps, s);
  const byComp = weightsByComponent(weights);

  const drafts: Partial<Record<ProfileComponentKey, ComponentDraft>> = {};
  const held: Array<{ key: ProfileComponentKey; before: Record<string, unknown>; after: Record<string, unknown> }> = [];
  for (const key of PROFILE_COMPONENT_KEYS) {
    if (s.scope && !s.scope.includes(key) && !(calibrated && PROFILE_COMPONENT_KIND[key] === 'weighted')) continue;
    const prev = prevComps.find((c) => c.key === key);
    const data: Record<string, unknown> = { ...(s.draft[key] ?? {}) };
    // Years are never stored unconfirmed or guessed (#38).
    if (key === 'story' && data.years !== undefined && data.years_basis !== 'stated' && data.years_basis !== 'confirmed') {
      delete data.years;
      delete data.years_basis;
    }
    const own = byComp[key];
    if (Object.keys(own.criterion_weights).length) data.criterion_weights = own.criterion_weights;
    let parsed: Record<string, unknown>;
    try {
      parsed = parseComponentData(key, data);
    } catch (e) {
      throw new OpError('invalid_input', `${key}: invalid data`, e);
    }
    if (current && ctx.actor !== 'human' && PROFILE_COMPONENT_KIND[key] === 'filter' && prev && !deepEqual(prev.data_json, parsed)) {
      const keys = [...new Set([...Object.keys(prev.data_json), ...Object.keys(parsed)])].filter(
        (k) => !deepEqual(prev.data_json[k], parsed[k]),
      );
      held.push({
        key,
        before: Object.fromEntries(keys.filter((k) => k in prev.data_json).map((k) => [k, prev.data_json[k]])),
        after: Object.fromEntries(keys.filter((k) => k in parsed).map((k) => [k, parsed[k]])),
      });
      continue;
    }
    drafts[key] = {
      key,
      confidence: confidenceFor(s, key, prev?.confidence, calibrated),
      weight: own.weight,
      data_json: parsed,
      md_path: deps.vault && MD_COMPONENTS.includes(key) ? componentMdPath(key) : (prev?.md_path ?? null),
    };
  }
  if (ctx.dryRun) {
    return {
      version: { id: 'dry_run', created_at: now.toISOString(), parent_id: current?.id ?? null, reason: 'onboard', event_id: null },
      proposed_diffs: [],
    };
  }
  const reason = s.scope ? `onboard: re-interview ${s.scope.join(', ')}` : current ? 'onboard: redo' : 'onboard';
  const { version, components } = insertVersion(deps.repos, { now, parent_id: current?.id ?? null, reason, event_id: null, drafts });

  if (deps.vault) {
    for (const c of components) {
      if (c.md_path && MD_COMPONENTS.includes(c.key) && drafts[c.key])
        deps.vault.write(c.md_path, renderComponentMd(c.key, c.id, c.data_json));
    }
  }
  const proposed: ProfileDiff[] = [];
  for (const h of held) {
    const input = { component: h.key, before: h.before, after: h.after, evidence: [`onboarding ${s.id} answers (agent-run)`] };
    if (deps.runOp) {
      // Every write is an op: the held filter change is proposed through profile.propose_diff.
      const o = await deps.runOp('profile.propose_diff', input, ctx);
      if (o.status !== 'ok')
        throw new OpError(o.status === 'error' ? o.code : 'internal', `propose ${h.key}: ${o.status === 'error' ? o.message : o.status}`);
      proposed.push((o.output as { diff: ProfileDiff }).diff);
    } else proposed.push(profileProposeDiff(deps, input, ctx).output.diff);
  }
  s.step = 'done';
  s.version_id = version.id;
  s.updated_at = now.toISOString();
  store(deps).save(s);
  return { version, proposed_diffs: proposed };
}

// ------------------------------------------------------------ start / state / samples

/** onboard.start: a full onboarding (step resume), or a re-interview of some components. */
export function onboardStart(deps: ProfileDeps, input: OpInput<'onboard.start'>, ctx: OpContext): OnboardState {
  if (input.components?.length) return startComponentInterview(deps, input.components, ctx);
  const s = newSession(deps, ctx.now(), null);
  if (!ctx.dryRun) store(deps).save(s);
  return stateOf(s);
}

/** onboard.state: the live session, or the start state when there is none. */
export function onboardState(deps: ProfileDeps): OnboardState {
  const s = store(deps).load();
  if (s) return stateOf(s);
  return { step: 'resume', components_filled: [], next_question: null };
}

const money = (n: number) => `$${Math.round(n / 1000)}k`;
function compLabel(min: number | null | undefined, max: number | null | undefined): string {
  if (min && max) return `${money(min)} to ${money(max)}`;
  if (min) return `${money(min)}+`;
  if (max) return `up to ${money(max)}`;
  return 'Not listed';
}

/** onboard.samples (read-only): the calibration cards and the baseline weights the bars start from. */
export function onboardSamples(deps: ProfileDeps): OpOutput<'onboard.samples'> {
  const s = store(deps).load();
  const all = deps.calibrationSamples ? deps.calibrationSamples() : samplesFromDb(deps.repos, CALIBRATION_SIZE);
  const live =
    s && s.step !== 'done' && s.calibration.sample_ids.length ? all.filter((x) => s.calibration.sample_ids.includes(x.id)) : null;
  const samples = live?.length ? live : all.slice(0, CALIBRATION_SIZE);
  const v = getCurrentVersion(deps.repos);
  const weights = statedPrior(v ? rubricWeights(getComponents(deps.repos, v.id)) : null, s && s.step !== 'done' ? s.draft : {});
  return {
    items: samples.map((x) => ({
      id: x.id,
      company: x.company ?? '',
      letter: (x.company ?? x.title).trim().charAt(0).toUpperCase() || '?',
      title: x.title,
      comp: compLabel(x.comp_min, x.comp_max),
      mode: x.workplace ?? 'unspecified',
      criteria: x.criteria,
    })),
    weights,
  };
}
