import type { BridgeTie, OpContext, OpOutcome } from '@perfect-placement/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctxAt, type FixtureEngine, openFixtureEngine } from '../testing/index.js';
import { rankPaths } from './index.js';

/*
 * Direct vs bridge for a 2nd-degree hiring-team target (#98). Synthetic people only: a VP on the hiring
 * team reachable by a likely email, and a 1st-degree mutual who works elsewhere.
 */

const NONE: BridgeTie = { same_company: false, same_industry: false, history: false };

describe('rankPaths (pure)', () => {
  it('weak mutual, reachable target: direct, with the bridge offered as the alternative', () => {
    const r = rankPaths({ target: 'likely', via: { reach: 'none', tie: NONE }, chosen: null });
    expect(r.recommended).toBe('direct');
    expect(r.chosen).toBe('direct');
    expect(r.options.map((o) => [o.path, o.reason, o.blocked])).toEqual([
      ['direct', 'Hiring team · Email likely', false],
      ['bridge', 'Other company · No email', true],
    ]);
  });

  it('a weak mutual with an email is still not preferred over a reachable target', () => {
    const r = rankPaths({ target: 'confirmed', via: { reach: 'confirmed', tie: { ...NONE, same_industry: true } }, chosen: null });
    expect(r.recommended).toBe('direct');
    expect(r.options[1]).toMatchObject({ path: 'bridge', reason: 'Same industry · Email known', blocked: false });
  });

  it('a strong mutual (same company, or history) with an email: bridge, direct as the alternative', () => {
    for (const tie of [
      { ...NONE, same_company: true },
      { ...NONE, history: true, same_industry: true },
    ]) {
      const r = rankPaths({ target: 'likely', via: { reach: 'confirmed', tie }, chosen: null });
      expect(r.recommended).toBe('bridge');
      expect(r.options.map((o) => o.path)).toEqual(['bridge', 'direct']);
    }
  });

  it('a strong mutual with no email never wins over a reachable target', () => {
    const r = rankPaths({ target: 'likely', via: { reach: 'none', tie: { ...NONE, same_company: true } }, chosen: null });
    expect(r.recommended).toBe('direct');
    expect(r.options[1]?.blocked).toBe(true);
  });

  it('an unreachable target: bridge', () => {
    const r = rankPaths({ target: 'none', via: { reach: 'none', tie: NONE }, chosen: null });
    expect(r.recommended).toBe('bridge');
    expect(r.options.every((o) => !o.blocked)).toBe(true);
  });

  it('the user pick wins unless it is a blocked bridge', () => {
    expect(rankPaths({ target: 'likely', via: { reach: 'confirmed', tie: NONE }, chosen: 'bridge' }).chosen).toBe('bridge');
    expect(rankPaths({ target: 'likely', via: { reach: 'none', tie: NONE }, chosen: 'bridge' }).chosen).toBe('direct');
    expect(
      rankPaths({ target: 'likely', via: { reach: 'confirmed', tie: { ...NONE, same_company: true } }, chosen: 'direct' }).chosen,
    ).toBe('direct');
  });
});

// ------------------------------------------------------------------ ops on a temp fixture vault

let v: FixtureEngine;
const ROLE = 'acme_vp-product';
// biome-ignore lint/suspicious/noExplicitAny: test helper returns loosely typed output
const ok = (o: OpOutcome<unknown>): any => {
  if (o.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(o)}`);
  return o.output;
};
const run = (name: string, input: unknown, c: OpContext = ctxAt('agent')) => v.runOp(name, input, c);

function person(id: string, name: string, headline: string, email: string | null, source: string | null, p: number | null) {
  v.db
    .prepare(
      `INSERT INTO contact (id, name, headline, linkedin_url, email, source, notes, email_source, email_confidence) VALUES (?, ?, ?, ?, ?, 'linkedin', NULL, ?, ?)`,
    )
    .run(id, name, headline, `https://www.linkedin.com/in/fixture-${id}`, email, source, p);
}

/**
 * Hopper-like: target Rowan (VP Product, hiring team, 2nd degree, likely pattern email); mutual Kit
 * (1st degree, account manager at an unrelated company, no email).
 */
