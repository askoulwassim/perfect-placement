import { FORBIDDEN_BUTTON_LABELS, OP_NAMES } from '@perfect-placement/contracts';
import { FIXTURE_NOW, FIXTURE_ROLE_IDS as R } from '@perfect-placement/fixtures';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { type Live, openLive } from './test/live';

/*
 * The app on the live HTTP client. A fake fetch serves `POST /api/ops/:name` from a real engine
 * over a temp copy of the synthetic fixture vault (src/test/live.ts): every click is a real op.
 */

const now = () => new Date(FIXTURE_NOW);
let live: Live | null = null;
afterEach(() => {
  live?.close();
  live = null;
});

async function boot(hash: string, before?: (l: Live) => Promise<unknown>) {
  window.location.hash = hash;
  live = openLive();
  await before?.(live);
  const utils = render(<App client={live.client} now={now} pollMs={20} />);
  return { live, ...utils };
}

const go = async (hash: string) => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
};

/** querySelector that throws, so waitFor retries until the element exists. */
const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

const VALID_OPS = new Set<string>([...OP_NAMES, 'nav', 'local']);

/** Every button names exactly one registry op (or nav/local view state) and none is an external Send/Submit. */
function assertButtons(container: HTMLElement) {
  const buttons = Array.from(container.querySelectorAll('button'));
  expect(buttons.length).toBeGreaterThan(0);
  for (const b of buttons) {
    const op = b.getAttribute('data-op');
    expect(op, `button "${b.textContent}" has no data-op`).not.toBeNull();
    expect(VALID_OPS.has(op as string), `unknown op ${op}`).toBe(true);
    expect(['outreach.send', 'apply.mark_submitted']).not.toContain(op);
    const label = (b.textContent ?? '').trim();
    for (const bad of FORBIDDEN_BUTTON_LABELS) expect(label.startsWith(bad)).toBe(false);
  }
}

const primary = (container: HTMLElement) => container.querySelector('.btn--primary') as HTMLButtonElement;
const nextQ = (container: HTMLElement) => container.querySelector('.decision__q')?.textContent ?? 'clear';
const opsCalled = () => live?.calls.map((c) => c.name) ?? [];

describe('screens', () => {
  const routes = [
    ['#/now', 'Review 7'],
    ['#/needs-you', 'Accept'],
    ['#/river', 'Scout now'],
    [`#/role/${R.stripeOnDeck}`, 'Research'],
    [`#/people/${R.linearDraft}`, 'Draft for Maya'],
    ['#/outreach/or_0001', 'Create Gmail draft'],
    ['#/you', 'Review 2 diff'],
    ['#/onboarding', 'Next'],
    ['#/settings', 'Save'],
  ] as const;
  for (const [hash, label] of routes) {
    it(`${hash} renders one primary "${label}" and only op-bound buttons`, async () => {
      const { container } = await boot(hash);
      await waitFor(() => expect(primary(container)?.textContent).toBe(label));
      expect(container.querySelectorAll('.btn--primary').length).toBe(1);
      assertButtons(container);
    });
  }

  it('reads go over HTTP as POST /api/ops/:name with the input as the JSON body', async () => {
    await boot(`#/role/${R.linearDraft}`);
    await waitFor(() => expect(opsCalled()).toContain('outreach.list'));
    const get = live?.calls.find((c) => c.name === 'roles.get');
    expect(get?.url).toBe('/api/ops/roles.get');
    expect(get?.body).toEqual({ role_id: R.linearDraft });
  });
});

