import { ARCHIVE_REASONS, type Company, ROLE_STATUSES, type Role, type RoleStatus, Slug, vaultPath } from '@perfect-placement/contracts';
import { get, insert, select } from '../_shim/repo.js';
import { atsFromUrl, normalizeUrl, TITLE_DUPLICATE_MIN, TITLE_POSSIBLE_MIN, titleSimilarity } from '../dedupe.js';
import { OpError } from '../errors.js';
import { roleIdFor, slugify } from '../ids.js';
import { defineHandler, type HandlerContext } from '../runtime.js';
import { renderMarkdown, stripFrontmatter } from '../vault.js';
import { applicationFor, getCompany, getRole, latestScore, latestScores, moveRole } from './shared.js';

// ------------------------------------------------------------------ roles.add

const LEGAL_SUFFIX = /[,.]?\s+(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|sa|ag|bv)\.?$/i;
export const companySlug = (name: string) => slugify(name.trim().replace(LEGAL_SUFFIX, ''));
const hostOf = (d: string | null | undefined) =>
  d
    ? d
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .split('/')[0] || null
    : null;

function findCompany(h: HandlerContext, name: string, domain: string | undefined, url: string | undefined): Company | null {
  const byId = get(h.db, 'company', companySlug(name));
  if (byId) return byId;
  const host = hostOf(domain);
  if (host) {
    const byDomain = select(h.db, 'company', 'lower(domain) = ?', [host])[0];
    if (byDomain) return byDomain;
  }
  const ats = atsFromUrl(url);
  if (ats.board && ats.type !== 'unknown') {
    const byBoard = select(h.db, 'company', 'ats_type = ? AND lower(ats_board) = ?', [ats.type, ats.board.toLowerCase()])[0];
    if (byBoard) return byBoard;
  }
  return null;
}

function createCompany(h: HandlerContext, name: string, domain: string | undefined, url: string | undefined): Company {
  const slug = companySlug(name);
  if (!Slug.safeParse(slug).success) throw new OpError('invalid_input', `cannot derive a company slug from "${name}"`);
  const ats = atsFromUrl(url);
  const company: Company = {
    id: slug,
    slug,
    name: name.trim().replace(LEGAL_SUFFIX, ''),
    domain: hostOf(domain),
    ats_type: ats.type,
    ats_board: ats.board,
    affinity: 0,
    md_path: null,
  };
  insert(h.db, 'company', company);
  return company;
}

interface Known {
  id: string;
  company_id: string;
  title: string;
  url: string | null;
  jobId: string | null;
}

