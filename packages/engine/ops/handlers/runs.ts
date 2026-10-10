import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { type RenderDoc, type Run, RunTabs, SCHEDULE_SKILL, SKILLS, type Skill, vaultPath } from '@perfect-placement/contracts';
import { draftRecipient } from '../../people/email.js';
import { gmailRecipient } from '../../people/outreach.js';
import { linkedinReadsOn } from '../../people/queries.js';
import { achievedMix, mixLine } from '../../scoring/source-mix.js';
import { notFound, OpError } from '../errors.js';
import { newId } from '../ids.js';
import { peopleDeps } from '../lanes/people.js';
import { activeDuplicate, isQueueRun, pipelineStarts, queueRuns, sameScope, scopeOf, summaryOf } from '../queue.js';
import { get, insert, select, update } from '../rows.js';
import {
  type AssistUploads,
  buildRunnerSpec,
  createSpawnLauncher,
  DEFAULT_SKILLS_DIR,
  defaultMcpServer,
  deniedTools,
  deniedToolsError,
  gmailDraftPrompt,
  gmailToPrompt,
  type RunnerExit,
  SKILL_TOOLS,
  skillPrompt,
} from '../runner.js';
import { defineHandler, type HandlerContext } from '../runtime.js';
import { renderMarkdown, stripFrontmatter } from '../vault.js';
import { scoutRunAdds } from './roles.js';
import { applicationFor, getRole, PICK_STAGES, type PickStage, pickRole } from './shared.js';

/**
 * runs.start, the single entry point for a skill run (#30). A human or schedule run is written `queued`
 * (unless an active run already has its skill and scope: that run is returned, `deduped`), and after
 * commit the queue is dispatched (`runs.dispatch`), which launches the configured headless runner
 * (`config.runner`) when a slot is free. An agent actor is already the running session: its run is
 * `running` at once and nothing is launched for it, unless it passes `queue: true` (#39, the Ask agent):
 * then the run is a queue run like a human's (`summary_json.actor: "ask"`).
 */
