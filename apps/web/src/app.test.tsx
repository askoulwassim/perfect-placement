import { FORBIDDEN_BUTTON_LABELS, OP_NAMES } from '@perfect-placement/contracts';
import { FIXTURE_NOW, FIXTURE_ROLE_IDS as R } from '@perfect-placement/fixtures';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createMockClient } from './client/mock';
import { SHIM_NAMES } from './client/types';

const now = () => new Date(FIXTURE_NOW);

function boot(hash: string) {
  window.location.hash = hash;
  const client = createMockClient({ now });
  const utils = render(<App client={client} now={now} />);
  return { client, ...utils };
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

const VALID_OPS = new Set<string>([...OP_NAMES, ...SHIM_NAMES, 'nav', 'local']);

/** Every button names exactly one op (or nav/local view state) and none is an external Send/Submit. */
function assertButtons(container: HTMLElement) {
  const buttons = Array.from(container.querySelectorAll('button'));
  expect(buttons.length).toBeGreaterThan(0);
  for (const b of buttons) {
    const op = b.getAttribute('data-op');
    expect(op, `button "${b.textContent}" has no data-op`).not.toBeNull();
    expect(VALID_OPS.has(op as string), `unknown op ${op}`).toBe(true);
    const label = (b.textContent ?? '').trim();
    for (const bad of FORBIDDEN_BUTTON_LABELS) expect(label.startsWith(bad)).toBe(false);
  }
}

const primary = (container: HTMLElement) => container.querySelector('.btn--primary') as HTMLButtonElement;
const nextQ = (container: HTMLElement) => container.querySelector('.decision__q')?.textContent ?? 'clear';

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
      const { container } = boot(hash);
      await waitFor(() => expect(primary(container)?.textContent).toBe(label));
      expect(container.querySelectorAll('.btn--primary').length).toBe(1);
      assertButtons(container);
    });
  }
});

