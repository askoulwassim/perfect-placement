import {
  type EventRow,
  type Impact,
  LEARNING_EVENTS,
  type OpContext,
  PROFILE_COMPONENT_KEYS,
  PROFILE_COMPONENT_KIND,
  type ProfileComponentKey,
  type ProfileDiff,
} from '@perfect-placement/contracts';
import { impactForComponent } from './components.js';
import type { ProfileDeps } from './deps.js';
import { OpError } from './errors.js';
import { deepEqual } from './json.js';
import { routeDiff } from './profile-ops.js';
import { getComponents, getCurrentVersion } from './versions.js';

/*
 * Learn loop (docs/architecture.md), every write an op (nested in `profile.learn`):
 *   event -> resolver Noulli x 11 "does this change <component>?" (profile.learn, low)
 *         -> for each yes: the writing model drafts a diff with evidence -> op profile.propose_diff
 *            (no writing model in the engine: the learn skill drafts and calls profile.propose_diff)
 *         -> policy via resolver (profile.apply_diff, impact by component kind, #14 / #24):
 *              Dealbreakers, a comp floor change: hard exclusion, always a human
 *              other filters: high -> auto + undo only when confident, else human
 *              weighted + assets: medium -> auto + 24h undo when confident (config), else human
 *         -> op profile.apply_diff (v+1, rescore of affected roles) or op profile.reject_diff.
 * The model supplies judgment (yes/no + drafted diff); this file is mechanics only.
 */

export interface LearnResult {
  event_id: string;
  asked: ProfileComponentKey[];
  /** Components the resolver said change (and was allowed to act on). */
  changed: ProfileComponentKey[];
  /** Noulli answers routed to a human by policy (decision ids). */
  learn_questions_for_human: string[];
  proposed: ProfileDiff[];
  applied: Array<{ diff_id: string; version_id: string; impact: Impact; rescored_role_ids: string[] }>;
  queued: Array<{ diff_id: string; decision_id: string; impact: Impact }>;
  rejected: string[];
}

const LABEL: Record<ProfileComponentKey, string> = {
  story: 'Story (resume facts, wins, metrics)',
  craft: 'Craft (function and level)',
  domain: 'Domain (problem spaces, ranked)',
  work_mode: 'Work mode (remote, hybrid, onsite, locations)',
  terms: 'Terms (comp floor and target, equity)',
  company: 'Company (stage, size, mission, affinity)',
  team: 'Team (proximity to decisions, leaders)',
  growth: 'Growth (scope ceiling, trajectory)',
  dealbreakers: 'Dealbreakers (hard nos)',
  voice: 'Voice (writing style, positioning, standard answers)',
  network: 'Network (warm people and companies)',
};

function loadEvent(deps: ProfileDeps, eventId: string): EventRow {
  const row = deps.repos.event.get(eventId);
  if (!row) throw new OpError('not_found', `event ${eventId} not found`);
  return row;
}

/** Unwrap a nested op's outcome; `requires_human` and errors surface as OpError / null. */
function okOrNull<T>(o: Awaited<ReturnType<NonNullable<ProfileDeps['runOp']>>>): T | null {
  if (o.status === 'ok') return o.output as T;
  if (o.status === 'requires_human') return null;
  throw new OpError(o.code, o.message, o.issues);
}

function truncate(s: string, n = 600): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

