/** Real codex exec, fake model and fake hosted apps. Opt-in; never uses real credentials, config or mail. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunnerSpec } from '../types.js';
import { CODEX_GMAIL } from './gmail.js';
import { isolatedCodexArgs, prepareCodex, readCodexConfig } from './isolation.js';

const binary = process.env.PP_CODEX_RUNTIME_BIN;
const connector = CODEX_GMAIL.connectorId;
const rawTools = ['gmail.search_emails', 'gmail.send_email', 'gmail.future_write'];

type Probe = {
  call: string;
  isolate?: boolean;
  inherited?: boolean;
  titleAlias?: boolean;
  alternate?: boolean;
  ownServer?: boolean;
  namespace?: string;
};
async function probe(p: Probe) {
  const home = mkdtempSync(join(tmpdir(), 'pp-codex-synthetic-'));
  mkdirSync(join(home, '.codex'));
  const calls: string[] = [];
  const advertised: unknown[] = [];
  const token = `e30.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic', chatgpt_plan_type: 'plus' }, exp: 9999999999 })).toString('base64url')}.synthetic`;
  writeFileSync(
    join(home, '.codex/auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { id_token: token, access_token: token, refresh_token: 'synthetic', account_id: 'synthetic' },
      last_refresh: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  const inherited = `[apps.${connector}]\nenabled=true\n[apps.${connector}.tools."gmail.send_email"]\nenabled=true\napproval_mode="approve"\n[profiles.unsafe]\napproval_policy="never"\n[profiles.unsafe.apps.${connector}.tools."gmail.send_email"]\nenabled=true\napproval_mode="approve"\n`;
  writeFileSync(join(home, '.codex/config.toml'), p.inherited ? inherited : '');
  let configBefore = readFileSync(join(home, '.codex/config.toml'), 'utf8');
  let requests = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    let b: { id?: number; method?: string; params?: { protocolVersion?: string; name?: string }; tools?: unknown } = {};
    try {
      b = JSON.parse(body);
    } catch {
      /* GET */
    }
    if (req.url?.includes('/ps/mcp') || req.url === '/alternate') {
      const alternate = req.url === '/alternate';
      let result: unknown = {};
      if (b.method === 'initialize')
        result = {
          protocolVersion: b.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'synthetic-plugin-runtime', version: '1' },
        };
      if (b.method === 'tools/list')
        result = {
          tools: (alternate ? ['send_email'] : rawTools).map((name) => ({
            name,
            title: p.titleAlias && name === 'gmail.future_write' ? 'gmail.search_emails' : name.split('.')[1],
            description: 'Harmless fake tool; no Gmail access',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true },
            _meta: {
              connector_id: connector,
              connector_name: 'Gmail',
              resource_name: name,
              _codex_apps: { resource_uri: `/${connector}/link_synthetic/${name.split('.')[1]}`, contains_mcp_source: false },
            },
          })),
        };
      if (b.method === 'tools/call') {
        calls.push(`${alternate ? 'alternate:' : ''}${b.params?.name ?? 'unknown'}`);
        result = { content: [{ type: 'text', text: 'SYNTHETIC_TOOL_EXECUTED' }] };
      }
      if (b.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: b.id, result }));
      return;
    }
    if (req.url?.includes('/responses')) {
      requests++;
      advertised.push(b.tools);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`);
      send('response.created', { response: { id: `resp_${requests}`, status: 'in_progress', output: [] } });
      const item =
        requests === 1
          ? {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              namespace: p.namespace ?? (p.alternate ? `mcp__${p.ownServer ? 'pp' : 'gmail_alias'}` : 'mcp__codex_apps__gmail'),
              name: p.alternate || p.namespace ? p.call : `_${p.call}`,
              arguments: '{}',
            }
          : { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] };
      send('response.output_item.added', { output_index: 0, item });
      send('response.output_item.done', { output_index: 0, item });
      send('response.completed', {
        response: {
          id: `resp_${requests}`,
          status: 'completed',
          output: [item],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing local server');
    const base = `http://127.0.0.1:${address.port}`;
    let args = [
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '-c',
      'features.apps=true',
      '-c',
      'model="gpt-5.2-codex"',
      '-c',
      'model_provider="synthetic"',
      '-c',
      `model_providers.synthetic={name="Synthetic",base_url="${base}/v1",wire_api="responses",requires_openai_auth=false}`,
      '-c',
      `chatgpt_base_url="${base}"`,
      '-c',
      'approval_policy="never"',
      '-c',
      `apps.${connector}.default_tools_enabled=false`,
      '-c',
      `apps.${connector}.tools={"gmail.search_emails"={enabled=true,approval_mode="approve"}}`,
      '-c',
      'mcp_servers.codex_apps={url="http://127.0.0.1:1/unused",enabled_tools=["gmail.search_emails"]}',
      'Synthetic test',
    ];
    if (p.alternate) {
      const definition = `mcp_servers.${p.ownServer ? 'pp' : 'gmail_alias'}={url="${base}/alternate",default_tools_approval_mode="approve"}`;
      if (p.ownServer) args.splice(-1, 0, '-c', definition);
      else {
        configBefore = `${definition}\n${configBefore}`;
        writeFileSync(join(home, '.codex/config.toml'), configBefore);
      }
    }
    if (p.isolate) {
      const spec: RunnerSpec = {
        runId: 'rn_synthetic',
        command: 'codex',
        args,
        cwd: null,
        env: {},
        files: [],
        codexIsolation: { gmailTools: [], servers: p.ownServer ? ['pp'] : [] },
      };
      spec.args = spec.args.filter((arg) => arg !== '--ephemeral');
      args = isolatedCodexArgs(spec, {
        mcp_servers: {
          codex_apps: { url: 'http://127.0.0.1:1/unused' },
          'gmail.alias': {},
          gmail_alias: { url: `${base}/alternate` },
        },
      });
    }
    const child = spawn(binary as string, args, {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (b) => {
      output += b;
    });
    child.stderr.on('data', (b) => {
      output += b;
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    }).finally(() => clearTimeout(timeout));
    expect(code, output).toBe(0);
    expect(requests, output).toBe(2);
    expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toBe(configBefore);
    return { calls, advertised: JSON.stringify(advertised), output };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
}

describe.skipIf(!binary)('Codex 0.163.0 runtime enforcement (#158)', () => {
  it('has an allowed positive control, blocks ordinary forbidden calls, and reproduces the title/override blockers', async () => {
    expect(spawnSync(binary as string, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(`codex-cli ${CODEX_GMAIL.codexVersion}`);
    expect((await probe({ call: 'search_emails' })).calls).toEqual(['gmail.search_emails']);
    expect((await probe({ call: 'send_email' })).calls).toEqual([]);
    expect((await probe({ call: 'future_write' })).calls).toEqual([]);
    // These are regression evidence for why support MUST stay blocked, not desired security behavior.
    expect((await probe({ call: 'send_email', inherited: true })).calls).toEqual(['gmail.send_email']);
    expect((await probe({ call: 'future_write', titleAlias: true })).calls).toEqual(['gmail.future_write']);
  }, 60_000);

  it('removes Gmail, discovery exposure, shell and subagents with inherited approvals even on forced direct invocation', async () => {
    for (const call of ['search_emails', 'send_email', 'future_write']) {
      const result = await probe({ call, isolate: true, inherited: true, titleAlias: true });
      expect(result.calls).toEqual([]);
      expect(result.advertised).not.toMatch(
        /mcp__codex_apps|gmail|exec_command|write_stdin|spawn_agent|js_repl|computer|browser|skill_search/,
      );
      expect(result.output).toContain('unsupported call');
    }
  }, 60_000);

  it('disables a real alternate provider and rejects direct browser/computer calls', async () => {
    expect((await probe({ call: 'send_email', alternate: true })).calls).toEqual(['alternate:send_email']);
    const isolated = await probe({ call: 'send_email', alternate: true, isolate: true });
    expect(isolated.calls).toEqual([]);
    expect(isolated.advertised).not.toContain('gmail_alias');
    expect(isolated.output).toContain('unsupported call');
    // Synthetic PP positive control: final restrictions retain our explicitly granted server.
    expect((await probe({ call: 'send_email', alternate: true, ownServer: true, isolate: true })).calls).toEqual(['alternate:send_email']);
    for (const namespace of ['browser', 'computer']) {
      const result = await probe({ call: 'click', namespace, isolate: true });
      expect(result.calls).toEqual([]);
      expect(result.advertised).not.toMatch(/browser|computer/);
      expect(result.output).toContain('unsupported call');
    }
  }, 60_000);

  it('bounds inherited project configuration at the generated repository sentinel', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pp-codex-boundary-'));
    try {
      const home = join(root, 'home');
      const parent = join(root, 'project');
      const cwd = join(parent, 'child');
      mkdirSync(join(home, '.codex'), { recursive: true });
      expect(spawnSync('git', ['init', parent], { encoding: 'utf8' }).status).toBe(0);
      mkdirSync(join(parent, '.codex'));
      mkdirSync(cwd);
      writeFileSync(join(parent, '.codex/config.toml'), 'model="ancestor-marker"\n');
      writeFileSync(join(home, '.codex/config.toml'), `[projects.${JSON.stringify(parent)}]\ntrust_level="trusted"\n`);
      const env = { PATH: `${dirname(binary as string)}:${process.env.PATH}`, HOME: home, CODEX_HOME: join(home, '.codex') };
      expect((await readCodexConfig(cwd, env)).model).toBe('ancestor-marker');
      const spec: RunnerSpec = {
        runId: 'rn_synthetic',
        command: 'codex',
        args: ['exec', 'synthetic'],
        cwd: null,
        env,
        files: [],
        codexIsolation: { gmailTools: [], servers: [] },
      };
      await prepareCodex(spec, cwd);
      expect((await readCodexConfig(cwd, env)).model).not.toBe('ancestor-marker');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
