import { FORBIDDEN_BUTTON_LABELS, OP_NAMES } from '@perfect-placement/contracts';
import { FIXTURE_NOW, FIXTURE_ROLE_IDS as R } from '@perfect-placement/fixtures';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

/** querySelector that throws, so waitFor retries until the element exists. */
const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

const primary = (container: HTMLElement) => container.querySelector('.btn--primary') as HTMLButtonElement;

describe('screens', () => {
  const routes = [
    ['#/now', 'Review 7'],
    ['#/needs-you', 'Accept'],
    ['#/river', 'Scout now'],
    [`#/role/${R.stripeOnDeck}`, 'Research'],
    [`#/people/${R.linearDraft}`, 'Draft for Maya R.'],
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
    await screen.findByText('Still open?');
    const seen: string[] = [];
    for (let i = 0; i < 7; i++) {
      const q = (await waitFor(() => $(container, '.decision__q'))).textContent as string;
      seen.push(q);
      fireEvent.click(primary(container));
      await waitFor(() => expect(container.querySelector('.decision__q')?.textContent ?? 'clear').not.toBe(q));
    }
    expect(seen).toEqual(
      expect.arrayContaining(['Still open?', 'What is this email?', 'Apply this change?', 'Ready for Gmail?', 'Ready to submit?']),
    );
    await screen.findByText('Clear');
    expect(window.open).toHaveBeenCalled();
  });

  it('Needs you keyboard: S skips, C opens change, A accepts', async () => {
    const { container } = boot('#/needs-you');
    await screen.findByText('Still open?');
    fireEvent.keyDown(window, { key: 's' });
    await screen.findByText('What is this email?');
    fireEvent.keyDown(window, { key: 'c' });
    const alts = await waitFor(() => $(container, '.decision__alts'));
    fireEvent.click(within(alts).getByText('Confirmation'));
    await screen.findByText('Apply this change?');
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

  it('River: drag active -> on-deck, forbidden drop bounces, then open the role', async () => {
    const id = 'datadog_staff-pm-data-pipelines';
    const { container, client } = boot('#/river');
    const tile = await waitFor(() => $(container, `.river-tile[data-role="${id}"]`));
    const col = (s: string) => container.querySelector(`.river-col[data-status="${s}"]`) as HTMLElement;

    fireEvent.dragStart(tile, { dataTransfer: { setData: () => {}, effectAllowed: '' } });
    await waitFor(() => expect(col('on-deck').className).toContain('is-drop-allowed'));
    expect(col('applied').className).not.toContain('is-drop-allowed');
    fireEvent.drop(col('applied'));
    await waitFor(() => expect(container.querySelector(`[data-role="${id}"]`)?.className).toContain('is-bounce'));

    const tile2 = container.querySelector(`.river-tile[data-role="${id}"]`) as HTMLElement;
    fireEvent.dragStart(tile2, { dataTransfer: { setData: () => {}, effectAllowed: '' } });
    fireEvent.drop(col('on-deck'));
    await waitFor(() => expect(col('on-deck').querySelector(`[data-role="${id}"]`)).not.toBeNull());
    const r = await client.run('roles.get', { role_id: id });
    expect(r.status === 'ok' && r.output.role.status).toBe('on-deck');

    fireEvent.click(col('on-deck').querySelector(`[data-role="${id}"]`) as HTMLElement);
    expect(window.location.hash).toBe(`#/role/${id}`);
  });

  it('River draws held roles as a stack on the capped company', async () => {
    const { container } = boot('#/river');
    await waitFor(() => expect(container.querySelector('.held-chip')?.textContent).toBe('+2 held'));
    expect(container.querySelector('.river-col[data-status="held"]')).toBeNull();
  });

  it('You: Domain -> Accept diff -> timeline gains v3', async () => {
    const { container } = boot('#/you');
    const domain = await waitFor(() => $(container, '[data-component="domain"]'));
    fireEvent.click(domain);
    await waitFor(() => expect(primary(container).textContent).toBe('Accept diff'));
    expect(container.querySelectorAll('.timeline__item').length).toBe(2);
    fireEvent.click(primary(container));
    await waitFor(() => expect(container.querySelectorAll('.timeline__item').length).toBe(3));
    expect(container.querySelector('.timeline__item.is-current .timeline__v')?.textContent).toBe('v3');
    await waitFor(() => expect(primary(container).textContent).toBe('Review 1 diff'));
  });

  it('Onboarding: four steps end to end', async () => {
    const { container } = boot('#/onboarding');
    await waitFor(() => expect(primary(container).disabled).toBe(true));
    fireEvent.drop(container.querySelector('.dropzone') as HTMLElement, { dataTransfer: { files: [] } });
    await waitFor(() => expect(primary(container).disabled).toBe(false));
    fireEvent.click(primary(container));

    for (let i = 0; i < 4; i++) {
      const q = (await waitFor(() => $(container, '.onboard-q__text'))).textContent;
      const chip = container.querySelector('.onboard-q .chip');
      if (chip) fireEvent.click(chip);
      await waitFor(() => expect(primary(container).disabled).toBe(false));
      fireEvent.click(primary(container));
      if (i < 3) await waitFor(() => expect(container.querySelector('.onboard-q__text')?.textContent).not.toBe(q));
    }

    await screen.findByText('Calibrate');
    await screen.findByText('1 / 12');
    const before = (container.querySelector('.weights__bar span') as HTMLElement).style.width;
    fireEvent.click(screen.getByText('Yes'));
    for (let i = 2; i <= 12; i++) {
      await screen.findByText(`${i} / 12`);
      fireEvent.keyDown(window, { key: i % 2 ? 'n' : 'y' });
    }
    await screen.findByText('Done');
    expect((container.querySelector('.weights__bar span') as HTMLElement).style.width).not.toBe(before);
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
    await waitFor(() => expect(container.querySelectorAll('.ask__reply .role-card').length).toBe(4));
    const check = within(container.querySelector('.ask__reply') as HTMLElement).getByText('Check all');
    expect(check.getAttribute('data-op')).toBe('roles.check_freshness');
    fireEvent.click(check);
    await waitFor(() => expect(container.querySelectorAll('.ask__reply [data-fresh="ok"]').length).toBe(4));
    assertButtons(container);
  });

  it('Settings: dragging a threshold recolors bars, Save calls config.update', async () => {
    const { container, client } = boot('#/settings');
    const auto = await screen.findByRole('slider', { name: 'Auto' });
    fireEvent.change(auto, { target: { value: '0.8' } });
    await waitFor(() => expect(container.querySelector('.policy__grid th:nth-child(2)')?.textContent).toContain('0.80'));
    fireEvent.click(primary(container));
    await waitFor(async () => {
      const c = await client.run('config.get', {});
      expect(c.status === 'ok' && c.output.policy.auto).toBe(0.8);
    });
  });

  it('Mobile tab bar has Now, River, You, Ask', async () => {
    const { container } = boot('#/now');
    const tabs = container.querySelector('.tabbar') as HTMLElement;
    expect(Array.from(tabs.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))).toEqual(['Now', 'River', 'You', 'Ask']);
  });
});
