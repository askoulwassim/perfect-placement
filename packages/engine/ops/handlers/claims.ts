import type { Company, Role } from '@perfect-placement/contracts';
import { type FactClaim, nearestSource, storySourceText } from '../../profile/facts.js';
import { getComponents, getCurrentVersion } from '../../profile/versions.js';
import { OpError } from '../errors.js';
import { select, update } from '../rows.js';
import { defineHandler, type HandlerContext } from '../runtime.js';
import { stripFrontmatter } from '../vault.js';
import { resolveSavedLine } from './answers-store.js';
import { applicationFor, getRole } from './shared.js';

/*
 * Fact sources and fact-check decisions shared by apply.tailor and apply.fill (#38, #42, #54).
 * An unsupported claim the user must judge becomes an `apply.fact_check` decision in Needs you
 * (keep / remove / edit); resolving it runs `apply.resolve_claim` on the vault document.
 */

export type FactDoc = 'resume' | 'cover_letter' | 'answers';
export type DocClaim = FactClaim & { doc: FactDoc };

export const DOC_LABEL: Record<FactDoc, string> = { resume: 'resume', cover_letter: 'cover letter', answers: 'answers' };

export const readBody = (h: HandlerContext, path: string | null | undefined): string | null => {
  if (!path) return null;
  const md = h.vault.read(path);
  return md === null ? null : stripFrontmatter(md);
};

/** Fact sources (#38): the kept resume text and the confirmed Story. */
export function factSources(h: HandlerContext): { texts: string[]; resumePath: string | null } {
  const v = getCurrentVersion(h.repos);
  const story = v ? (getComponents(h.repos, v.id).find((c) => c.key === 'story')?.data_json ?? null) : null;
  const resumePath = typeof story?.source_path === 'string' ? story.source_path : null;
  const resume = readBody(h, resumePath);
  return { texts: [resume ?? '', storySourceText(story)].filter((t) => t.trim()), resumePath: resume === null ? null : resumePath };
}

/** CONTEXT for a role: title, company, JD and dossier (titles and employers may come from here). */
export const roleContext = (h: HandlerContext, role: Role, company: Company) =>
  [role.title, company.name, readBody(h, role.md_path), readBody(h, company.md_path)].filter(Boolean).join('\n');

export const FACT_OPTIONS = ['keep', 'remove', 'other'] as const;

/**
 * Queue one `apply.fact_check` decision per claim (medium impact, always the human), after expiring the
 * pending ones for the same role and documents (a re-tailor or re-fill replaces the documents).
 * Returns the claims with their decision ids.
 */
export async function queueFactChecks(
  h: HandlerContext,
  roleId: string,
  docs: readonly FactDoc[],
  claims: readonly DocClaim[],
  sources: readonly string[],
): Promise<Array<{ doc: FactDoc; kind: string; claim: string; line: string; decision_id?: string }>> {
  if (h.ctx.dryRun) return claims.map(({ doc, kind, claim, line }) => ({ doc, kind, claim, line }));
  const now = h.nowIso();
  for (const d of select(
    h.db,
    'decision',
    `kind = 'apply.fact_check' AND status = 'pending' AND subject_type = 'role' AND subject_id = ?`,
    [roleId],
  ))
    if (docs.includes((d.question_json as { doc?: FactDoc }).doc as FactDoc))
      update(h.db, 'decision', d.id, { status: 'expired', resolved_at: now });
  const out: Array<{ doc: FactDoc; kind: string; claim: string; line: string; decision_id?: string }> = [];
  for (const c of claims) {
    const source = nearestSource(c.claim, c.line, sources);
    const { decisionId } = await h.resolver.record(
      {
        decision: 'apply.fact_check',
        impact: 'medium',
        subject: { type: 'role', id: roleId },
        question: {
          id: 'claim',
          type: 'choice',
          instructions: `Keep "${c.claim}" in the ${DOC_LABEL[c.doc]}? It is not in the source resume or confirmed Story.`,
          options: [...FACT_OPTIONS],
          doc: c.doc,
          kind: c.kind,
          claim: c.claim,
          line: c.line,
          source,
        },
        // Truth only: the default pick drops what the sources do not say.
        answer: { id: 'claim', value: 'remove', p: 0.5 },
        backend: 'rule',
        action: { op: 'apply.resolve_claim', input: { role_id: roleId, doc: c.doc, line: c.line, value: '$value' } },
      },
      { forceHuman: true, actor: h.ctx.actor },
    );
    out.push({ doc: c.doc, kind: c.kind, claim: c.claim, line: c.line, decision_id: decisionId });
  }
  return out;
}

// ---------------------------------------------------------- apply.resolve_claim

export const applyResolveClaim = defineHandler('apply.resolve_claim', {
  run(input, h) {
    const role = getRole(h.db, input.role_id);
    const app = applicationFor(h.db, role.id);
    const path = (app?.package_paths_json as Record<string, string> | undefined)?.[input.doc] ?? null;
    const value = input.value.trim();
    if (value.toLowerCase() === 'keep') return { changed: false, path };
    if (value.toLowerCase() === 'other') throw new OpError('invalid_input', 'edit needs the new text for the line');
    if (!path) throw new OpError('not_found', `${role.id}: no ${DOC_LABEL[input.doc]} yet`);
    const md = h.vault.read(path);
    if (md === null) throw new OpError('not_found', `${path} is missing`);
    const lines = md.split('\n');
    const at = lines.findIndex((l) => l.trim() === input.line.trim());
    // The line is gone (re-tailored or edited since): nothing left to change.
    if (at < 0) return { changed: false, path };
    if (value.toLowerCase() === 'remove') {
      lines.splice(at, 1);
      if (at > 0 && lines[at - 1]?.trim() === '' && (lines[at] ?? '').trim() === '') lines.splice(at, 1);
    } else {
      const indent = /^\s*/.exec(lines[at] as string)?.[0] ?? '';
      lines[at] = `${indent}${value}`;
    }
    const body = lines.join('\n');
    // #81: keep the filed answers (frontmatter, read by an Ask merge) in step with the body.
    h.vault.write(
      path,
      input.doc === 'answers' ? resolveSavedLine(body, input.line, value.toLowerCase() === 'remove' ? null : value) : body,
    );
    return { changed: true, path };
  },
});
