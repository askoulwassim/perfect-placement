import {
  ARCHIVE_REASONS,
  ArchiveReason,
  type Company,
  type DecisionAction,
  type IntakeCounts,
  type OpInput,
  ROLE_STATUSES,
  type Role,
  type RoleStatus,
  Slug,
  vaultPath,
} from '@perfect-placement/contracts';
import type Database from 'better-sqlite3';
import { defaultFetch } from '../../integrations/ats/index.js';
import { getComponent, getCurrentVersion } from '../../profile/versions.js';
import { watchlistFrom } from '../../scoring/source-mix.js';
import { type IntakeVerdict, intakeDeps, rulesFromProfile, type ScanCompany, scanWatchlist, verifyCandidate } from '../../scout/index.js';
import { atsFromUrl, normalizeUrl, TITLE_DUPLICATE_MIN, TITLE_POSSIBLE_MIN, titleSimilarity } from '../dedupe.js';
import { OpError } from '../errors.js';
import { roleIdFor, slugify } from '../ids.js';
import { get, insert, select } from '../rows.js';
import { defineHandler, type HandlerContext } from '../runtime.js';
import { renderMarkdown, stripFrontmatter } from '../vault.js';
import { applicationFor, getCompany, getRole, latestScore, latestScores, moveRole, undoMove } from './shared.js';

// ------------------------------------------------------------------ roles.add

// Legal suffixes are dropped from the slug / dedupe key only ("Acme, Inc." and "Acme" are one company).
// The display name is kept exactly as given, trimmed ("Example Co" stays "Example Co").
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

