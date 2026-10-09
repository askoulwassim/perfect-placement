/*
 * `pp up` smoke test, CI-safe: the real engine on a temp copy of the fixture vault, an ephemeral
 * loopback port, a stub web dist. No network beyond loopback, no Kev, no runner spawn.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OP_NAMES } from '@perfect-placement/contracts';
import { ops } from '@perfect-placement/engine';
import { type FixtureEngine, fakeBackend, fakeLauncher, noNetwork, openFixtureEngine } from '@perfect-placement/engine/testing';
import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { checkKev, type Running, up } from './commands/up.js';
import type { Io } from './io.js';

let engine: FixtureEngine;
let running: Running;
let web: string;

beforeAll(async () => {
  engine = openFixtureEngine();
  web = mkdtempSync(join(tmpdir(), 'pp-web-'));
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>pp stub</title><div id="root"></div>');
  mkdirSync(join(web, 'assets'));
  writeFileSync(join(web, 'assets', 'app.js'), 'console.log("pp")');
  running = await up({ engine, port: 0, webDir: web });
});
afterAll(async () => {
  await running.close();
  engine.cleanup();
  rmSync(web, { recursive: true, force: true });
});

const post = (path: string, body: string) =>
  fetch(`${running.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

describe('pp up (in-process smoke)', () => {
  it('binds to loopback on an ephemeral port', () => {
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('POST /api/ops/:name runs the op with the JSON body as input and actor human', async () => {
    const res = await post('/api/ops/roles.get', JSON.stringify({ role_id: FIXTURE_ROLE_IDS.rampIv }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { status: string; output: { role: { id: string } } };
    expect(out).toMatchObject({ status: 'ok', output: { role: { id: FIXTURE_ROLE_IDS.rampIv } } });
    const summary = await post('/api/ops/pipeline.summary', '');
    expect(((await summary.json()) as { output: { counts: { active: number } } }).output.counts.active).toBeGreaterThan(0);
    // Human-only op: a human caller runs it (an agent would get requires_human).
    const submitted = await post('/api/ops/apply.mark_submitted', JSON.stringify({ role_id: FIXTURE_ROLE_IDS.vercelDraft }));
    expect(((await submitted.json()) as { status: string }).status).toBe('ok');
  });

  it('maps errors: 404 unknown op, 400 bad JSON, op errors by code, 405 wrong method', async () => {
    const unknown = await post('/api/ops/roles.delete_everything', '{}');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ status: 'error', code: 'not_found' });
    const bad = await post('/api/ops/roles.list', '{nope');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ status: 'error', code: 'invalid_input' });
    const missing = await post('/api/ops/roles.get', JSON.stringify({ role_id: 'nope' }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ status: 'error', code: 'not_found' });
    const invalid = await post('/api/ops/roles.get', JSON.stringify({}));
    expect(invalid.status).toBe(400);
    expect((await fetch(`${running.url}/api/ops/roles.list`)).status).toBe(405);
    expect((await fetch(`${running.url}/api/nope`)).status).toBe(404);
  });

  it('lists ops', async () => {
    const list = (await (await fetch(`${running.url}/api/ops`)).json()) as { name: string; implemented: boolean }[];
    expect(list.find((o) => o.name === 'roles.list')?.implemented).toBe(true);
    expect(list.find((o) => o.name === 'outreach.send')?.implemented).toBe(false);
  });

  it('serves MCP Streamable HTTP at /mcp as an agent', async () => {
    const client = new Client({ name: 'pp-up-smoke', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`)));
    const { tools } = await client.listTools();
    expect(tools.length).toBe(OP_NAMES.length);
    expect(tools.map((t) => t.name)).toContain('roles_list');
    const res = await client.callTool({ name: 'apply_mark_submitted', arguments: { role_id: FIXTURE_ROLE_IDS.linearDraft } });
    expect((res.structuredContent as { status: string }).status).toBe('requires_human');
    await client.close();
  });

  it('serves the web build with SPA fallback; missing assets are 404', async () => {
    const root = await fetch(`${running.url}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(await root.text()).toContain('pp stub');
    const route = await fetch(`${running.url}/roles/some-role`);
    expect(await route.text()).toContain('pp stub');
    const asset = await fetch(`${running.url}/assets/app.js`);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${running.url}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${running.url}/..%2f..%2fetc%2fpasswd`)).status).not.toBe(500);
  });

  it('refuses non-loopback Host headers (DNS rebinding) and non-loopback binds', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${running.url}/api/ops/roles.list`, { method: 'POST', headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(403);
    await expect(up({ engine, port: 0, host: '0.0.0.0', webDir: null })).rejects.toThrow(/loopback/);
  });

  it('--kev only checks reachability; system.backends tells not installed from down (#40)', async () => {
    const r = await checkKev(engine); // the fixture engine's Kev is a fake that is down, and PP_HOME has no Kev
    expect(r.ok).toBe(false);
    expect(r.line).toContain('kev: not installed (run pp kev install)');
    mkdirSync(join(engine.home, 'kev'), { recursive: true });
    writeFileSync(join(engine.home, 'kev', 'installed.json'), '{}');
    expect((await checkKev(engine)).line).toMatch(/^kev: unreachable at /);
  });
});

describe('pp up command', () => {
  it('starts on a fixtures vault, reports Kev, and shuts down cleanly closing the engine', async () => {
    const out: string[] = [];
    let stop: () => void = () => {};
    const stopped = new Promise<void>((r) => {
      stop = r;
    });
    const io: Io = {
      env: {},
      out: (l) => out.push(l),
      err: (l) => out.push(l),
      stdin: () => '',
      services: { fetch: noNetwork, launcher: fakeLauncher(), backends: { kev: fakeBackend('kev', 'down') }, freshnessDelayMs: 0, env: {} },
    };
    const code = runCli(['up', '--fixtures', '--port', '0', '--web', 'none', '--kev'], io, async () => {
      const url = /pp up: (http:\/\/127\.0\.0\.1:\d+)/.exec(out.join('\n'))?.[1] as string;
      const res = await fetch(`${url}/api/ops/roles.list`, { method: 'POST', body: '{"limit":1}' });
      expect(((await res.json()) as { status: string }).status).toBe('ok');
      expect((await fetch(`${url}/`)).status).toBe(404);
      stop();
      await stopped;
    });
    expect(await code).toBe(0);
    expect(out.join('\n')).toMatch(/kev: unreachable/);
    expect(out.at(-1)).toBe('pp up: stopped');
    const home = /fixtures demo \(synthetic data, offline\) at (\S+)/.exec(out.join('\n'))?.[1] as string;
    rmSync(dirname(home), { recursive: true, force: true });
  });
});

describe('pp up: interrupted runs (#21)', () => {
  it('on startup, a run left running whose runner is gone is finished as error "interrupted"', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pp-up-stale-'));
    const home = join(tmp, 'vault');
    const out: string[] = [];
    const services = {
      fetch: noNetwork,
      launcher: fakeLauncher(),
      backends: { kev: fakeBackend('kev', 'down') },
      freshnessDelayMs: 0,
      env: {},
    };
    const base: Io = { env: {}, out: (l) => out.push(l), err: (l) => out.push(l), stdin: () => '', services };
    try {
      expect(await runCli(['init', '--home', home], base)).toBe(0);
      // A previous pp up launched two runs an hour ago; one runner is still alive.
      const prev = ops.openEngine({ home, services });
      const hourAgo = () => new Date(Date.now() - 3_600_000);
      const start = async (skill: string) => {
        const o = await prev.runOp('runs.start', { skill }, { actor: 'human', now: hourAgo });
        return (o as { output: { run: { id: string } } }).output.run.id;
      };
      const dead = await start('scout');
      const alive = await start('inbox');
      prev.close();

      const io: Io = { ...base, runnerAlive: (id) => id === alive };
      const statusOf = async (url: string, id: string) => {
        const res = await fetch(`${url}/api/ops/runs.get`, { method: 'POST', body: JSON.stringify({ run_id: id }) });
        return ((await res.json()) as { output: { run: { status: string; summary_json: { error?: string } } } }).output.run;
      };
      let stop: () => void = () => {};
      const stopped = new Promise<void>((r) => {
        stop = r;
      });
      const code = runCli(['up', '--home', home, '--port', '0', '--web', 'none', '--no-kev'], io, async () => {
        const url = /pp up: (http:\/\/127\.0\.0\.1:\d+)/.exec(out.join('\n'))?.[1] as string;
        expect(await statusOf(url, dead)).toMatchObject({ status: 'error', summary_json: { error: 'interrupted' } });
        expect((await statusOf(url, alive)).status).toBe('running');
        stop();
        await stopped;
      });
      expect(await code).toBe(0);
      expect(out.join('\n')).toContain(`pp up: 1 interrupted run marked error (${dead})`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('run queue (#30): pp drain and pp up launch queued runs', () => {
  it('a run queued while nothing dispatched is launched by pp drain once, and by pp up on start', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pp-drain-'));
    const home = join(tmp, 'vault');
    const out: string[] = [];
    const launcher = fakeLauncher();
    const services = { fetch: noNetwork, launcher, backends: { kev: fakeBackend('kev', 'down') }, freshnessDelayMs: 0, env: {} };
    const io: Io = { env: {}, out: (l) => out.push(l), err: (l) => out.push(l), stdin: () => '', services, runnerAlive: () => true };
    const queue = (id: string, skill: string) => {
      const e = ops.openEngine({ home, services });
      const at = new Date().toISOString();
      e.db
        .prepare(
          `INSERT INTO run (id, op, started_at, finished_at, status, summary_json, log_path) VALUES (?, ?, ?, NULL, 'queued', ?, NULL)`,
        )
        .run(id, skill, at, JSON.stringify({ skill, actor: 'schedule', runner: 'claude', queued_at: at }));
      e.close();
    };
    try {
      expect(await runCli(['init', '--home', home], io)).toBe(0);
      queue('rn_q1', 'inbox');
      expect(await runCli(['drain', '--home', home], io)).toBe(0);
      expect(out.at(-1)).toBe('pp drain: 1 launched (rn_q1), 0 queued');
      expect(launcher.specs.map((s) => s.runId)).toEqual(['rn_q1']);
      expect(await runCli(['drain', '--home', home], io)).toBe(0);
      expect(out.at(-1)).toBe('pp drain: 0 launched, 0 queued');

      queue('rn_q2', 'learn');
      const code = runCli(['up', '--home', home, '--port', '0', '--web', 'none', '--no-kev'], io, async () => {});
      expect(await code).toBe(0);
      expect(out).toContain('pp up: launched 1 queued run');
      expect(launcher.specs.map((s) => s.runId)).toEqual(['rn_q1', 'rn_q2']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