describe('click paths', () => {
  it('Now -> Review -> through every decision -> Clear', async () => {
    const { container } = await boot('#/now');
    await waitFor(() => expect(primary(container).textContent).toBe('Review 7'));
    fireEvent.click(primary(container));
    const seen: string[] = [];
    for (let i = 0; i < 7; i++) {
      const q = (await waitFor(() => $(container, '.decision__q'))).textContent as string;
      seen.push(q);
      fireEvent.click(primary(container));
      await waitFor(() => expect(nextQ(container)).not.toBe(q));
    }
    expect(seen).toEqual(
      expect.arrayContaining([
        'Is this posting open?',
        'What is this reply?',
        'Apply this change?',
        'Create the Gmail draft?',
        'Submit this application?',
      ]),
    );
    await screen.findByText('Clear');
    expect(primary(container).textContent).toBe('Back to Now');
    // Submit opens the portal; the app never resolves it.
    expect(window.open).toHaveBeenCalled();
    expect(
      live?.calls.filter((c) => c.name === 'decisions.resolve').map((c) => (c.body as { decision_id: string }).decision_id),
    ).not.toContain('dc_0005');
    const q = await live?.client.run('decisions.queue', {});
    expect(q?.status === 'ok' && q.output.pending.map((d) => d.id)).toEqual(['dc_0005']);
  });

  it('Needs you keyboard: S skips, C opens change, A accepts', async () => {
    const { container } = await boot('#/needs-you');
    const first = (await waitFor(() => $(container, '.decision__q'))).textContent;
    fireEvent.keyDown(window, { key: 's' });
    await waitFor(() => expect(nextQ(container)).not.toBe(first));
    const second = nextQ(container);
    fireEvent.keyDown(window, { key: 'c' });
    const alts = await waitFor(() => $(container, '.decision__alts'));
    fireEvent.click(within(alts).getAllByRole('button')[0] as HTMLElement);
    await waitFor(() => expect(nextQ(container)).not.toBe(second));
    // Queue is newest first: the third card is the submit decision, where A opens the portal and never resolves.
    expect(nextQ(container)).toBe('Submit this application?');
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(nextQ(container)).not.toBe('Submit this application?'));
    const fourth = nextQ(container);
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(nextQ(container)).not.toBe(fourth));
    const actions = live?.calls.filter((c) => c.name === 'decisions.resolve').map((c) => (c.body as { action: string }).action);
    expect(actions).toEqual(['skip', 'change', 'accept']);
  });

  it('Role -> Connect -> People -> warm hiring -> Create Gmail draft -> Role with Connect done', async () => {
    const { container } = await boot(`#/role/${R.linearDraft}`);
    await waitFor(() => expect(primary(container).textContent).toBe('Connect'));
    fireEvent.click(primary(container));
    await waitFor(() => expect(window.location.hash).toBe(`#/people/${R.linearDraft}`));
    // The click started a headless run; the engine launched the configured runner (a fake here).
    expect(live?.engine.launcher.specs.at(-1)?.args.join(' ')).toContain('connect');
    await go(`#/people/${R.linearDraft}`);
    const maya = await waitFor(() => $(container, '.people-list [data-contact="ct_0001"]'));
    fireEvent.click(maya);
    await go(window.location.hash);
    await waitFor(() => expect(primary(container).textContent).toBe('Create Gmail draft'));
    expect(primary(container).getAttribute('data-op')).toBe('runs.start');
    fireEvent.click(primary(container));
    // Gmail via agent: the click starts a connect run scoped to the draft; the headless agent makes the draft.
    await waitFor(() => expect(container.querySelector('[data-run]')?.getAttribute('data-run')).toBe('running'));
    expect(live?.calls.filter((c) => c.name === 'runs.start').at(-1)?.body).toEqual({ skill: 'connect', outreach_id: 'or_0001' });
    expect(primary(container).disabled).toBe(true);
    const spec = live?.engine.launcher.specs.at(-1);
    expect(spec?.args).not.toContain('--chrome');
    expect(spec?.args[1]).toContain('outreach_id: or_0001');
    expect(live?.calls.some((c) => c.name === 'outreach.to_gmail')).toBe(false);
    // The agent records the draft it created with its own Gmail tool, then finishes the run.
    const recorded = await live?.as(
      'agent',
      'outreach.to_gmail',
      { outreach_id: 'or_0001', gmail_draft_id: 'r-agent-1' },
      { confidence: { p: 0.95, backend: 'agent' } },
    );
    expect(recorded?.status).toBe('ok');
    expect(
      await live?.as('agent', 'runs.finish', { run_id: spec?.runId, status: 'ok', summary: { outreach_id: 'or_0001' } }),
    ).toMatchObject({
      status: 'ok',
    });
    // runs.get poll sees the run finish; the outreach refreshes to in_gmail and the button disables.
    await waitFor(() => expect(container.querySelector('[data-run]')?.getAttribute('data-run')).toBe('ok'));
    await waitFor(() => expect(primary(container).disabled).toBe(true));
    expect(live?.calls.some((c) => c.name === 'runs.get')).toBe(true);
    await go(`#/role/${R.linearDraft}`);
    await waitFor(() => expect(primary(container).textContent).toBe('Fill'));
    const connect = Array.from(container.querySelectorAll('.stage')).find((s) => s.textContent === 'Connect');
    expect(connect?.getAttribute('data-state')).toBe('done');
    const o = await live?.client.run('outreach.get', { outreach_id: 'or_0001' });
    expect(o?.status === 'ok' && o.output.outreach).toMatchObject({ status: 'in_gmail', gmail_draft_id: 'r-agent-1' });
  });

  it('People: Draft for <best path> starts a connect run for that person and opens the draft it wrote', async () => {
    const { container } = await boot(`#/people/${R.linearDraft}`);
    await waitFor(() => expect(primary(container).textContent).toBe('Draft for Maya'));
    fireEvent.click(primary(container));
    await waitFor(() => expect(live?.calls.some((c) => c.name === 'runs.start')).toBe(true));
    const start = live?.calls.find((c) => c.name === 'runs.start');
    expect(start?.body).toEqual({ skill: 'connect', role_id: R.linearDraft, contact_id: 'ct_0001' });
    // The headless agent finishes the run and names the draft (wave2 contract: summary_json.outreach_id).
    const runs = await live?.client.run('runs.list', { op: 'connect' });
    const run = runs?.status === 'ok' ? runs.output.items.find((r) => r.status === 'running') : undefined;
    expect(run).toBeDefined();
    const fin = await live?.as('agent', 'runs.finish', { run_id: run?.id, status: 'ok', summary: { outreach_id: 'or_0001' } });
    expect(fin?.status).toBe('ok');
    await waitFor(() => expect(window.location.hash).toBe('#/outreach/or_0001'));
  });

  it('Outreach tone chips switch the draft text locally', async () => {
    const { container } = await boot('#/outreach/or_0001');
    await waitFor(() => $(container, '.outreach-block'));
    const text = () =>
      Array.from(container.querySelectorAll('.outreach-block'))
        .map((b) => b.textContent)
        .join('|');
    const before = text();
    const calls = live?.calls.length;
    fireEvent.click(screen.getByText('Coffee or intro'));
    await waitFor(() => expect(text()).not.toBe(before));
    expect(live?.calls.length).toBe(calls);
    expect(screen.getByText('Coffee or intro').closest('button')?.getAttribute('data-op')).toBe('local');
  });

  it('River: drag active -> on-deck, forbidden drop bounces, then open the role', async () => {
    const id = 'datadog_staff-pm-data-pipelines';
    const { container } = await boot('#/river');
    const tile = await waitFor(() => $(container, `.river-tile[data-role="${id}"]`));
    const col = (s: string) => $(container, `.river-col[data-status="${s}"]`);

    fireEvent.dragStart(tile, { dataTransfer: { setData: () => {}, effectAllowed: '' } });
    await waitFor(() => expect(col('on-deck').className).toContain('is-drop-allowed'));
    expect(col('applied').className).not.toContain('is-drop-allowed');
    expect(col('held').className).not.toContain('is-drop-allowed');
    fireEvent.drop(col('applied'));
    await waitFor(() => expect($(container, `[data-role="${id}"]`).className).toContain('is-bounce'));

    fireEvent.dragStart($(container, `.river-tile[data-role="${id}"]`), { dataTransfer: { setData: () => {}, effectAllowed: '' } });
    fireEvent.drop(col('on-deck'));
    await waitFor(() => expect(col('on-deck').querySelector(`[data-role="${id}"]`)).not.toBeNull());
    const r = await live?.client.run('roles.get', { role_id: id });
    expect(r?.status === 'ok' && r.output.role.status).toBe('on-deck');

    fireEvent.click(col('on-deck').querySelector(`[data-role="${id}"]`) as HTMLElement);
    expect(window.location.hash).toBe(`#/role/${id}`);
  });

  it('River has a Held column and stacks held roles on the capped company tile', async () => {
    const { container } = await boot('#/river');
    await waitFor(() => expect($(container, '.held-chip').textContent).toBe('+2 held'));
    const held = $(container, '.river-col[data-status="held"]');
    expect(held.querySelectorAll('.river-tile').length).toBe(2);
  });

  it('You: Domain -> Accept diff -> timeline gains a version', async () => {
    const { container } = await boot('#/you');
    const domain = await waitFor(() => $(container, '[data-component="domain"]'));
    fireEvent.click(domain);
    await waitFor(() => expect(primary(container).textContent).toBe('Accept diff'));
    const before = container.querySelectorAll('.timeline__item').length;
    fireEvent.click(primary(container));
    await waitFor(() => expect(container.querySelectorAll('.timeline__item').length).toBe(before + 1));
    expect($(container, '.timeline__item.is-current .timeline__v').textContent).toBe(`v${before + 1}`);
    await waitFor(() => expect(primary(container).textContent).toBe('Review 1 diff'));
  });

  it('Onboarding resumes the saved session at Calibrate', async () => {
    await boot('#/onboarding');
    await screen.findByText('1 / 12');
  });

  it('Onboarding: four steps end to end', async () => {
    const { container } = await boot('#/onboarding', (l) => l.client.run('onboard.start', {}));
    await waitFor(() => expect(primary(container).disabled).toBe(true));
    const resume = new File(['# Resume\n\nData product lead. Built a self-serve analytics product.'], 'resume.md', {
      type: 'text/markdown',
    });
    fireEvent.drop($(container, '.dropzone'), { dataTransfer: { files: [resume] } });
    await waitFor(() => expect(container.querySelectorAll('.ob-node.is-lit').length).toBeGreaterThan(4), { timeout: 4000 });
    await waitFor(() => expect(primary(container).style.opacity).toBe('1'), { timeout: 4000 });
    fireEvent.click(primary(container));

    for (let i = 0; i < 12 && !container.querySelector('.calibrate'); i++) {
      const q = (await waitFor(() => $(container, '.onboard-q__text'))).textContent;
      const chip = container.querySelector('.onboard-q .chip');
      const text = container.querySelector('.onboard-q textarea');
      if (chip) fireEvent.click(chip);
      if (text) fireEvent.change(text, { target: { value: 'Short and direct.' } });
      fireEvent.click(primary(container));
      await waitFor(() =>
        expect(container.querySelector('.calibrate') ?? container.querySelector('.onboard-q__text')?.textContent).not.toBe(q),
      );
    }

    await screen.findByText('1 / 12');
    const bars = () =>
      Array.from(container.querySelectorAll<HTMLElement>('.weights__bar'))
        .map((b) => b.style.width)
        .join();
    const before = bars();
    fireEvent.click(screen.getByRole('button', { name: 'Y' }));
    for (let i = 2; i <= 12; i++) {
      await screen.findByText(`${i} / 12`);
      fireEvent.keyDown(window, { key: i % 2 ? 'n' : 'y' });
    }
    await waitFor(() => $(container, '.cal-done'));
    expect(bars()).not.toBe(before);
    fireEvent.click(primary(container));
    await waitFor(() => expect(primary(container).textContent).toBe('Start'));
    fireEvent.click(primary(container));
    await waitFor(() => expect(window.location.hash).toBe('#/now'));
    expect(opsCalled()).toContain('onboard.confirm');
  });

  it('Cmd+K from anywhere: staleness -> generated cards -> Check all', async () => {
    const { container } = await boot('#/river');
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByRole('textbox', { name: 'Ask' });
    fireEvent.change(input, { target: { value: 'Which active roles are going stale?' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    const reply = await waitFor(() => $(container, '.ask__reply[data-state="done"]'), { timeout: 4000 });
    await waitFor(() => expect(reply.querySelectorAll('[data-genui="RoleCard"] .role-card').length).toBe(4));
    const check = await waitFor(() => within(reply).getByText('Check all'));
    expect(check.getAttribute('data-op')).toBe('roles.check_freshness');
    fireEvent.click(check);
    await waitFor(() => expect(reply.querySelector('[data-genui="OpButton"][data-done]')).not.toBeNull());
    const checked = live?.calls.find((c) => c.name === 'roles.check_freshness');
    expect((checked?.body as { role_ids?: string[] } | undefined)?.role_ids).toHaveLength(4);
    assertButtons(container);
  });

  it('Settings: policy grid #24 with locked exclusions; threshold drag and schedule toggle save via config.update', async () => {
    const { container } = await boot('#/settings');
    const cells = await waitFor(() => {
      const c = Array.from(container.querySelectorAll('.policy__grid [data-outcome]')).map((e) => e.getAttribute('data-outcome'));
      if (c.length !== 9) throw new Error('grid');
      return c;
    });
    expect(cells).toEqual(['auto', 'auto', 'auto_undo', 'auto', 'auto_second', 'human', 'auto_undo', 'human', 'human']);
    const locked = Array.from(container.querySelectorAll('.policy__lock')).map((e) => e.textContent);
    expect(locked).toEqual(['Submit application', 'Send email', 'Delete anything', 'Dealbreakers', 'Comp floor']);
    expect(container.querySelectorAll('.policy__locked button, .policy__locked input').length).toBe(0);
    await waitFor(() =>
      expect(Array.from(container.querySelectorAll('.backend')).map((b) => b.textContent?.slice(0, 5))).toEqual(['KevLO', 'Agent']),
    );

    const auto = await screen.findByRole('slider', { name: 'Auto' });
    fireEvent.keyDown(auto, { key: 'ArrowRight' });
    await waitFor(() => expect($(container, '.policy__head').textContent).toContain('0.89'));
    fireEvent.click(screen.getByRole('switch', { name: 'Inbox' }));
    fireEvent.click(primary(container));
    await waitFor(async () => {
      const c = await live?.client.run('config.get', {});
      expect(c?.status === 'ok' && c.output.policy.auto).toBe(0.89);
      expect(c?.status === 'ok' && c.output.schedules.inbox).toBe('off');
    });
  });
});

describe('mobile', () => {
  const real = window.matchMedia;
  afterEach(() => {
    window.matchMedia = real;
  });
  it('phone layout: tab bar Now, River, You, Ask and the primary pinned above it', async () => {
    window.matchMedia = ((q: string) => ({
      matches: true,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    const { container } = await boot('#/now');
    const tabs = await waitFor(() => $(container, '.tabbar'));
    expect(Array.from(tabs.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))).toEqual(['Now', 'River', 'You', 'Ask']);
    await waitFor(() => expect(primary(container).textContent).toBe('Review 7'));
    expect(container.querySelector('.rail')).toBeNull();
    assertButtons(container);
  });
});
