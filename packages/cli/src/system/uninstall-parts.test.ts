/*
 * pp uninstall building blocks on synthetic data in temp dirs: the Hugging Face cache selection
 * (Kev dirs, pinned bases, only unshared blobs), the tar.gz backup (readable by the system tar),
 * and the Codex TOML removal. Nothing reads or writes the real ~/.cache/huggingface.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTarGz, writeTarGz } from './backup.js';
import { removeCodexToml, renderCodexBlock, upsertCodexToml } from './clients.js';
import { applyHfPlan, hfHubCache, planHfCache } from './hf-cache.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pp-uninst-parts-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sha = (c: string) => c.repeat(40).slice(0, 40);

/** One repo dir in a synthetic hub cache: blobs by hash, snapshots of file -> blob hash (or an absolute link target). */
function repo(
  cache: string,
  name: string,
  spec: { blobs?: Record<string, string>; snapshots: Record<string, Record<string, string>>; refs?: Record<string, string> },
) {
  const dir = join(cache, name);
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  for (const [h, content] of Object.entries(spec.blobs ?? {})) writeFileSync(join(dir, 'blobs', h), content);
  for (const [s, files] of Object.entries(spec.snapshots)) {
    mkdirSync(join(dir, 'snapshots', s), { recursive: true });
    for (const [f, target] of Object.entries(files))
      symlinkSync(target.startsWith('/') ? target : `../../blobs/${target}`, join(dir, 'snapshots', s, f));
  }
  for (const [r, s] of Object.entries(spec.refs ?? {})) {
    mkdirSync(join(dir, 'refs'), { recursive: true });
    writeFileSync(join(dir, 'refs', r), s);
  }
  return dir;
}

const trainingConfig = (base: string, rev: string) => JSON.stringify({ args: { base, base_revision: rev }, base_revision: rev });

