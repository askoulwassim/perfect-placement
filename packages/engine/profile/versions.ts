import {
  PROFILE_COMPONENT_KEYS,
  PROFILE_COMPONENT_KIND,
  type ProfileComponent,
  type ProfileComponentKey,
  type ProfileDiff,
  type ProfileDiffStatus,
  type ProfileVersion,
  RESCORE_MOVABLE,
} from '@perfect-placement/contracts';
import type { Repos } from '../db/repo.js';
import { newId } from './deps.js';

/*
 * Profile versions, components and diffs over lane A's repositories (the only db access).
 * Callers run inside an op's transaction (runOp), so nothing here opens its own.
 */

export function getVersion(R: Repos, id: string): ProfileVersion | null {
  return R.profile_version.get(id) ?? null;
}

/** Current version = newest by created_at (ties: id). */
export function getCurrentVersion(R: Repos): ProfileVersion | null {
  return R.profile_version.select('1 ORDER BY created_at DESC, id DESC LIMIT 1')[0] ?? null;
}

export function listVersions(R: Repos): ProfileVersion[] {
  return R.profile_version.select('1 ORDER BY created_at ASC, id ASC');
}

export function getComponents(R: Repos, versionId: string): ProfileComponent[] {
  return R.profile_component
    .list({ version_id: versionId })
    .sort((a, b) => PROFILE_COMPONENT_KEYS.indexOf(a.key) - PROFILE_COMPONENT_KEYS.indexOf(b.key));
}

export function getComponent(R: Repos, versionId: string, key: ProfileComponentKey): ProfileComponent | null {
  return R.profile_component.list({ version_id: versionId, key })[0] ?? null;
}

export function getDiff(R: Repos, id: string): ProfileDiff | null {
  return R.profile_diff.get(id) ?? null;
}

export function listDiffs(R: Repos, status?: ProfileDiffStatus): ProfileDiff[] {
  return status
    ? R.profile_diff.select('status = ? ORDER BY created_at ASC, id ASC', [status])
    : R.profile_diff.select('1 ORDER BY created_at ASC, id ASC');
}

export function insertDiff(R: Repos, d: ProfileDiff): void {
  R.profile_diff.insert(d);
}

export function updateDiff(
  R: Repos,
  id: string,
  patch: Partial<Pick<ProfileDiff, 'status' | 'decision_id' | 'event_id' | 'applied_version_id'>>,
): void {
  if (Object.keys(patch).length) R.profile_diff.update(id, patch);
}

export interface ComponentDraft {
  key: ProfileComponentKey;
  confidence: number;
  weight: number | null;
  data_json: Record<string, unknown>;
  md_path: string | null;
}

/**
 * Write a new version with all 11 components.
 * Components not in `drafts` are copied from the parent (when there is one) or created empty.
 */
export function insertVersion(
  R: Repos,
  args: {
    now: Date;
    parent_id: string | null;
    reason: string;
    event_id: string | null;
    drafts: Partial<Record<ProfileComponentKey, ComponentDraft>>;
  },
): { version: ProfileVersion; components: ProfileComponent[] } {
  const version: ProfileVersion = {
    id: newId('pv', args.now),
    created_at: args.now.toISOString(),
    parent_id: args.parent_id,
    reason: args.reason,
    event_id: args.event_id,
  };
  // Guard against a same-ms created_at tie making "current" ambiguous: bump past the parent.
  if (args.parent_id) {
    const parent = getVersion(R, args.parent_id);
    if (parent && parent.created_at >= version.created_at) version.created_at = new Date(Date.parse(parent.created_at) + 1).toISOString();
  }
  R.profile_version.insert(version);
  const parentComps = args.parent_id ? getComponents(R, args.parent_id) : [];
  for (const key of PROFILE_COMPONENT_KEYS) {
    const prev = parentComps.find((c) => c.key === key);
    const d: ComponentDraft =
      args.drafts[key] ??
      (prev
        ? { key, confidence: prev.confidence, weight: prev.weight, data_json: prev.data_json, md_path: prev.md_path }
        : { key, confidence: 0, weight: null, data_json: {}, md_path: null });
    R.profile_component.insert({
      id: newId('pc', args.now),
      version_id: version.id,
      key,
      kind: PROFILE_COMPONENT_KIND[key],
      confidence: Math.min(1, Math.max(0, d.confidence)),
      weight: d.weight,
      data_json: d.data_json,
      md_path: d.md_path,
    });
  }
  return { version, components: getComponents(R, version.id) };
}

/**
 * Roles a profile change rescoring may move: RESCORE_MOVABLE (inbox, active, held) with a score.
 * On-deck and later are human picks, protected from automated rescoring (wave1-decisions #13).
 */
export function rescoreScope(R: Repos): string[] {
  const scope = RESCORE_MOVABLE.map(() => '?').join(',');
  return R.role.select(`status IN (${scope}) AND id IN (SELECT role_id FROM score) ORDER BY id`, [...RESCORE_MOVABLE]).map((r) => r.id);
}