describe('click paths', () => {
  it('Now -> Review -> through every decision -> Clear', async () => {
    const { container } = boot('#/now');
    await waitFor(() => expect(primary(container).textContent).toBe('Review 7'));
    fireEvent.click(primary(container));
    await screen.findByText('Is this posting open?');
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
    expect(window.open).toHaveBeenCalled();
  });

  it('Needs you keyboard: S skips, C opens change, A accepts', async () => {
    const { container } = boot('#/needs-you');
    await screen.findByText('Is this posting open?');
    fireEvent.keyDown(window, { key: 's' });
    await screen.findByText('What is this reply?');
    fireEvent.keyDown(window, { key: 'c' });
    const alts = await waitFor(() => $(container, '.decision__alts'));
    fireEvent.click(within(alts).getByText('Confirmation'));
    await screen.findByText('Apply this change?');
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(nextQ(container)).not.toBe('Apply this change?'));
  });

  it('Role -> Connect -> People -> warm hiring -> Draft -> Create Gmail draft -> Role with Connect done', async () => {
    const { container, client } = boot(`#/role/${R.linearDraft}`);
    await waitFor(() => expect(primary(container).textContent).toBe('Connect'));
    fireEvent.click(primary(container));
    await waitFor(() => expect(window.location.hash).toBe(`#/people/${R.linearDraft}`));
    await go(`#/people/${R.linearDraft}`);
    const maya = await waitFor(() => $(container, '.people-list [data-contact="ct_0001"]'));
    fireEvent.click(maya);
    await go(window.location.hash);
    await waitFor(() => expect(primary(container).textContent).toBe('Create Gmail draft'));
    fireEvent.click(primary(container));
    await waitFor(() => expect(window.location.hash).toBe(`#/role/${R.linearDraft}`));
    await go(window.location.hash);
    await waitFor(() => expect(primary(container).textContent).toBe('Fill'));
    const connect = Array.from(container.querySelectorAll('.stage')).find((s) => s.textContent === 'Connect');
    expect(connect?.getAttribute('data-state')).toBe('done');
    const o = await client.run('outreach.get', { outreach_id: 'or_0001' });
    expect(o.status === 'ok' && o.output.outreach.status).toBe('in_gmail');
  });

  it('Outreach tone chips switch the draft text locally', async () => {
    const { container } = boot('#/outreach/or_0001');
    const hook = await waitFor(() => $(container, '.outreach-block'));
    const before = hook.textContent;
    fireEvent.click(screen.getByText('Forwardable blurb'));
    await waitFor(() => expect($(container, '.outreach-block').textContent).not.toBe(before));
    expect(screen.getByText('Forwardable blurb').closest('button')?.getAttribute('data-op')).toBe('local');
  });

  it('River: drag active -> on-deck, forbidden drop bounces, then open the role', async () => {
    const id = 'datadog_staff-pm-data-pipelines';
    const { container, client } = boot('#/river');
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
    const r = await client.run('roles.get', { role_id: id });
    expect(r.status === 'ok' && r.output.role.status).toBe('on-deck');

    fireEvent.click(col('on-deck').querySelector(`[data-role="${id}"]`) as HTMLElement);
    expect(window.location.hash).toBe(`#/role/${id}`);
  });

  it('River has a Held column and stacks held roles on the capped company tile', async () => {
    const { container } = boot('#/river');
    await waitFor(() => expect($(container, '.held-chip').textContent).toBe('+2 held'));
    const held = $(container, '.river-col[data-status="held"]');
    expect(held.querySelectorAll('.river-tile').length).toBe(2);
  });

  it('You: Domain -> Accept diff -> timeline gains v3', async () => {
    const { container } = boot('#/you');
    const domain = await waitFor(() => $(container, '[data-component="domain"]'));
    fireEvent.click(domain);
    await waitFor(() => expect(primary(container).textContent).toBe('Accept diff'));
    expect(container.querySelectorAll('.timeline__item').length).toBe(2);
    fireEvent.click(primary(container));
    await waitFor(() => expect(container.querySelectorAll('.timeline__item').length).toBe(3));
    expect($(container, '.timeline__item.is-current .timeline__v').textContent).toBe('v3');
    await waitFor(() => expect(primary(container).textContent).toBe('Review 1 diff'));
  });

  it('Onboarding: four steps end to end', async () => {
    const { container } = boot('#/onboarding');
    await waitFor(() => expect(primary(container).disabled).toBe(true));
    fireEvent.drop($(container, '.dropzone'), { dataTransfer: { files: [] } });
    await waitFor(() => expect(container.querySelectorAll('.ob-node.is-lit').length).toBe(5), { timeout: 4000 });
    await waitFor(() => expect(primary(container).style.opacity).toBe('1'), { timeout: 4000 });
    fireEvent.click(primary(container));

    for (let i = 0; i < 3; i++) {
      const q = (await waitFor(() => $(container, '.onboard-q__text'))).textContent;
      const chip = container.querySelector('.onboard-q .chip');
      if (chip) fireEvent.click(chip);
      fireEvent.click(primary(container));
      if (i < 2) await waitFor(() => expect(container.querySelector('.onboard-q__text')?.textContent).not.toBe(q));
    }

    await screen.findByText('1 / 12');
    const before = $(container, '.weights__bar').style.width;
    fireEvent.click(screen.getByRole('button', { name: 'Y' }));
    for (let i = 2; i <= 12; i++) {
      await screen.findByText(`${i} / 12`);
      fireEvent.keyDown(window, { key: i % 2 ? 'n' : 'y' });
    }
    await waitFor(() => $(container, '.cal-done'));
    expect($(container, '.weights__bar').style.width).not.toBe(before);
    fireEvent.click(primary(container));
    await waitFor(() => expect(primary(container).textContent).toBe('Start'));
    fireEvent.click(primary(container));
    await waitFor(() => expect(window.location.hash).toBe('#/now'));
  });

  it('Cmd+K from anywhere: staleness -> cards -> Check all', async () => {
    const { container } = boot('#/river');
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByRole('textbox', { name: 'Ask' });
    fireEvent.change(input, { target: { value: 'Which active roles are going stale?' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => expect(container.querySelectorAll('.ask__reply .role-card').length).toBe(4), { timeout: 3000 });
    const check = await waitFor(() => within($(container, '.ask__reply')).getByText('Check all'));
    expect(check.getAttribute('data-op')).toBe('roles.check_freshness');
    fireEvent.click(check);
    await waitFor(() => expect(container.querySelectorAll('.ask__reply .role-card[data-fresh="ok"]').length).toBe(4));
    assertButtons(container);
  });

  it('Settings: moving a threshold relabels the grid, Save calls config.update', async () => {
    const { container, client } = boot('#/settings');
    const auto = await screen.findByRole('slider', { name: 'Auto' });
    fireEvent.keyDown(auto, { key: 'ArrowRight' });
    await waitFor(() => expect($(container, '.policy__head').textContent).toContain('0.89'));
    fireEvent.click(primary(container));
    await waitFor(async () => {
      const c = await client.run('config.get', {});
      expect(c.status === 'ok' && c.output.policy.auto).toBe(0.89);
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
    const { container } = boot('#/now');
    const tabs = await waitFor(() => $(container, '.tabbar'));
    expect(Array.from(tabs.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))).toEqual(['Now', 'River', 'You', 'Ask']);
    await waitFor(() => expect(primary(container).textContent).toBe('Review 7'));
    expect(container.querySelector('.rail')).toBeNull();
    assertButtons(container);
  });
});
