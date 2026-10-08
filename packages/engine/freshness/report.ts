import type { FreshnessRow, FreshnessSummary } from './run.js';

const cell = (s: unknown) =>
  String(s ?? '')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .slice(0, 120);

function table(rows: FreshnessRow[]): string {
  const head =
    '| Role | Company | Status | Freshness | Via | Action | Stale | Evidence |\n| --- | --- | --- | --- | --- | --- | --- | --- |';
  const body = rows
    .map(
      (r) =>
        `| ${cell(r.title)} | ${cell(r.company)} | ${r.status} | ${r.freshness} | ${r.method} | ${r.action} | ${r.stale ? `yes (${r.age_days}d)` : 'no'} | ${cell(r.error ?? r.evidence)} |`,
    )
    .join('\n');
  return `${head}\n${body}`;
}

function counts(s: FreshnessSummary): string {
  return [
    `- checked: ${s.checked}`,
    `- open: ${s.open}`,
    `- closed: ${s.closed}`,
    `- unsure: ${s.unsure}`,
    `- stale (flag only): ${s.stale}`,
    `- skipped (out of scope): ${s.skipped}`,
    `- errors: ${s.errors}`,
    `- via: ats_api ${s.by_method.ats_api}, page ${s.by_method.page}, resolver ${s.by_method.resolver}`,
  ].join('\n');
}

/** Vault run log (`runs/<date>_freshness.md`). Frontmatter carries the run id; the db row is canonical. */
export function renderRunLog(rows: FreshnessRow[], s: FreshnessSummary, meta: { runId: string; startedAt: string }): string {
  return `---\nid: ${meta.runId}\ntype: run\n---\n\n# Freshness ${meta.startedAt.slice(0, 10)}\n\n${counts(s)}\n\n${table(rows)}\n`;
}

/** Backfill dry-run report: what the first run would do. Nothing was written, no resolver calls. */
export function renderDryRunReport(rows: FreshnessRow[], s: FreshnessSummary, meta: { source: string; at: string }): string {
  const group = (f: FreshnessRow['freshness']) => rows.filter((r) => r.freshness === f);
  return [
    `# Freshness backfill dry run`,
    '',
    `Source: ${meta.source}. Run at ${meta.at}. No writes, no resolver calls: \`unsure\` = would be asked.`,
    '',
    counts(s),
    '',
    `## Closed (${group('closed').length})`,
    '',
    table(group('closed')),
    '',
    `## Unsure (${group('unsure').length})`,
    '',
    table(group('unsure')),
    '',
    `## Open (${group('open').length})`,
    '',
    table(group('open')),
    '',
  ].join('\n');
}