export const rolesAdd = defineHandler('roles.add', {
  run(input, h) {
    const now = h.nowIso();
    const known: Known[] = select(h.db, 'role').map((r) => ({
      id: r.id,
      company_id: r.company_id,
      title: r.title,
      url: normalizeUrl(r.url),
      jobId: r.ats_job_id,
    }));
    const added: string[] = [];
    const duplicates: { index: number; existing_id: string; match: 'url' | 'ats_job_id' | 'company_title' }[] = [];
    const possible: { role_id: string; existing_id: string; similarity: number; decision_id: string }[] = [];

    for (const [index, c] of input.candidates.entries()) {
      const ats = atsFromUrl(c.url);
      const jobId = c.ats_job_id ?? ats.jobId;
      const nurl = normalizeUrl(c.url);
      const company = findCompany(h, c.company_name, c.company_domain, c.url);

      const byUrl = nurl ? known.find((k) => k.url === nurl) : undefined;
      if (byUrl) {
        duplicates.push({ index, existing_id: byUrl.id, match: 'url' });
        continue;
      }
      const byJob = jobId ? known.find((k) => k.jobId === jobId) : undefined;
      if (byJob) {
        duplicates.push({ index, existing_id: byJob.id, match: 'ats_job_id' });
        continue;
      }
      let best: { k: Known; sim: number } | null = null;
      if (company)
        for (const k of known.filter((k) => k.company_id === company.id)) {
          const sim = titleSimilarity(c.title, k.title);
          if (!best || sim > best.sim) best = { k, sim };
        }
      if (best && best.sim >= TITLE_DUPLICATE_MIN) {
        duplicates.push({ index, existing_id: best.k.id, match: 'company_title' });
        continue;
      }

      const co = company ?? createCompany(h, c.company_name, c.company_domain, c.url);
      const id = roleIdFor(co.slug, c.title, (rid) => known.some((k) => k.id === rid) || get(h.db, 'role', rid) !== null);
      const workplace = c.workplace ?? 'unspecified';
      const role: Role = {
        id,
        company_id: co.id,
        title: c.title.trim(),
        url: c.url ?? null,
        ats_job_id: jobId ?? null,
        source: c.source,
        found_at: now,
        posted_at: c.posted_at ?? null,
        workplace,
        remote_ok: workplace === 'remote' ? true : workplace === 'onsite' ? false : null,
        location: c.location ?? null,
        comp_min: c.comp_min ?? null,
        comp_max: c.comp_max ?? null,
        comp_currency: c.comp_currency ?? null,
        facing: null,
        seniority: null,
        status: 'inbox',
        archive_reason: null,
        held_reason: null,
        last_checked_at: null,
        freshness: 'unknown',
        flags_json: {},
        md_path: vaultPath.role(id),
        created_at: now,
        updated_at: now,
      };
      insert(h.db, 'role', role);
      h.vault.write(
        role.md_path as string,
        renderMarkdown(
          { id, type: 'role' },
          `# ${role.title}, ${co.name}\n\n## JD\n\n${c.jd_markdown?.trim() || '_Not captured yet._'}\n\n## Notes\n\n- Found via ${c.source} on ${now.slice(0, 10)}.${c.url ? `\n- ${c.url}` : ''}`,
        ),
      );
      h.emit('role_added', 'role', id, { company_id: co.id, title: role.title, source: c.source, url: role.url });
      added.push(id);
      known.push({ id, company_id: co.id, title: role.title, url: nurl, jobId: jobId ?? null });

      if (best && best.sim >= TITLE_POSSIBLE_MIN) {
        const { decisionId } = h.decisions.record(
          h.db,
          {
            kind: 'roles.dedupe',
            impact: 'low',
            subject: { type: 'role', id },
            question: {
              id: 'same',
              type: 'noulli',
              instructions: `Same job as "${best.k.title}"?`,
              existing_id: best.k.id,
            },
            answer: { id: 'same', value: true, p: Math.round(best.sim * 100) / 100 },
            backend: 'rule',
            action: { op: 'roles.archive', input: { role_id: id, reason: 'passed', note: `duplicate of ${best.k.id}` } },
            forceHuman: true,
          },
          { ctx: h.ctx, config: h.config },
        );
        possible.push({ role_id: id, existing_id: best.k.id, similarity: best.sim, decision_id: decisionId });
      }
    }

    h.runLog({
      title: 'roles.add',
      summary: { candidates: input.candidates.length, added: added.length, duplicates: duplicates.length, possible: possible.length },
      lines: [
        `Candidates in: ${input.candidates.length}, added: ${added.length}, deduped: ${duplicates.length}, possible duplicates: ${possible.length}`,
        '',
        '### Added to inbox',
        ...(added.length ? added.map((id) => `- ${id}`) : ['- (none)']),
        '',
        '### Deduped (already in pipeline)',
        ...(duplicates.length
          ? duplicates.map((d) => `- #${d.index} ${input.candidates[d.index]?.title} -> ${d.existing_id} (${d.match})`)
          : ['- (none)']),
        ...(possible.length
          ? [
              '',
              '### Possible duplicates (Needs you)',
              ...possible.map((p) => `- ${p.role_id} ~ ${p.existing_id} (${p.similarity.toFixed(2)})`),
            ]
          : []),
      ],
    });
    return { added, duplicates };
  },
});

// ----------------------------------------------------------- roles.move/archive

export const rolesMove = defineHandler('roles.move', {
  decisionKind: 'roles.move',
  run(input, h) {
    const role = getRole(h.db, input.role_id);
    const from = role.status;
    const moved = moveRole(h, role, input.to, { via: 'move', ...(input.reason ? { note: input.reason } : {}) });
    if (input.to === 'on-deck' && from === 'active') h.emit('role_picked', 'role', role.id, { from });
    return { role: moved, from };
  },
});

/** Statuses where archiving with `passed` is a skip signal for the Learn loop. */
const SKIPPABLE: RoleStatus[] = ['active', 'held', 'on-deck'];

export const rolesArchive = defineHandler('roles.archive', {
  decisionKind: 'roles.archive',
  run(input, h) {
    const role = getRole(h.db, input.role_id);
    const moved = moveRole(h, role, 'archived', {
      via: 'archive',
      archiveReason: input.reason,
      ...(input.note ? { note: input.note } : {}),
    });
    if (input.reason === 'passed' && SKIPPABLE.includes(role.status)) h.emit('role_skipped', 'role', role.id, { from: role.status });
    return { role: moved };
  },
});

// ---------------------------------------------------------------- reads

