import { roles as fixtureRoles, FIXTURE_ROLE_IDS as R } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine } from '../../testing/index.js';

/*
 * #105 On deck = picked: starting an apply stage (Research, Tailor, Connect) on an active or held role
 * moves it to on-deck and emits role_picked; Tailor then goes on-deck -> draft-ready.
 */

let e: FixtureEngine;
beforeEach(() => {
  e = openFixtureEngine();
});
afterEach(() => e.cleanup());

const status = (id: string) => (e.db.prepare('SELECT status FROM role WHERE id = ?').get(id) as { status: string }).status;
const events = (type: string, id: string) =>
  (
    e.db.prepare('SELECT payload_json FROM event WHERE type = ? AND subject_id = ? ORDER BY rowid').all(type, id) as {
      payload_json: string;
    }[]
  ).map((r) => JSON.parse(r.payload_json) as Record<string, unknown>);
const trail = (id: string) =>
  (e.db.prepare('SELECT type FROM event WHERE subject_id = ? ORDER BY rowid').all(id) as { type: string }[]).map((r) => r.type);
const pkg = { resume_md: '# Resume\n\nFacts only.', cover_letter_md: '# Cover\n\nHook.', fit_map_md: '# Fit map' };
const atCo = (co: string, s: string) => fixtureRoles.filter((r) => r.company_id === co && status(r.id) === s).map((r) => r.id);

describe('apply stage start picks the role (#105)', () => {
  for (const skill of ['research', 'tailor', 'connect'] as const)
    it(`runs.start ${skill} on an active role -> on-deck + role_picked`, async () => {
      const id = R.datadogActive;
      okOut(await e.runOp('runs.start', { skill, role_id: id }, ctxAt('human')));
      expect(status(id)).toBe('on-deck');
      expect(events('role_picked', id)).toEqual([{ from: 'active', stage: skill }]);
      expect(events('role_moved', id).at(-1)).toMatchObject({ from: 'active', to: 'on-deck', via: 'pick', stage: skill });
    });

  it('an agent starting its own run picks too; idempotent across stages', async () => {
    const id = R.datadogActive;
    okOut(await e.runOp('runs.start', { skill: 'research', role_id: id }, ctxAt('agent')));
    okOut(await e.runOp('runs.start', { skill: 'connect', role_id: id }, ctxAt('agent')));
    okOut(await e.runOp('runs.start', { skill: 'research', role_id: id }, ctxAt('human')));
    expect(status(id)).toBe('on-deck');
    expect(events('role_picked', id)).toHaveLength(1);
  });

  it('other skills, inbox roles and roles at on-deck or later are not moved (no downgrade)', async () => {
    okOut(await e.runOp('runs.start', { skill: 'fill', role_id: R.datadogActive }, ctxAt('human')));
    expect(status(R.datadogActive)).toBe('active');
    okOut(await e.runOp('runs.start', { skill: 'research', role_id: R.notionInbox }, ctxAt('human')));
    expect(status(R.notionInbox)).toBe('inbox');
    for (const id of [R.airtableOnDeck, R.linearDraft, R.stripeApplied, R.figmaIv]) {
      const before = status(id);
      okOut(await e.runOp('runs.start', { skill: 'tailor', role_id: id }, ctxAt('agent')));
      expect(status(id)).toBe(before);
      expect(events('role_picked', id)).toHaveLength(0);
    }
  });

  it('companies.dossier.write with role_id picks that role; another company is refused', async () => {
    okOut(
      await e.runOp('companies.dossier.write', { company_id: 'datadog', markdown: '# Datadog', role_id: R.datadogActive }, ctxAt('agent')),
    );
    expect(status(R.datadogActive)).toBe('on-deck');
    expect(events('role_picked', R.datadogActive)).toEqual([{ from: 'active', stage: 'research' }]);
    expect(
      await e.runOp('companies.dossier.write', { company_id: 'stripe', markdown: '# Stripe', role_id: R.datadogActive }, ctxAt('agent')),
    ).toMatchObject({ code: 'invalid_input' });
    // Without role_id nothing is picked (the dossier is shared by the company's roles).
    okOut(await e.runOp('companies.dossier.write', { company_id: 'notion', markdown: '# Notion' }, ctxAt('agent')));
    expect(status(R.notionInbox)).toBe('inbox');
  });

  it('people.find on an active role picks it (Connect); a dry run does not', async () => {
    const dry = await e.runOp('people.find', { role_id: R.datadogActive, dry_run: true }, ctxAt('agent'));
    expect(dry).toMatchObject({ status: 'error', code: 'conflict' });
    expect(status(R.datadogActive)).toBe('active');
    okOut(await e.runOp('people.find', { role_id: R.datadogActive, hints: [] }, ctxAt('agent')));
    expect(status(R.datadogActive)).toBe('on-deck');
    expect(events('role_picked', R.datadogActive)).toEqual([{ from: 'active', stage: 'connect' }]);
  });
});

