import { select } from '../_shim/repo.js';
import { OpError } from '../errors.js';
import { defineHandler } from '../runtime.js';
import { stripFrontmatter } from '../vault.js';
import { getCompany, latestScores } from './shared.js';

/** companies.get (Wave 2 contract, lane C request): one company with its roles and dossier. */
export const companiesGet = defineHandler('companies.get', {
  run(input, h) {
    const company = getCompany(h.db, input.company_id);
    const scores = latestScores(h.db);
    const roles = select(h.db, 'role', 'company_id = ? ORDER BY found_at DESC, id', [company.id]).map((role) => ({
      role,
      company,
      latest_score: scores.get(role.id) ?? null,
    }));
    const md = company.md_path ? h.vault.read(company.md_path) : null;
    return { company, roles, dossier_md: md === null ? null : stripFrontmatter(md) };
  },
});

/** Every vault path a db row references (vault.read serves only these). */
function referencedPaths(h: Parameters<(typeof vaultRead)['run']>[1]): Set<string> {
  const out = new Set<string>();
  const add = (p: unknown) => {
    if (typeof p === 'string' && p) out.add(p);
  };
  for (const t of ['role', 'company', 'outreach', 'profile_component'] as const) for (const r of select(h.db, t)) add(r.md_path);
  for (const i of select(h.db, 'interview')) {
    add(i.prep_path);
    add(i.retro_path);
  }
  for (const a of select(h.db, 'application')) for (const p of Object.values(a.package_paths_json)) add(p);
  for (const r of select(h.db, 'run')) add(r.log_path);
  return out;
}

/** vault.read (Wave 2 contract, lane D request): package previews, frontmatter stripped. */
export const vaultRead = defineHandler('vault.read', {
  run(input, h) {
    if (!referencedPaths(h).has(input.path)) throw new OpError('not_found', `no db row references ${input.path}`);
    const md = h.vault.read(input.path);
    return { markdown: md === null ? null : stripFrontmatter(md) };
  },
});