describe('Hugging Face cache: Kev dirs, their pinned bases, unshared blobs only', () => {
  it('resolves the cache dir like huggingface_hub', () => {
    expect(hfHubCache({ home: '/h', env: {} })).toBe('/h/.cache/huggingface/hub');
    expect(hfHubCache({ home: '/h', env: { XDG_CACHE_HOME: '/x' } })).toBe('/x/huggingface/hub');
    expect(hfHubCache({ home: '/h', env: { HF_HOME: '/hf' } })).toBe('/hf/hub');
    expect(hfHubCache({ home: '/h', env: { HF_HOME: '/hf', HF_HUB_CACHE: '/c' } })).toBe('/c');
  });

  it('selects exactly the Kev dirs, the pinned base snapshot and the blobs nothing else uses', () => {
    const home = join(root, 'home');
    const cache = join(home, '.cache', 'huggingface', 'hub');
    const r1 = sha('a');
    const r2 = sha('b');
    // kev-4b pins Qwen 4B base at r1 (training_config.json); kev-0.8b names its base only in adapter_config.json.
    const kev4 = repo(cache, 'models--jaredpalmer--kev-4b', {
      blobs: { k1: trainingConfig('Qwen/Qwen3.5-4B-Base', r1), k2: 'adapter' },
      snapshots: { [sha('c')]: { 'training_config.json': 'k1', 'adapter_model.safetensors': 'k2' } },
      refs: { main: sha('c') },
    });
    const kev08 = repo(cache, 'models--jaredpalmer--kev-0.8b', {
      blobs: { j1: JSON.stringify({ base_model_name_or_path: 'Qwen/Qwen3.5-0.8B-Base', revision: null }) },
      snapshots: { [sha('d')]: { 'adapter_config.json': 'j1' } },
    });
    // The 4B base has the pinned snapshot r1 and another revision r2 that shares one blob.
    const base4 = repo(cache, 'models--Qwen--Qwen3.5-4B-Base', {
      blobs: { shared: 'tokenizer', only: 'weights-r1'.repeat(100), other: 'weights-r2' },
      snapshots: {
        [r1]: { 'tokenizer.json': 'shared', 'model.safetensors': 'only' },
        [r2]: { 'tokenizer.json': 'shared', 'model.safetensors': 'other' },
      },
      refs: { main: r2, pinned: r1 },
    });
    const base08 = repo(cache, 'models--Qwen--Qwen3.5-0.8B-Base', {
      blobs: { q: 'small-weights' },
      snapshots: { [sha('e')]: { 'model.safetensors': 'q' } },
    });
    mkdirSync(join(cache, '.locks', 'models--Qwen--Qwen3.5-0.8B-Base'), { recursive: true });
    // Unrelated model: never touched.
    const unrelated = repo(cache, 'models--someone--else', { blobs: { u: 'u' }, snapshots: { [sha('f')]: { 'x.bin': 'u' } } });

    const plan = planHfCache({ home, env: {} });
    expect(plan.repos.map((r) => [r.name, r.role, r.whole]).sort()).toEqual(
      [
        ['models--Qwen--Qwen3.5-0.8B-Base', 'base', true],
        ['models--Qwen--Qwen3.5-4B-Base', 'base', false],
        ['models--jaredpalmer--kev-0.8b', 'kev', true],
        ['models--jaredpalmer--kev-4b', 'kev', true],
      ].sort(),
    );
    expect(plan.keptShared.some((f) => f.endsWith('/blobs/shared'))).toBe(true);
    expect(plan.bytes).toBeGreaterThan(1000);
    // Planning changed nothing.
    expect(existsSync(kev4)).toBe(true);

    const r = applyHfPlan(plan);
    expect(r.failed).toEqual([]);
    expect(existsSync(kev4)).toBe(false);
    expect(existsSync(kev08)).toBe(false);
    expect(existsSync(base08)).toBe(false);
    expect(existsSync(join(cache, '.locks', 'models--Qwen--Qwen3.5-0.8B-Base'))).toBe(false);
    // 4B base: only the pinned snapshot, its own blob and its ref go; r2, the shared blob and refs/main stay.
    expect(existsSync(join(base4, 'snapshots', r1))).toBe(false);
    expect(existsSync(join(base4, 'blobs', 'only'))).toBe(false);
    expect(existsSync(join(base4, 'refs', 'pinned'))).toBe(false);
    expect(readFileSync(join(base4, 'snapshots', r2, 'tokenizer.json'), 'utf8')).toBe('tokenizer');
    expect(readFileSync(join(base4, 'snapshots', r2, 'model.safetensors'), 'utf8')).toBe('weights-r2');
    expect(readFileSync(join(base4, 'refs', 'main'), 'utf8')).toBe(r2);
    expect(readFileSync(join(unrelated, 'snapshots', sha('f'), 'x.bin'), 'utf8')).toBe('u');
    // Idempotent.
    expect(planHfCache({ home, env: {} }).remove).toEqual([]);
  });

  it('keeps a blob in a Kev dir that another model links to; lists pinned bases that are not cached', () => {
    const cache = join(root, 'hub');
    const kev = repo(cache, 'models--jaredpalmer--kev-9b', {
      blobs: { cfg: trainingConfig('Qwen/Qwen3.5-9B-Base', sha('9')), tok: 'tokenizer', w: 'adapter' },
      snapshots: { [sha('1')]: { 'training_config.json': 'cfg', 'tokenizer.json': 'tok', 'adapter.bin': 'w' } },
    });
    const other = repo(cache, 'models--someone--uses-kev-tokenizer', {
      snapshots: { [sha('2')]: { 'tokenizer.json': join(kev, 'blobs', 'tok') } },
    });
    const plan = planHfCache({ home: root, env: { HF_HUB_CACHE: cache } });
    expect(plan.notCached).toEqual([`Qwen/Qwen3.5-9B-Base@${sha('9').slice(0, 12)}`]);
    applyHfPlan(plan);
    expect(existsSync(join(kev, 'snapshots'))).toBe(false);
    expect(existsSync(join(kev, 'blobs', 'w'))).toBe(false);
    expect(readFileSync(join(other, 'snapshots', sha('2'), 'tokenizer.json'), 'utf8')).toBe('tokenizer');
  });

  it('no cache, or no Kev in it: nothing to do', () => {
    expect(planHfCache({ home: root, env: {} }).remove).toEqual([]);
    const cache = join(root, 'hub');
    repo(cache, 'models--Qwen--Qwen3.5-4B-Base', { blobs: { a: 'a' }, snapshots: { [sha('a')]: { a: 'a' } } });
    expect(planHfCache({ home: root, env: { HF_HUB_CACHE: cache } }).remove).toEqual([]);
  });
});

