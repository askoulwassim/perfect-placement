import { vaultPath } from '@perfect-placement/contracts';
import { notFound, OpError } from '../errors.js';
import { newId } from '../ids.js';
import { get, insert, select, update } from '../rows.js';
import {
  buildRunnerSpec,
  createSpawnLauncher,
  DEFAULT_SKILLS_DIR,
  defaultMcpServer,
  deniedTools,
  deniedToolsError,
  gmailDraftPrompt,
  type RunnerExit,
  skillPrompt,
} from '../runner.js';
import { defineHandler } from '../runtime.js';
import { renderMarkdown, stripFrontmatter } from '../vault.js';
import { getRole } from './shared.js';

/**
 * runs.start: write the run row and its log, then (after commit, for a human or schedule actor) launch
 * the configured headless runner (`config.runner`) with the skill prompt and the pp MCP server. If the
 * runner cannot start, the run is finished as `error`. An agent actor is already the running session.
 */
export const runsStart = defineHandler('runs.start', {
  run(raw, h) {
    let input = raw;
    // Gmail via agent: a `connect` run scoped to one outreach draft (the Gmail draft step). Its role and
    // contact come from the outreach.
    if (raw.outreach_id) {
      if (raw.skill !== 'connect') throw new OpError('invalid_input', 'outreach_id is for skill "connect" (the Gmail draft step)');
      const o = get(h.db, 'outreach', raw.outreach_id);
      if (!o) throw notFound('outreach', raw.outreach_id);
      if ((raw.role_id && raw.role_id !== o.role_id) || (raw.contact_id && raw.contact_id !== o.contact_id))
        throw new OpError('invalid_input', `outreach ${o.id} is for role ${o.role_id} and contact ${o.contact_id}`);
      if (o.status !== 'drafted') throw new OpError('conflict', `outreach ${o.id} is ${o.status}; it is already in Gmail`);
      input = { ...raw, role_id: o.role_id, contact_id: o.contact_id };
    }
    const outreachId = input.outreach_id;
    if (input.role_id) getRole(h.db, input.role_id);
    if (input.contact_id && !get(h.db, 'contact', input.contact_id)) throw notFound('contact', input.contact_id);
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
      status: 'running' as const,
      summary_json: {
        skill: input.skill,
        ...(input.role_id ? { role_id: input.role_id } : {}),
        ...(input.contact_id ? { contact_id: input.contact_id } : {}),
        ...(outreachId ? { outreach_id: outreachId, step: 'gmail_draft' } : {}),
        actor: h.ctx.actor,
        runner: h.config.runner.command,
      },
      log_path,
    };
    insert(h.db, 'run', run);
    h.vault.write(
      log_path,
      renderMarkdown(
        { id, type: 'run' },
        `# ${date} ${input.skill}${outreachId ? ' Gmail draft' : ''}${input.role_id ? ` (${input.role_id})` : ''}\n\nStarted ${iso} by ${h.ctx.actor} (runner: ${h.config.runner.command}).`,
      ),
    );
    h.emit('run_started', 'run', id, {
      skill: input.skill,
      role_id: input.role_id ?? null,
      contact_id: input.contact_id ?? null,
      ...(outreachId ? { outreach_id: outreachId } : {}),
    });

    // A UI button or a schedule starts a headless agent run. An agent calling runs.start is already
    // the session doing the work (skills open their own run), so nothing is launched for it.
    if (!h.ctx.dryRun && h.ctx.actor !== 'agent') {
      const spec = buildRunnerSpec({
        runner: h.config.runner,
        skill: input.skill,
        runId: id,
        home: h.home,
        mcp: defaultMcpServer(h.home),
        ...(outreachId ? { gmailDraft: true } : {}),
        prompt:
          outreachId && input.role_id && input.contact_id
            ? gmailDraftPrompt(DEFAULT_SKILLS_DIR, { runId: id, outreachId, roleId: input.role_id, contactId: input.contact_id })
            : skillPrompt(DEFAULT_SKILLS_DIR, {
                runId: id,
                skill: input.skill,
                ...(input.role_id ? { roleId: input.role_id } : {}),
                ...(input.contact_id ? { contactId: input.contact_id } : {}),
              }),
      });
      const launcher = h.services.launcher ?? createSpawnLauncher();
      const runOp = h.runOp;
      const ctx = { actor: 'schedule' as const, now: h.ctx.now };
      const skill = input.skill;
      /** The runner exited and the run is still open: finish it as error, naming denied tools and the fix. */
      const failIfOpen = async (r: RunnerExit) => {
        const got = await runOp('runs.get', { run_id: id }, ctx);
        if (got.status !== 'ok' || (got.output as { run: { status: string } }).run.status !== 'running') return;
        const denied = spec.command === 'claude' ? deniedTools(r.output) : [];
        const error = denied.length
          ? deniedToolsError(skill, denied)
          : `runner ${spec.command} exited (code ${r.code ?? 'none'}) without calling runs.finish`;
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
          const started = await launcher.launch(spec);
          // Never awaited: the runner outlives this op. If it ends without runs.finish, fail the run loudly.
          started.exit?.then((r) => failIfOpen(r)).catch(() => {});
        } catch (e) {
          await runOp(
            'runs.finish',
            { run_id: id, status: 'error', note: `runner ${spec.command} did not start: ${(e as Error).message}` },
            ctx,
          );
        }
      });
    }
    return { run };
  },
});

export const runsFinish = defineHandler('runs.finish', {
  run(input, h) {
    const run = get(h.db, 'run', input.run_id);
    if (!run) throw notFound('run', input.run_id);
    if (run.status !== 'running' && run.status !== 'queued') throw new OpError('conflict', `run ${run.id} is already ${run.status}`);
    const iso = h.nowIso();
    const patch = { finished_at: iso, status: input.status, summary_json: { ...run.summary_json, ...(input.summary ?? {}) } };
    update(h.db, 'run', run.id, patch);
    if (run.log_path)
      h.vault.append(run.log_path, `\n## Finished\n\n${iso}: ${input.status}${input.note ? `\n\n${input.note.trim()}` : ''}\n`);
    h.emit('run_finished', 'run', run.id, { status: input.status, skill: run.op });
    return { run: { ...run, ...patch } };
  },
});

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
