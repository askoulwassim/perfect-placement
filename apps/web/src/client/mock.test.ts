import { OPS, type OpName } from '@perfect-placement/contracts';
import { FIXTURE_ROLE_IDS as R } from '@perfect-placement/fixtures';
import { describe, expect, it } from 'vitest';
import { createMockClient } from './mock';

const okOut = async <T>(p: Promise<{ status: string; output?: T }>) => {
  const o = await p;
  expect(o.status).toBe('ok');
  return (o as { output: T }).output;
};

describe('mock client (read-only fixtures preview)', () => {
  it('read ops return outputs that parse against the contract schemas', async () => {
    const c = createMockClient();
    const reads: Array<[OpName, unknown]> = [
      ['profile.get', {}],
      ['profile.history', {}],
      ['onboard.state', {}],
      ['onboard.samples', {}],
      ['roles.list', { limit: 500 }],
      ['roles.get', { role_id: R.linearDraft }],
      ['companies.get', { company_id: 'linear' }],
      ['pipeline.summary', {}],
      ['decisions.queue', {}],
      ['config.get', {}],
      ['runs.list', {}],
      ['outreach.get', { outreach_id: 'or_0001' }],
      ['outreach.list', { role_id: R.linearDraft }],
      ['contacts.get', { contact_id: 'ct_0001' }],
      ['vault.read', { path: 'outreach/ct_0001-linear_product-lead-insights.md' }],
      ['system.backends', {}],
    ];
    for (const [name, input] of reads) {
      const out = await okOut(c.run(name, input as never));
      const parsed = OPS[name].output.safeParse(out);
      expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues?.[0])}`).toBe(true);
    }
  });

  it('validates inputs against the registry', async () => {
    const o = await createMockClient().run('roles.move', { role_id: R.linearDraft } as never);
    expect(o.status === 'error' && o.code).toBe('invalid_input');
  });

  it('refuses every write: the mechanics live in the engine', async () => {
    const c = createMockClient();
    const writes = (Object.keys(OPS) as OpName[]).filter((n) => !OPS[n].readOnly);
    expect(writes).toContain('outreach.send');
    for (const name of writes) {
      const o = await c.run(name, {} as never);
      expect(o.status, name).toBe('error');
      expect(o.status === 'error' && ['unimplemented', 'invalid_input'].includes(o.code), name).toBe(true);
    }
    const move = await c.run('roles.move', { role_id: R.stripeOnDeck, to: 'draft-ready' });
    expect(move.status === 'error' && move.code).toBe('unimplemented');
    const r = await okOut(c.run('roles.get', { role_id: R.stripeOnDeck }));
    expect(r.role.status).toBe('on-deck');
  });

  it('outreach.get reads the Hook / Proof / Ask from the vault draft', async () => {
    const d = await okOut(createMockClient().run('outreach.get', { outreach_id: 'or_0001' }));
    expect(d.hook.length).toBeGreaterThan(0);
    expect(d.variants).toHaveLength(4);
  });
});
