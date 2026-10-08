/*
 * "A fresh Claude Code session can list roles, score a fixture role, and see a queued
 * decision": proven with a real MCP client over the in-memory transport and the FAKE
 * fixtures runOp (lane B's runOp replaces it in Wave 2).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FIXTURE_NOW, FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPpMcpServer } from './server.js';
import { createFakeRunOp, type FakeRunOp } from './testing/fake-run-op.js';
import type { ToolNameStyle } from './tools.js';

let fake: FakeRunOp;
let client: Client;

async function connect(toolNames: ToolNameStyle = 'dotted') {
  fake = createFakeRunOp();
  const server = createPpMcpServer({ runOp: fake.runOp, now: () => new Date(FIXTURE_NOW), toolNames });
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

describe('MCP server over the fake runOp', () => {
  beforeEach(() => connect());
  afterEach(() => client.close());

  it('lists one tool per op', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(37);
    expect(tools.map((t) => t.name)).toContain('roles.list');
  });

  it('lists roles', async () => {
    const res = await call('roles.list', { status: ['inbox'] });
    expect(res.structuredContent.status).toBe('ok');
    const ids = res.structuredContent.output.items.map((i: { role: { id: string } }) => i.role.id);
    expect(ids).toContain(FIXTURE_ROLE_IDS.notionInbox);
  });

  it('scores a fixture role and the role moves', async () => {
    const criteria = { c1: 5, c2: 5, c3: 5, c4: 5, c5: 5, c6: 5, c7: 5, c8: 5, c9: 5 };
    const res = await call('roles.score', { role_id: FIXTURE_ROLE_IDS.notionInbox, criteria, facts: { workplace: 'hybrid' } });
    expect(res.structuredContent.status).toBe('ok');
    expect(res.structuredContent.output.score.band).toBe('green');
    expect(res.structuredContent.output.status).toBe('active');
    const role = await call('roles.get', { role_id: FIXTURE_ROLE_IDS.notionInbox });
    expect(role.structuredContent.output.role.status).toBe('active');
  });

  it('every call reaches runOp as an agent', async () => {
    await call('roles.list');
    expect(fake.state.calls.at(-1)?.ctx.actor).toBe('agent');
  });

  it('shows queued decisions', async () => {
    const res = await call('decisions.queue', { status: ['pending'] });
    expect(res.structuredContent.output.pending.length).toBeGreaterThan(0);
    const queue = await readJson('pp://needs-you');
    expect(queue.pending.map((d: { id: string }) => d.id)).toContain('dc_0001');
  });

  it('high-impact ops return requires_human with a queued decision id that shows in the queue', async () => {
    const res = await call('apply.mark_submitted', { role_id: FIXTURE_ROLE_IDS.vercelDraft });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.status).toBe('requires_human');
    const id = res.structuredContent.decisionId as string;
    expect(res.content[0]?.text).toContain(id);
    const queue = await call('decisions.queue', {});
    expect(queue.structuredContent.output.pending.map((d: { id: string }) => d.id)).toContain(id);
    const send = await call('outreach.send', { outreach_id: 'or_0001' });
    expect(send.structuredContent.status).toBe('requires_human');
  });

  it('passes runOp errors through as tool errors', async () => {
    const bad = await call('roles.score', { role_id: 'x', criteria: { c1: 9 }, facts: {} });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.code).toBe('invalid_input');
    const missing = await call('roles.get', { role_id: 'nope' });
    expect(missing.structuredContent.code).toBe('not_found');
  });

  it('rejects unknown tools', async () => {
    await expect(client.callTool({ name: 'roles.delete_everything', arguments: {} })).rejects.toThrow(/unknown tool/);
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

  it('supports underscore tool names', async () => {
    await client.close();
    await connect('underscore');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('roles_list');
    expect((await call('roles_list', { limit: 2 })).structuredContent.output.items.length).toBe(2);
  });
});