describe('vault backup tar.gz', () => {
  it('writes 0600, skips excluded paths, and reads back with this reader and the system tar', async () => {
    const vault = join(root, '.perfect-placement');
    mkdirSync(join(vault, 'roles'), { recursive: true });
    mkdirSync(join(vault, 'kev', 'repo', '.venv'), { recursive: true });
    writeFileSync(join(vault, 'pp.db'), Buffer.alloc(1500, 7));
    writeFileSync(join(vault, 'config.json'), '{}\n');
    const long = `${'a-very-long-role-file-name-'.repeat(6)}.md`;
    writeFileSync(join(vault, 'roles', long), '---\nid: x\n---\n');
    writeFileSync(join(vault, 'kev', 'installed.json'), '{}');
    writeFileSync(join(vault, 'kev', 'repo', 'big.py'), 'x');
    symlinkSync('config.json', join(vault, 'link.json'));
    const out = join(root, 'b', 'vault.tar.gz');
    mkdirSync(join(root, 'b'));
    const w = await writeTarGz(vault, out, (rel) => rel === 'kev/repo');
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const names = await listTarGz(out);
    expect(names.length).toBe(w.entries);
    expect(names).toContain('.perfect-placement/pp.db');
    expect(names).toContain(`.perfect-placement/roles/${long}`);
    expect(names).toContain('.perfect-placement/kev/installed.json');
    expect(names.some((n) => n.includes('kev/repo'))).toBe(false);
    await expect(writeTarGz(vault, out)).rejects.toThrow(); // never overwrites

    const x = join(root, 'x');
    mkdirSync(x);
    const tar = spawnSync('tar', ['-xzf', out, '-C', x], { encoding: 'utf8' });
    expect(tar.status).toBe(0);
    expect(readFileSync(join(x, '.perfect-placement', 'pp.db'))).toEqual(Buffer.alloc(1500, 7));
    expect(readFileSync(join(x, '.perfect-placement', 'roles', long), 'utf8')).toContain('id: x');
    expect(readFileSync(join(x, '.perfect-placement', 'link.json'), 'utf8')).toBe('{}\n');

    writeFileSync(join(root, 'cut.tar.gz'), readFileSync(out).subarray(0, 40));
    await expect(listTarGz(join(root, 'cut.tar.gz'))).rejects.toThrow();
  });
});

describe('Codex config.toml: removing [mcp_servers.pp]', () => {
  const pp = renderCodexBlock({ command: '/n/node', args: ['/r/bin.js'], env: { PP_HOME: '/v' } });
  it('drops the table and its sub-tables, keeps everything else', () => {
    const text = `model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n${pp}\n\n[mcp_servers.pp.env]\nA = "1"\n\n[profiles.fast]\nmodel = "m"\n`;
    expect(removeCodexToml(text)).toBe('model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n\n[profiles.fast]\nmodel = "m"\n');
    expect(removeCodexToml(upsertCodexToml('', pp))).toBe('');
    expect(removeCodexToml(upsertCodexToml('model = "o3"\n', pp))).toBe('model = "o3"\n');
  });
  it('dotted and inline forms; a file without pp is returned byte for byte', () => {
    expect(removeCodexToml('mcp_servers.pp = { command = "n" }\nx = 1\n')).toBe('x = 1\n');
    expect(removeCodexToml('[mcp_servers]\npp = { command = "n" }\nppx = { command = "y" }\n')).toBe(
      '[mcp_servers]\nppx = { command = "y" }\n',
    );
    const keep = '# no pp here\n[mcp_servers.ppx]\ncommand = "y"\n\n\n';
    expect(removeCodexToml(keep)).toBe(keep);
  });
});
