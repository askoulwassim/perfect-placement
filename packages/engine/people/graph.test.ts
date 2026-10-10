import type { BridgeTie, ConnectPaths, Contact, ContactLink, OpOutcome, RoleGraph } from '@perfect-placement/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { ctxAt, type FixtureEngine, openFixtureEngine } from '../testing/index.js';
import { buildRoleGraph, companyNodeId, type GraphPerson, ME_NODE } from './index.js';

/*
 * The people graph for a role (#131). Synthetic people only. StackBlitz-like case: the target (2nd degree,
 * hiring team) is reached through a 1st-degree mutual who people.find stored as a contact only, with no
 * role link of their own.
 */

const CO = { id: 'blitzco', name: 'Blitzco' };
const CO_NODE = companyNodeId(CO.id);
const NONE: BridgeTie = { same_company: false, same_industry: false, history: false };

const contact = (id: string, name: string): Contact => ({
  id,
  name,
  headline: null,
  linkedin_url: null,
  email: null,
  source: 'linkedin',
  notes: null,
  email_source: null,
  email_confidence: null,
});

const link = (contactId: string, l: Partial<ContactLink>): ContactLink => ({
  id: `cl_${contactId}`,
  contact_id: contactId,
  company_id: CO.id,
  role_id: 'blitzco_pm',
  degree: 'cold',
  tier: 'cold_other',
  via_contact_id: null,
  is_hiring_team: false,
  path: null,
  via_tie_json: null,
  ...l,
});

const target = (
  id: string,
  name: string,
  via: string,
  extra: Partial<ContactLink> = {},
  paths: ConnectPaths | null = null,
): GraphPerson => ({
  contact: contact(id, name),
  link: link(id, { degree: '2', tier: 'bridge', via_contact_id: via, is_hiring_team: true, ...extra }),
  paths,
});

const graphOf = (people: GraphPerson[], known: Contact[] = []) =>
  buildRoleGraph({ company: CO, people, contactById: (id) => known.find((c) => c.id === id) });

const edgeKeys = (g: RoleGraph) => g.edges.map((e) => `${e.from}>${e.to}:${e.kind}`).sort();
const recommended = (g: RoleGraph) => ({
  nodes: g.nodes.filter((n) => n.recommended).map((n) => n.id),
  edges: g.edges.filter((e) => e.recommended).map((e) => `${e.from}>${e.to}`),
});

describe('buildRoleGraph (pure)', () => {
  it('StackBlitz-like: a mutual with no role link is still a node; me -> mutual -> target -> company is the path', () => {
    const mutual = contact('ct_mutual', 'Ivo Lark');
    const g = graphOf([target('ct_target', 'Noa Fenn', 'ct_mutual')], [mutual]);
    expect(g.nodes.map((n) => [n.id, n.kind])).toEqual([
      [ME_NODE, 'me'],
      ['ct_target', 'person'],
      ['ct_mutual', 'person'],
      [CO_NODE, 'company'],
    ]);
    expect(g.nodes.find((n) => n.id === 'ct_mutual')).toMatchObject({
      degree: '1',
      tier: 'warm_other',
      team_side: false,
      name: 'Ivo Lark',
    });
    expect(g.nodes.find((n) => n.id === 'ct_target')).toMatchObject({ degree: '2', tier: 'bridge', team_side: true });
    expect(edgeKeys(g)).toEqual(['ct_mutual>ct_target:via', 'ct_target>co:blitzco:hiring', 'me>ct_mutual:knows'].sort());
    expect(recommended(g)).toEqual({
      nodes: [ME_NODE, 'ct_target', 'ct_mutual', CO_NODE],
      edges: ['me>ct_mutual', 'ct_mutual>ct_target', 'ct_target>co:blitzco'],
    });
  });

  it('several targets through one mutual and another through a second mutual: no duplicate nodes', () => {
    const known = [contact('ct_m1', 'Ivo Lark'), contact('ct_m2', 'Bea Quill')];
    const g = graphOf(
      [
        target('ct_t1', 'Noa Fenn', 'ct_m1'),
        target('ct_t2', 'Rui Dax', 'ct_m1', { is_hiring_team: false }),
        target('ct_t3', 'Sol Wren', 'ct_m2', { via_tie_json: { ...NONE, same_company: true } }),
      ],
      known,
    );
    const ids = g.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([ME_NODE, 'ct_t1', 'ct_t2', 'ct_t3', 'ct_m1', 'ct_m2', CO_NODE]);
    expect(edgeKeys(g)).toEqual(
      [
        'me>ct_m1:knows',
        'me>ct_m2:knows',
        'ct_m1>ct_t1:via',
        'ct_m1>ct_t2:via',
        'ct_m2>ct_t3:via',
        'ct_t1>co:blitzco:hiring',
        'ct_t2>co:blitzco:works_at',
        'ct_t3>co:blitzco:hiring',
        // The skill judged Bea works at the company.
        'ct_m2>co:blitzco:works_at',
      ].sort(),
    );
    // The first warmest target is recommended; the rest are alternatives.
    expect(recommended(g).edges).toEqual(['me>ct_m1', 'ct_m1>ct_t1', 'ct_t1>co:blitzco']);
    // Recommended edges are drawn last (on top).
    expect(g.edges.slice(-3).every((e) => e.recommended)).toBe(true);
  });

  it('a mutual who also has a role link is one node, with its own link', () => {
    const g = graphOf([
      { contact: contact('ct_m1', 'Ivo Lark'), link: link('ct_m1', { degree: '1', tier: 'warm_other' }) },
      target('ct_t1', 'Noa Fenn', 'ct_m1'),
    ]);
    expect(g.nodes.filter((n) => n.id === 'ct_m1')).toHaveLength(1);
    expect(edgeKeys(g)).toContain('ct_m1>co:blitzco:works_at');
    expect(edgeKeys(g)).toContain('me>ct_m1:knows');
  });

  it('a 1st-degree direct contact on the hiring team: me -> them -> company', () => {
    const g = graphOf([
      { contact: contact('ct_w', 'Ada Pine'), link: link('ct_w', { degree: '1', tier: 'warm_hiring', is_hiring_team: true }) },
      { contact: contact('ct_c', 'Cy Holt'), link: link('ct_c', { degree: 'cold', tier: 'cold_other' }) },
    ]);
    expect(edgeKeys(g)).toEqual(['ct_c>co:blitzco:works_at', 'ct_w>co:blitzco:hiring', 'me>ct_w:knows']);
    expect(recommended(g)).toEqual({ nodes: [ME_NODE, 'ct_w', CO_NODE], edges: ['me>ct_w', 'ct_w>co:blitzco'] });
  });

  it('a direct path picked for a 2nd-degree target skips the mutual on the recommended path', () => {
    const paths: ConnectPaths = { recommended: 'direct', chosen: 'direct', options: [] };
    const g = graphOf([target('ct_t', 'Noa Fenn', 'ct_m', {}, paths)], [contact('ct_m', 'Ivo Lark')]);
    expect(recommended(g)).toEqual({ nodes: [ME_NODE, 'ct_t', CO_NODE], edges: ['ct_t>co:blitzco'] });
    expect(g.nodes.find((n) => n.id === 'ct_m')?.recommended).toBe(false);
  });

  it('no people: me and the company only; a missing mutual contact is skipped', () => {
    expect(graphOf([])).toEqual({
      nodes: [
        { id: ME_NODE, kind: 'me', name: 'You', recommended: false },
        { id: CO_NODE, kind: 'company', name: 'Blitzco', recommended: false },
      ],
      edges: [],
    });
    const g = graphOf([target('ct_t', 'Noa Fenn', 'ct_gone')]);
    expect(g.nodes.map((n) => n.id)).toEqual([ME_NODE, 'ct_t', CO_NODE]);
    expect(edgeKeys(g)).toEqual(['ct_t>co:blitzco:hiring']);
  });
});

