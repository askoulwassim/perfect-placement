/*
 * Kev's model files in the Hugging Face hub cache, for `pp uninstall --purge`. Exactly:
 *   - every `models--jaredpalmer--kev-*` repo dir (the adapters / full weights Kev serves), and
 *   - the base model each of them pins in its own config (`training_config.json` / `provenance.json`:
 *     `base` + `base_revision`; else `adapter_config.json`: `base_model_name_or_path` + `revision`):
 *     only the pinned snapshot, or the whole dir when no revision is pinned or nothing else is in it,
 *   - and only the blobs those snapshots reference that no other snapshot in the cache references.
 * Anything shared with another model stays. Cache layout: <cache>/<repo>/{blobs,refs,snapshots/<sha>/...}
 * with snapshot files symlinked into blobs. Planning is read only; `applyHfPlan` deletes.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { SystemDeps } from './deps.js';

export const KEV_REPO_PREFIX = 'models--jaredpalmer--kev-';

/** The hub cache dir, as huggingface_hub resolves it: HF_HUB_CACHE, HF_HOME/hub, XDG_CACHE_HOME/huggingface/hub, ~/.cache/huggingface/hub. */
export function hfHubCache(d: Pick<SystemDeps, 'home' | 'env'>): string {
  const e = d.env;
  if (e.HF_HUB_CACHE) return e.HF_HUB_CACHE;
  if (e.HUGGINGFACE_HUB_CACHE) return e.HUGGINGFACE_HUB_CACHE;
  const hfHome = e.HF_HOME || join(e.XDG_CACHE_HOME || join(d.home, '.cache'), 'huggingface');
  return join(hfHome, 'hub');
}

/** `Qwen/Qwen3.5-4B-Base` -> `models--Qwen--Qwen3.5-4B-Base`. */
export const modelRepoDir = (id: string) => `models--${id.split('/').join('--')}`;

export interface BaseModelRef {
  id: string;
  revision: string | null;
  /** The Kev repo dir that pins it. */
  from: string;
}

const isHubId = (s: unknown): s is string => typeof s === 'string' && /^[\w.-]+\/[\w.-]+$/.test(s);

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** The base model one Kev snapshot pins, from its own config files. */
export function snapshotBase(snapshot: string): { id: string; revision: string | null } | null {
  const tc = readJson(join(snapshot, 'training_config.json'));
  const args = (tc?.args ?? null) as Record<string, unknown> | null;
  const prov = (readJson(join(snapshot, 'provenance.json'))?.config ?? null) as Record<string, unknown> | null;
  for (const [base, rev] of [
    [args?.base, tc?.base_revision ?? args?.base_revision],
    [prov?.base, prov?.base_revision],
  ]) {
    if (isHubId(base)) return { id: base, revision: str(rev) };
  }
  const ad = readJson(join(snapshot, 'adapter_config.json'));
  if (isHubId(ad?.base_model_name_or_path)) return { id: ad.base_model_name_or_path, revision: str(ad.revision) };
  return null;
}

