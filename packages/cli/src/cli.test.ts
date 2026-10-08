import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ops } from '@perfect-placement/engine';
import { openFixtureEngine } from '@perfect-placement/engine/ops/testing';
import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { up } from './commands/up.js';
import type { Io } from './io.js';

let home: string;
let out: string[];
let err: string[];
let io: Io;

beforeEach(() => {
  const e = openFixtureEngine();
  home = e.home;
  e.close();
  out = [];
  err = [];
  io = { env: { PP_HOME: home }, out: (l) => out.push(l), err: (l) => err.push(l), stdin: () => '[]' };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const lastJson = () => JSON.parse(out.at(-1) as string);

describe('pp', () => {
  it('prints usage and rejects unknown commands', async () => {
    expect(await runCli([], io)).toBe(0);
    expect(out[0]).toContain('pp <command>');
    expect(await runCli(['nope'], io)).toBe(1);
  });

  it('scout: runs.start -> roles.add -> runs.finish, with a coverage log in PP_HOME/runs', async () => {
    const file = join(home, 'candidates.json');
    writeFileSync(file, JSON.stringify({ candidates: [{ company_name: 'Acme', title: 'Staff PM, AI', source: 'scout' }] }));
    expect(await runCli(['scout', '--in', file, '--note', 'greenhouse: staff pm ai'], io)).toBe(0);
    expect(lastJson()).toMatchObject({ status: 'ok', output: { added: ['acme_staff-pm-ai'] } });
    const logs = readdirSync(join(home, 'runs')).filter((f) => f.endsWith('_scout.md'));
    const md = logs.map((f) => readFileSync(join(home, 'runs', f), 'utf8')).find((m) => m.includes('## roles.add')) ?? '';
    expect(md).toContain('acme_staff-pm-ai');
    expect(md).toContain('greenhouse: staff pm ai');
  });

  it('inbox reads stdin; op runs any op; actor defaults to agent', async () => {
    io.stdin = () =>
      JSON.stringify([
        {
          message_id: 'c1',
          received_at: '2026-10-08T07:00:00.000Z',
          role_id: FIXTURE_ROLE_IDS.linearDraft,
          class: 'confirmation',
          p: 0.97,
        },
      ]);
    expect(await runCli(['inbox', '--in', '-', '--home', home], io)).toBe(0);
    expect(lastJson().output.applied[0].to).toBe('applied');
    expect(await runCli(['op', 'roles.get', '--input', JSON.stringify({ role_id: FIXTURE_ROLE_IDS.linearDraft })], io)).toBe(0);
    expect(lastJson().output.role.status).toBe('applied');
    expect(await runCli(['op', 'apply.mark_submitted', '--input', JSON.stringify({ role_id: FIXTURE_ROLE_IDS.vercelDraft })], io)).toBe(0);
    expect(lastJson().status).toBe('requires_human');
  });

  it('score, fresh and doctor pass through to lanes F, G and A (unimplemented until merged)', async () => {
    const file = join(home, 'scores.json');
    writeFileSync(file, '[]');
    expect(await runCli(['score', '--in', file], io)).toBe(0);
    expect(await runCli(['fresh', '--role', FIXTURE_ROLE_IDS.datadogActive], io)).toBe(1);
    expect(lastJson()).toMatchObject({ code: 'unimplemented' });
    expect(await runCli(['doctor'], io)).toBe(1);
    expect(lastJson().message).toContain('lane A');
  });

  it('bad input is a usage error', async () => {
    expect(await runCli(['scout'], io)).toBe(2);
    expect(err[0]).toContain('--in');
  });
});

describe('pp up', () => {
  it('serves the op list and runs ops over HTTP', async () => {
    const engine = ops.openEngine({ home });
    const running = await up({ engine, port: 0, webDir: null });
    try {
      const list = (await (await fetch(`${running.url}/api/ops`)).json()) as { name: string; implemented: boolean }[];
      expect(list.find((o) => o.name === 'roles.list')?.implemented).toBe(true);
      expect(list.find((o) => o.name === 'outreach.send')?.implemented).toBe(false);
      const res = await fetch(`${running.url}/api/ops/pipeline.summary`, { method: 'POST', body: JSON.stringify({ input: {} }) });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { output: { counts: { active: number } } }).output.counts.active).toBeGreaterThan(0);
      const bad = await fetch(`${running.url}/api/ops/roles.get`, { method: 'POST', body: JSON.stringify({ input: { role_id: 'nope' } }) });
      expect(bad.status).toBe(404);
      const queued = await fetch(`${running.url}/api/ops/apply.mark_submitted`, {
        method: 'POST',
        body: JSON.stringify({ actor: 'agent', input: { role_id: FIXTURE_ROLE_IDS.vercelDraft } }),
      });
      expect(queued.status).toBe(202);
      expect((await fetch(`${running.url}/mcp`)).status).toBe(501);
    } finally {
      await running.close();
      engine.close();
    }
  });
});
