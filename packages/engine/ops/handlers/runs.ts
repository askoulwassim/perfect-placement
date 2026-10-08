import { vaultPath } from '@perfect-placement/contracts';
import { get, insert, select, update } from '../_shim/repo.js';
import { notFound, OpError } from '../errors.js';
import { newId } from '../ids.js';
import { defineHandler } from '../runtime.js';
import { renderMarkdown, stripFrontmatter } from '../vault.js';
import { getRole } from './shared.js';

export const runsStart = defineHandler('runs.start', {
  run(input, h) {
    if (input.role_id) getRole(h.db, input.role_id);
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
      summary_json: { skill: input.skill, ...(input.role_id ? { role_id: input.role_id } : {}), actor: h.ctx.actor },
      log_path,
    };
    insert(h.db, 'run', run);
    h.vault.write(
      log_path,
      renderMarkdown(
        { id, type: 'run' },
        `# ${date} ${input.skill}${input.role_id ? ` (${input.role_id})` : ''}\n\nStarted ${iso} by ${h.ctx.actor}.`,
      ),
    );
    h.emit('run_started', 'run', id, { skill: input.skill, role_id: input.role_id ?? null });
    return { run };
  },
});

export const runsFinish = defineHandler('runs.finish', {
  run(input, h) {
    const run = get(h.db, 'run', input.run_id);
    if (!run) throw notFound('run', input.run_id);
    if (run.status !== 'running') throw new OpError('conflict', `run ${run.id} is already ${run.status}`);
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
