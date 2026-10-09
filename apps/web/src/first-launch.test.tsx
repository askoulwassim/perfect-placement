import { tint } from '@perfect-placement/contracts';
import { FIXTURE_NOW } from '@perfect-placement/fixtures';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App, shownRoute } from './App';
import { GUIDE_STEPS, guideSteps, STEP_CUE } from './lib/guide';
import { type Live, openLive } from './test/live';

/*
 * First launch: a fresh vault lands on You, which is setup until a profile exists (#25). Then a Getting started
 * card on Now walks the path (#24): steps done from real state, one sentence on arrival at a step, gone for good
 * once finished (config.ui.guide.done). No setting shows, replays or skips it (#43).
 */

const now = () => new Date(FIXTURE_NOW);
let live: Live | null = null;
afterEach(() => {
  live?.close();
  live = null;
});

function boot(hash: string, opts: Parameters<typeof openLive>[0] = {}) {
  window.location.hash = hash;
  live = openLive(opts);
  return { live, ...render(<App client={live.client} now={now} pollMs={20} />) };
}
const nav = async (hash: string) => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
};
const screenLabel = (c: HTMLElement) => c.querySelector('[data-screen-label]')?.getAttribute('data-screen-label');
const rail = (c: HTMLElement, label: string) => c.querySelector(`nav[aria-label="Main"] button[aria-label="${label}"]`) as HTMLElement;
const cue = (id: string) => document.querySelector(`[data-cue="${id}"]`);
const savedGuide = async () => {
  const o = await live?.client.run('config.get', {});
  return o?.status === 'ok' ? (o.output.ui?.guide ?? null) : null;
};
/** A vault mid-path: the fixture state, with the guide flags not set yet. */
const unguided = { config: { ui: { guide: { policy: false, review: false, done: false } } } };
const card = () => document.querySelector('section[aria-label="Getting started"]');
const step = (id: string) => document.querySelector(`[data-step="${id}"]`) as HTMLElement | null;
const doneSteps = () => Array.from(document.querySelectorAll('[data-step][data-done="true"]')).map((e) => e.getAttribute('data-step'));

describe('fresh start lands on setup', () => {
  it('a vault with no profile opens You at setup step 1 from /, with the rail still there and no Setup entry', async () => {
    const { container } = boot('', { seed: false });
    await waitFor(() => expect(window.location.hash).toBe('#/you'));
    await waitFor(() => expect(screenLabel(container)).toBe('You · setup'));
    expect((container.querySelector('.btn--primary') as HTMLElement).textContent).toBe('Next');
    expect(container.querySelector('.dropzone')).not.toBeNull();
    expect(container.querySelector('nav[aria-label="Main"]')).not.toBeNull();
    expect(rail(container, 'Setup')).toBeNull();
    expect(rail(container, 'You').getAttribute('aria-current')).toBe('page');
    const state = await live?.client.run('onboard.state', {});
    expect(state?.status === 'ok' && state.output.step).toBe('resume');
  });

  it('any route on first open goes to setup; Settings stays reachable, Now / Needs you / River redirect', async () => {
    const { container } = boot('#/settings', { seed: false });
    await waitFor(() => expect(window.location.hash).toBe('#/you'));
    fireEvent.click(rail(container, 'Settings'));
    await waitFor(() => expect(screenLabel(container)).toBe('Settings'));
    expect(window.location.hash).toBe('#/settings');
    for (const label of ['River', 'Needs you', 'Now']) {
      await nav('#/settings');
      await waitFor(() => expect(screenLabel(container)).toBe('Settings'));
      fireEvent.click(rail(container, label));
      await waitFor(() => expect(window.location.hash).toBe('#/you'));
      // The redirect re-renders after the hash settles: wait for it, never read it synchronously.
      await waitFor(() => expect(screenLabel(container)).toBe('You · setup'));
    }
  });

  it('with a confirmed profile, / goes to Now; You is the profile and a redo hides the rail as before', async () => {
    const { container } = boot('');
    await waitFor(() => expect(screenLabel(container)).toBe('Now'));
    await waitFor(() => expect((container.querySelector('.btn--primary') as HTMLElement).textContent).toBe('Review 7'));
    expect(window.location.hash).toBe('');
    expect(card()).toBeNull();
    await nav('#/you');
    await waitFor(() => expect(screenLabel(container)).toBe('You'));
    expect(container.querySelector('nav[aria-label="Main"]')).not.toBeNull();
    // Old Setup links open the same steps inside You.
    await nav('#/onboarding');
    await waitFor(() => expect(screenLabel(container)).toBe('You · setup'));
    expect(container.querySelector('nav[aria-label="Main"]')).toBeNull();
  });

  it('shownRoute: gated screens wait, then show You (setup) while fresh; others pass through', () => {
    const o = (fresh: boolean | null, lastFresh: boolean | null, mobile = false) => ({ mobile, fresh, lastFresh });
    expect(shownRoute({ screen: 'now' }, o(null, null))).toBeNull();
    expect(shownRoute({ screen: 'river' }, o(true, true))).toEqual({ screen: 'you' });
    expect(shownRoute({ screen: 'needs-you' }, o(null, true))).toBeNull(); // refetching after a write
    expect(shownRoute({ screen: 'now' }, o(false, false))).toEqual({ screen: 'now' });
    expect(shownRoute({ screen: 'now' }, o(null, false))).toEqual({ screen: 'now' }); // never flickers once a profile exists
    expect(shownRoute({ screen: 'settings' }, o(true, true))).toEqual({ screen: 'settings' });
    expect(shownRoute({ screen: 'you' }, o(true, true))).toEqual({ screen: 'you' });
    expect(shownRoute({ screen: 'settings' }, o(true, true, true))).toEqual({ screen: 'you' });
    expect(shownRoute({ screen: 'settings' }, o(false, false, true))).toEqual({ screen: 'now' });
    expect(shownRoute({ screen: 'you', flow: 'calibrate' }, o(false, false))).toEqual({ screen: 'you', flow: 'calibrate' });
  });
});

