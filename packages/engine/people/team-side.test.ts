import type { ContactLink, OpContext, OpOutcome } from '@perfect-placement/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDryRunGmail, type DryRunGmail } from '../integrations/gmail/index.js';
import { ctxAt, type FixtureEngine, openFixtureEngine } from '../testing/index.js';
import { buildRoleGraph } from './graph.js';
import { rankPaths } from './path.js';

/*
 * #132: a team-side target (not the hiring team, but e.g. the Head of Design at the company's product brand)
 * reached through a 1st-degree mutual gets ranked direct / bridge paths and is drawn on the team side; a
 * recipient with no address at all never gets a Gmail draft (no To). Synthetic people only.
 */

// biome-ignore lint/suspicious/noExplicitAny: test helper returns loosely typed output
const ok = (o: OpOutcome<unknown>): any => {
  if (o.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(o)}`);
  return o.output;
};

let v: FixtureEngine;
let gmail: DryRunGmail;
const ROLE = 'nimbus_staff-pm';
const run = (name: string, input: unknown, c: OpContext = ctxAt('agent')) => v.runOp(name, input, c);
const human = () => ctxAt('human');
const TARGET_URL = 'https://www.linkedin.com/in/fixture-quinn-hale';
const MUTUAL_URL = 'https://www.linkedin.com/in/fixture-ren-ito';

function open() {
  v?.cleanup();
  gmail = createDryRunGmail();
  v = openFixtureEngine({ services: { linkedin: undefined, gmail }, config: { linkedin: { mode: 'live' } } });
  v.db
    .prepare(
      `INSERT INTO company (id, slug, name, domain, ats_type, ats_board, affinity, md_path) VALUES ('nimbus', 'nimbus', 'Nimbus Labs', 'nimbus.example', 'unknown', NULL, 0, NULL)`,
    )
    .run();
  v.db
    .prepare(
      `INSERT INTO role (id, company_id, title, source, found_at, status, md_path, created_at, updated_at) VALUES (?, 'nimbus', 'Staff PM, Design Tools', 'manual', '2026-10-01T00:00:00Z', 'on-deck', NULL, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
    )
    .run(ROLE);
}

/** The connect skill's read: the Head of Design at the product brand (team side), 2nd degree via a 1st-degree mutual. */
async function find(opts: { teamSide?: boolean; hiringTeam?: boolean } = {}) {
  const out = ok(
    await run('people.find', {
      role_id: ROLE,
      linkedin: { pages_opened: 2 },
      hints: [
        {
          name: 'Quinn Hale',
          headline: 'Head of Design, Cirrus',
          linkedin_url: TARGET_URL,
          source: 'linkedin',
          degree: '2',
          ...(opts.hiringTeam ? { hiring_team: true } : {}),
          ...(opts.teamSide === false ? {} : { team_side: true, brand: 'Cirrus' }),
          via: { name: 'Ren Ito', headline: 'Product Designer at Otherco', linkedin_url: MUTUAL_URL },
        },
      ],
    }),
  );
  const target = out.found[0];
  const mutual = v.db.prepare('SELECT id FROM contact WHERE linkedin_url = ?').get(MUTUAL_URL) as { id: string };
  return { target, mutualId: mutual.id };
}

// biome-ignore lint/suspicious/noExplicitAny: loosely typed output
const roleGet = async (): Promise<any> => ok(await run('roles.get', { role_id: ROLE }, human()));

const draft = (contactId: string, tier: string) =>
  run('outreach.draft', {
    contact_id: contactId,
    role_id: ROLE,
    tier,
    hook: 'Hi Ren, your design tools work keeps coming up.',
    proof: 'I led a design tools rebuild end to end and shipped it.',
    ask: 'Would you forward a short note to Quinn? Blurb below.',
  });

beforeEach(() => open());
afterEach(() => v.cleanup());