export const runsStart = defineHandler('runs.start', {
  run(raw, h) {
    let input = raw;
    let step: 'gmail_draft' | 'gmail_to' | null = null;
    // Gmail via agent: a `connect` run scoped to one outreach draft (the Gmail draft step). Its role and
    // contact come from the outreach.
    if (raw.outreach_id) {
      if (raw.skill !== 'connect') throw new OpError('invalid_input', 'outreach_id is for skill "connect" (the Gmail draft step)');
      const o = h.repos.outreach.get(raw.outreach_id);
      if (!o) throw notFound('outreach', raw.outreach_id);
      if ((raw.role_id && raw.role_id !== o.role_id) || (raw.contact_id && raw.contact_id !== o.contact_id))
        throw new OpError('invalid_input', `outreach ${o.id} is for role ${o.role_id} and contact ${o.contact_id}`);
      // #99: the To comes first. A guess waiting in Needs you gets no Gmail draft (the confirmation queues
      // this step); an in-Gmail draft with no To gets the To update step once the address is confirmed.
      const deps = peopleDeps(h);
      const recipient = gmailRecipient(deps, o);
      const to = recipient ? draftRecipient(deps, recipient, { except: h.ctx.decisionId }) : null;
      if (o.status === 'drafted') {
        if (to?.decision_id)
          throw new OpError(
            'conflict',
            `${recipient?.name ?? 'the recipient'}'s address is an unconfirmed guess: confirm it in Needs you; the Gmail draft is queued then`,
          );
        step = 'gmail_draft';
      } else if (o.status === 'in_gmail' && o.gmail_draft_id && !o.gmail_to && to?.email) step = 'gmail_to';
      else throw new OpError('conflict', `outreach ${o.id} is ${o.status}; it is already in Gmail`);
      input = { ...raw, role_id: o.role_id, contact_id: o.contact_id };
    }
    if (raw.assist && raw.skill !== 'fill') throw new OpError('invalid_input', 'assist is for skill "fill" (the fill assist)');
    if (raw.assist && !raw.role_id) throw new OpError('invalid_input', 'assist needs role_id');
    if (input.schedule && SCHEDULE_SKILL[input.schedule] !== input.skill)
      throw new OpError('invalid_input', `schedule ${input.schedule} runs ${SCHEDULE_SKILL[input.schedule]}, not ${input.skill}`);
    const outreachId = input.outreach_id;
    const found = input.role_id ? getRole(h.db, input.role_id) : null;
    // #105 On deck = picked: starting Research, Tailor or Connect on an active or held role picks it
    // (-> on-deck, role_picked), whoever starts it. Idempotent; never moves a role at on-deck or later.
    const role = found && PICK_STAGES.includes(input.skill) ? pickRole(h, found, input.skill as PickStage) : found;
    if (input.contact_id && !get(h.db, 'contact', input.contact_id)) throw notFound('contact', input.contact_id);
    const parent = input.triggered_by ? get(h.db, 'run', input.triggered_by) : null;
    if (input.triggered_by && !parent) throw notFound('run', input.triggered_by);
    // Research writes one dossier per company: its scope is the company.
    const companyId = input.skill === 'research' && role ? role.company_id : undefined;
    // An agent is the session doing the work, unless it asks for a queued headless run (#39: Ask delegates).
    const asked = h.ctx.actor === 'agent' && input.queue === true;
    const agent = h.ctx.actor === 'agent' && !asked;

    if (!agent) {
      // A pipeline score run for the whole inbox waits behind a running one (it listed the inbox earlier).
      const queuedOnly = Boolean(parent) && input.skill === 'score' && !input.role_id;
      const dup = activeDuplicate(
        h.db,
        { skill: input.skill, role_id: input.role_id, contact_id: input.contact_id, outreach_id: outreachId, company_id: companyId },
        { queuedOnly },
      );
      if (dup) {
        // #106: Open and fill on a fill run still queued without assist turns the assist on for it.
        if (input.skill === 'fill' && input.assist && dup.status === 'queued' && dup.summary_json.assist !== true) {
          const summary_json = { ...dup.summary_json, assist: true };
          update(h.db, 'run', dup.id, { summary_json });
          return { run: { ...dup, summary_json }, deduped: true };
        }
        return { run: dup, deduped: true };
      }
    }

    const now = h.ctx.now();
    const iso = now.toISOString();
    const id = newId('run', now);
    const date = iso.slice(0, 10);
    const base = input.role_id ? `${input.skill}_${input.role_id}` : input.skill;
    let log_path = vaultPath.runLog(date, base);
    for (let n = 2; h.vault.exists(log_path) || select(h.db, 'run', 'log_path = ?', [log_path]).length; n++)
      log_path = vaultPath.runLog(date, `${base}-${n}`);
    const run = {
      id,
      op: input.skill,
      started_at: iso,
      finished_at: null,
      status: agent ? ('running' as const) : ('queued' as const),
      summary_json: {
        skill: input.skill,
        ...(input.role_id ? { role_id: input.role_id } : {}),
        ...(companyId ? { company_id: companyId } : {}),
        ...(input.contact_id ? { contact_id: input.contact_id } : {}),
        ...(outreachId ? { outreach_id: outreachId, step: step ?? 'gmail_draft' } : {}),
        ...(parent ? { triggered_by: parent.id, triggered_by_skill: parent.op } : {}),
        ...(input.schedule ? { schedule: input.schedule } : {}),
        ...(input.skill === 'fill' && input.assist ? { assist: true } : {}),
        actor: asked ? 'ask' : h.ctx.actor,
        runner: h.config.runner.command,
        ...(agent ? {} : { queued_at: iso }),
      },
      log_path,
    };
    insert(h.db, 'run', run);
    const by = `${asked ? 'agent (Ask)' : h.ctx.actor}${input.schedule ? ` (schedule ${input.schedule})` : ''}${parent ? ` after ${parent.op} run ${parent.id}` : ''}`;
    h.vault.write(
      log_path,
      renderMarkdown(
        { id, type: 'run' },
        `# ${date} ${input.skill}${outreachId ? (step === 'gmail_to' ? ' Gmail To' : ' Gmail draft') : ''}${input.role_id ? ` (${input.role_id})` : ''}\n\n${agent ? 'Started' : 'Queued'} ${iso} by ${by} (runner: ${h.config.runner.command}).`,
      ),
    );
    h.emit('run_started', 'run', id, {
      skill: input.skill,
      role_id: input.role_id ?? null,
      contact_id: input.contact_id ?? null,
      ...(outreachId ? { outreach_id: outreachId } : {}),
      status: run.status,
      ...(parent ? { triggered_by: parent.id } : {}),
    });

    // A UI button or a schedule queues a headless agent run; the dispatcher launches it when a slot is
    // free. An agent calling runs.start is already the session doing the work, so nothing is queued.
    if (!h.ctx.dryRun && !agent) {
      const runOp = h.runOp;
      const now = h.ctx.now;
      h.afterCommit(async () => {
        await runOp('runs.dispatch', {}, { actor: 'schedule', now });
      });
    }
    return { run };
  },
});

