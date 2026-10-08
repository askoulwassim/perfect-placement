import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OP_NAMES } from '@perfect-placement/contracts';
import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeRunOp } from './testing/fake-run-op.js';
import { type StartedHttpServer, startMcpHttpServer } from './transports.js';

describe('Streamable HTTP transport', () => {
  let http: StartedHttpServer;
  beforeAll(async () => {
    http = await startMcpHttpServer({ runOp: createFakeRunOp().runOp });
  });
  afterAll(() => http.close());

  it('serves tools to an HTTP client', async () => {
    const client = new Client({ name: 'http-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(http.url));
    const { tools } = await client.listTools();
    expect(tools.length).toBe(OP_NAMES.length);
    const res = await client.callTool({ name: 'roles.get', arguments: { role_id: FIXTURE_ROLE_IDS.rampIv } });
    expect((res.structuredContent as { status: string }).status).toBe('ok');
    await client.close();
  });

  it('rejects non-loopback hosts and non-POST methods', async () => {
    const evil = await new Promise<number>((resolve, reject) => {
      const req = request(http.url, { method: 'POST', headers: { host: 'evil.example', 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end('{}');
    });
    expect(evil).toBe(403);
    const get = await fetch(http.url, { method: 'GET' });
    expect(get.status).toBe(405);
  });
});