describe('team-side targets get ranked paths (#132)', () => {
  it('rankPaths: the direct reason names the side; hiring team stays the default label', () => {
    const tie = { same_company: false, same_industry: false, history: false };
    expect(rankPaths({ target: 'none', via: { reach: 'none', tie }, chosen: null, side: 'Team · Cirrus' }).options).toEqual([
      expect.objectContaining({ path: 'bridge', blocked: false }),
      expect.objectContaining({ path: 'direct', reason: 'Team · Cirrus · No email', blocked: false }),
    ]);
    expect(rankPaths({ target: 'likely', via: { reach: 'none', tie }, chosen: null }).options[0]?.reason).toBe(
      'Hiring team · Email likely',
    );
  });

  it('people.find keeps team_side + brand; classify as other keeps them; roles.get ranks paths and the graph marks the team side', async () => {
    const { target, mutualId } = await find();
    expect(target.link).toMatchObject({ degree: '2', tier: 'bridge', is_hiring_team: false, team_side: true, brand: 'Cirrus' });
    // The resolver may call them `other` (not the hiring team): the team side stays.
    ok(await run('people.classify', { contact_id: target.contact.id, role_id: ROLE, role: 'other' }, human()));
    const got = await roleGet();
    const p = got.contacts.find((c: { contact: { id: string } }) => c.contact.id === target.contact.id);
    expect(p.link).toMatchObject({ is_hiring_team: false, team_side: true });
    // Neither has an email: the target is unreachable, so the bridge is recommended; direct stays open.
    expect(p.paths).toMatchObject({ recommended: 'bridge', chosen: 'bridge' });
    expect(p.paths.options).toEqual([
      expect.objectContaining({ path: 'bridge', contact_id: mutualId, tier: 'bridge', blocked: false }),
      expect.objectContaining({ path: 'direct', contact_id: target.contact.id, tier: 'cold_hiring', reason: 'Team · Cirrus · No email' }),
    ]);
    // Graph: the target is team side, drawn to the company as `team`; the mutual is a 1st-degree node on the path.
    const node = got.graph.nodes.find((n: { id: string }) => n.id === target.contact.id);
    expect(node).toMatchObject({ team_side: true, degree: '2', recommended: true });
    expect(got.graph.nodes.find((n: { id: string }) => n.id === mutualId)).toMatchObject({ degree: '1', recommended: true });
    expect(got.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: target.contact.id, to: 'co:nimbus', kind: 'team', recommended: true }),
        expect.objectContaining({ from: mutualId, to: target.contact.id, kind: 'via', recommended: true }),
        expect.objectContaining({ from: 'me', to: mutualId, kind: 'knows', recommended: true }),
      ]),
    );
    // The user may pick direct (a vault draft only while there is no email).
    ok(await run('people.set_path', { contact_id: target.contact.id, role_id: ROLE, path: 'direct' }, human()));
    expect((await roleGet()).contacts[0].paths.chosen).toBe('direct');
  });

  it('a target with an email on the team side: direct recommended, a bridge to a mutual with no email is blocked', async () => {
    const { target } = await find();
    v.db
      .prepare(`UPDATE contact SET email = 'quinn@cirrus.example', email_source = 'gmail', email_confidence = 1 WHERE id = ?`)
      .run(target.contact.id);
    const paths = (await roleGet()).contacts[0].paths;
    expect(paths).toMatchObject({ recommended: 'direct' });
    expect(paths.options.map((o: { path: string; blocked: boolean }) => [o.path, o.blocked])).toEqual([
      ['direct', false],
      ['bridge', true],
    ]);
    expect((await draft(target.contact.id, 'bridge')).status).toBe('error');
  });

  it('existing behavior: not team side and not hiring team = no paths; hiring team unchanged', async () => {
    const plain = await find({ teamSide: false });
    expect(plain.target.link).toMatchObject({ team_side: false, brand: null });
    expect((await roleGet()).contacts[0].paths).toBeNull();
    const g = (await roleGet()).graph;
    expect(g.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: plain.target.contact.id, kind: 'works_at' })]));
    // A later hint can only add the team side, never clear it.
    await find();
    await find({ teamSide: false });
    expect((await roleGet()).contacts[0].link).toMatchObject({ team_side: true, brand: 'Cirrus' });

    open();
    const hiring = await find({ teamSide: false, hiringTeam: true });
    const got = await roleGet();
    expect(got.contacts[0].paths.options[1]).toMatchObject({ path: 'direct', reason: 'Hiring team · No email' });
    expect(got.graph.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: hiring.target.contact.id, kind: 'hiring' })]));
  });

  it('graph from link data without team_side (old fixtures preview) still builds', () => {
    const g = buildRoleGraph({
      company: { id: 'nimbus', name: 'Nimbus Labs' },
      people: [
        {
          contact: {
            id: 'ct_a',
            name: 'A',
            headline: null,
            linkedin_url: null,
            email: null,
            source: 'manual',
            notes: null,
            email_source: null,
            email_confidence: null,
          },
          // An old link with no team_side / brand.
          link: {
            id: 'cl_a',
            contact_id: 'ct_a',
            company_id: 'nimbus',
            role_id: ROLE,
            degree: '1',
            tier: 'warm_other',
            via_contact_id: null,
            is_hiring_team: false,
            path: null,
            via_tie_json: null,
          } as unknown as ContactLink,
        },
      ],
      contactById: () => undefined,
    });
    expect(g.nodes.find((n) => n.id === 'ct_a')?.team_side).toBe(false);
    expect(g.edges.find((e) => e.from === 'ct_a' && e.to === 'co:nimbus')?.kind).toBe('works_at');
  });
});