/**
 * runs.dispatch: the run queue's dispatcher. Inside one transaction (BEGIN IMMEDIATE, so two processes
 * never claim the same slot) it marks the oldest queued runs `running`, up to `config.runs.max_concurrent`,
 * skipping a run whose scope already has a running run; after commit it launches their runners.
 */
export const runsDispatch = defineHandler('runs.dispatch', {
  run(_input, h) {
    const running = queueRuns(h.db, ['running']);
    const queued = queueRuns(h.db, ['queued']);
    const launched: Run[] = [];
    if (h.ctx.dryRun) return { launched: [], queued: queued.length, running: running.length };
    let free = h.config.runs.max_concurrent - running.length;
    const iso = h.nowIso();
    for (const r of queued) {
      if (free <= 0) break;
      const scope = scopeOf(r);
      if ([...running, ...launched].some((x) => sameScope(scopeOf(x), scope))) continue;
      const patch = {
        status: 'running' as const,
        started_at: iso,
        summary_json: { ...r.summary_json, runner: h.config.runner.command, launched_at: iso },
      };
      update(h.db, 'run', r.id, patch);
      if (r.log_path) h.vault.append(r.log_path, `\nLaunched ${iso} (runner: ${h.config.runner.command}).\n`);
      launched.push({ ...r, ...patch });
      free--;
    }
    for (const r of launched) launchRun(r, h);
    return { launched: launched.map((r) => r.id), queued: queued.length - launched.length, running: running.length + launched.length };
  },
});

/**
 * After commit, launch the headless runner for a run `runs.dispatch` just marked `running`. If the
 * runner cannot start, or exits leaving the run open, the run is finished as `error`.
 */
