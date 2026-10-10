import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isSubmitLike, type RenderDoc, type RenderFormat, renderedKey, VaultPath, vaultPath } from '@perfect-placement/contracts';
import type Database from 'better-sqlite3';
import { RENDER_MIME, renderDocx, renderPdf } from '../documents.js';
import { OpError } from '../errors.js';
import { select } from '../rows.js';
import { defineHandler } from '../runtime.js';
import { stripFrontmatter } from '../vault.js';
import { applicationFor, getRole, laterStage, upsertApplication } from './shared.js';

/*
 * #106: downloads and the fill assist.
 * apply.render_documents renders the tailored resume and cover letter to PDF and DOCX under files/<role_id>/ and
 * records them on the application; apply.fill_done records what a fill assist did in the portal (stopped before
 * Submit), so the Role screen's primary becomes Open portal. `downloadableFile` is the read-only download route's
 * guard: only rendered files an application references are served.
 */

const DOC_LABEL: Record<RenderDoc, string> = { resume: 'Resume', cover_letter: 'Cover letter' };

export const applyRenderDocuments = defineHandler('apply.render_documents', {
  async run(input, h) {
    const role = getRole(h.db, input.role_id);
    const app = applicationFor(h.db, role.id);
    const paths = { ...(app?.package_paths_json ?? {}) } as Record<string, string>;
    const formats = [...new Set(input.formats)] as RenderFormat[];
    const docs = [...new Set(input.docs)] as RenderDoc[];
    const missing = docs.filter((d) => !paths[d] || h.vault.read(paths[d] as string) === null);
    if (!app || missing.length)
      throw new OpError(
        'conflict',
        `${role.id}: no tailored ${missing.map((d) => DOC_LABEL[d].toLowerCase()).join(' or ')} yet (Tailor first)`,
      );
    const files = [];
    for (const doc of docs) {
      const md = stripFrontmatter(h.vault.read(paths[doc] as string) ?? '');
      const title = `${DOC_LABEL[doc]} ${role.title}`;
      for (const format of formats) {
        const bytes = format === 'pdf' ? await renderPdf(md, { title }) : await renderDocx(md, { title });
        const path = vaultPath.rendered(role.id, doc, format);
        h.vault.writeBytes(path, bytes);
        paths[renderedKey(doc, format)] = path;
        files.push({ doc, format, path, abs_path: h.vault.abs(path), bytes: bytes.length });
      }
    }
    const application = upsertApplication(h, role.id, { package_paths_json: paths });
    if (h.ctx.runId)
      h.runLog({
        title: 'apply.render_documents',
        summary: { role_id: role.id, files: files.map((f) => f.path) },
        lines: files.map((f) => `- ${f.path} (${f.bytes} bytes)`),
      });
    return { application, files };
  },
});

export const applyFillDone = defineHandler('apply.fill_done', {
  run(input, h) {
    const role = getRole(h.db, input.role_id);
    if (role.status !== 'draft-ready')
      throw new OpError('conflict', `${role.id}: a fill assist is for a draft-ready role (is ${role.status})`);
    const app = applicationFor(h.db, role.id);
    if (!app) throw new OpError('conflict', `${role.id}: no application yet (Tailor first)`);
    // The human submits: a report that it filled a submit / apply / send control is refused outright.
    const submit = input.filled.filter(isSubmitLike);
    if (submit.length)
      throw new OpError(
        'invalid_input',
        `never act on a submit control: ${submit.join(', ')}. Leave it for the user; they submit.`,
        submit.map((label) => ({ label, reason: 'submit-like control' })),
      );
    const paths = app.package_paths_json as Record<string, string>;
    const notRendered = input.uploaded.filter((d) => !paths[renderedKey(d, 'pdf')]);
    if (notRendered.length)
      throw new OpError(
        'invalid_input',
        `uploaded ${notRendered.join(', ')} without a rendered PDF: call apply.render_documents first and upload its abs_path`,
      );
    const fill_assist_json = {
      at: h.nowIso(),
      run_id: h.ctx.runId ?? null,
      filled: [...new Set(input.filled)],
      uploaded: [...new Set(input.uploaded)],
      skipped: input.skipped,
    };
    const application = upsertApplication(h, role.id, { fill_assist_json, stage: laterStage(app.stage, 'submit') });
    if (h.ctx.runId)
      h.runLog({
        title: 'apply.fill_done',
        summary: {
          role_id: role.id,
          filled: fill_assist_json.filled.length,
          uploaded: fill_assist_json.uploaded,
          skipped: input.skipped.length,
        },
        lines: [
          `${role.id}: ${fill_assist_json.filled.length} filled, uploaded ${fill_assist_json.uploaded.join(', ') || 'nothing'}, stopped before Submit`,
          ...input.skipped.map((s) => `- left for you: ${s.label} (${s.reason})`),
        ],
      });
    return { application };
  },
});

/**
 * The download route's guard (`GET /api/files?path=`): a vault-relative `files/...` PDF or DOCX that an
 * application's package references and that exists. Anything else is null (the route answers 404).
 */
export function downloadableFile(
  db: Database.Database,
  home: string,
  rel: string,
): { abs: string; name: string; contentType: string; bytes: number } | null {
  if (!VaultPath.safeParse(rel).success || isAbsolute(rel) || rel.includes('\\') || !rel.startsWith('files/')) return null;
  const ext = /\.(pdf|docx)$/.exec(rel)?.[1] as RenderFormat | undefined;
  if (!ext) return null;
  const referenced = select(db, 'application').some((a) => Object.values(a.package_paths_json).includes(rel));
  if (!referenced) return null;
  const abs = join(home, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  const name = rel.split('/').slice(1).join('_');
  return { abs, name, contentType: RENDER_MIME[ext], bytes: statSync(abs).size };
}
