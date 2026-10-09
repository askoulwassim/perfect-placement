import { vaultPath } from '@perfect-placement/contracts';
import { recordConnectFallback, skipConnect } from '../../people/queries.js';
import { checkFacts, type FactClaim } from '../../profile/facts.js';
import { OpError } from '../errors.js';
import { newId } from '../ids.js';
import { select, update } from '../rows.js';
import { defineHandler } from '../runtime.js';
import { renderMarkdown } from '../vault.js';
import { type DocClaim, factSources, queueFactChecks, roleContext } from './claims.js';
import { appendRoleLog, applicationFor, getCompany, getRole, laterStage, moveRole, pickRole, upsertApplication } from './shared.js';

// ------------------------------------------------------- companies.dossier.write

export const companiesDossierWrite = defineHandler('companies.dossier.write', {
  run(input, h) {
    const company = getCompany(h.db, input.company_id);
    // #105: research for a role picks it (active or held -> on-deck, role_picked).
    if (input.role_id) {
      const role = getRole(h.db, input.role_id);
      if (role.company_id !== company.id) throw new OpError('invalid_input', `role ${role.id} is not at company ${company.id}`);
      pickRole(h, role, 'research');
    }
    const md_path = vaultPath.dossier(company.slug);
    h.vault.write(md_path, renderMarkdown({ id: company.id, type: 'dossier' }, input.markdown));
    if (company.md_path !== md_path) update(h.db, 'company', company.id, { md_path });
    // Link the shared dossier into every open application at this company.
    const apps = select(h.db, 'application', `role_id IN (SELECT id FROM role WHERE company_id = ? AND status NOT IN ('archived'))`, [
      company.id,
    ]);
    for (const app of apps)
      update(h.db, 'application', app.id, {
        package_paths_json: { ...app.package_paths_json, dossier: md_path },
        stage: laterStage(app.stage, 'tailor'),
      });
    return { md_path };
  },
});

// ---------------------------------------------------------------- apply.tailor

/** The fit map plus the fact check: where each claim comes from, and what needs the user. */
function factSection(resumePath: string | null, supported: DocClaim[], needsYou: DocClaim[]): string {
  const cell = (t: string) => t.replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 160);
  const out = ['', '## Fact check', '', `Sources: ${resumePath ?? 'no kept resume'} + confirmed Story.`];
  if (supported.length) {
    out.push('', '| Claim | Source line |', '| --- | --- |');
    for (const c of supported.slice(0, 40)) out.push(`| ${cell(c.claim)} | ${cell(c.source ?? '')} |`);
  }
  if (needsYou.length) {
    out.push('', '### Needs you', '');
    for (const c of needsYou) out.push(`- ${c.doc === 'resume' ? 'Resume' : 'Cover letter'}: "${c.claim}" (${c.kind}) not in the sources`);
  }
  return out.join('\n');
}