function launchRun(run: Run, h: HandlerContext): void {
  const s = summaryOf(run);
  const skill = run.op as Skill;
  const id = run.id;
  const outreachId = s.outreach_id;
  const fillTo = Boolean(outreachId) && (run.summary_json as { step?: string }).step === 'gmail_to';
  // #82: a connect run reads LinkedIn via Claude in Chrome only when config.linkedin.mode is `live`.
  const li = h.config.linkedin;
  const linkedin =
    skill === 'connect' && !outreachId
      ? { ...li, budget_left: Math.max(0, li.max_profiles_per_day - linkedinReadsOn(h.repos, h.ctx.now())) }
      : undefined;
  // #81: a fill run answers the questions the user pasted (apply.set_questions) instead of reading the portal.
  const questions = skill === 'fill' && s.role_id ? applicationFor(h.db, s.role_id)?.package_paths_json.questions : undefined;
  // #106: the fill assist (Open and fill) uploads the rendered PDFs and fills answer fields, stops before Submit.
  const assist = skill === 'fill' && (run.summary_json as { assist?: unknown }).assist === true;
  const build = (uploads?: AssistUploads) =>
    buildRunnerSpec({
      runner: h.config.runner,
      skill,
      runId: id,
      home: h.home,
      mcp: defaultMcpServer(h.home),
      ...(outreachId ? (fillTo ? { gmailTo: true } : { gmailDraft: true }) : {}),
      ...(skill === 'connect' || skill === 'voice' ? { linkedin: li.mode === 'live' } : {}),
      ...(assist ? { assist: true } : {}),
      // #123: the session may read the role's rendered-files folder, and only that one.
      ...(uploads && 'dir' in uploads ? { filesDir: uploads.dir } : {}),
      prompt:
        outreachId && s.role_id && s.contact_id
          ? (fillTo ? gmailToPrompt : gmailDraftPrompt)(DEFAULT_SKILLS_DIR, {
              runId: id,
              outreachId,
              roleId: s.role_id,
              contactId: s.contact_id,
            })
          : skillPrompt(DEFAULT_SKILLS_DIR, {
              runId: id,
              skill,
              ...(s.role_id ? { roleId: s.role_id } : {}),
              ...(s.contact_id ? { contactId: s.contact_id } : {}),
              ...(linkedin ? { linkedin } : {}),
              ...(questions ? { questions } : {}),
              ...(assist ? { assist: true, ...(uploads ? { uploads } : {}) } : {}),
              // #76: Learn voice reads LinkedIn posts only when LinkedIn is live, within the page cap.
              ...(skill === 'voice' ? { voice: { linkedin: li.mode === 'live', max_pages: Math.min(li.max_pages_per_run, 5) } } : {}),
            }),
    });
  const launcher = h.services.launcher ?? createSpawnLauncher();
  const runOp = h.runOp;
  const ctx = { actor: 'schedule' as const, now: h.ctx.now };
  const command = h.config.runner.command;
  /** The runner exited and the run is still open: finish it as error, naming denied tools and the fix. */
  const failIfOpen = async (r: RunnerExit) => {
    const got = await runOp('runs.get', { run_id: id }, ctx);
    if (got.status !== 'ok' || (got.output as { run: { status: string } }).run.status !== 'running') return;
    const denied = command === 'claude' ? deniedTools(r.output) : [];
    const error = denied.length
      ? deniedToolsError(skill, denied)
      : `runner ${command} exited (code ${r.code ?? 'none'}) without calling runs.finish`;
    await runOp(
      'runs.finish',
      {
        run_id: id,
        status: 'error',
        summary: { error, ...(denied.length ? { denied_tools: denied } : {}), ...(r.logFile ? { runner_log: r.logFile } : {}) },
        note: `${error}${r.logFile ? `\n\nRunner output: ${r.logFile}` : ''}`,
      },
      ctx,
    );
  };
  h.afterCommit(async () => {
    try {
      // #123: the fill assist renders the PDFs before launch, so the folder exists for --add-dir and the prompt can
      // name absolute paths; a failed render launches anyway, and the run reports both uploads as skipped.
      const spec = build(assist && s.role_id ? await renderForAssist(runOp, ctx, id, s.role_id) : undefined);
      const started = await launcher.launch(spec);
      // Never awaited: the runner outlives this op. If it ends without runs.finish, fail the run loudly.
      started.exit?.then((r) => failIfOpen(r)).catch(() => {});
    } catch (e) {
      await runOp('runs.finish', { run_id: id, status: 'error', note: `runner ${command} did not start: ${(e as Error).message}` }, ctx);
    }
  });
}

/**
 * The fill assist's PDFs (#123): `apply.render_documents { role_id, formats: ["pdf"] }` (logged on the run), then the
 * absolute folder they are in. Any failure (nothing tailored, a render error, no folder) is the reason uploads are skipped.
 */
