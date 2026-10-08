import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine } from '../../testing/index.js';

let e: FixtureEngine;
beforeEach(() => {
  e = openFixtureEngine();
});
afterEach(() => e.cleanup());

describe('companies.get', () => {
  it('returns the company, its roles and the dossier body', async () => {
    const out = okOut(await e.runOp('companies.get', { company_id: 'linear' }, ctxAt('human')));
    expect(out.company.slug).toBe('linear');
    expect(out.roles.map((r) => r.role.id)).toContain(FIXTURE_ROLE_IDS.linearDraft);
    expect(out.roles.every((r) => r.company.id === 'linear')).toBe(true);
    expect(out.dossier_md).not.toMatch(/^---/);
    expect(out.dossier_md?.length).toBeGreaterThan(0);
  });

  it('serves a company with no dossier and errors on an unknown one', async () => {
    expect(okOut(await e.runOp('companies.get', { company_id: 'plaid' }, ctxAt('human'))).dossier_md).toBeNull();
    expect(await e.runOp('companies.get', { company_id: 'nope' }, ctxAt('human'))).toMatchObject({ status: 'error', code: 'not_found' });
  });
});

describe('vault.read', () => {
  it('reads a path the db references, frontmatter stripped', async () => {
    const out = okOut(await e.runOp('vault.read', { path: `applications/${FIXTURE_ROLE_IDS.vercelDraft}/answers.md` }, ctxAt('human')));
    expect(out.markdown).not.toBeNull();
    expect(out.markdown).not.toMatch(/^---/);
  });

  it('refuses paths no row references and paths outside the vault', async () => {
    expect(await e.runOp('vault.read', { path: 'config.json' }, ctxAt('human'))).toMatchObject({ code: 'not_found' });
    expect(await e.runOp('vault.read', { path: '../secret.md' }, ctxAt('human'))).toMatchObject({ code: 'invalid_input' });
  });
});