export const applyTailor = defineHandler('apply.tailor', {
  async run(input, h) {
    const found = getRole(h.db, input.role_id);
    if (found.status !== 'draft-ready' && found.status !== 'active' && found.status !== 'held' && found.status !== 'on-deck')
      throw new OpError('forbidden_transition', `${found.id}: cannot tailor a role in ${found.status}`);
    // #105: Tailor is an apply stage: an active or held role is picked first (-> on-deck), then -> draft-ready.
    const role = pickRole(h, found, 'tailor');
    const existing = applicationFor(h.db, role.id);
    const company = getCompany(h.db, role.company_id);

    // Fact check (#38): numbers, years, dates, degrees and role headings must be in the sources; a title
    // or employer named in prose that they lack goes to the user (needs-you).
    const { texts, resumePath } = factSources(h);
    const context = roleContext(h, role, company);
    const tag = (doc: 'resume' | 'cover_letter', cs: FactClaim[]): DocClaim[] => cs.map((c) => ({ ...c, doc }));
    const r = checkFacts(input.resume_md, texts);
    const c = checkFacts(input.cover_letter_md, texts, { context, numbersFromContext: true, headings: false });
    const unsupported = [...tag('resume', r.unsupported), ...tag('cover_letter', c.unsupported)];
    const blocked = unsupported.filter((x) => x.hard);
    if (blocked.length)
      throw new OpError(
        'invalid_input',
        `unsupported claims (not in the source resume or confirmed Story): ${blocked
          .map((x) => `${x.doc === 'resume' ? 'resume' : 'cover letter'} "${x.claim}" (${x.kind})`)
          .join(', ')}`,
        blocked.map(({ doc, kind, claim, line }) => ({ doc, kind, claim, line })),
      );
    const needsYou = unsupported.filter((x) => !x.hard);
    const supported = [...tag('resume', r.supported), ...tag('cover_letter', c.supported)];
    const fitMap =
      supported.length || needsYou.length
        ? `${input.fit_map_md.trimEnd()}\n${factSection(resumePath, supported, needsYou)}`
        : input.fit_map_md;

    const files = {
      resume: [vaultPath.application(role.id, 'resume'), 'application_resume', input.resume_md],
      cover_letter: [vaultPath.application(role.id, 'cover_letter'), 'application_cover_letter', input.cover_letter_md],
      fit_map: [vaultPath.application(role.id, 'fit_map'), 'application_fit_map', fitMap],
    } as const;
    const app = upsertApplication(h, role.id, {});
    for (const [kind, [path, type, body]] of Object.entries(files))
      h.vault.write(path, renderMarkdown({ id: `${app.id}-${kind}`, type }, body));
    const package_paths_json = {
      ...(existing?.package_paths_json ?? {}),
      ...(company.md_path ? { dossier: company.md_path } : {}),
      resume: files.resume[0],
      cover_letter: files.cover_letter[0],
      fit_map: files.fit_map[0],
    };
    const application = upsertApplication(h, role.id, { package_paths_json, stage: laterStage(app.stage, 'connect') });
    // #54: each needs-you claim is a decision in Needs you (keep / remove / edit).
    const needs_you = (await queueFactChecks(h, role.id, ['resume', 'cover_letter'], needsYou, texts)).map((c) => ({
      ...c,
      doc: c.doc as 'resume' | 'cover_letter',
    }));
    h.emit('application_tailored', 'role', role.id, {
      application_id: application.id,
      retailor: role.status === 'draft-ready',
      facts_checked: supported.length + unsupported.length,
      ...(needs_you.length ? { needs_you: needs_you.map(({ doc, kind, claim, line }) => ({ doc, kind, claim, line })) } : {}),
    });
    if (role.status !== 'draft-ready') moveRole(h, role, 'draft-ready', { via: 'tailor' });
    return { application, fact_check: { checked: supported.length + unsupported.length, needs_you } };
  },
});

// ------------------------------------------------------- apply.mark_submitted

export const applyMarkSubmitted = defineHandler('apply.mark_submitted', {
  decisionKind: 'apply.submit',
  run(input, h) {
    let role = getRole(h.db, input.role_id);
    const applied_at = input.applied_at ?? h.nowIso();
    const already = role.status === 'applied' || role.status === 'interviews' || role.status === 'offers';
    const app = applicationFor(h.db, role.id);
    const application = upsertApplication(h, role.id, { applied_at: app?.applied_at ?? applied_at, stage: 'done' });
    h.emit('application_submitted', 'role', role.id, { application_id: application.id, applied_at: application.applied_at });
    if (!already) role = moveRole(h, role, 'applied', { via: 'submit' });
    return { role, application };
  },
});

// ------------------------------------------------------- apply.skip_connect

/**
 * #78: skip Connect so a role never stalls (no usable contact, or the user's call). The application
 * moves `connect` -> `fill`; the skip is recorded (roles.get `connect`) with its reason. Past Connect:
 * a no-op. An archived or not-yet-tailored role is refused.
 */
export const applySkipConnect = defineHandler('apply.skip_connect', {
  run(input, h) {
    const role = getRole(h.db, input.role_id);
    if (role.status === 'archived') throw new OpError('forbidden_transition', `${role.id} is archived`);
    const r = skipConnect(h.repos, role, () => newId('application', h.ctx.now()));
    if ('error' in r) throw new OpError('conflict', r.error);
    if (r.skipped) {
      recordConnectFallback(h.repos, {
        id: newId('run', h.ctx.now()),
        op: 'apply.skip_connect',
        at: h.nowIso(),
        role_id: role.id,
        fallback: 'skipped',
        reason: input.reason,
        contact_id: null,
      });
      appendRoleLog(h, role, `Connect skipped (${input.reason})`);
    }
    return r;
  },
});
