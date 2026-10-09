import { tint } from '@perfect-placement/contracts';
import { FIXTURE_NOW } from '@perfect-placement/fixtures';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App, shownRoute } from './App';
import { createMockClient } from './client/mock';
import { CUE_IDS, CUES, cueFor, pendingCue } from './lib/cues';
import { type Live, openLive } from './test/live';

/*
 * First launch: a fresh vault lands on You, which is setup until a profile exists (#25); first-visit cues (wave1-decisions #27) show
 * once per screen, persist in the vault (config.ui.cues_seen) and come back with Settings > Show cues.
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
const savedCues = async () => {
  const o = await live?.client.run('config.get', {});
  return o?.status === 'ok' ? (o.output.ui?.cues_seen ?? []) : null;
};
/** Every cue already seen, so a test can look at one screen's behaviour alone. */
const allSeen = { config: { ui: { cues_seen: CUE_IDS } } };

describe('fresh start lands on setup', () => {
  it('a vault with no profile opens You at setup step 1 from /, with the rail still there and no Setup entry', async () => {
    const { container } = boot('', { seed: false, ...allSeen });
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
    const { container } = boot('#/settings', { seed: false, ...allSeen });
    await waitFor(() => expect(window.location.hash).toBe('#/you'));
    fireEvent.click(rail(container, 'Settings'));
    await waitFor(() => expect(screenLabel(container)).toBe('Settings'));
    expect(window.location.hash).toBe('#/settings');
    for (const label of ['River', 'Needs you', 'Now']) {
      await nav('#/settings');
      await waitFor(() => expect(screenLabel(container)).toBe('Settings'));
      fireEvent.click(rail(container, label));
      await waitFor(() => expect(window.location.hash).toBe('#/you'));
      expect(screenLabel(container)).toBe('You · setup');
    }
  });

  it('with a confirmed profile, / goes to Now; You is the profile and a redo hides the rail as before', async () => {
    const { container } = boot('', allSeen);
    await waitFor(() => expect(screenLabel(container)).toBe('Now'));
    await waitFor(() => expect((container.querySelector('.btn--primary') as HTMLElement).textContent).toBe('Review 7'));
    expect(window.location.hash).toBe('');
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

describe('first-visit cues', () => {
  it('labels are one to three words, one per main screen plus Ask', () => {
    expect(CUE_IDS.sort()).toEqual(['ask', 'needs-you', 'now', 'outreach', 'people', 'river', 'role', 'settings', 'you']);
    for (const l of Object.values(CUES)) expect(l.split(/\s+/).length).toBeLessThanOrEqual(3);
    expect(cueFor('outreach-draft', false)).toBe('outreach');
    expect(cueFor(null, false)).toBeNull();
    expect(cueFor('now', true)).toBe('ask');
    expect(pendingCue('now', null)).toBeNull();
    expect(pendingCue('now', ['now'])).toBeNull();
    expect(pendingCue('now', [])).toBe('now');
  });

  it('spotlights the primary once, any click dismisses it, and the vault remembers', async () => {
    const { container, unmount } = boot('#/now');
    await waitFor(() => expect(cue('now')?.textContent).toBe('Review here'));
    expect(cue('now')?.querySelector('button')).toBeNull();
    fireEvent.click(document.body);
    await waitFor(() => expect(cue('now')).toBeNull());
    await waitFor(async () => expect(await savedCues()).toEqual(['now']));
    expect(live?.calls.filter((c) => c.name === 'config.update').map((c) => c.body)).toEqual([{ patch: { ui: { cues_seen: ['now'] } } }]);
    // Other screens still have theirs; Now never shows again, even after a reload.
    await nav('#/river');
    await waitFor(() => expect(cue('river')?.textContent).toBe('Scout roles'));
    unmount();
    render(<App client={(live as Live).client} now={now} pollMs={20} />);
    await nav('#/now');
    await waitFor(() => expect(container.ownerDocument.querySelector('.btn--primary')?.textContent).toBe('Review 7'));
    expect(cue('now')).toBeNull();
  });

  it('clicks pass through: the primary still runs its action', async () => {
    const { container } = boot('#/now');
    await waitFor(() => expect(cue('now')).not.toBeNull());
    await waitFor(() => expect((container.querySelector('.btn--primary') as HTMLElement).textContent).toBe('Review 7'));
    fireEvent.click(container.querySelector('.btn--primary') as HTMLElement);
    await waitFor(() => expect(window.location.hash).toBe('#/needs-you'));
    expect(cue('now')).toBeNull();
  });

  it('Esc dismisses (and only the cue: Ask stays open); keyboard focus is untouched', async () => {
    const seen = CUE_IDS.filter((x) => x !== 'ask');
    const { container } = boot('#/river', { config: { ui: { cues_seen: seen } } });
    await waitFor(() => expect(container.querySelector('.btn--primary')).not.toBeNull());
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await waitFor(() => expect(cue('ask')?.textContent).toBe('Ask anything'));
    const input = document.querySelector('.ask input') as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(cue('ask')).toBeNull());
    expect(document.querySelector('[role="dialog"][aria-label="Ask"]')).not.toBeNull();
    expect(document.activeElement).toBe(input);
    await waitFor(async () => expect(await savedCues()).toContain('ask'));
  });

  it('Settings "Show cues" brings every cue back, and off retires them', async () => {
    const { container } = boot('#/settings', allSeen);
    const toggle = await waitFor(() => {
      const t = container.querySelector('button[aria-label="Show cues"]') as HTMLElement;
      expect(t).not.toBeNull();
      return t;
    });
    expect(toggle.getAttribute('data-op')).toBe('config.update');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(cue('settings')).toBeNull();
    fireEvent.click(toggle);
    await waitFor(async () => expect(await savedCues()).toEqual([]));
    await waitFor(() => expect(cue('settings')?.textContent).toBe('Tune policy'));
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(async () => expect([...((await savedCues()) ?? [])].sort()).toEqual([...CUE_IDS].sort()));
    await waitFor(() => expect(cue('settings')).toBeNull());
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('mock mode keeps seen cues in memory (writes are refused)', async () => {
    window.location.hash = '#/river';
    const client = createMockClient();
    const { container } = render(<App client={client} now={now} />);
    await waitFor(() => expect(cue('river')).not.toBeNull());
    fireEvent.keyDown(window, { key: 'Tab' });
    await waitFor(() => expect(cue('river')).toBeNull());
    await nav('#/you');
    await waitFor(() => expect(cue('you')?.textContent).toBe('Your profile'));
    fireEvent.click(document.body);
    await nav('#/river');
    await waitFor(() => expect(screenLabel(container)).toBe('River'));
    await waitFor(() => expect(container.querySelector('.btn--primary')).not.toBeNull());
    expect(cue('river')).toBeNull();
    const cfg = await client.run('config.get', {});
    expect(cfg.status === 'ok' && cfg.output.ui?.cues_seen).toEqual([]);
  });

  it('respects reduced motion: no fade', async () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({ ...real(q), matches: q.includes('reduced-motion') })) as typeof window.matchMedia;
    try {
      boot('#/now');
      await waitFor(() => expect(cue('now')).not.toBeNull());
      const halo = document.querySelector('.cue__halo') as HTMLElement;
      expect(halo.style.animation).toBe('none');
      expect(halo.style.boxShadow).toContain(tint.scrim);
    } finally {
      window.matchMedia = real;
    }
  });
});