const run = (id: string, status: 'queued' | 'running' | 'ok' | 'partial' | 'error', at = '2026-10-08T05:00:00.000Z') => ({
  id,
  op: 'scout',
  started_at: at,
  finished_at: null,
  status,
  summary_json: { skill: 'scout' },
  log_path: null,
});

describe('getting started', () => {
  const base = {
    profile: false,
    flags: { policy: false, review: false, done: false },
    scouts: [],
    counts: {},
    topRole: null,
    needsYou: 0,
  } satisfies Parameters<typeof guideSteps>[0];
  const done = (i: Partial<typeof base> & Record<string, unknown>) =>
    guideSteps({ ...base, ...i } as typeof base)
      .filter((s) => s.done)
      .map((s) => s.id);

  it('steps complete from real state, in order, with one-sentence cues', () => {
    expect(guideSteps(base).map((s) => s.id)).toEqual([...GUIDE_STEPS]);
    expect(done({})).toEqual([]);
    expect(done({ profile: true })).toEqual(['profile']);
    expect(done({ flags: { policy: true, review: false, done: false } })).toEqual(['policy']);
    // A scout started: step 3; it ended: step 4. A failed one leaves step 4 open, marked Failed.
    expect(done({ scouts: [run('rn_a', 'running')] })).toEqual(['scout']);
    expect(guideSteps({ ...base, scouts: [run('rn_a', 'running')] })[3]?.state).toBe('Scouting');
    expect(guideSteps({ ...base, scouts: [run('rn_a', 'queued')] })[3]?.state).toBe('Queued');
    expect(guideSteps({ ...base, scouts: [run('rn_a', 'error')] })[3]).toMatchObject({ done: false, state: 'Failed' });
    expect(done({ scouts: [run('rn_a', 'ok')] })).toEqual(['scout', 'roles']);
    // Review needs scored roles and River or Needs you opened.
    expect(done({ counts: { active: 2 } })).toEqual([]);
    expect(done({ counts: { inbox: 3 }, flags: { policy: false, review: true, done: false } })).toEqual([]);
    expect(done({ counts: { archived: 1 }, flags: { policy: false, review: true, done: false } })).toEqual(['review']);
    // First role: one role through Research -> Tailor (draft-ready or later).
    expect(done({ counts: { active: 4 } })).not.toContain('role');
    expect(done({ counts: { 'draft-ready': 1 } })).toContain('role');
    expect(done({ counts: { applied: 1 } })).toContain('role');
    for (const c of Object.values(STEP_CUE)) {
      expect(c.split(/\s+/).length).toBeLessThanOrEqual(10);
      expect(c.match(/[.!?]/g)).toHaveLength(1);
      expect(c).not.toMatch(/\u2014/);
    }
  });

  it('Settings has no cue or guide setting', async () => {
    const { container } = boot('#/settings', unguided);
    await waitFor(() => expect(screenLabel(container)).toBe('Settings'));
    await waitFor(() => expect(container.querySelector('button[data-op="config.update"]')).not.toBeNull());
    expect(container.textContent).not.toMatch(/cue|guide|getting started/i);
    expect(container.querySelector('[aria-label*="cue" i], [aria-label*="guide" i]')).toBeNull();
  });

  it('the card walks the path from real state, cues show on step arrival only, and it disappears for good', async () => {
    const { container, unmount } = boot('#/now', unguided);
    await waitFor(() => expect(card()).not.toBeNull());
    // Fixture state: a profile, a finished scout, scored roles, a role tailored; policy and review still open.
    await waitFor(() => expect(doneSteps()).toEqual(['profile', 'scout', 'roles', 'role']));
    expect(step('policy')?.getAttribute('aria-current')).toBe('step');
    expect(step('policy')?.getAttribute('data-op')).toBe('nav');
    expect(container.querySelector('.guide .btn--primary')).toBeNull();
    expect(cue('policy')).toBeNull();

    // Opening a step's screen from the card: its one sentence shows; any click dismisses it.
    fireEvent.click(step('policy') as HTMLElement);
    await waitFor(() => expect(screenLabel(container)).toBe('Settings'));
    await waitFor(() => expect(cue('policy')?.textContent).toBe(STEP_CUE.policy));
    fireEvent.click(document.body);
    await waitFor(() => expect(cue('policy')).toBeNull());
    // Visiting Settings is the real state: saved in the vault.
    await waitFor(async () => expect((await savedGuide())?.policy).toBe(true));

    await nav('#/now');
    await waitFor(() => expect(doneSteps()).toContain('policy'));
    expect(step('review')?.getAttribute('aria-current')).toBe('step');
    // A plain visit (not from the card) shows no cue.
    await nav('#/settings');
    await waitFor(() => expect(screenLabel(container)).toBe('Settings'));
    await waitFor(() => expect(container.querySelector('.btn--primary')).not.toBeNull());
    expect(document.querySelector('[data-cue]')).toBeNull();

    await nav('#/now');
    await waitFor(() => expect(step('review')).not.toBeNull());
    fireEvent.click(step('review') as HTMLElement);
    await waitFor(() => expect(window.location.hash).toBe('#/needs-you'));
    await waitFor(() => expect(cue('review')?.textContent).toBe(STEP_CUE.review));
    await waitFor(async () => expect(await savedGuide()).toEqual({ policy: true, review: true, done: false }));

    // Every step done: the card goes and the vault remembers it is finished.
    await nav('#/now');
    await waitFor(async () => expect((await savedGuide())?.done).toBe(true));
    await waitFor(() => expect(card()).toBeNull());
    unmount();
    render(<App client={(live as Live).client} now={now} pollMs={20} />);
    await nav('#/now');
    await waitFor(() => expect(screenLabel(document.body)).toBe('Now'));
    await waitFor(() => expect((document.querySelector('.btn--primary') as HTMLElement | null)?.textContent).toMatch(/^Review|Open River/));
    expect(card()).toBeNull();
  });

  it('leaving the step screen drops its cue; reduced motion shows it without a fade', async () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({ ...real(q), matches: q.includes('reduced-motion') })) as typeof window.matchMedia;
    try {
      const { container } = boot('#/now', unguided);
      await waitFor(() => expect(step('policy')).not.toBeNull());
      fireEvent.click(step('policy') as HTMLElement);
      await waitFor(() => expect(cue('policy')).not.toBeNull());
      const halo = document.querySelector('.cue__halo') as HTMLElement;
      expect(halo.style.animation).toBe('none');
      expect(halo.style.boxShadow).toContain(tint.scrim);
      await nav('#/river');
      await waitFor(() => expect(screenLabel(container)).toBe('River'));
      expect(document.querySelector('[data-cue]')).toBeNull();
    } finally {
      window.matchMedia = real;
    }
  });
});