export async function learnFromEvent(deps: ProfileDeps, eventId: string, ctx: OpContext): Promise<LearnResult> {
  if (!deps.ask) throw new OpError('backend_unavailable', 'resolver not configured');
  const runOp = deps.runOp;
  if (!runOp) throw new OpError('internal', 'the learn loop runs inside runOp');
  const event = loadEvent(deps, eventId);
  const result: LearnResult = {
    event_id: event.id,
    asked: [],
    changed: [],
    learn_questions_for_human: [],
    proposed: [],
    applied: [],
    queued: [],
    rejected: [],
  };
  if (!(LEARNING_EVENTS as readonly string[]).includes(event.type)) return result;

  const version = getCurrentVersion(deps.repos);
  if (!version) throw new OpError('not_found', 'no profile yet');
  const comps = getComponents(deps.repos, version.id);

  const state: Record<string, string> = {
    event: `${event.type} on ${event.subject_type} ${event.subject_id}`,
    payload: truncate(JSON.stringify(event.payload_json)),
  };
  for (const c of comps) state[`profile.${c.key}`] = truncate(JSON.stringify(c.data_json), 300);

  result.asked = [...PROFILE_COMPONENT_KEYS];
  const ask = await deps.ask({
    decision: 'profile.learn',
    impact: 'low',
    state,
    questions: PROFILE_COMPONENT_KEYS.map((k) => ({
      id: k,
      type: 'noulli' as const,
      instructions: `Does this ${event.type.replace('_', ' ')} event mean the ${LABEL[k]} component should change?`,
    })),
    subject: { type: 'profile', id: version.id },
  });

  for (let i = 0; i < ask.answers.length; i++) {
    const a = ask.answers[i];
    const outcome = ask.outcomes[i];
    const key = a?.id as ProfileComponentKey;
    if (!a || !PROFILE_COMPONENT_KEYS.includes(key) || a.value !== true) continue;
    if (outcome === 'human') {
      const d = ask.decisionIds[i];
      if (d) result.learn_questions_for_human.push(d);
      continue;
    }
    result.changed.push(key);

    // No writing model in the engine: the learn skill (agent session) drafts and calls profile.propose_diff.
    if (!deps.llm) continue;
    const cur = getComponents(deps.repos, getCurrentVersion(deps.repos)?.id ?? version.id).find((c) => c.key === key);
    if (!cur) continue;
    const draft = await deps.llm.draftDiff({
      component: key,
      data: cur.data_json,
      event: {
        id: event.id,
        type: event.type,
        subject_type: event.subject_type,
        subject_id: event.subject_id,
        payload: event.payload_json,
      },
      context: `kind=${PROFILE_COMPONENT_KIND[key]}`,
    });
    if (!draft || !Object.keys(draft.after).length) continue;
    // `before` is mechanics: always the current values, never the model's recollection.
    const keys = [...new Set([...Object.keys(draft.before), ...Object.keys(draft.after)])];
    const before = Object.fromEntries(keys.filter((k) => k in cur.data_json).map((k) => [k, cur.data_json[k]]));
    if (deepEqual(before, draft.after)) continue;
    const evidence = draft.evidence.length ? draft.evidence : [`${event.type} ${event.subject_id}`];

    const proposed = okOrNull<{ diff: ProfileDiff }>(
      await runOp('profile.propose_diff', { component: key, before, after: draft.after, evidence, event_id: event.id }, ctx),
    );
    if (!proposed) continue;
    const diff = proposed.diff;
    result.proposed.push(diff);

    const impact = impactForComponent(key);
    const routed = await routeDiff(deps, diff, ctx);
    if (routed.outcome !== 'human' && routed.value === true) {
      const applied = okOrNull<{ version: { id: string }; rescored_role_ids: string[] }>(
        await runOp('profile.apply_diff', { diff_id: diff.id }, { ...ctx, decisionId: routed.decisionId }),
      );
      if (applied)
        result.applied.push({ diff_id: diff.id, version_id: applied.version.id, impact, rescored_role_ids: applied.rescored_role_ids });
      else result.queued.push({ diff_id: diff.id, decision_id: routed.decisionId, impact });
    } else if (routed.outcome !== 'human' && routed.value === false) {
      okOrNull(
        await runOp(
          'profile.reject_diff',
          { diff_id: diff.id, reason: 'resolver: confident no' },
          { ...ctx, decisionId: routed.decisionId },
        ),
      );
      result.rejected.push(diff.id);
    } else {
      result.queued.push({ diff_id: diff.id, decision_id: routed.decisionId, impact });
    }
  }
  return result;
}
