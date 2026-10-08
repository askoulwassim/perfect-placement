import type { Frontmatter } from '@perfect-placement/contracts';
import { applications, companies, FIXTURE_CONFIG, interviews, outreach, profileComponents, roles, runs } from './data.js';

const md = (fm: Frontmatter, body: string) => {
  const head = Object.entries(fm)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');
  return `---\n${head}\n---\n\n${body.trim()}\n`;
};

/** Vault-relative path -> file content for the synthetic vault. */
export function vaultFiles(): Map<string, string> {
  const files = new Map<string, string>();
  files.set('config.json', `${JSON.stringify(FIXTURE_CONFIG, null, 2)}\n`);

  for (const c of profileComponents.filter((c) => c.md_path && c.version_id === 'pv_0002')) {
    const body =
      c.key === 'story'
        ? '# Story\n\n- 12 years in data platforms and analytics products.\n- Launched a self-serve analytics product used by 400 teams.\n- Cut pipeline cost 38% with a usage-based redesign.'
        : '# Voice\n\nPunchy. Hook, reframe, close. No em dashes.';
    files.set(c.md_path as string, md({ id: c.id, type: 'profile_component', key: c.key }, body));
  }

  for (const co of companies.filter((c) => c.md_path)) {
    files.set(
      co.md_path as string,
      md({ id: co.id, type: 'dossier' }, `# ${co.name}\n\n## Snapshot\n\nSynthetic dossier for fixtures.\n\n## Why\n\n- Placeholder hook.`),
    );
  }

  for (const r of roles) {
    const co = companies.find((c) => c.id === r.company_id);
    files.set(
      r.md_path as string,
      md(
        { id: r.id, type: 'role' },
        `# ${r.title}, ${co?.name}\n\n## JD\n\nSynthetic job description for fixtures. Own the roadmap for a data product used by internal and external teams.\n\n## Notes\n\n- Found via ${r.source}.`,
      ),
    );
  }

  const appTypes = {
    resume: 'application_resume',
    cover_letter: 'application_cover_letter',
    fit_map: 'application_fit_map',
    answers: 'application_answers',
  } as const;
  for (const a of applications) {
    for (const [kind, path] of Object.entries(a.package_paths_json)) {
      const type = appTypes[kind as keyof typeof appTypes];
      if (type) files.set(path, md({ id: `${a.id}-${kind}`, type }, `# ${kind}\n\nSynthetic ${kind} for ${a.role_id}.`));
    }
  }

  for (const iv of interviews) {
    if (iv.prep_path && !files.has(iv.prep_path))
      files.set(iv.prep_path, md({ id: `${iv.id}-prep`, type: 'interview_prep' }, '# Prep\n\nSynthetic.'));
    if (iv.retro_path) files.set(iv.retro_path, md({ id: `${iv.id}-retro`, type: 'interview_retro' }, '# Retro\n\nSynthetic.'));
  }

  for (const o of outreach) {
    files.set(
      o.md_path as string,
      md(
        { id: o.id, type: 'outreach' },
        '## Hook\n\nYour insights team is shipping fast.\n\n## Proof\n\nI built a self-serve analytics product 400 teams use.\n\n## Ask\n\n20 minutes next week?',
      ),
    );
  }

  for (const r of runs.filter((r) => r.log_path)) {
    files.set(r.log_path as string, md({ id: r.id, type: 'run' }, `# ${r.op}\n\n${JSON.stringify(r.summary_json)}`));
  }
  return files;
}
