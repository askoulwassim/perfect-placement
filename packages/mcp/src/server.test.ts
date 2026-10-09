/*
 * "A fresh Claude Code / Codex / Cursor session can list roles, score a fixture role, and see a
 * queued decision": a real MCP client over the in-memory transport, on the real engine opened on
 * a temp copy of the synthetic fixture vault (no network, no Kev, no runner spawn).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { OP_NAMES } from '@perfect-placement/contracts';
import { type FixtureEngine, openFixtureEngine } from '@perfect-placement/engine/testing';
import { FIXTURE_NOW, FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPpMcpServer } from './server.js';
import type { ToolNameStyle } from './tools.js';

let engine: FixtureEngine;
let client: Client;
const calls: Array<{ op: string; ctx: { actor: string; confidence?: unknown; runId?: string } }> = [];

async function connect(toolNames?: ToolNameStyle, runId?: string) {
  const server = createPpMcpServer({
    ...(runId ? { runId } : {}),
    runOp: (op, input, ctx) => {
      calls.push({ op, ctx });
      return engine.runOp(op, input, ctx);
    },
    now: () => new Date(FIXTURE_NOW),
    ...(toolNames ? { toolNames } : {}),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(b);
}

type Structured = {
  status: string; // biome-ignore lint/suspicious/noExplicitAny: test reads loosely typed op outputs
  output?: any;
  decisionId?: string;
  code?: string;
};
const call = async (name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as {
    structuredContent: Structured;
    isError?: boolean;
    content: Array<{ text: string }>;
  };
const readJson = async (uri: string) => {
  const r = await client.readResource({ uri });
  return JSON.parse((r.contents[0] as { text: string }).text);
};

describe('MCP server on the real engine (fixtures vault)', () => {
  beforeEach(async () => {
    calls.length = 0;
    engine = openFixtureEngine();
    await connect();
  });
  afterEach(async () => {
    await client.close();
    engine.cleanup();
  });

  it('lists one tool per op, underscore names by default', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(OP_NAMES.length);
    expect(tools.map((t) => t.name)).toContain('roles_list');
    expect(tools.find((t) => t.name === 'roles_list')?.title).toBe('roles.list');
  });

  it('lists roles', async () => {
    const res = await call('roles_list', { status: ['inbox'] });
    expect(res.structuredContent.status).toBe('ok');
    const ids = res.structuredContent.output.items.map((i: { role: { id: string } }) => i.role.id);
    expect(ids).toContain(FIXTURE_ROLE_IDS.notionInbox);
  });

  it('scores a fixture role and the role moves', async () => {
    const criteria = { c1: 4, c2: 4, c3: 4, c4: 4, c5: 4, c6: 4, c7: 4, c8: 4, c9: 4 };
    const res = await call('roles_score', {
      role_id: FIXTURE_ROLE_IDS.notionInbox,
      criteria,
      facts: { workplace: 'remote', remote_ok: true },
    });
    expect(res.structuredContent.status).toBe('ok');
    expect(res.structuredContent.output.status).toBe('active');
    const role = await call('roles_get', { role_id: FIXTURE_ROLE_IDS.notionInbox });
    expect(role.structuredContent.output.role.status).toBe('active');
  });

  it('every call reaches runOp as an agent', async () => {
    await call('roles_list');
    expect(calls.at(-1)?.ctx.actor).toBe('agent');
  });

  it('confidence maps to ctx.confidence and drives the policy grid (#17)', async () => {
    const role_id = FIXTURE_ROLE_IDS.datadogActive;
    const unsure = await call('roles_move', { role_id, to: 'on-deck' });
    expect(unsure.structuredContent.status).toBe('requires_human');
    expect(calls.at(-1)?.ctx.confidence).toBeUndefined();
    const sure = await call('roles_move', { role_id, to: 'on-deck', confidence: 0.95 });
    expect(sure.structuredContent.status).toBe('ok');
    expect(sure.structuredContent.output.role.status).toBe('on-deck');
    expect(calls.at(-1)?.ctx.confidence).toEqual({ p: 0.95, backend: 'agent' });
    const bad = await call('roles_move', { role_id, to: 'active', confidence: 2 });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.code).toBe('invalid_input');
  });

  it('shows queued decisions', async () => {
    const res = await call('decisions_queue', { status: ['pending'] });
    expect(res.structuredContent.output.pending.length).toBeGreaterThan(0);
    const queue = await readJson('pp://needs-you');
    expect(queue.pending.length).toBeGreaterThan(0);
  });

  it('human-only ops return requires_human with a queued decision id that shows in the queue', async () => {
    const res = await call('apply_mark_submitted', { role_id: FIXTURE_ROLE_IDS.vercelDraft });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.status).toBe('requires_human');
    const id = res.structuredContent.decisionId as string;
    expect(res.content[0]?.text).toContain(id);
    const queue = await call('decisions_queue', {});
    expect(queue.structuredContent.output.pending.map((d: { id: string }) => d.id)).toContain(id);
    const send = await call('outreach_send', { outreach_id: 'or_0001' });
    expect(send.structuredContent.status).not.toBe('ok');
  });

  it('passes runOp errors through as tool errors', async () => {
    const bad = await call('roles_score', { role_id: 'x', criteria: { c1: 9 }, facts: {} });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.code).toBe('invalid_input');
    const missing = await call('roles_get', { role_id: 'nope' });
    expect(missing.structuredContent.code).toBe('not_found');
  });

  it('rejects unknown tools', async () => {
    await expect(client.callTool({ name: 'roles_delete_everything', arguments: {} })).rejects.toThrow(/unknown tool/);
    await expect(client.callTool({ name: 'roles.list', arguments: {} })).rejects.toThrow(/unknown tool/);
  });

  it('serves resources: profile, role, contacts, company', async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain('pp://profile');
    expect(uris).toContain('pp://needs-you');
    expect(uris).toContain(`pp://roles/${FIXTURE_ROLE_IDS.figmaIv}`);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
      'pp://companies/{company_id}',
      'pp://roles/{role_id}',
      'pp://roles/{role_id}/contacts',
    ]);

    expect((await readJson('pp://profile')).components.length).toBeGreaterThan(0);
    expect((await readJson(`pp://roles/${FIXTURE_ROLE_IDS.figmaIv}`)).role.id).toBe(FIXTURE_ROLE_IDS.figmaIv);
    expect(Array.isArray((await readJson(`pp://roles/${FIXTURE_ROLE_IDS.figmaIv}/contacts`)).contacts)).toBe(true);
    const co = await readJson('pp://companies/stripe');
    expect(co.company.id).toBe('stripe');
    expect(co.roles.length).toBeGreaterThan(0);
    await expect(client.readResource({ uri: 'pp://roles/nope' })).rejects.toThrow();
  });

  it('supports dotted tool names when asked', async () => {
    await client.close();
    await connect('dotted');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('roles.list');
    expect((await call('roles.list', { limit: 2 })).structuredContent.output.items.length).toBe(2);
  });

  it('#50: a headless run server (PP_RUN_ID) puts the run id on every op; events carry it', async () => {
    await client.close();
    const run = await engine.runOp(
      'runs.start',
      { skill: 'research', role_id: FIXTURE_ROLE_IDS.figmaIv },
      { actor: 'agent', now: () => new Date(FIXTURE_NOW) },
    );
    const runId = (run as { output: { run: { id: string } } }).output.run.id;
    calls.length = 0;
    await connect(undefined, runId);
    await call('runs_finish', { run_id: runId, status: 'ok' });
    expect(calls.map((c) => c.ctx.runId)).toEqual([runId]);
    const ev = engine.db
      .prepare(`SELECT json_extract(payload_json, '$.run_id') run_id FROM event WHERE type = 'run_finished' AND subject_id = ?`)
      .get(runId) as { run_id: string };
    expect(ev.run_id).toBe(runId);
  });
});
