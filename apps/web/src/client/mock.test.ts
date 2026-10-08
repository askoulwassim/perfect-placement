import { OPS, type OpName } from '@perfect-placement/contracts';
import { FIXTURE_ROLE_IDS as R } from '@perfect-placement/fixtures';
import { describe, expect, it } from 'vitest';
import { createMockClient } from './mock';

const okOut = async <T>(p: Promise<{ status: string; output?: T }>) => {
  const o = await p;
  expect(o.status).toBe('ok');
  return (o as { output: T }).output;
};

describe('mock client', () => {
  it('read ops return outputs that parse against the contract schemas', async () => {
    const c = createMockClient();
    const reads: Array<[OpName, unknown]> = [
      ['profile.get', {}],
      ['profile.history', {}],
      ['roles.list', { limit: 500 }],
      ['roles.get', { role_id: R.linearDraft }],
      ['pipeline.summary', {}],
      ['decisions.queue', {}],
      ['config.get', {}],
      ['runs.list', {}],
    ];
    for (const [name, input] of reads) {
      const out = await okOut(c.run(name, input as never));
      const parsed = OPS[name].output.safeParse(out);
      expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues?.[0])}`).toBe(true);
    }
  });

  it('validates inputs against the registry', async () => {
    const c = createMockClient();
    const o = await c.run('roles.move', { role_id: R.linearDraft } as never);
    expect(o.status).toBe('error');
    expect(o.status === 'error' && o.code).toBe('invalid_input');
  });

  it('allows only MANUAL_MOVES', async () => {
    const c = createMockClient();
    const bad = await c.run('roles.move', { role_id: R.linearDraft, to: 'applied' });
    expect(bad.status === 'error' && bad.code).toBe('forbidden_transition');
    const held = await c.run('roles.move', { role_id: R.stripeOnDeck, to: 'held' });
    expect(held.status === 'error' && held.code).toBe('forbidden_transition');
    const good = await okOut(c.run('roles.move', { role_id: R.stripeOnDeck, to: 'draft-ready' }));
    expect(good.role.status).toBe('draft-ready');
  });

  it('never sends or submits', async () => {
    const c = createMockClient();
    const send = await c.run('outreach.send', { outreach_id: 'or_0001' });
    expect(send.status === 'error' && send.code).toBe('unimplemented');
    const submit = await c.run('decisions.resolve', { decision_id: 'dc_0005', action: 'accept' });
    expect(submit.status === 'error' && submit.code).toBe('human_only');
    const mark = await c.run('apply.mark_submitted', { role_id: R.vercelDraft });
    expect(mark.status).toBe('error');
  });

  it('resolving the terms diff in Needs you clears it on You, and the reverse', async () => {
    const c = createMockClient();
    await okOut(c.run('decisions.resolve', { decision_id: 'dc_0003', action: 'accept' }));
    const p = await okOut(c.run('profile.get', {}));
    expect(p.pending_diffs.map((d) => d.id)).toEqual(['pd_0002']);
    expect(p.components.find((x) => x.key === 'terms')?.data_json.comp_floor).toBe(215000);

    const c2 = createMockClient();
    await okOut(c2.run('profile.apply_diff', { diff_id: 'pd_0001' }));
    const q = await okOut(c2.run('decisions.queue', {}));
    expect(q.pending.some((d) => d.id === 'dc_0003')).toBe(false);
  });

  it('applying a diff adds a version', async () => {
    const c = createMockClient();
    const before = await okOut(c.run('profile.history', {}));
    await okOut(c.run('profile.apply_diff', { diff_id: 'pd_0002' }));
    const after = await okOut(c.run('profile.history', {}));
    expect(after.versions.length).toBe(before.versions.length + 1);
  });

  it('undo restores an auto + undo close', async () => {
    const c = createMockClient();
    await okOut(c.run('decisions.undo', { decision_id: 'dc_0101' }));
    const r = await okOut(c.run('roles.get', { role_id: R.vercelClosed }));
    expect(r.role.status).toBe('active');
  });

  it('Gmail draft moves the application past Connect', async () => {
    const c = createMockClient();
    await okOut(c.run('outreach.to_gmail', { outreach_id: 'or_0001' }));
    const r = await okOut(c.run('roles.get', { role_id: R.linearDraft }));
    expect(r.application?.stage).toBe('fill');
    const d = await okOut(c.run('outreach.get', { outreach_id: 'or_0001' }));
    expect(d.outreach.status).toBe('in_gmail');
    expect(d.hook.length).toBeGreaterThan(0);
  });

  it('stage runs advance a role', async () => {
    const c = createMockClient();
    await okOut(c.run('runs.start', { skill: 'research', role_id: R.stripeOnDeck }));
    await okOut(c.run('runs.start', { skill: 'tailor', role_id: R.stripeOnDeck }));
    const r = await okOut(c.run('roles.get', { role_id: R.stripeOnDeck }));
    expect(r.role.status).toBe('draft-ready');
    expect(r.application?.stage).toBe('connect');
  });
});
