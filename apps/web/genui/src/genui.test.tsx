import type { ParseResult } from '@openuidev/react-lang';
import { FORBIDDEN_BUTTON_LABELS, GENUI_PROPS, PRIMARY_ACTIONS } from '@perfect-placement/contracts';
import { FIXTURE_NOW, FIXTURE_ROLE_IDS as R } from '@perfect-placement/fixtures';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientProvider } from '../../src/client/context';
import { type Live, openLive } from '../../src/test/live';
import { composeReply, intentOf } from './compose';
import { ASK_ACTION_OPS, actionInput, askLibrary, askSystemPrompt } from './library';
import { SCENARIOS } from './replies.test-fixtures';
import { GenuiReply } from './reply';
import { roughPieces } from './stream';

const now = () => new Date(FIXTURE_NOW);
let live: Live | null = null;
afterEach(() => {
  live?.close();
  live = null;
});

/** Render a reply inside the app's client (cards fetch through ops served by a fixture engine). */
function view(response: string, isStreaming = false, onParseResult?: (r: ParseResult | null) => void) {
  live ??= openLive();
  const node = (text: string, streaming: boolean) => (
    <ClientProvider client={live?.client as Live['client']} now={now}>
      <GenuiReply response={text} isStreaming={streaming} onParseResult={onParseResult} />
    </ClientProvider>
  );
  const utils = render(node(response, isStreaming));
  return { ...utils, again: (text: string, streaming: boolean) => utils.rerender(node(text, streaming)) };
}
const all = (el: HTMLElement, kind: string) => Array.from(el.querySelectorAll(`[data-genui="${kind}"]`));
const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)?.openui ?? '';

describe('library', () => {
  it('registers the four cards with the contract GENUI_PROPS (same keys, same order) plus OpButton', () => {
    expect(Object.keys(askLibrary.components).sort()).toEqual([
      'ContactCard',
      'Group',
      'OpButton',
      'ProfileDiff',
      'Reply',
      'RoleCard',
      'ScoreRadar',
      'Text',
    ]);
    for (const name of ['RoleCard', 'ScoreRadar', 'ContactCard', 'ProfileDiff'] as const) {
      const props = askLibrary.components[name]?.props as { shape: Record<string, unknown> } | undefined;
      expect(Object.keys(props?.shape ?? {})).toEqual(Object.keys(GENUI_PROPS[name].shape));
    }
    const prompt = askSystemPrompt();
    for (const sig of [
      'RoleCard(roleId: string)',
      'ScoreRadar(roleId: string)',
      'ContactCard(contactId: string, roleId?: string)',
      'ProfileDiff(diffId: string)',
    ])
      expect(prompt).toContain(sig);
  });

  it('actions are limited to PRIMARY_ACTIONS ops and never submit or send', () => {
    const primary = new Set(Object.values(PRIMARY_ACTIONS).flatMap((xs) => xs.map((x) => x.op)));
    expect(ASK_ACTION_OPS.length).toBeGreaterThan(0);
    for (const op of ASK_ACTION_OPS) expect(primary.has(op)).toBe(true);
    expect(ASK_ACTION_OPS as readonly string[]).not.toContain('outreach.send');
    expect(ASK_ACTION_OPS as readonly string[]).not.toContain('apply.mark_submitted');
    expect(ASK_ACTION_OPS as readonly string[]).not.toContain('decisions.resolve');
    expect(actionInput('runs.start', ['r1', 'c1'], 'connect')).toEqual({ skill: 'connect', role_id: 'r1', contact_id: 'c1' });
    expect(actionInput('roles.check_freshness', [])).toEqual({ all_in_scope: true });
    expect(actionInput('runs.start', ['r1'])).toBeNull();
  });
});