function findCompany(db: Database.Database, name: string, domain: string | undefined, url: string | undefined): Company | null {
  const byId = get(db, 'company', companySlug(name));
  if (byId) return byId;
  const host = hostOf(domain);
  if (host) {
    const byDomain = select(db, 'company', 'lower(domain) = ?', [host])[0];
    if (byDomain) return byDomain;
  }
  const ats = atsFromUrl(url);
  if (ats.board && ats.type !== 'unknown') {
    const byBoard = select(db, 'company', 'ats_type = ? AND lower(ats_board) = ?', [ats.type, ats.board.toLowerCase()])[0];
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
    name: name.trim(),
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

type Candidate = OpInput<'roles.add'>['candidates'][number];
type DupMatch = { existing_id: string; match: 'url' | 'ats_job_id' | 'company_title' };

const knownRoles = (db: Database.Database): Known[] =>
  select(db, 'role').map((r) => ({ id: r.id, company_id: r.company_id, title: r.title, url: normalizeUrl(r.url), jobId: r.ats_job_id }));

/** Exact duplicate (url, ATS job id, company + title >= TITLE_DUPLICATE_MIN), plus the best same-company title match. */
function matchKnown(
  known: readonly Known[],
  company: Company | null,
  title: string,
  url: string | undefined,
  jobId: string | null | undefined,
): { dup: DupMatch | null; best: { k: Known; sim: number } | null } {
  const nurl = normalizeUrl(url);
  const byUrl = nurl ? known.find((k) => k.url === nurl) : undefined;
  if (byUrl) return { dup: { existing_id: byUrl.id, match: 'url' }, best: null };
  const byJob = jobId ? known.find((k) => k.jobId === jobId) : undefined;
  if (byJob) return { dup: { existing_id: byJob.id, match: 'ats_job_id' }, best: null };
  let best: { k: Known; sim: number } | null = null;
  if (company)
    for (const k of known.filter((k) => k.company_id === company.id)) {
      const sim = titleSimilarity(title, k.title);
      if (!best || sim > best.sim) best = { k, sim };
    }
  if (best && best.sim >= TITLE_DUPLICATE_MIN) return { dup: { existing_id: best.k.id, match: 'company_title' }, best };
  return { dup: null, best };
}

/** Intake verdicts by candidate index (#32), computed before the transaction (network). */
type Verdicts = Map<number, IntakeVerdict>;

const emptyCounts = (): IntakeCounts => ({ candidates: 0, added: 0, duplicates: 0, skipped_dead: 0, skipped_aggregator: 0 });

export const rolesAdd = defineHandler('roles.add', {
  async prepare(input, p): Promise<Verdicts> {
    const verdicts: Verdicts = new Map();
    if (input.verify === false) return verdicts;
    const deps = intakeDeps(p.services.fetch ?? defaultFetch());
    const known = knownRoles(p.db);
    for (const [index, c] of input.candidates.entries()) {
      if (!c.url) continue;
      const company = findCompany(p.db, c.company_name, c.company_domain, c.url);
      const { dup } = matchKnown(known, company, c.title, c.url, c.ats_job_id ?? atsFromUrl(c.url).jobId);
      if (dup) continue; // no network for known roles
      known.push({
        id: `#${index}`,
        company_id: company?.id ?? companySlug(c.company_name),
        title: c.title,
        url: normalizeUrl(c.url),
        jobId: c.ats_job_id ?? null,
      });
      const hint = {
        slug: company?.slug ?? companySlug(c.company_name),
        ats_type: company?.ats_type ?? null,
        ats_board: company?.ats_board ?? null,
      };
      verdicts.set(index, await verifyCandidate({ title: c.title, url: c.url, location: c.location }, hint, deps));
    }
    return verdicts;
  },
  async run(input, h, prepared) {
    const verdicts = (prepared as Verdicts | undefined) ?? new Map<number, IntakeVerdict>();
    const now = h.nowIso();
    const known = knownRoles(h.db);
    const added: string[] = [];
    const duplicates: { index: number; existing_id: string; match: 'url' | 'ats_job_id' | 'company_title' }[] = [];
    const possible: { index: number; role_id: string; existing_id: string; similarity: number; decision_id: string }[] = [];
    const skipped: { index: number; reason: 'dead' | 'aggregator'; detail: string }[] = [];
    const resolved: { index: number; role_id: string; from: string; to: string }[] = [];
    const notes = new Map<string, string>();
    const bySource: Partial<Record<Candidate['source'], IntakeCounts>> = {};
    const count = (c: Candidate, key: keyof IntakeCounts) => {
      const n = bySource[c.source] ?? emptyCounts();
      n[key]++;
      bySource[c.source] = n;
    };

    for (const [index, raw] of input.candidates.entries()) {
      count(raw, 'candidates');
      let company = findCompany(h.db, raw.company_name, raw.company_domain, raw.url);
      const first = matchKnown(known, company, raw.title, raw.url, raw.ats_job_id ?? atsFromUrl(raw.url).jobId);
      if (first.dup) {
        duplicates.push({ index, ...first.dup });
        count(raw, 'duplicates');
        continue;
      }

      const v = verdicts.get(index);
      if (v && v.verdict !== 'keep') {
        skipped.push({ index, reason: v.verdict, detail: v.reason });
        count(raw, v.verdict === 'dead' ? 'skipped_dead' : 'skipped_aggregator');
        continue;
      }

      // The company's own posting replaces an aggregator link; the ATS JD fills or replaces a summary.
      let c: Candidate = raw;
      let best = first.best;
      if (v?.url && v.url !== raw.url) {
        c = { ...raw, url: v.url, ...(v.ats_job_id ? { ats_job_id: v.ats_job_id } : {}) };
        company = company ?? findCompany(h.db, c.company_name, c.company_domain, c.url);
        const again = matchKnown(known, company, c.title, c.url, c.ats_job_id ?? atsFromUrl(c.url).jobId);
        if (again.dup) {
          duplicates.push({ index, ...again.dup });
          count(raw, 'duplicates');
          continue;
        }
        best = again.best;
      }
      const posting = v?.posting;
      if (posting) {
        c = {
          ...c,
          ...(posting.text.trim() ? { jd_markdown: posting.text.trim() } : {}),
          ...(!c.ats_job_id && v?.ats_job_id ? { ats_job_id: v.ats_job_id } : {}),
          ...(!c.location && posting.location ? { location: posting.location } : {}),
          ...(!c.posted_at && posting.postedAt && !Number.isNaN(Date.parse(posting.postedAt))
            ? { posted_at: new Date(posting.postedAt).toISOString() }
            : {}),
          ...(!c.workplace && (posting.workplace === 'remote' || posting.workplace === 'hybrid' || posting.workplace === 'onsite')
            ? { workplace: posting.workplace }
            : {}),
        };
      }

      const nurl = normalizeUrl(c.url);
      const jobId = c.ats_job_id ?? atsFromUrl(c.url).jobId;
      const co = company ?? createCompany(h, c.company_name, c.company_domain, c.url);
      const id = roleIdFor(co.slug, c.title, (rid) => known.some((k) => k.id === rid) || get(h.db, 'role', rid) !== null);
      const workplace = c.workplace ?? 'unspecified';
      const checked = v && v.freshness !== 'unknown';
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
        last_checked_at: checked ? now : null,
        freshness: v?.freshness ?? 'unknown',
        flags_json: {},
        md_path: vaultPath.role(id),
        created_at: now,
        updated_at: now,
      };
      insert(h.db, 'role', role);
      const found = [`- Found via ${c.source} on ${now.slice(0, 10)}.`];
      if (c.url) found.push(`- ${c.url}`);
      if (v?.resolved_from) found.push(`- Resolved from ${v.resolved_from}`);
      if (v && v.verdict === 'keep' && v.freshness !== 'unknown') found.push(`- Intake check: ${v.freshness} (${v.reason})`);
      h.vault.write(
        role.md_path as string,
        renderMarkdown(
          { id, type: 'role' },
          `# ${role.title}, ${co.name}\n\n## JD\n\n${c.jd_markdown?.trim() || '_Not captured yet._'}\n\n## Notes\n\n${found.join('\n')}`,
        ),
      );
      h.emit('role_added', 'role', id, { company_id: co.id, title: role.title, source: c.source, url: role.url });
      added.push(id);
      count(raw, 'added');
      if (v?.resolved_from && c.url) resolved.push({ index, role_id: id, from: v.resolved_from, to: c.url });
      if (v && v.freshness === 'unsure') notes.set(id, v.reason);
      known.push({ id, company_id: co.id, title: role.title, url: nurl, jobId: jobId ?? null });

      if (best && best.sim >= TITLE_POSSIBLE_MIN) {
        // Near matches are always queued for a human; accepting archives the new copy as `duplicate`.
        const { decisionId } = await h.resolver.record(
          {
            decision: 'roles.dedupe',
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
            action: { op: 'roles.archive', input: { role_id: id, reason: 'duplicate', note: `duplicate of ${best.k.id}` }, when: true },
          },
          { forceHuman: true, actor: h.ctx.actor },
        );
        possible.push({ index, role_id: id, existing_id: best.k.id, similarity: best.sim, decision_id: decisionId });
      }
    }

    const skippedDead = skipped.filter((s) => s.reason === 'dead');
    const skippedAgg = skipped.filter((s) => s.reason === 'aggregator');
    h.runLog({
      title: 'roles.add',
      summary: {
        candidates: input.candidates.length,
        added: added.length,
        duplicates: duplicates.length,
        possible: possible.length,
        skipped_dead: skippedDead.length,
        skipped_aggregator: skippedAgg.length,
        resolved: resolved.length,
        by_source: bySource,
      },
      lines: [
        `Candidates in: ${input.candidates.length}, added: ${added.length}, deduped: ${duplicates.length}, possible duplicates: ${possible.length}, skipped dead: ${skippedDead.length}, skipped aggregator: ${skippedAgg.length}`,
        '',
        '| Source | Candidates | Added | Duplicates | Dead | Aggregator |',
        '| --- | --- | --- | --- | --- | --- |',
        ...Object.entries(bySource).map(
          ([src, n]) => `| ${src} | ${n.candidates} | ${n.added} | ${n.duplicates} | ${n.skipped_dead} | ${n.skipped_aggregator} |`,
        ),
        '',
        '### Added to inbox',
        ...(added.length ? added.map((id) => `- ${id}${notes.has(id) ? ` (freshness unsure: ${notes.get(id)})` : ''}`) : ['- (none)']),
        '',
        '### Deduped (already in pipeline)',
        ...(duplicates.length
          ? duplicates.map((d) => `- #${d.index} ${input.candidates[d.index]?.title} -> ${d.existing_id} (${d.match})`)
          : ['- (none)']),
        ...(resolved.length
          ? ['', "### Resolved to the company's own posting", ...resolved.map((r) => `- ${r.role_id}: ${r.from} -> ${r.to}`)]
          : []),
        ...(skipped.length
          ? ['', '### Skipped', ...skipped.map((s) => `- #${s.index} ${input.candidates[s.index]?.title} (${s.reason}: ${s.detail})`)]
          : []),
        ...(possible.length
          ? [
              '',
              '### Possible duplicates (Needs you)',
              ...possible.map((p) => `- ${p.role_id} ~ ${p.existing_id} (${p.similarity.toFixed(2)})`),
            ]
          : []),
      ],
    });
    return {
      added,
      duplicates,
      possible_duplicates: possible.map(({ index, role_id, existing_id, decision_id }) => ({ index, role_id, existing_id, decision_id })),
      skipped,
      resolved,
      by_source: bySource,
    };
  },
});

// --------------------------------------------------------- scout.watchlist_scan

const titleCase = (slug: string) => slug.replace(/(^|-)([a-z])/g, (_m, sep: string, ch: string) => `${sep ? ' ' : ''}${ch.toUpperCase()}`);

export const scoutWatchlistScanHandler = defineHandler('scout.watchlist_scan', {
  async run(input, h) {
    const version = getCurrentVersion(h.repos);
    const comp = (key: 'craft' | 'work_mode' | 'company') =>
      version ? ((getComponent(h.repos, version.id, key)?.data_json as Record<string, unknown> | undefined) ?? {}) : {};
    const names = input.companies ?? watchlistFrom(comp('company'));
    const companies: ScanCompany[] = [];
    for (const n of names) {
      const row = findCompany(h.db, n, undefined, undefined);
      const slug = row?.slug ?? companySlug(n);
      if (!Slug.safeParse(slug).success || companies.some((c) => c.slug === slug)) continue;
      companies.push({
        slug,
        name: row?.name ?? (n === slug ? titleCase(n) : n.trim()),
        ats_type: row?.ats_type ?? null,
        ats_board: row?.ats_board ?? null,
      });
    }
    const rules = rulesFromProfile(
      { craft: comp('craft'), work_mode: comp('work_mode') },
      { ...(input.include ? { include: input.include } : {}), ...(input.exclude ? { exclude: input.exclude } : {}) },
    );
    const roles = select(h.db, 'role');
    const known = {
      urls: new Set(roles.map((r) => normalizeUrl(r.url)).filter((u): u is string => !!u)),
      jobIds: new Set(roles.map((r) => r.ats_job_id).filter((j): j is string => !!j)),
    };
    const res = await scanWatchlist(companies, rules, known, {
      fetch: h.services.fetch ?? defaultFetch(),
      boards: new Map(),
      jdChars: input.jd_chars ?? 400,
    });
    return res;
  },
});

// ----------------------------------------------------------- roles.move/archive

/** Is this call `decisions.undo` running the inverse move recorded on the decision? */
function isUndoOf(h: HandlerContext, roleId: string, to: RoleStatus): boolean {
  if (!h.ctx.decisionId) return false;
  const d = get(h.db, 'decision', h.ctx.decisionId);
  const undo = (d?.action_json as DecisionAction | null)?.undo;
  const input = undo?.input as { role_id?: string; to?: string } | undefined;
  return d?.status === 'applied' && undo?.op === 'roles.move' && input?.role_id === roleId && input?.to === to;
}

export const rolesMove = defineHandler('roles.move', {
  decisionKind: 'roles.move',
  run(input, h) {
    const role = getRole(h.db, input.role_id);
    const from = role.status;
    const undo = isUndoOf(h, role.id, input.to);
    const archiveReason = undo && input.to === 'archived' ? ArchiveReason.safeParse(input.reason) : null;
    const moved = moveRole(h, role, input.to, {
      via: undo ? 'undo' : 'move',
      ...(archiveReason?.success ? { archiveReason: archiveReason.data } : {}),
      ...(input.reason && !archiveReason?.success ? { note: input.reason } : {}),
    });
    if (input.to === 'on-deck' && from === 'active') h.emit('role_picked', 'role', role.id, { from });
    h.setUndo(undoMove(role));
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
    h.setUndo(undoMove(role));
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
