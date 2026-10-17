import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { RunnerSpec } from '../types.js';
import { prepareCodex } from './isolation.js';

it.each(['version', 'protocol', 'schema', 'ok'])(
  'bounds metadata inspection and fails closed on %s without launching an agent',
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'pp-codex-preflight-'));
    const log = join(root, 'calls');
    try {
      const cwd = join(root, 'cwd');
      mkdirSync(cwd);
      const executable = join(root, 'codex');
      writeFileSync(
        executable,
        `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, pid: process.pid }) + '\\n');
if (args[0] === '--version') {
  console.log(${JSON.stringify(mode === 'version' ? 'codex-cli unknown' : 'codex-cli 0.163.0')});
  process.exit(0);
}
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
process.stdin.once('data', () => {
  console.log(${JSON.stringify(mode === 'protocol' ? 'malformed' : JSON.stringify({ id: 2, result: { config: mode === 'schema' ? {} : { mcp_servers: {} } } }))});
});
`,
      );
      chmodSync(executable, 0o755);
      const spec: RunnerSpec = {
        runId: 'rn_synthetic',
        command: 'codex',
        args: ['exec', 'synthetic'],
        cwd: null,
        files: [],
        env: { PATH: root, HOME: root, CODEX_HOME: join(root, '.codex') },
        codexIsolation: { gmailTools: [], servers: [] },
      };
      if (mode === 'ok') await prepareCodex(spec, cwd);
      else await expect(prepareCodex(spec, cwd)).rejects.toThrow('setup required: Gmail');
      const calls = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { args: string[]; pid: number });
      expect(calls.map((call) => call.args[0])).toEqual(mode === 'version' ? ['--version'] : ['--version', 'app-server']);
      const pid = calls.find((call) => call.args[0] === 'app-server')?.pid;
      if (pid) {
        // The fake metadata server ignores SIGTERM and keeps its event loop alive: cleanup must still terminate it.
        await expect
          .poll(() => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          })
          .toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