describe('Tailor goes through on-deck (#105)', () => {
  it('apply.tailor on an active role: picked, then on-deck -> draft-ready', async () => {
    const id = R.datadogActive;
    okOut(await e.runOp('apply.tailor', { role_id: id, ...pkg }, ctxAt('agent')));
    expect(status(id)).toBe('draft-ready');
    expect(trail(id).slice(-4)).toEqual(['role_moved', 'role_picked', 'application_tailored', 'role_moved']);
    expect(events('role_moved', id).slice(-2)).toMatchObject([
      { from: 'active', to: 'on-deck', via: 'pick' },
      { from: 'on-deck', to: 'draft-ready', via: 'tailor' },
    ]);
  });

  it('runs.start tailor then apply.tailor: on-deck -> draft-ready, one pick', async () => {
    const id = R.datadogActive;
    const run = okOut(await e.runOp('runs.start', { skill: 'tailor', role_id: id }, ctxAt('agent'))).run;
    okOut(await e.runOp('apply.tailor', { role_id: id, ...pkg }, ctxAt('agent', { runId: run.id })));
    expect(status(id)).toBe('draft-ready');
    expect(events('role_picked', id)).toHaveLength(1);
    expect(events('role_moved', id).at(-1)).toMatchObject({ from: 'on-deck', to: 'draft-ready' });
  });

  it('a draft-ready role is re-tailored in place, never picked again', async () => {
    okOut(await e.runOp('apply.tailor', { role_id: R.linearDraft, ...pkg }, ctxAt('agent')));
    expect(status(R.linearDraft)).toBe('draft-ready');
    expect(events('role_picked', R.linearDraft)).toHaveLength(0);
  });
});

describe('company cap (#105)', () => {
  it('picking an active role frees its slot: the best held role is promoted', async () => {
    const held = atCo('datadog', 'held');
    expect(held.length).toBeGreaterThan(0);
    const activeBefore = atCo('datadog', 'active').length;
    okOut(await e.runOp('runs.start', { skill: 'research', role_id: R.datadogActive }, ctxAt('human')));
    expect(atCo('datadog', 'active')).toHaveLength(activeBefore);
    expect(held.filter((id) => status(id) === 'active')).toHaveLength(1);
    expect(held.flatMap((id) => events('role_promoted', id))).toHaveLength(1);
  });

  it('a held role can be picked: on-deck, outside the cap, the active roles keep their slots', async () => {
    const [id] = atCo('datadog', 'held');
    const active = atCo('datadog', 'active');
    okOut(await e.runOp('runs.start', { skill: 'tailor', role_id: id as string }, ctxAt('human')));
    expect(status(id as string)).toBe('on-deck');
    expect(events('role_picked', id as string)).toEqual([{ from: 'held', stage: 'tailor' }]);
    expect(atCo('datadog', 'active')).toEqual(active);
  });
});