// ------------------------------------------------------------------ roles.get on a temp fixture vault

let v: FixtureEngine | undefined;
afterEach(() => {
  v?.cleanup();
  v = undefined;
});
// biome-ignore lint/suspicious/noExplicitAny: test helper returns loosely typed output
const ok = (o: OpOutcome<unknown>): any => {
  if (o.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(o)}`);
  return o.output;
};

describe('roles.get graph (#131)', () => {
  it('people.find stores the mutual without a role link; roles.get still draws me -> mutual -> target -> company', async () => {
    const e = openFixtureEngine({ services: { linkedin: undefined }, config: { linkedin: { mode: 'live' } } });
    v = e;
    const ROLE = 'blitzco_senior-pm';
    e.db
      .prepare(
        `INSERT INTO company (id, slug, name, domain, ats_type, ats_board, affinity, md_path) VALUES ('blitzco', 'blitzco', 'Blitzco', 'blitzco.example', 'unknown', NULL, 0, NULL)`,
      )
      .run();
    e.db
      .prepare(
        `INSERT INTO role (id, company_id, title, source, found_at, status, md_path, created_at, updated_at) VALUES (?, 'blitzco', 'Senior PM', 'manual', '2026-10-01T00:00:00Z', 'on-deck', NULL, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
      )
      .run(ROLE);
    const found = ok(
      await e.runOp(
        'people.find',
        {
          role_id: ROLE,
          linkedin: { pages_opened: 2 },
          hints: [
            {
              name: 'Noa Fenn',
              headline: 'Head of Product at Blitzco',
              linkedin_url: 'https://www.linkedin.com/in/fixture-noa-fenn',
              source: 'linkedin',
              degree: '2',
              hiring_team: true,
              via: { name: 'Ivo Lark', linkedin_url: 'https://www.linkedin.com/in/fixture-ivo-lark' },
            },
          ],
        },
        ctxAt('agent'),
      ),
    );
    const t = found.found[0];
    const mutualId = t.link.via_contact_id as string;
    expect(mutualId).toBeTruthy();
    // The mutual is a contact with no contact_link to the role (existing vault data looks like this).
    expect(e.db.prepare('SELECT count(*) n FROM contact_link WHERE contact_id = ?').get(mutualId)).toEqual({ n: 0 });

    const got = ok(await e.runOp('roles.get', { role_id: ROLE }, ctxAt('human')));
    expect(got.contacts).toHaveLength(1);
    const g = got.graph as RoleGraph;
    expect(g.nodes.map((n) => [n.kind, n.name])).toEqual([
      ['me', 'You'],
      ['person', 'Noa Fenn'],
      ['person', 'Ivo Lark'],
      ['company', 'Blitzco'],
    ]);
    expect(edgeKeys(g)).toEqual([`${mutualId}>${t.contact.id}:via`, `${t.contact.id}>co:blitzco:hiring`, `me>${mutualId}:knows`].sort());
    expect(recommended(g).edges).toEqual([`me>${mutualId}`, `${mutualId}>${t.contact.id}`, `${t.contact.id}>co:blitzco`]);
  });
});
