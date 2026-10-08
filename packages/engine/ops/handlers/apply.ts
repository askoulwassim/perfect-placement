import { vaultPath } from '@perfect-placement/contracts';
import { select, update } from '../_shim/repo.js';
import { OpError } from '../errors.js';
import { defineHandler } from '../runtime.js';
import { renderMarkdown } from '../vault.js';
import { applicationFor, getCompany, getRole, laterStage, moveRole, upsertApplication } from './shared.js';

// ------------------------------------------------------- companies.dossier.write

export const companiesDossierWrite = defineHandler('companies.dossier.write', {
  run(input, h) {
    const company = getCompany(h.db, input.company_id);
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

export const applyTailor = defineHandler('apply.tailor', {
  run(input, h) {
    const role = getRole(h.db, input.role_id);
    if (role.status !== 'draft-ready' && role.status !== 'active' && role.status !== 'on-deck')
      throw new OpError('forbidden_transition', `${role.id}: cannot tailor a role in ${role.status}`);
    const existing = applicationFor(h.db, role.id);
    const company = getCompany(h.db, role.company_id);
    const files = {
      resume: [vaultPath.application(role.id, 'resume'), 'application_resume', input.resume_md],
      cover_letter: [vaultPath.application(role.id, 'cover_letter'), 'application_cover_letter', input.cover_letter_md],
      fit_map: [vaultPath.application(role.id, 'fit_map'), 'application_fit_map', input.fit_map_md],
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
    h.emit('application_tailored', 'role', role.id, { application_id: application.id, retailor: role.status === 'draft-ready' });
    if (role.status !== 'draft-ready') moveRole(h, role, 'draft-ready', { via: 'tailor' });
    return { application };
  },
});

// ------------------------------------------------------------------ apply.fill

export const applyFill = defineHandler('apply.fill', {
  run(input, h) {
    const role = getRole(h.db, input.role_id);
    if (role.status !== 'draft-ready') throw new OpError('conflict', `${role.id}: fill needs a draft-ready role (is ${role.status})`);
    const app = upsertApplication(h, role.id, {});
    const path = vaultPath.application(role.id, 'answers');
    const flagged = input.answers.filter((a) => a.needs_human).length;
    const body = [
      '# Application answers',
      '',
      input.portal_url ? `Portal: ${input.portal_url}` : 'Portal: not recorded',
      flagged ? `Needs you: ${flagged}` : '',
      ...input.answers.flatMap((a, i) => [
        '',
        `## ${i + 1}. ${a.question}`,
        '',
        a.answer.trim(),
        ...(a.needs_human ? ['', '> **Needs you**'] : []),
      ]),
    ]
      .filter((l, i, all) => !(l === '' && all[i - 1] === ''))
      .join('\n');
    h.vault.write(path, renderMarkdown({ id: `${app.id}-answers`, type: 'application_answers' }, body));
    const application = upsertApplication(h, role.id, {
      package_paths_json: { ...app.package_paths_json, answers: path },
      stage: laterStage(app.stage, 'submit'),
      ...(input.portal_url ? { portal_url: input.portal_url } : {}),
    });
    return { application };
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
