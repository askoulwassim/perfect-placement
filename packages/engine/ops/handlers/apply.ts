import { vaultPath } from '@perfect-placement/contracts';
import { checkFacts, type FactClaim, storySourceText } from '../../profile/facts.js';
import { getComponents, getCurrentVersion } from '../../profile/versions.js';
import { OpError } from '../errors.js';
import { select, update } from '../rows.js';
import { defineHandler, type HandlerContext } from '../runtime.js';
import { renderMarkdown, stripFrontmatter } from '../vault.js';
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

const readBody = (h: HandlerContext, path: string | null | undefined): string | null => {
  if (!path) return null;
  const md = h.vault.read(path);
  return md === null ? null : stripFrontmatter(md);
};

/** Fact sources (#38): the kept resume text and the confirmed Story. */
function factSources(h: HandlerContext): { texts: string[]; resumePath: string | null } {
  const v = getCurrentVersion(h.repos);
  const story = v ? (getComponents(h.repos, v.id).find((c) => c.key === 'story')?.data_json ?? null) : null;
  const resumePath = typeof story?.source_path === 'string' ? story.source_path : null;
  const resume = readBody(h, resumePath);
  return { texts: [resume ?? '', storySourceText(story)].filter((t) => t.trim()), resumePath: resume === null ? null : resumePath };
}

type DocClaim = FactClaim & { doc: 'resume' | 'cover_letter' };

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
  run(input, h) {
    const role = getRole(h.db, input.role_id);
    if (role.status !== 'draft-ready' && role.status !== 'active' && role.status !== 'on-deck')
      throw new OpError('forbidden_transition', `${role.id}: cannot tailor a role in ${role.status}`);
    const existing = applicationFor(h.db, role.id);
    const company = getCompany(h.db, role.company_id);

    // Fact check (#38): numbers, years, dates, degrees and role headings must be in the sources; a title
    // or employer named in prose that they lack goes to the user (needs-you).
    const { texts, resumePath } = factSources(h);
    const context = [role.title, company.name, readBody(h, role.md_path), readBody(h, company.md_path)].filter(Boolean).join('\n');
    const tag = (doc: DocClaim['doc'], cs: FactClaim[]): DocClaim[] => cs.map((c) => ({ ...c, doc }));
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
    const needs_you = needsYou.map(({ doc, kind, claim, line }) => ({ doc, kind, claim, line }));
    h.emit('application_tailored', 'role', role.id, {
      application_id: application.id,
      retailor: role.status === 'draft-ready',
      facts_checked: supported.length + unsupported.length,
      ...(needs_you.length ? { needs_you } : {}),
    });
    if (role.status !== 'draft-ready') moveRole(h, role, 'draft-ready', { via: 'tailor' });
    return { application, fact_check: { checked: supported.length + unsupported.length, needs_you } };
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
