import {
  PROFILE_COMPONENT_KEYS,
  PROFILE_COMPONENT_KIND,
  ProfileComponent,
  type ProfileComponentKey,
  ProfileDiff,
  type ProfileDiffStatus,
  ProfileVersion,
} from '@perfect-placement/contracts';
import { type Db, newId } from './deps.js';

/*
 * Profile repository. SHIM for Wave 2: lane A owns the typed repository layer.
 * This file is the only place lane E touches SQL, so the swap is one file.
 */

type Row = Record<string, unknown>;

function hydrate(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = k.endsWith('_json') && typeof v === 'string' ? JSON.parse(v) : v;
  return out;
}

export function getVersion(db: Db, id: string): ProfileVersion | null {
  const row = db.prepare('SELECT * FROM profile_version WHERE id = ?').get(id) as Row | undefined;
  return row ? ProfileVersion.parse(row) : null;
}

/** Current version = newest by created_at (ties: id). */
export function getCurrentVersion(db: Db): ProfileVersion | null {
  const row = db.prepare('SELECT * FROM profile_version ORDER BY created_at DESC, id DESC LIMIT 1').get() as Row | undefined;
  return row ? ProfileVersion.parse(row) : null;
}

export function listVersions(db: Db): ProfileVersion[] {
  return (db.prepare('SELECT * FROM profile_version ORDER BY created_at ASC, id ASC').all() as Row[]).map((r) => ProfileVersion.parse(r));
}

export function getComponents(db: Db, versionId: string): ProfileComponent[] {
  const rows = db.prepare('SELECT * FROM profile_component WHERE version_id = ?').all(versionId) as Row[];
  const comps = rows.map((r) => ProfileComponent.parse(hydrate(r)));
  return comps.sort((a, b) => PROFILE_COMPONENT_KEYS.indexOf(a.key) - PROFILE_COMPONENT_KEYS.indexOf(b.key));
}

export function getComponent(db: Db, versionId: string, key: ProfileComponentKey): ProfileComponent | null {
  const row = db.prepare('SELECT * FROM profile_component WHERE version_id = ? AND key = ?').get(versionId, key) as Row | undefined;
  return row ? ProfileComponent.parse(hydrate(row)) : null;
}

export function getDiff(db: Db, id: string): ProfileDiff | null {
  const row = db.prepare('SELECT * FROM profile_diff WHERE id = ?').get(id) as Row | undefined;
  return row ? ProfileDiff.parse(hydrate(row)) : null;
}

export function listDiffs(db: Db, status?: ProfileDiffStatus): ProfileDiff[] {
  const rows = (
    status
      ? db.prepare('SELECT * FROM profile_diff WHERE status = ? ORDER BY created_at ASC, id ASC').all(status)
      : db.prepare('SELECT * FROM profile_diff ORDER BY created_at ASC, id ASC').all()
  ) as Row[];
  return rows.map((r) => ProfileDiff.parse(hydrate(r)));
}

export function insertDiff(db: Db, d: ProfileDiff): void {
  db.prepare(
    `INSERT INTO profile_diff (id, created_at, component_key, base_version_id, diff_json, evidence_json, impact, status, decision_id, event_id, applied_version_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    d.id,
    d.created_at,
    d.component_key,
    d.base_version_id,
    JSON.stringify(d.diff_json),
    JSON.stringify(d.evidence_json),
    d.impact,
    d.status,
    d.decision_id,
    d.event_id,
    d.applied_version_id,
  );
}

export function updateDiff(
  db: Db,
  id: string,
  patch: Partial<Pick<ProfileDiff, 'status' | 'decision_id' | 'event_id' | 'applied_version_id'>>,
): void {
  const sets = Object.keys(patch).map((k) => `${k} = @${k}`);
  if (!sets.length) return;
  db.prepare(`UPDATE profile_diff SET ${sets.join(', ')} WHERE id = @id`).run({ ...patch, id });
}

export interface ComponentDraft {
  key: ProfileComponentKey;
  confidence: number;
  weight: number | null;
  data_json: Record<string, unknown>;
  md_path: string | null;
}

/**
 * Write a new version with all 11 components in one transaction.
 * Components not in `drafts` are copied from the parent (when there is one) or created empty.
 */
export function insertVersion(
  db: Db,
  args: {
    now: Date;
    parent_id: string | null;
    reason: string;
    event_id: string | null;
    drafts: Partial<Record<ProfileComponentKey, ComponentDraft>>;
  },
): { version: ProfileVersion; components: ProfileComponent[] } {
  const tx = db.transaction(() => {
    const version: ProfileVersion = {
      id: newId('pv', args.now),
      created_at: args.now.toISOString(),
      parent_id: args.parent_id,
      reason: args.reason,
      event_id: args.event_id,
    };
    // Guard against a same-ms created_at tie making "current" ambiguous: bump past the parent.
    if (args.parent_id) {
      const parent = getVersion(db, args.parent_id);
      if (parent && parent.created_at >= version.created_at) version.created_at = new Date(Date.parse(parent.created_at) + 1).toISOString();
    }
    db.prepare('INSERT INTO profile_version (id, created_at, parent_id, reason, event_id) VALUES (?, ?, ?, ?, ?)').run(
      version.id,
      version.created_at,
      version.parent_id,
      version.reason,
      version.event_id,
    );
    const parentComps = args.parent_id ? getComponents(db, args.parent_id) : [];
    const ins = db.prepare(
      'INSERT INTO profile_component (id, version_id, key, kind, confidence, weight, data_json, md_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const key of PROFILE_COMPONENT_KEYS) {
      const prev = parentComps.find((c) => c.key === key);
      const d: ComponentDraft =
        args.drafts[key] ??
        (prev
          ? { key, confidence: prev.confidence, weight: prev.weight, data_json: prev.data_json, md_path: prev.md_path }
          : { key, confidence: 0, weight: null, data_json: {}, md_path: null });
      ins.run(
        newId('pc', args.now),
        version.id,
        key,
        PROFILE_COMPONENT_KIND[key],
        Math.min(1, Math.max(0, d.confidence)),
        d.weight,
        JSON.stringify(d.data_json),
        d.md_path,
      );
    }
    return version;
  });
  const version = tx();
  return { version, components: getComponents(db, version.id) };
}

/** Roles a profile change should rescore: unapplied, not protected by no-downgrade. */
export function rescoreScope(db: Db): string[] {
  return (db.prepare(`SELECT id FROM role WHERE status IN ('active','held','on-deck') ORDER BY id`).all() as { id: string }[]).map(
    (r) => r.id,
  );
}