export const rolesGet = defineHandler('roles.get', {
  run(input, h) {
    const role = getRole(h.db, input.role_id);
    const contacts = select(h.db, 'contact_link', 'role_id = ?', [role.id]).flatMap((link) => {
      const contact = get(h.db, 'contact', link.contact_id);
      return contact ? [{ contact, link }] : [];
    });
    const md = role.md_path ? h.vault.read(role.md_path) : null;
    return {
      role,
      company: getCompany(h.db, role.company_id),
      latest_score: latestScore(h.db, role.id),
      application: applicationFor(h.db, role.id),
      contacts,
      md_body: md === null ? null : stripFrontmatter(md),
    };
  },
});

export const rolesList = defineHandler('roles.list', {
  run(input, h) {
    const where: string[] = [];
    const params: unknown[] = [];
    const inList = (col: string, values: readonly string[] | undefined) => {
      if (!values?.length) return;
      where.push(`${col} IN (${values.map(() => '?').join(', ')})`);
      params.push(...values);
    };
    inList('status', input.status);
    inList('freshness', input.freshness);
    inList('workplace', input.workplace);
    if (input.company_id) {
      where.push('company_id = ?');
      params.push(input.company_id);
    }
    const scores = latestScores(h.db);
    const companies = new Map(select(h.db, 'company').map((c) => [c.id, c]));
    let roles = select(h.db, 'role', where.length ? where.join(' AND ') : '1', params);
    if (input.band?.length) roles = roles.filter((r) => input.band?.includes(scores.get(r.id)?.band as never));
    const sort = input.sort ?? 'found_at';
    roles.sort((a, b) => {
      if (sort === 'fit') return (scores.get(b.id)?.total ?? -1) - (scores.get(a.id)?.total ?? -1) || a.id.localeCompare(b.id);
      if (sort === 'last_checked_at') return (a.last_checked_at ?? '').localeCompare(b.last_checked_at ?? '') || a.id.localeCompare(b.id);
      return b.found_at.localeCompare(a.found_at) || a.id.localeCompare(b.id);
    });
    const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
    if (!Number.isFinite(offset) || offset < 0) throw new OpError('invalid_input', `bad cursor: ${input.cursor}`);
    const page = roles.slice(offset, offset + input.limit);
    return {
      items: page.map((role) => ({ role, company: companies.get(role.company_id) as Company, latest_score: scores.get(role.id) ?? null })),
      next_cursor: offset + input.limit < roles.length ? String(offset + input.limit) : null,
    };
  },
});

export const pipelineSummary = defineHandler('pipeline.summary', {
  run(_input, h) {
    const counts = Object.fromEntries(ROLE_STATUSES.map((s) => [s, 0])) as Record<RoleStatus, number>;
    for (const r of h.db.prepare('SELECT status, count(*) n FROM role GROUP BY status').all() as { status: RoleStatus; n: number }[])
      counts[r.status] = r.n;
    const archived_by_reason = Object.fromEntries(ARCHIVE_REASONS.map((s) => [s, 0])) as Record<(typeof ARCHIVE_REASONS)[number], number>;
    for (const r of h.db.prepare(`SELECT archive_reason, count(*) n FROM role WHERE status = 'archived' GROUP BY archive_reason`).all() as {
      archive_reason: (typeof ARCHIVE_REASONS)[number];
      n: number;
    }[])
      archived_by_reason[r.archive_reason] = r.n;
    const now = h.ctx.now();
    const since24h = new Date(now.getTime() - 86_400_000).toISOString();
    const startOfDay = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const one = (sql: string, ...p: unknown[]) => (h.db.prepare(sql).get(...p) as { n: number }).n;
    const total24 = one('SELECT count(*) n FROM decision WHERE ts >= ?', since24h);
    const auto24 = one(`SELECT count(*) n FROM decision WHERE ts >= ? AND policy_outcome <> 'human'`, since24h);
    return {
      counts,
      archived_by_reason,
      needs_you: one(`SELECT count(*) n FROM decision WHERE status = 'pending' AND policy_outcome = 'human'`),
      auto_share_24h: total24 === 0 ? 0 : auto24 / total24,
      closed_today: one(
        `SELECT count(DISTINCT subject_id) n FROM event WHERE ts >= ? AND (type = 'role_closed' OR (type = 'role_archived' AND json_extract(payload_json, '$.reason') = 'closed'))`,
        startOfDay,
      ),
      drafts_ready: counts['draft-ready'],
      replies: one(`SELECT count(*) n FROM outreach WHERE status = 'replied'`),
    };
  },
});