describe('no Gmail draft without To (#132)', () => {
  it('no address at all: vault draft only; to_gmail and the Gmail step refuse; outreach shows No email + LinkedIn; a confirmed address queues the step', async () => {
    const { target, mutualId } = await find();
    // The bridge (recommended) goes to the mutual, who has no email: the vault draft is written.
    const o = ok(await draft(target.contact.id, 'bridge')).outreach;
    expect(o).toMatchObject({ contact_id: mutualId, about_contact_id: target.contact.id, status: 'drafted', gmail_draft_id: null });

    const got = ok(await run('outreach.get', { outreach_id: o.id }, human()));
    expect(got.to).toMatchObject({ contact_id: mutualId, email: null, guess: null, linkedin_url: MUTUAL_URL });
    expect(ok(await run('outreach.list', { role_id: ROLE }, human())).items).toEqual([
      expect.objectContaining({ id: o.id, no_email: true }),
    ]);

    // Neither the engine client nor an agent-made draft is accepted, and the Gmail step is not started.
    const sure = ctxAt('agent', { confidence: { p: 0.95, backend: 'agent' } });
    expect(await run('outreach.to_gmail', { outreach_id: o.id }, human())).toMatchObject({ code: 'conflict' });
    expect(await run('outreach.to_gmail', { outreach_id: o.id, gmail_draft_id: 'gd-x' }, sure)).toMatchObject({ code: 'conflict' });
    expect(gmail.drafts).toEqual([]);
    expect(await run('runs.start', { skill: 'connect', outreach_id: o.id }, human())).toMatchObject({ code: 'conflict' });
    expect(v.launcher.specs).toHaveLength(0);
    expect(ok(await run('outreach.get', { outreach_id: o.id }, human())).outreach).toMatchObject({
      status: 'drafted',
      gmail_draft_id: null,
    });

    // An address found later and confirmed: the Gmail step is queued for this draft as today (#99).
    ok(
      await run('people.find_email', {
        contact_id: mutualId,
        role_id: ROLE,
        hints: [{ email: 'ren@otherco.example', name: 'Ren Ito', source: 'gmail' }],
      }),
    );
    const runs = v.db.prepare(`SELECT summary_json FROM run WHERE op = 'connect'`).all() as Array<{ summary_json: string }>;
    expect(runs.map((r) => JSON.parse(r.summary_json))).toEqual([expect.objectContaining({ outreach_id: o.id, step: 'gmail_draft' })]);
    expect(ok(await run('outreach.list', { role_id: ROLE }, human())).items[0].no_email).toBe(false);
  });
});