async function renderForAssist(
  runOp: HandlerContext['runOp'],
  ctx: { actor: 'schedule'; now: () => Date },
  runId: string,
  roleId: string,
): Promise<AssistUploads> {
  try {
    const o = await runOp('apply.render_documents', { role_id: roleId, formats: ['pdf'] }, { ...ctx, runId });
    if (o.status !== 'ok') return { error: o.status === 'error' ? o.message : 'render needs a decision' };
    const files = (o.output as { files: Array<{ doc: RenderDoc; format: string; abs_path: string }> }).files
      .filter((f) => f.format === 'pdf')
      .map((f) => ({ doc: f.doc, abs_path: resolve(f.abs_path) }));
    const dir = files[0] ? dirname(files[0].abs_path) : null;
    if (!dir || !existsSync(dir) || !statSync(dir).isDirectory() || files.some((f) => dirname(f.abs_path) !== dir))
      return { error: 'no rendered files folder' };
    return { dir, files };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Skills whose runs use Claude in Chrome (#107: they report the tabs they used and closed). */
const CHROME_SKILLS: readonly Skill[] = SKILLS.filter((s) => (SKILL_TOOLS[s].chrome?.length ?? 0) > 0);

/**
 * The tabs a Chrome run reported on `runs.finish` (#107), checked: only `connect`, `fill` and `voice` report
 * tabs; `closed` and `left_open` are tabs it used (`opened`), never both; only a fill assist run may leave a
 * tab open, and only its `portal` tab. Undefined when the run reported none.
 */
export function runTabsOf(run: Run, raw: unknown): RunTabs | undefined {
  if (raw === undefined || raw === null) return undefined;
  const p = RunTabs.safeParse(raw);
  if (!p.success) throw new OpError('invalid_input', `tabs: ${p.error.issues[0]?.message ?? 'invalid'}`);
  const t = p.data;
  if (!CHROME_SKILLS.includes(run.op as Skill)) throw new OpError('invalid_input', `tabs: ${run.op} runs use no Chrome tabs`);
  const used = new Set(t.opened);
  const stray = [...t.closed, ...t.left_open].filter((id) => !used.has(id));
  if (stray.length) throw new OpError('invalid_input', `tabs: ${stray.join(', ')} not opened by this run (never close the user's tabs)`);
  if (t.closed.some((id) => t.left_open.includes(id))) throw new OpError('invalid_input', 'tabs: a tab is both closed and left open');
  if (t.left_open.length) {
    const assist = run.op === 'fill' && (run.summary_json as { assist?: unknown }).assist === true;
    if (!assist || t.portal === undefined || t.left_open.length !== 1 || t.left_open[0] !== t.portal)
      throw new OpError('invalid_input', 'tabs: only the fill assist may leave a tab open, and only its portal tab');
  }
  return t;
}

/** The run log's tabs line (#107): "Tabs: opened 12, 13; closed 13; left open 12 (portal)". */
export function tabsLogLine(t: RunTabs): string {
  const ids = (a: number[]) => (a.length ? a.join(', ') : 'none');
  const left = t.left_open.length ? `; left open ${t.left_open.map((id) => (id === t.portal ? `${id} (portal)` : id)).join(', ')}` : '';
  return `Tabs: opened ${ids(t.opened)}; closed ${ids(t.closed)}${left}`;
}

/**
 * runs.finish closes a queued or running run, then applies the pipeline rules (config `pipeline`,
 * #30): the runs they start are queued with `triggered_by` = this run and listed in its
 * `summary_json.triggered`. After commit the queue is dispatched (a slot just freed).
 */
export const runsFinish = defineHandler('runs.finish', {
  async run(input, h) {
    const run = get(h.db, 'run', input.run_id);
    if (!run) throw notFound('run', input.run_id);
    if (run.status !== 'running' && run.status !== 'queued') throw new OpError('conflict', `run ${run.id} is already ${run.status}`);
    const iso = h.nowIso();
    // #67: a scout run's achieved source mix vs its targets, from the roles it added (engine-counted).
    let mix: ReturnType<typeof achievedMix> | null = null;
    let adds: ReturnType<typeof scoutRunAdds> = [];
    if (run.op === 'scout') {
      const linked = scoutRunAdds(h.db, run, true);
      adds = linked.length || isQueueRun(run) ? linked : scoutRunAdds(h.db, run, false);
      mix = achievedMix(adds, h.config.scout);
    }
    const tabs = runTabsOf(run, input.tabs ?? input.summary?.tabs);
    const patch = {
      finished_at: iso,
      status: input.status,
      summary_json: {
        ...run.summary_json,
        ...(input.summary ?? {}),
        ...(mix ? { source_mix: mix } : {}),
        ...(tabs ? { tabs } : {}),
      } as Record<string, unknown>,
    };
    update(h.db, 'run', run.id, patch);
    if (run.log_path)
      h.vault.append(
        run.log_path,
        `\n## Finished\n\n${iso}: ${input.status}${mix ? `\n\n${mixLine(mix)}` : ''}${tabs ? `\n\n${tabsLogLine(tabs)}` : ''}${input.note ? `\n\n${input.note.trim()}` : ''}\n`,
      );
    h.emit('run_finished', 'run', run.id, { status: input.status, skill: run.op });

    const triggered: string[] = [];
    if (!h.ctx.dryRun) {
      const ctx = { actor: 'schedule' as const, now: h.ctx.now };
      if (run.op === 'scout' && input.status === 'ok' && h.config.pipeline.score_after_scout) {
        const precheck = await precheckInbox(h, run, adds);
        if (precheck) {
          patch.summary_json = { ...patch.summary_json, precheck };
          update(h.db, 'run', run.id, { summary_json: patch.summary_json });
          if (run.log_path)
            h.vault.append(
              run.log_path,
              `\nPre-check: ${precheck.checked} checked, ${precheck.closed} closed, ${precheck.unsure} unsure\n`,
            );
        }
      }
      for (const next of pipelineStarts(h.db, h.config, run, input.status)) {
        const o = await h.runOp('runs.start', { ...next, triggered_by: run.id }, ctx);
        if (o.status !== 'ok') continue;
        const out = o.output as { run: Run; deduped?: boolean };
        if (!out.deduped) triggered.push(out.run.id);
      }
      if (triggered.length) {
        patch.summary_json = { ...patch.summary_json, triggered };
        update(h.db, 'run', run.id, { summary_json: patch.summary_json });
        if (run.log_path) h.vault.append(run.log_path, `\nQueued next: ${triggered.join(', ')}\n`);
      }
      const runOp = h.runOp;
      h.afterCommit(async () => {
        await runOp('runs.dispatch', {}, ctx);
      });
    }
    return { run: { ...run, ...patch } };
  },
});

/**
 * Pipeline pre-check (#77): before the automatic score run, the inbox roles this scout run added that intake did
 * not confirm open get the cheap freshness ladder (`roles.check_freshness { precheck }`); closed ones are archived
 * (reason `closed`), so the score run never sees them. Linked to the scout run (its events carry its run id).
 */
async function precheckInbox(
  h: HandlerContext,
  run: Run,
  adds: ReadonlyArray<{ role_id: string }>,
): Promise<{ checked: number; closed: number; unsure: number } | null> {
  const ids = [...new Set(adds.map((a) => a.role_id))].filter((id) => {
    const r = get(h.db, 'role', id);
    return r?.status === 'inbox' && r.freshness !== 'open';
  });
  if (!ids.length) return null;
  const o = await h.runOp('roles.check_freshness', { role_ids: ids, precheck: true }, { actor: 'schedule', now: h.ctx.now, runId: run.id });
  if (o.status !== 'ok') return null;
  const results = (o.output as { results: Array<{ freshness: string }> }).results;
  return {
    checked: results.length,
    closed: results.filter((r) => r.freshness === 'closed').length,
    unsure: results.filter((r) => r.freshness === 'unsure').length,
  };
}

export const runsList = defineHandler('runs.list', {
  run(input, h) {
    const rows = input.op
      ? select(h.db, 'run', 'op = ? ORDER BY started_at DESC, id DESC', [input.op])
      : select(h.db, 'run', '1 ORDER BY started_at DESC, id DESC');
    const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
    if (!Number.isFinite(offset) || offset < 0) throw new OpError('invalid_input', `bad cursor: ${input.cursor}`);
    return {
      items: rows.slice(offset, offset + input.limit),
      next_cursor: offset + input.limit < rows.length ? String(offset + input.limit) : null,
    };
  },
});

export const runsGet = defineHandler('runs.get', {
  run(input, h) {
    const run = get(h.db, 'run', input.run_id);
    if (!run) throw notFound('run', input.run_id);
    const md = run.log_path ? h.vault.read(run.log_path) : null;
    return { run, log_md: md === null ? null : stripFrontmatter(md) };
  },
});