describe('cards hydrate through ops (ids only)', () => {
  it('nested groups render lane D RoleCard, ScoreRadar and ContactCards', async () => {
    const { container } = view(scenario('best-fit'));
    await waitFor(() => expect(all(container, 'ContactCard')).toHaveLength(2));
    expect(all(container, 'Group')).toHaveLength(2);
    const role = await waitFor(() => {
      const r = all(container, 'RoleCard')[0];
      if (!r) throw new Error('no role');
      return r;
    });
    expect(role.querySelector('.role-card')?.textContent).toContain('Linear');
    expect(all(container, 'ScoreRadar')[0]?.querySelector('svg.radar')).not.toBeNull();
    expect(all(container, 'ContactCard').map((e) => e.getAttribute('data-tier'))).toEqual(['warm_hiring', 'bridge']);
    expect(container.querySelector('.avatar')).not.toBeNull();
  });

  it('ProfileDiff renders the DiffBlock from the pending diff', async () => {
    const { container } = view(scenario('profile'));
    await waitFor(() => expect(all(container, 'ProfileDiff')).toHaveLength(2));
    expect(all(container, 'ProfileDiff')[0]?.textContent).toContain('215k');
  });

  it('every recorded scenario parses without errors', async () => {
    for (const s of SCENARIOS) {
      let last: ParseResult | null = null;
      const { container, unmount } = view(s.openui, false, (r) => {
        last = r;
      });
      expect(all(container, 'Reply')).toHaveLength(1);
      expect((last as ParseResult | null)?.meta.errors ?? []).toEqual([]);
      unmount();
    }
  });

  it('an unknown component is dropped and reported; the rest still renders', async () => {
    let last: ParseResult | null = null;
    const src = `root = Reply([x, r])\nx = PieChart("nope")\nr = RoleCard("${R.linearDraft}")`;
    const { container } = view(src, false, (res) => {
      last = res;
    });
    await waitFor(() => expect(all(container, 'RoleCard')).toHaveLength(1));
    expect((last as ParseResult | null)?.meta.errors.map((e) => e.code)).toContain('unknown-component');
  });

  it('a wrong id never invents a card: Pending while streaming, Missing when done', async () => {
    const src = 'root = Reply([r])\nr = RoleCard("acme_ghost-role")';
    const v = view(src, true);
    expect(all(v.container, 'Pending')).toHaveLength(1);
    v.again(src, false);
    await waitFor(() => expect(all(v.container, 'Missing')).toHaveLength(1));
    expect(all(v.container, 'RoleCard')).toHaveLength(0);
  });

  it('positional args: swapped ContactCard args resolve to nothing', async () => {
    const v = view(`root = Reply([p])\np = ContactCard("${R.linearDraft}", "ct_0001")`);
    await waitFor(() => expect(all(v.container, 'Missing')).toHaveLength(1));
    expect(all(v.container, 'ContactCard')).toHaveLength(0);
  });

  it('streaming: the shell and first cards appear before the reply is complete', async () => {
    const src = scenario('top-active');
    const pieces = roughPieces(src);
    const v = view('', true);
    let text = '';
    let firstShellAt = -1;
    for (const [i, p] of pieces.entries()) {
      text += p;
      await act(async () => v.again(text, true));
      if (firstShellAt < 0 && all(v.container, 'Reply').length) firstShellAt = i;
    }
    expect(firstShellAt).toBeGreaterThan(-1);
    expect(firstShellAt).toBeLessThan(pieces.length - 1);
    v.again(text, false);
    await waitFor(() => expect(all(v.container, 'RoleCard')).toHaveLength(3));
  });
});

describe('OpButton', () => {
  it('runs one op through the live client and reports the outcome', async () => {
    const src = `root = Reply([a])\na = OpButton("Check all", "roles.check_freshness", ["${R.linearDraft}"])`;
    const v = view(src);
    const btn = await waitFor(() => {
      const b = v.container.querySelector('button');
      if (!b) throw new Error('no button');
      return b;
    });
    expect(btn.getAttribute('data-op')).toBe('roles.check_freshness');
    await act(async () => btn.click());
    await waitFor(() =>
      expect(v.container.querySelector('[data-genui="OpButton"]')?.getAttribute('data-done')).toBe('1 checked · 0 closed'),
    );
    expect(live?.calls.filter((c) => c.name === 'roles.check_freshness').map((c) => c.body)).toEqual([{ role_ids: [R.linearDraft] }]);
  });

  it('refuses forbidden labels and ops outside the Ask set', async () => {
    const v = view(
      [
        'root = Reply([a, b, c])',
        `a = OpButton("Submit now", "runs.start", ["${R.linearDraft}"], "fill")`,
        'b = OpButton("Send", "outreach.send", ["or_0001"])',
        'c = OpButton("Go", "apply.mark_submitted", ["x"])',
      ].join('\n'),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(v.container.querySelectorAll('button')).toHaveLength(0);
    for (const b of Array.from(v.container.querySelectorAll('button')))
      for (const bad of FORBIDDEN_BUTTON_LABELS) expect(b.textContent?.startsWith(bad)).toBe(false);
  });
});

describe('compose (local Ask)', () => {
  it('routes intents', () => {
    expect(intentOf('what is in interviews?', false)).toBe('interviews');
    expect(intentOf('what changed in my profile', false)).toBe('profile');
    expect(intentOf('find people for this role', true)).toBe('people');
    expect(intentOf('find people for this role', false)).toBe('stale');
    expect(intentOf('Which active roles are going stale?', false)).toBe('stale');
  });

  it('composes id-only replies from op reads that parse cleanly', async () => {
    live = openLive();
    for (const q of ['stale?', 'interviews', 'profile', 'top fit', 'people']) {
      const text = await composeReply(q, { client: live.client, now: now(), roleId: R.linearDraft });
      let last: ParseResult | null = null;
      const { unmount } = view(text, false, (r) => {
        last = r;
      });
      expect((last as ParseResult | null)?.meta.errors ?? [], q).toEqual([]);
      unmount();
    }
    const people = await composeReply('people', { client: live.client, now: now(), roleId: R.linearDraft });
    expect(people).toContain(`OpButton("Draft for Maya", "runs.start", ["${R.linearDraft}", "ct_0001"], "connect")`);
    // Reads only: composing never writes.
    expect(
      live.calls.every((c) => ['roles.get', 'roles.list', 'profile.get', 'contacts.get', 'config.get', 'runs.list'].includes(c.name)),
    ).toBe(true);
  });
});