const subdirs = (dir: string) => {
  try {
    return readdirSync(dir).filter((f) => {
      try {
        return statSync(join(dir, f)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
};

/** Every file path a snapshot points at (symlinks resolved), plus regular files in it. */
function snapshotRefs(dir: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const f of readdirSync(p)) walk(join(p, f));
      return;
    }
    try {
      out.push(realpathSync(p));
    } catch {
      // dangling link
    }
  };
  walk(dir);
  return out;
}

/** Every regular file under `dir` (no symlink following), as real paths. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    const st = lstatSync(p);
    if (st.isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
    else if (st.isFile()) out.push(p);
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

export interface HfRepoPlan {
  /** Repo dir name, e.g. models--jaredpalmer--kev-4b. */
  name: string;
  role: 'kev' | 'base';
  /** Why a base dir is included (which Kev pins it, at which revision). */
  why?: string;
  /** Whole dir goes (else only `snapshots`). */
  whole: boolean;
  snapshots: string[];
}

export interface HfPlan {
  cache: string;
  repos: HfRepoPlan[];
  /** Paths to delete, in order (dirs recursively). */
  remove: string[];
  /** Blobs kept because another model's snapshot references them. */
  keptShared: string[];
  bytes: number;
  /** Pinned base models not present in the cache (nothing to do). */
  notCached: string[];
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

/** Plan the deletion (read only). Empty when the cache or Kev's dirs do not exist. */
export function planHfCache(d: Pick<SystemDeps, 'home' | 'env'>): HfPlan {
  const configured = hfHubCache(d);
  const empty: HfPlan = { cache: configured, repos: [], remove: [], keptShared: [], bytes: 0, notCached: [] };
  if (!existsSync(configured)) return empty;
  const cache = realpathSync(configured);
  const repoNames = subdirs(cache).filter((n) => /^(models|datasets|spaces)--/.test(n));
  const kev = repoNames.filter((n) => n.startsWith(KEV_REPO_PREFIX));
  if (!kev.length) return { ...empty, cache };

  const snapshotsOf = (repo: string) => subdirs(join(cache, repo, 'snapshots'));
  // What goes: repo -> snapshot names (null = all).
  const targets = new Map<string, { role: 'kev' | 'base'; snaps: Set<string> | null; why: string[] }>();
  for (const k of kev) targets.set(k, { role: 'kev', snaps: null, why: [] });

  const notCached: string[] = [];
  for (const k of kev)
    for (const s of snapshotsOf(k)) {
      const base = snapshotBase(join(cache, k, 'snapshots', s));
      if (!base) continue;
      const repo = modelRepoDir(base.id);
      if (repo.startsWith(KEV_REPO_PREFIX)) continue;
      const label = `${base.id}${base.revision ? `@${base.revision.slice(0, 12)}` : ''}`;
      if (!repoNames.includes(repo)) {
        if (!notCached.includes(label)) notCached.push(label);
        continue;
      }
      const t = targets.get(repo) ?? { role: 'base' as const, snaps: new Set<string>(), why: [] };
      targets.set(repo, t);
      t.why.push(
        `${base.id} pinned by ${k.slice('models--'.length).replace('--', '/')}${base.revision ? ` @${base.revision.slice(0, 12)}` : ''}`,
      );
      if (t.snaps === null) continue;
      if (!base.revision) {
        t.snaps = null;
        continue;
      }
      const snaps = snapshotsOf(repo);
      let hit = snaps.find((x) => x === base.revision);
      if (!hit) {
        const ref = join(cache, repo, 'refs', base.revision);
        const sha = existsSync(ref) ? readFileSync(ref, 'utf8').trim() : null;
        hit =
          snaps.find((x) => x === sha) ??
          (snaps.filter((x) => x.startsWith(base.revision as string)).length === 1
            ? snaps.find((x) => x.startsWith(base.revision as string))
            : undefined);
      }
      if (hit) t.snaps.add(hit);
      else if (!notCached.includes(label)) notCached.push(label);
    }

  // Bases whose pinned revision is not cached drop out.
  for (const [repo, t] of targets) if (t.role === 'base' && t.snaps !== null && t.snaps.size === 0) targets.delete(repo);

  const removed = new Set<string>();
  const kept = new Set<string>();
  for (const repo of repoNames)
    for (const s of snapshotsOf(repo)) {
      const t = targets.get(repo);
      const going = t !== undefined && (t.snaps === null || t.snaps.has(s));
      for (const f of snapshotRefs(join(cache, repo, 'snapshots', s))) (going ? removed : kept).add(f);
    }

  const remove: string[] = [];
  const keptShared: string[] = [];
  let bytes = 0;
  const size = (f: string) => {
    try {
      return statSync(f).size;
    } catch {
      return 0;
    }
  };
  const repos: HfRepoPlan[] = [];
  for (const [repo, t] of targets) {
    const dir = join(cache, repo);
    const all = snapshotsOf(repo);
    const snaps = t.snaps === null ? all : all.filter((s) => t.snaps?.has(s));
    const whole = snaps.length === all.length;
    repos.push({ name: repo, role: t.role, whole, snapshots: snaps, ...(t.why.length ? { why: t.why.join('; ') } : {}) });
    if (whole) {
      const files = filesUnder(dir).map((f) => realpathSync(f));
      const shared = files.filter((f) => kept.has(f));
      for (const f of files) if (!kept.has(f)) bytes += size(f);
      if (!shared.length) {
        remove.push(dir);
        const lock = join(cache, '.locks', repo);
        if (existsSync(lock)) remove.push(lock);
      } else {
        keptShared.push(...shared);
        remove.push(join(dir, 'snapshots'));
        if (existsSync(join(dir, 'refs'))) remove.push(join(dir, 'refs'));
        for (const f of filesUnder(join(dir, 'blobs'))) if (!kept.has(realpathSync(f))) remove.push(f);
      }
      continue;
    }
    for (const s of snaps) remove.push(join(dir, 'snapshots', s));
    const refs = join(dir, 'refs');
    for (const r of filesUnder(refs)) if (snaps.includes(readFileSync(r, 'utf8').trim())) remove.push(r);
    for (const f of filesUnder(join(dir, 'blobs'))) {
      const real = realpathSync(f);
      if (removed.has(real) && !kept.has(real)) {
        remove.push(f);
        bytes += size(f);
      } else if (removed.has(real)) keptShared.push(real);
    }
  }
  // Blobs outside the target dirs (a shared blob store), still inside the cache.
  const repoDirs = repoNames.map((r) => join(cache, r));
  for (const f of removed)
    if (!kept.has(f) && inside(f, cache) && !repoDirs.some((dir) => inside(f, dir))) {
      remove.push(f);
      bytes += size(f);
    }
  for (const f of removed) if (kept.has(f) && !keptShared.includes(f)) keptShared.push(f);
  return { cache, repos, remove, keptShared: [...new Set(keptShared)], bytes, notCached };
}

/** Delete what the plan lists. Never anything outside the cache dir. */
export function applyHfPlan(plan: HfPlan): { removed: number; failed: string[] } {
  let removed = 0;
  const failed: string[] = [];
  for (const p of plan.remove) {
    if (!inside(p, plan.cache) || p === plan.cache) {
      failed.push(`${p} (outside ${plan.cache})`);
      continue;
    }
    try {
      rmSync(p, { recursive: true, force: true });
      removed++;
    } catch (e) {
      failed.push(`${p} (${(e as Error).message})`);
    }
  }
  return { removed, failed };
}

export const formatBytes = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
