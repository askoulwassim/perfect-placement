/*
 * FAKE runOp, FOR TESTS AND LOCAL DEMOS ONLY (`pp-mcp --fixtures`).
 *
 * Lane B's real `runOp` (packages/engine/ops) is not merged in Wave 1. This in-memory
 * stand-in serves the synthetic fixtures so the MCP layer can be exercised end to end.
 * It covers only what the MCP tests need; every other op returns `unimplemented`.
 * Wave 2 replaces it with lane B's runOp. Never wire it into `pp up`.
 */
import {
  CRITERIA,
  type Criterion,
  type Decision,
  OPS,
  type OpContext,
  type OpDef,
  type OpOutcome,
  type Role,
  type RunOp,
  type Score,
  type ScoreDecision,
} from '@perfect-placement/contracts';
import * as fx from '@perfect-placement/fixtures';

const PROTECTED = new Set(['draft-ready', 'applied', 'interviews', 'offers']);

export interface FakeState {
  roles: Role[];
  scores: Score[];
  decisions: Decision[];
  /** Every call, for assertions. */
  calls: Array<{ op: string; input: unknown; ctx: OpContext }>;
}

export interface FakeRunOp {
  runOp: RunOp;
  state: FakeState;
}

export function createFakeRunOp(): FakeRunOp {
  const state: FakeState = {
    roles: structuredClone(fx.roles),
    scores: structuredClone(fx.scores),
    decisions: structuredClone(fx.decisions),
    calls: [],
  };
  const companies = new Map(fx.companies.map((c) => [c.id, c]));
  let seq = 0;

  const ok = (output: unknown, eventIds: string[] = []): OpOutcome<unknown> => ({ status: 'ok', output, eventIds });
  const err = (code: 'not_found' | 'invalid_input' | 'unimplemented', message: string, issues?: unknown): OpOutcome<unknown> => ({
    status: 'error',
    code,
    message,
    ...(issues === undefined ? {} : { issues }),
  });
  const latestScore = (roleId: string): Score | null => state.scores.filter((s) => s.role_id === roleId).at(-1) ?? null;
  const summary = (role: Role) => ({ role, company: companies.get(role.company_id), latest_score: latestScore(role.id) });

  const queue = (name: string, def: OpDef, input: unknown, ctx: OpContext): OpOutcome<unknown> => {
    const id = `dc_fake_${String(++seq).padStart(4, '0')}`;
    const subject = (input as { role_id?: string }).role_id;
    state.decisions.push({
      id,
      ts: ctx.now().toISOString(),
      kind: name === 'apply.mark_submitted' ? 'apply.submit' : name === 'profile.apply_diff' ? 'profile.apply_diff' : 'other',
      subject_type: subject ? 'role' : 'system',
      subject_id: subject ?? name,
      question_json: { id: 'approve', type: 'noulli', instructions: `Run ${name}?` },
      backend: 'rule',
      answer_json: { id: 'approve', value: true, p: 0.5 },
      p: 0.5,
      impact: def.impact,
      policy_outcome: 'human',
      status: 'pending',
      human_choice: null,
      overridden: false,
      undo_until: null,
      resolved_at: null,
      latency_ms: 0,
      action_json: { op: name, input },
    });
    return { status: 'requires_human', decisionId: id };
  };

  const runOp: RunOp = async (name, rawInput, ctx) => {
    state.calls.push({ op: name, input: rawInput, ctx });
    const def = (OPS as Record<string, OpDef>)[name];
    if (!def) return err('not_found', `unknown op ${name}`);
    const parsed = def.input.safeParse(rawInput);
    if (!parsed.success) return err('invalid_input', 'input failed validation', parsed.error.issues);
    const input = parsed.data as Record<string, unknown>;

    // Policy stand-in: human-only and high-impact ops from a non-human actor are queued.
    if ((def.humanOnly || def.impact === 'high') && ctx.actor !== 'human') return queue(name, def, input, ctx);
    if (def.unimplemented) return err('unimplemented', `${name} is not implemented in v2`);

    switch (name) {
      case 'profile.get':
        return ok({
          version: fx.profileVersions.at(-1),
          components: fx.profileComponents.filter((c) => c.version_id === fx.profileVersions.at(-1)?.id),
          pending_diffs: fx.profileDiffs.filter((d) => d.status === 'pending'),
        });
      case 'roles.list': {
        const { status, company_id, limit } = input as { status?: string[]; company_id?: string; limit: number };
        const items = state.roles
          .filter((r) => (!status || status.includes(r.status)) && (!company_id || r.company_id === company_id))
          .slice(0, limit)
          .map(summary);
        return ok({ items, next_cursor: null });
      }
      case 'roles.get': {
        const role = state.roles.find((r) => r.id === input.role_id);
        if (!role) return err('not_found', `role ${String(input.role_id)} not found`);
        const contacts = fx.contactLinks
          .filter((l) => l.role_id === role.id)
          .map((link) => ({ contact: fx.contacts.find((c) => c.id === link.contact_id), link }));
        return ok({ ...summary(role), application: fx.applications.find((a) => a.role_id === role.id) ?? null, contacts, md_body: null });
      }
      case 'roles.score': {
        const role = state.roles.find((r) => r.id === input.role_id);
        if (!role) return err('not_found', `role ${String(input.role_id)} not found`);
        const criteria = input.criteria as Record<string, number>;
        const cs = CRITERIA.map((k) => criteria[k] ?? 1);
        const crit = Object.fromEntries(CRITERIA.map((k, i) => [k, cs[i] ?? 1])) as Record<Criterion, number>;
        const affinity_mod = companies.get(role.company_id)?.affinity ?? 0;
        // Fixture helpers, not real scoring: lane F owns the scorer.
        const total = fx.fixtureTotal(cs, affinity_mod);
        const band = fx.fixtureBand(total);
        const decision: ScoreDecision = band === 'green' ? 'active' : 'archived';
        const score: Score = {
          id: `sc_fake_${String(++seq).padStart(4, '0')}`,
          role_id: role.id,
          profile_version_id: fx.profileVersions.at(-1)?.id ?? null,
          rubric_json: { ...fx.RUBRIC },
          ...crit,
          affinity_mod,
          total,
          band,
          decision,
          facts_json: input.facts as Record<string, unknown>,
          created_at: ctx.now().toISOString(),
        };
        state.scores.push(score);
        if (!PROTECTED.has(role.status)) {
          role.status = decision;
          role.archive_reason = decision === 'archived' ? 'below_threshold' : null;
        }
        return ok({ score, status: role.status, held: false }, [`ev_fake_${seq}`]);
      }
      case 'decisions.queue': {
        const statuses = (input.status as string[] | undefined) ?? ['pending'];
        return ok({
          pending: state.decisions.filter((d) => statuses.includes(d.status)),
          recent_auto: state.decisions.filter((d) => d.policy_outcome !== 'human' && d.status === 'applied'),
        });
      }
      default:
        return err('unimplemented', `fake runOp does not cover ${name}; lane B's runOp lands in Wave 2`);
    }
  };

  return { runOp, state };
}