function seed(opts: { mutualEmail?: boolean; tie?: Partial<BridgeTie> } = {}) {
  v.db
    .prepare(
      `INSERT INTO company (id, slug, name, domain, ats_type, ats_board, affinity, md_path) VALUES ('acme', 'acme', 'Acme', 'acme.example', 'unknown', NULL, 0, NULL)`,
    )
    .run();
  v.db
    .prepare(
      `INSERT INTO role (id, company_id, title, source, found_at, status, md_path, created_at, updated_at) VALUES (?, 'acme', 'Director of Product', 'manual', '2026-10-01T00:00:00Z', 'on-deck', NULL, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
    )
    .run(ROLE);
  person('ct_rowan', 'Rowan Vale', 'VP Product at Acme', 'rowan.vale@acme.example', 'pattern', 0.6);
  person(
    'ct_kit',
    'Kit Moss',
    'Account Manager at Otherco',
    opts.mutualEmail ? 'kit@otherco.example' : null,
    opts.mutualEmail ? 'gmail' : null,
    opts.mutualEmail ? 1 : null,
  );
  const tie = opts.tie ? JSON.stringify({ ...NONE, ...opts.tie }) : null;
  v.db
    .prepare(
      `INSERT INTO contact_link (id, contact_id, company_id, role_id, degree, tier, via_contact_id, is_hiring_team, path, via_tie_json) VALUES ('cl_rowan', 'ct_rowan', 'acme', ?, '2', 'bridge', 'ct_kit', 1, NULL, ?)`,
    )
    .run(ROLE, tie);
}

const pathsOf = async (cid = 'ct_rowan') =>
  // biome-ignore lint/suspicious/noExplicitAny: loosely typed output
  ok(await run('roles.get', { role_id: ROLE })).contacts.find((c: any) => c.contact.id === cid)?.paths;
const draft = (tier: string) =>
  run('outreach.draft', {
    contact_id: 'ct_rowan',
    role_id: ROLE,
    tier,
    hook: 'Hi Rowan, your team is rebuilding how people search.',
    proof: 'I led a search rebuild end to end and shipped it.',
    ask: 'Open to a short call next week?',
  });

beforeEach(() => {
  v = openFixtureEngine();
});
afterEach(() => v.cleanup());

describe('direct vs bridge through the ops (#98)', () => {
  it('Hopper-like: roles.get recommends a direct note; the bridge is offered but blocked (mutual has no email)', async () => {
    seed();
    const paths = await pathsOf();
    expect(paths).toMatchObject({ recommended: 'direct', chosen: 'direct' });
    expect(paths.options).toEqual([
      expect.objectContaining({ path: 'direct', contact_id: 'ct_rowan', name: 'Rowan Vale', tier: 'cold_hiring', blocked: false }),
      expect.objectContaining({ path: 'bridge', contact_id: 'ct_kit', name: 'Kit Moss', tier: 'bridge', blocked: true }),
    ]);
    // Never a draft to the mutual: the bridge tier is refused, the direct one lands with Rowan as To.
    const bad = await draft('bridge');
    expect(bad.status === 'error' && bad.message).toContain('not an open path');
    const o = ok(await draft('cold_hiring')).outreach;
    expect(o).toMatchObject({ contact_id: 'ct_rowan', tier: 'cold_hiring' });
    expect(ok(await run('outreach.get', { outreach_id: o.id })).to).toMatchObject({ contact_id: 'ct_rowan', name: 'Rowan Vale' });
    // The blocked bridge cannot be picked.
    const set = await run('people.set_path', { contact_id: 'ct_rowan', role_id: ROLE, path: 'bridge' }, ctxAt('human'));
    expect(set.status === 'error' && set.code).toBe('conflict');
  });

  it('the user switches to the bridge before drafting, and back', async () => {
    seed({ mutualEmail: true });
    expect((await pathsOf()).recommended).toBe('direct');
    const set = ok(await run('people.set_path', { contact_id: 'ct_rowan', role_id: ROLE, path: 'bridge' }, ctxAt('human')));
    expect(set.link.path).toBe('bridge');
    expect(set.paths).toMatchObject({ recommended: 'direct', chosen: 'bridge' });
    expect((await pathsOf()).chosen).toBe('bridge');
    const o = ok(await draft('bridge')).outreach;
    expect(ok(await run('outreach.get', { outreach_id: o.id })).to).toMatchObject({ contact_id: 'ct_kit', email: 'kit@otherco.example' });
    // Back to the default: the direct note is a second draft; the bridge intro stays.
    ok(await run('people.set_path', { contact_id: 'ct_rowan', role_id: ROLE, path: null }, ctxAt('human')));
    expect((await pathsOf()).chosen).toBe('direct');
    const d = ok(await draft('cold_hiring')).outreach;
    expect(d.id).not.toBe(o.id);
    expect(ok(await run('outreach.list', { role_id: ROLE })).items).toHaveLength(2);
  });

  it('Hopper-like: a direct note to the target and a bridge intro to the mutual, each filed under its recipient', async () => {
    seed({ mutualEmail: true });
    const direct = ok(await draft('cold_hiring')).outreach;
    const bridge = ok(await draft('bridge')).outreach;
    expect(direct).toMatchObject({ contact_id: 'ct_rowan', about_contact_id: null, tier: 'cold_hiring' });
    expect(direct.md_path).toBe(`outreach/ct_rowan-${ROLE}.md`);
    expect(bridge).toMatchObject({ contact_id: 'ct_kit', about_contact_id: 'ct_rowan', tier: 'bridge' });
    expect(bridge.md_path).toBe(`outreach/ct_kit-${ROLE}-about-ct_rowan.md`);
    // outreach.list: one per recipient, with names.
    const items = ok(await run('outreach.list', { role_id: ROLE })).items;
    expect(
      items
        .map((i: { contact_id: string; recipient_name: string; about_name: string | null; tier: string }) => [
          i.contact_id,
          i.recipient_name,
          i.about_name,
          i.tier,
        ])
        .sort(),
    ).toEqual([
      ['ct_kit', 'Kit Moss', 'Rowan Vale', 'bridge'],
      ['ct_rowan', 'Rowan Vale', null, 'cold_hiring'],
    ]);
    // outreach.get: the recipient, the To, and the target a bridge intro is about.
    const g = ok(await run('outreach.get', { outreach_id: bridge.id }));
    expect([g.contact.id, g.to.contact_id, g.about?.id]).toEqual(['ct_kit', 'ct_kit', 'ct_rowan']);
    const gd = ok(await run('outreach.get', { outreach_id: direct.id }));
    expect([gd.contact.id, gd.to.contact_id, gd.about]).toEqual(['ct_rowan', 'ct_rowan', null]);
    // Redrafting either one updates it in place, never the other.
    expect(ok(await draft('bridge')).outreach.id).toBe(bridge.id);
    expect(ok(await draft('cold_hiring')).outreach.id).toBe(direct.id);
    // The bridge intro goes to Gmail addressed to the mutual.
    const sent = ok(await run('outreach.to_gmail', { outreach_id: bridge.id, gmail_draft_id: 'gm-1' }, ctxAt('human')));
    expect(sent.to).toBe('kit@otherco.example');
  });

  it('a strong mutual (same company) with an email: bridge by default, direct as the alternative', async () => {
    seed({ mutualEmail: true, tie: { same_company: true } });
    const paths = await pathsOf();
    expect(paths).toMatchObject({ recommended: 'bridge', chosen: 'bridge' });
    expect(paths.options.map((o: { path: string; reason: string }) => [o.path, o.reason])).toEqual([
      ['bridge', 'Same company · Email known'],
      ['direct', 'Hiring team · Email likely'],
    ]);
    expect(ok(await draft('bridge')).outreach.tier).toBe('bridge');
  });

  it('no choice for anyone else: paths null, set_path refused', async () => {
    seed();
    v.db.prepare(`UPDATE contact_link SET is_hiring_team = 0 WHERE id = 'cl_rowan'`).run();
    expect(await pathsOf()).toBeNull();
    const set = await run('people.set_path', { contact_id: 'ct_rowan', role_id: ROLE, path: 'direct' }, ctxAt('human'));
    expect(set.status === 'error' && set.code).toBe('invalid_input');
  });

  it('people.find keeps the skill-judged tie with the via (#98)', async () => {
    v.cleanup();
    v = openFixtureEngine({ services: { linkedin: undefined }, config: { linkedin: { mode: 'live' } } });
    seed();
    v.db.prepare(`DELETE FROM contact_link`).run();
    v.db.prepare(`DELETE FROM contact WHERE id IN ('ct_rowan', 'ct_kit')`).run();
    const out = ok(
      await run('people.find', {
        role_id: ROLE,
        linkedin: { pages_opened: 2 },
        hints: [
          {
            name: 'Rowan Vale',
            headline: 'VP Product at Acme',
            linkedin_url: 'https://www.linkedin.com/in/fixture-rowan',
            source: 'linkedin',
            degree: '2',
            hiring_team: true,
            via: { name: 'Kit Moss', linkedin_url: 'https://www.linkedin.com/in/fixture-kit', tie: { same_industry: true } },
          },
        ],
      }),
    );
    expect(out.found[0].link).toMatchObject({
      degree: '2',
      tier: 'bridge',
      is_hiring_team: true,
      path: null,
      via_tie_json: { same_company: false, same_industry: true, history: false },
    });
    // No email for anyone yet: the target is unreachable, so the bridge is the default.
    expect((await pathsOf(out.found[0].contact.id)).recommended).toBe('bridge');
  });
});
