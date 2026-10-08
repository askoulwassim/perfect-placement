import {
  EventRow,
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
import { applyApproved, profileProposeDiff, profileRejectDiff, routeDiff } from './profile-ops.js';
import { getComponents, getCurrentVersion } from './store.js';

/*
 * Learn loop (blueprint.md):
 *   event -> resolver Noulli x 11 "does this change <component>?" (profile.learn, low)
 *         -> for each yes: LLM drafts a diff with evidence -> profile.propose_diff (pending)
 *         -> policy via resolver (profile.apply_diff, impact by component kind):
 *              filters + dealbreakers: high -> always human (never auto-applied)
 *              weighted: medium -> auto + 24h undo when confident, else human
 *              assets: low -> auto (or auto after second backend), else human
 *         -> applied diffs create profile v+1 and return roles to rescore.
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
  const row = deps.db.prepare('SELECT * FROM event WHERE id = ?').get(eventId) as Record<string, unknown> | undefined;
  if (!row) throw new OpError('not_found', `event ${eventId} not found`);
  return EventRow.parse({ ...row, payload_json: JSON.parse(String(row.payload_json ?? '{}')) });
}

function truncate(s: string, n = 600): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

export async function learnFromEvent(deps: ProfileDeps, eventId: string, ctx: OpContext): Promise<LearnResult> {
  if (!deps.ask) throw new OpError('backend_unavailable', 'resolver not configured');
  if (!deps.llm) throw new OpError('backend_unavailable', 'LLM not configured');
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

  const version = getCurrentVersion(deps.db);
  if (!version) throw new OpError('not_found', 'no profile yet');
  const comps = getComponents(deps.db, version.id);

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

  const childCtx: OpContext = { ...ctx };
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

    const cur = getComponents(deps.db, getCurrentVersion(deps.db)?.id ?? version.id).find((c) => c.key === key);
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

    const { output } = profileProposeDiff(deps, { component: key, before, after: draft.after, evidence, event_id: event.id }, childCtx);
    const diff = output.diff;
    result.proposed.push(diff);

    const impact = impactForComponent(key);
    const routed = await routeDiff(deps, diff, childCtx);
    if (impact !== 'high' && routed.outcome !== 'human' && routed.value === true) {
      const applied = await applyApproved(
        deps,
        { ...diff, decision_id: routed.decisionId },
        { ...childCtx, decisionId: routed.decisionId },
      );
      result.applied.push({
        diff_id: diff.id,
        version_id: applied.output.version.id,
        impact,
        rescored_role_ids: applied.output.rescored_role_ids,
      });
    } else if (impact !== 'high' && routed.outcome !== 'human' && routed.value === false) {
      profileRejectDiff(deps, { diff_id: diff.id, reason: 'resolver: confident no' }, { ...childCtx, decisionId: routed.decisionId });
      result.rejected.push(diff.id);
    } else {
      result.queued.push({ diff_id: diff.id, decision_id: routed.decisionId, impact });
    }
  }
  return result;
}
