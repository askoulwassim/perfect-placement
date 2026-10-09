import { FORBIDDEN_BUTTON_LABELS, OP_NAMES, OPS, type OpName } from '@perfect-placement/contracts';
import { claudeScoreTranscript, claudeTranscript } from '@perfect-placement/engine/testing';
import { FIXTURE_NOW, FIXTURE_ROLE_IDS as R } from '@perfect-placement/fixtures';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeReply } from '../genui/src';
import { App } from './App';
import { RIVER_SORT_KEY, sortLane } from './lib/river';
import type { RoleView } from './lib/role';
import { ASK_THREAD_KEY } from './screens/Ask';
import { type Live, type LiveOptions, openLive } from './test/live';

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

async function boot(hash: string, before?: (l: Live) => Promise<unknown>, opts?: LiveOptions) {
  window.location.hash = hash;
  live = openLive(opts);
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
/** Write ops called so far. Read-only calls (the background runs.list poll, refetches) vary with timing. */
const writes = () =>
  live?.calls.filter((c) => !(OPS[c.name as OpName] as { readOnly?: true } | undefined)?.readOnly).map((c) => c.name) ?? [];
const queueCalls = () => live?.calls.filter((c) => c.name === 'decisions.queue').length ?? 0;

/**
 * The decision card once it has settled (#46): it matches `ok` and stays put with no queue refetch in
 * flight. A card can show briefly between a resolve and the refetch it triggers, so never act on the
 * first card seen.
 */
async function settledQ(container: HTMLElement, ok: (q: string) => boolean): Promise<string> {
  let seen = '';
  await waitFor(
    async () => {
      const q = nextQ(container);
      expect(ok(q), `card "${q}"`).toBe(true);
      const n = queueCalls();
      await new Promise((r) => setTimeout(r, 40));
      expect(queueCalls()).toBe(n);
      expect(nextQ(container)).toBe(q);
      seen = q;
    },
    { timeout: 4000 },
  );
  return seen;
}

describe('screens', () => {
  const routes = [
    ['#/now', 'Review 7'],
    ['#/needs-you', 'Accept'],
    ['#/river', 'Scout now'],
    // Stripe has a dossier already: Research is done, Tailor is next (#61).
    [`#/role/${R.stripeOnDeck}`, 'Tailor'],
    [`#/role/${R.airtableOnDeck}`, 'Research'],
    [`#/role/${R.notionInbox}`, 'Score'],
    [`#/people/${R.linearDraft}`, 'Draft for Maya'],
    ['#/outreach/or_0001', 'Create Gmail draft'],
    ['#/you', 'Review 2 diff'],
    ['#/you/setup', 'Next'],
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
    let prev = '';
    for (let i = 0; i < 7; i++) {
      const before = prev;
      const q = await settledQ(container, (x) => x !== 'clear' && x !== before);
      seen.push(q);
      prev = q;
      fireEvent.click(primary(container));
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
    // #46: every key waits for a settled card (findBy/waitFor), never a synchronous read right after a change.
    const first = await settledQ(container, (q) => q !== 'clear');
    fireEvent.keyDown(window, { key: 's' });
    const second = await settledQ(container, (q) => q !== 'clear' && q !== first);
    fireEvent.keyDown(window, { key: 'c' });
    const alts = await waitFor(() => $(container, '.decision__alts'));
    fireEvent.click(within(alts).getAllByRole('button')[0] as HTMLElement);
    // Queue is newest first: the third card is the submit decision, where A opens the portal and never resolves.
    await settledQ(container, (q) => q === 'Submit this application?' && q !== second);
    fireEvent.keyDown(window, { key: 'a' });
    const fourth = await settledQ(container, (q) => q !== 'clear' && q !== 'Submit this application?');
    fireEvent.keyDown(window, { key: 'a' });
    await waitFor(() => expect(nextQ(container)).not.toBe(fourth));
    await waitFor(() =>
      expect(live?.calls.filter((c) => c.name === 'decisions.resolve').map((c) => (c.body as { action: string }).action)).toEqual([
        'skip',
        'change',
        'accept',
      ]),
    );
  });

  /** Arrow through the queue until the settled card asks `want` (#102). */
  async function cardFor(container: HTMLElement, want: string) {
    for (let i = 0; i < 10 && nextQ(container) !== want; i++) {
      const q = await settledQ(container, (x) => x !== 'clear');
      if (q === want) break;
      fireEvent.keyDown(window, { key: 'ArrowRight' });
    }
    await settledQ(container, (q) => q === want);
    return $(container, '.decision');
  }

  it('Needs you: a freshness card shows Open posting, the last check and its evidence; O opens it (#102)', async () => {
    const url = 'https://boards.example/datadog/cloud-cost';
    const evidence = 'Greenhouse board lists the job; apply button present';
    const { container } = await boot('#/needs-you', async (l) => {
      l.engine.db
        .prepare('UPDATE role SET url = ?, last_checked_at = ? WHERE id = ?')
        .run(url, '2026-10-06T08:00:00.000Z', R.datadogActive);
      l.engine.db
        .prepare(
          `INSERT INTO event (id, ts, type, subject_type, subject_id, payload_json, actor, decision_id) VALUES ('ev_test102', '2026-10-06T08:00:00.000Z', 'freshness_checked', 'role', ?, ?, 'schedule', NULL)`,
        )
        .run(R.datadogActive, JSON.stringify({ freshness: 'unsure', evidence }));
    });
    const card = await cardFor(container, 'Is this posting open?');
    const link = $<HTMLAnchorElement>(card, 'a.open-posting');
    expect(link.getAttribute('href')).toBe(url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toContain('Open posting');
    expect($(card, '.decision__checked').textContent).toMatch(new RegExp(`ago · ${evidence}`));
    const q = await live?.client.run('decisions.queue', {});
    const dec = q?.status === 'ok' ? q.output.pending.find((d) => d.kind === 'freshness.closed') : undefined;
    expect(dec?.subject_role).toEqual({
      id: R.datadogActive,
      url,
      last_checked_at: '2026-10-06T08:00:00.000Z',
      freshness_evidence: evidence,
    });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      fireEvent.keyDown(window, { key: 'o' });
      expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
      // Not while typing.
      const input = document.createElement('input');
      document.body.appendChild(input);
      fireEvent.keyDown(input, { key: 'o' });
      input.remove();
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
    expect(writes()).toEqual([]);
    assertButtons(container);
  });

  it('Needs you: no Open posting and O does nothing when the role has no url (#102)', async () => {
    const { container } = await boot('#/needs-you', async (l) => {
      l.engine.db.prepare('UPDATE role SET url = NULL WHERE id = ?').run(R.datadogActive);
    });
    const card = await cardFor(container, 'Is this posting open?');
    expect(card.querySelector('.open-posting')).toBeNull();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    try {
      fireEvent.keyDown(window, { key: 'o' });
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  it('Needs you: a fact-check claim shows the claim, document and source; Edit rewrites the line (#54)', async () => {
    const cover = 'Hi team,\n\nBefore that I worked at Globex on analytics.\n\nThanks.';
    const { container } = await boot('#/needs-you', (l) =>
      l.as('agent', 'apply.tailor', {
        role_id: R.datadogActive,
        resume_md: '# Resume\n\nFacts only.',
        cover_letter_md: cover,
        fit_map_md: '# Fit map',
      }),
    );
    const want = 'Keep "Globex"?';
    for (let i = 0; i < 8 && nextQ(container) !== want; i++) {
      const q = await settledQ(container, (x) => x !== 'clear');
      if (q === want) break;
      fireEvent.keyDown(window, { key: 'ArrowRight' });
    }
    await settledQ(container, (q) => q === want);
    const card = $(container, '.decision');
    expect(card.textContent).toContain('Cover letter');
    fireEvent.click(within(card).getByText('Cover letter'));
    expect(card.textContent).toContain('Before that I worked at Globex on analytics.');
    fireEvent.keyDown(window, { key: 'c' });
    const alts = await waitFor(() => $(container, '.decision__alts'));
    expect(
      within(alts)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Keep', 'Save']);
    const input = $<HTMLInputElement>(alts, '.decision__edit input');
    fireEvent.change(input, { target: { value: 'Before that I built analytics products.' } });
    const save = within(alts).getByText('Save');
    expect(save.getAttribute('data-op')).toBe('decisions.resolve');
    fireEvent.click(save);
    await waitFor(() =>
      expect(live?.calls.filter((c) => c.name === 'decisions.resolve').at(-1)?.body).toMatchObject({
        action: 'change',
        value: 'Before that I built analytics products.',
      }),
    );
    const doc = await live?.as('human', 'vault.read', { path: `applications/${R.datadogActive}/cover_letter.md` });
    expect(doc?.status === 'ok' && (doc.output as { markdown: string }).markdown).toContain('Before that I built analytics products.');
    assertButtons(container);
  });

  it('People, Outreach and Needs you: a guessed email shows its source and confidence; picking an alternative confirms it (#37)', async () => {
    const guess = 'maya.rivera@linear.example';
    const { container } = await boot(`#/people/${R.linearDraft}`, async (l) => {
      l.engine.db.prepare(`UPDATE company SET domain = 'linear.example' WHERE id = 'linear'`).run();
      l.engine.db.prepare(`UPDATE contact SET name = 'Maya Rivera' WHERE id = 'ct_0001'`).run();
      return l.as('agent', 'people.find_email', { contact_id: 'ct_0001', role_id: R.linearDraft });
    });
    const row = await waitFor(() => $(container, '.people-list [data-contact="ct_0001"] .person__email'));
    expect(row.textContent).toBe(`${guess}Guess 45%`);
    expect(row.getAttribute('data-sure')).toBe('false');

    await go('#/outreach/or_0001');
    const to = await waitFor(() => $(container, '.outreach__to'));
    await waitFor(() => expect(to.textContent).toContain(guess));
    expect(to.textContent).toContain('Guess 45%');
    expect(to.getAttribute('data-to')).toBe('');

    await go('#/needs-you');
    const want = `Use ${guess}?`;
    for (let i = 0; i < 8 && nextQ(container) !== want; i++) {
      const q = await settledQ(container, (x) => x !== 'clear');
      if (q === want) break;
      fireEvent.keyDown(window, { key: 'ArrowRight' });
    }
    await settledQ(container, (q) => q === want);
    const card = $(container, '.decision');
    expect(card.textContent).toContain('Maya Rivera');
    expect(card.textContent).toContain('linear.example');
    fireEvent.keyDown(window, { key: 'c' });
    const alts = await waitFor(() => $(container, '.decision__alts'));
    const labels = within(alts)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(labels).toEqual(['mrivera@linear.example', 'maya@linear.example', 'm.rivera@linear.example', 'Save']);
    fireEvent.click(within(alts).getByText('mrivera@linear.example'));
    await waitFor(async () => {
      const o = await live?.as('human', 'outreach.get', { outreach_id: 'or_0001' });
      expect(o?.status === 'ok' && (o.output as { to: { email: string | null } }).to.email).toBe('mrivera@linear.example');
    });
    assertButtons(container);
  });

  it('Needs you: each email candidate shows its evidence, a Check link and Valid / Invalid (#99)', async () => {
    const { container } = await boot(
      '#/needs-you',
      async (l) => {
        l.engine.db.prepare(`UPDATE company SET domain = 'linear.example' WHERE id = 'linear'`).run();
        l.engine.db.prepare(`UPDATE contact SET name = 'Maya Rivera' WHERE id = 'ct_0001'`).run();
        return l.as('agent', 'people.find_email', {
          contact_id: 'ct_0001',
          role_id: R.linearDraft,
          evidence: [{ kind: 'inbox_peer', address: 'lee.park@linear.example', source: 'gmail', name: 'Lee Park' }],
        });
      },
      { services: { mx: async () => true } },
    );
    const want = 'Use maya.rivera@linear.example?';
    for (let i = 0; i < 8 && nextQ(container) !== want; i++) {
      const q = await settledQ(container, (x) => x !== 'clear');
      if (q === want) break;
      fireEvent.keyDown(window, { key: 'ArrowRight' });
    }
    await settledQ(container, (q) => q === want);
    const row = (address: string) => $(container, `.email-check[data-address="${address}"]`);
    const top = await waitFor(() => row('maya.rivera@linear.example'));
    expect(Array.from(top.querySelectorAll('.email-check__label')).map((l) => l.textContent)).toEqual(['Pattern: 1 peer']);

    // Check: a plain link to the address checker (no op) that also copies the address.
    const link = within(top).getByText('Check').closest('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://email-checker.net/');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('data-op')).toBe('local');
    link.addEventListener('click', (e) => e.preventDefault());
    const copied: string[] = [];
    const clip = { writeText: async (t: string) => void copied.push(t) };
    Object.defineProperty(navigator, 'clipboard', { value: clip, configurable: true });
    const before = writes().length;
    fireEvent.click(link);
    await waitFor(() => expect(copied).toEqual(['maya.rivera@linear.example']));
    // A refused clipboard is ignored.
    clip.writeText = async () => Promise.reject(new Error('denied'));
    fireEvent.click(link);
    expect(writes().length).toBe(before);

    // Invalid drops a candidate and the card stays; Valid confirms the address and the card moves on.
    fireEvent.click(within(row('maya@linear.example')).getByText('Invalid'));
    await waitFor(() => expect(container.querySelector('.email-check[data-address="maya@linear.example"]')).toBeNull());
    expect(nextQ(container)).toBe(want);
    const calls = () => live?.calls.filter((c) => c.name === 'people.email_checked').map((c) => c.body);
    expect(calls()).toEqual([{ contact_id: 'ct_0001', address: 'maya@linear.example', result: 'invalid' }]);
    assertButtons(container);
    fireEvent.click(within(row('maya.rivera@linear.example')).getByText('Valid'));
    await waitFor(() => expect(nextQ(container)).not.toBe(want));
    expect(calls()?.[1]).toEqual({ contact_id: 'ct_0001', address: 'maya.rivera@linear.example', result: 'valid' });
    const c = await live?.client.run('contacts.get', { contact_id: 'ct_0001' });
    expect(c?.status === 'ok' && c.output.contact.email).toBe('maya.rivera@linear.example');
  });

  it('Settings: no Email check section, no provider or key (#99)', async () => {
    const { container } = await boot('#/settings');
    await waitFor(() => expect(primary(container)?.textContent).toContain('Save'));
    expect(container.querySelector('.settings-email')).toBeNull();
    expect(container.textContent).not.toMatch(/Email check|Key variable|NeverBounce|ZeroBounce|Hunter/);
    assertButtons(container);
  });

  it('You -> Terms: Application defaults save once with one op (#42)', async () => {
    const { container } = await boot('#/you/terms');
    const box = await waitFor(() => $(container, '.app-defaults'));
    const save = within(box).getByText('Save') as HTMLButtonElement;
    expect(save.getAttribute('data-op')).toBe('profile.set_defaults');
    expect(save.disabled).toBe(true);
    fireEvent.change($<HTMLInputElement>(box, 'input[name="sponsorship"]'), { target: { value: 'no' } });
    const countries = $<HTMLInputElement>(box, 'input[name="authorized_countries"]');
    fireEvent.change(countries, { target: { value: 'United States' } });
    fireEvent.keyDown(countries, { key: 'Enter' });
    expect(within(box).getByRole('button', { name: 'Remove United States' }).getAttribute('data-op')).toBe('local');
    // Typed but not yet committed still counts on Save.
    fireEvent.change(countries, { target: { value: 'Canada' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(live?.calls.filter((c) => c.name === 'profile.set_defaults').at(-1)?.body).toMatchObject({
        defaults: { sponsorship: 'no', authorized_countries: ['United States', 'Canada'] },
      }),
    );
    await waitFor(async () => {
      const p = await live?.as('human', 'profile.get', {});
      const comps =
        p?.status === 'ok' ? (p.output as { components: { key: string; data_json: Record<string, unknown> }[] }).components : [];
      expect(comps.find((c) => c.key === 'terms')?.data_json.application_defaults).toEqual({
        sponsorship: 'no',
        authorized_countries: ['United States', 'Canada'],
      });
    });
    assertButtons(container);
  });

  it('Role -> Answers tab groups Needs you, Written, Standard and Portal fills (#42)', async () => {
    const { container } = await boot(`#/role/${R.linearDraft}`, (l) =>
      l.as('agent', 'apply.fill', {
        role_id: R.linearDraft,
        answers: [
          { question: 'Email', kind: 'autofill', field: 'email' },
          { question: 'Sponsorship?', kind: 'standard', field: 'sponsorship' },
          { question: 'Gender', kind: 'standard', field: 'eeo' },
          { question: 'Why Linear?', kind: 'written', answer: 'Speed is the product.' },
        ],
      }),
    );
    const tab = await waitFor(() => within(container).getByText('Answers'));
    fireEvent.click(tab);
    await waitFor(() => expect(container.textContent).toContain('Portal fills'));
    const text = container.textContent ?? '';
    expect(text.indexOf('Needs you')).toBeLessThan(text.indexOf('Written'));
    expect(text.indexOf('Written')).toBeLessThan(text.indexOf('Standard'));
    expect(text).toContain('no saved answer for visa sponsorship');
    expect(text).toContain('Prefer not to say');
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
    // The runs poll (runs.list) sees the run finish; the outreach refreshes to in_gmail and the button disables.
    await waitFor(() => expect(container.querySelector('[data-run]')?.getAttribute('data-run')).toBe('ok'));
    await waitFor(() => expect(primary(container).disabled).toBe(true));
    expect(live?.calls.some((c) => c.name === 'runs.list')).toBe(true);
    await go(`#/role/${R.linearDraft}`);
    await waitFor(() => expect(primary(container).textContent).toBe('Open and fill'));
    const connect = Array.from(container.querySelectorAll('.stage')).find((s) => s.textContent === 'Connect');
    expect(connect?.getAttribute('data-state')).toBe('done');
    const o = await live?.client.run('outreach.get', { outreach_id: 'or_0001' });
    expect(o?.status === 'ok' && o.output.outreach).toMatchObject({ status: 'in_gmail', gmail_draft_id: 'r-agent-1' });
  });

  it('People (#82): "LinkedIn not read" with the reason until the agent reads LinkedIn, then "LinkedIn: N people"', async () => {
    const { container } = await boot(`#/people/${R.linearDraft}`);
    const tag = await waitFor(() => $(container, '.people-linkedin'));
    expect(tag.getAttribute('data-linkedin')).toBe('not-read');
    expect(tag.textContent).toBe('LinkedIn not read · Not run');
    // One run per role here: runs in a test share a timestamp, so "latest" would be ambiguous.
    await live?.as('agent', 'people.find', { role_id: R.airtableOnDeck, linkedin: { pages_opened: 0, skipped: 'checkpoint' } });
    await go(`#/people/${R.airtableOnDeck}`);
    await waitFor(() => expect($(container, '.people-linkedin').textContent).toBe('LinkedIn not read · Checkpoint'));
    await live?.as('agent', 'people.find', {
      role_id: R.linearDraft,
      linkedin: { pages_opened: 2 },
      hints: [
        { name: 'Fixture Pat', linkedin_url: 'https://www.linkedin.com/in/fixture-pat', source: 'linkedin', degree: '1' },
        { name: 'Fixture Lee', linkedin_url: 'https://www.linkedin.com/in/fixture-lee', source: 'linkedin', degree: 'cold' },
      ],
    });
    await go(`#/people/${R.airtableOnDeck}`);
    await go(`#/people/${R.linearDraft}`);
    await waitFor(() => expect($(container, '.people-linkedin').getAttribute('data-linkedin')).toBe('read'));
    expect($(container, '.people-linkedin').textContent).toBe('LinkedIn: 2 people');
    assertButtons(container);
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
    const wrote = writes();
    fireEvent.click(screen.getByText('Coffee or intro'));
    await waitFor(() => expect(text()).not.toBe(before));
    // Local only: no write op (read-only polling such as runs.list may still tick).
    expect(writes()).toEqual(wrote);
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

  it('River and Now label on-deck as In progress (#105)', async () => {
    const { container } = await boot('#/river');
    const col = await waitFor(() => $(container, '.river-col[data-status="on-deck"]'));
    await waitFor(() => expect(col.textContent).toContain('In progress'));
    expect(container.textContent).not.toContain('On deck');
    await go('#/now');
    await waitFor(() => expect(container.querySelectorAll('.role-card').length).toBe(3));
    const card = (id: string) => container.querySelector(`.role-card[data-role="${id}"]`);
    const onDeck = [R.stripeOnDeck, R.airtableOnDeck].find((id) => card(id));
    expect(onDeck, 'an on-deck role in Top picks').toBeDefined();
    expect(card(onDeck as string)?.querySelector('.role-card__tag')?.textContent).toBe('In progress');
    expect(container.querySelectorAll('.role-card__tag').length).toBeLessThanOrEqual(2);
  });

  it('Now groups a score run into one row: count, total, expand, one group Undo (#103)', async () => {
    const ROLE = 'notion_product-lead-data-platform';
    let total = 0;
    const { container, live: l } = await boot('#/now', async (lv) => {
      const run = (await lv.as('agent', 'runs.start', { skill: 'score' })) as { status: 'ok'; output: { run: { id: string } } };
      const FIVES = Object.fromEntries(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'].map((c) => [c, 5]));
      const o = (await lv.as(
        'agent',
        'roles.score',
        { role_id: ROLE, criteria: FIVES, facts: { workplace: 'remote', remote_ok: true } },
        { runId: run.output.run.id },
      )) as { status: 'ok'; output: { score: { total: number } } };
      total = o.output.score.total;
      // Setup: the nine criteria applied with an open undo window (auto + undo).
      lv.engine.db
        .prepare(`UPDATE decision SET policy_outcome = 'auto_undo', undo_until = ? WHERE kind = 'roles.criterion' AND subject_id = ?`)
        .run('2026-10-09T12:00:00.000Z', ROLE);
    });
    const row = await waitFor(() => {
      const r = Array.from(container.querySelectorAll('.auto-row')).find((x) => x.textContent?.includes('9 criteria'));
      if (!r) throw new Error('no group row');
      return r as HTMLElement;
    });
    expect(row.textContent).toContain(`Scored ${Math.round(total)} · Agent · 9 criteria`);
    expect(row.textContent).toContain('Notion');
    // One row for the run, not nine.
    expect(Array.from(container.querySelectorAll('.auto-row')).filter((x) => x.textContent?.includes('Notion')).length).toBe(1);
    const toggle = $(row, '.auto-row__toggle');
    expect(toggle.getAttribute('data-op')).toBe('local');
    expect(toggle.textContent).toContain('9');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(Array.from(container.querySelectorAll('.auto-row')).filter((x) => x.textContent?.includes('Notion')).length).toBe(10),
    );
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    assertButtons(container);

    const undo = $(row, '.auto-row__undo');
    expect(undo.getAttribute('data-op')).toBe('decisions.undo_group');
    const before = writes().length;
    fireEvent.click(undo);
    await waitFor(() => expect(writes().slice(before)).toEqual(['decisions.undo_group']));
    const call = l.calls.find((c) => c.name === 'decisions.undo_group');
    expect((call as { body: { decision_ids: string[] } }).body.decision_ids).toHaveLength(9);
    await waitFor(() => expect(row.querySelector('.auto-row__undo')).toBeNull());
    expect(row.textContent).toContain('undone');
  });

  it('River has a Held column and stacks held roles on the capped company tile', async () => {
    const { container } = await boot('#/river');
    await waitFor(() => expect($(container, '.held-chip').textContent).toBe('+2 held'));
    const held = $(container, '.river-col[data-status="held"]');
    expect(held.querySelectorAll('.river-tile').length).toBe(2);
  });

  describe('River lane sort (#104)', () => {
    const laneIds = (container: HTMLElement, s: string) =>
      Array.from(container.querySelectorAll(`.river-col[data-status="${s}"] .river-tile`)).map((e) => e.getAttribute('data-role'));
    const expected = async (l: Live, s: string, sort: 'score' | 'newest') => {
      const o = (await l.client.run('roles.list', { limit: 500 })) as { status: 'ok'; output: { items: RoleView[] } };
      return sortLane(
        o.output.items.filter((v) => v.role.status === s),
        sort,
      ).map((v) => v.role.id);
    };

    it('sorts each lane by score, keeps the held stack on the best tile, and the toggle switches and persists', async () => {
      const { container, live: l, unmount } = await boot('#/river');
      await waitFor(() => expect(laneIds(container, 'active').length).toBeGreaterThan(1));
      const byScore = await expected(l, 'active', 'score');
      expect(laneIds(container, 'active')).toEqual(byScore);
      // The "+N held" chip sits on the first (best) tile of its company.
      const chipTile = $(container, '.held-chip').closest('.river-tile');
      const coTiles = Array.from(container.querySelectorAll('.river-col[data-status="active"] .river-tile'));
      const items = ((await l.client.run('roles.list', { limit: 500 })) as { status: 'ok'; output: { items: RoleView[] } }).output.items;
      const coOf = (id: string | null) => items.find((v) => v.role.id === id)?.company.id;
      const chipCo = coOf(chipTile?.getAttribute('data-role') ?? null);
      expect(coTiles.find((e) => coOf(e.getAttribute('data-role')) === chipCo)).toBe(chipTile);

      const col = $(container, '.river-col[data-status="active"]');
      const newest = $<HTMLButtonElement>(col, '.river-sort [data-sort="newest"]');
      expect(newest.getAttribute('data-op')).toBe('local');
      fireEvent.click(newest);
      const byNewest = await expected(l, 'active', 'newest');
      expect(byNewest).not.toEqual(byScore);
      await waitFor(() => expect(laneIds(container, 'active')).toEqual(byNewest));
      expect(newest.getAttribute('aria-pressed')).toBe('true');
      expect(JSON.parse(window.localStorage.getItem(RIVER_SORT_KEY) ?? '{}')).toEqual({ active: 'newest' });
      assertButtons(container);
      unmount();
      live?.close();

      // A fresh open keeps the viewer's choice.
      const again = await boot('#/river');
      await waitFor(() => expect(laneIds(again.container, 'active')).toEqual(byNewest));
      expect($(again.container, '.river-col[data-status="active"] [data-sort="newest"]').getAttribute('aria-pressed')).toBe('true');
    });

    it('renders sorted lanes when storage throws', async () => {
      const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      try {
        const { container, live: l } = await boot('#/river');
        await waitFor(() => expect(laneIds(container, 'active').length).toBeGreaterThan(1));
        expect(laneIds(container, 'active')).toEqual(await expected(l, 'active', 'score'));
        fireEvent.click($(container, '.river-col[data-status="active"] [data-sort="newest"]'));
        const byNewest = await expected(l, 'active', 'newest');
        await waitFor(() => expect(laneIds(container, 'active')).toEqual(byNewest));
      } finally {
        get.mockRestore();
        set.mockRestore();
      }
    });
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

  it('You: with diffs pending the primary stays Review N diff and Recalibrate is a secondary action (#66)', async () => {
    const { container } = await boot('#/you');
    await waitFor(() => expect(primary(container).textContent).toMatch(/^Review \d+ diff$/));
    const recal = $(container, '.recalibrate');
    expect(recal.textContent).toBe('Recalibrate');
    expect(recal.getAttribute('data-op')).toBe('onboard.start');
    expect(recal.classList.contains('btn--primary')).toBe(false);
    assertButtons(container);
    fireEvent.click(recal);
    await waitFor(() => expect(window.location.hash).toBe('#/you/calibrate'));
    expect(live?.calls.find((c) => c.name === 'onboard.start')?.body).toEqual({ calibrate: true });
  });

  it('You setup resumes the saved session at Calibrate', async () => {
    await boot('#/you/setup');
    await screen.findByText('1 / 12');
  });

  it('Onboarding: Voice keeps several writing samples (add, remove)', async () => {
    const { container } = await boot('#/you/interview', (l) => l.client.run('onboard.start', { components: ['voice'] }));
    await waitFor(() => expect($(container, '.onboard-q__text').textContent).toBe('How do you want your writing to sound?'));
    fireEvent.click($(container, '.onboard-q .chip'));
    fireEvent.click(primary(container));
    await waitFor(() =>
      expect($(container, '.onboard-q__text').textContent).toBe('Paste a few things you have written that sound like you.'),
    );
    // The fixture's two samples are listed; remove the first, add two more.
    await waitFor(() => expect(container.querySelectorAll('.onboard-q__item')).toHaveLength(2));
    assertButtons(container);
    fireEvent.click(screen.getByRole('button', { name: 'Remove 1' }));
    expect(container.querySelectorAll('.onboard-q__item')).toHaveLength(1);
    const area = $(container, '.onboard-q textarea');
    fireEvent.change(area, { target: { value: 'Sample two, short.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(container.querySelectorAll('.onboard-q__item')).toHaveLength(2);
    fireEvent.change($(container, '.onboard-q textarea'), { target: { value: 'Sample three, pending.' } });
    fireEvent.click(primary(container));
    await waitFor(() => expect(live?.calls.filter((c) => c.name === 'onboard.answer')).toHaveLength(2));
    const last = live?.calls.filter((c) => c.name === 'onboard.answer').at(-1);
    expect(last?.status).toBe('ok');
    const sent = last?.body as { question_id: string; value: string[] };
    expect(sent.question_id).toBe('voice.sample');
    expect(sent.value).toHaveLength(3);
    expect(sent.value.slice(1)).toEqual(['Sample two, short.', 'Sample three, pending.']);
    // The re-interview leaves the questions: confirm step, then You with Voice selected.
    await waitFor(() => expect(primary(container).textContent).toBe('Save'));
    expect(container.querySelector('.onboard-q__text')).toBeNull();
    fireEvent.click(primary(container));
    await waitFor(() => expect(window.location.hash).toBe('#/you/voice'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy());
    expect(container.textContent).toContain('Sample three, pending.');
    expect(opsCalled()).toContain('onboard.confirm');
  });

  it('Onboarding: the resume upload is kept and parsed by a run; derived years are confirmed (#38)', async () => {
    const { container } = await boot('#/you/setup', (l) => l.client.run('onboard.start', {}));
    const text = [
      '# Riley Sample',
      '',
      '**Title:** Senior Product Manager',
      '',
      '## Experience',
      '',
      '### Northwind Analytics — Senior Product Manager — Jan 2019–Present',
      '- Shipped a forecasting product used by 85 customers.',
      '',
      '### Contoso Retail — Product Analyst — 2016–2018',
      '- Built the weekly demand dashboard.',
    ].join('\n');
    fireEvent.drop($(container, '.dropzone'), { dataTransfer: { files: [new File([text], 'riley.md', { type: 'text/markdown' })] } });
    await waitFor(() => expect(live?.calls.some((c) => c.name === 'onboard.ingest_resume')).toBe(true));
    const sent = live?.calls.find((c) => c.name === 'onboard.ingest_resume')?.body as { file: { name: string; content_base64: string } };
    expect(sent.file.name).toBe('riley.md');
    expect(new TextDecoder().decode(Uint8Array.from(atob(sent.file.content_base64), (ch) => ch.charCodeAt(0)))).toBe(text);
    // The parse run shows its status on the drop zone.
    await waitFor(() => expect(['Queued', 'Setting up']).toContain($(container, '.dropzone__run').textContent));
    await waitFor(() => expect(primary(container).style.opacity).toBe('1'), { timeout: 4000 });
    fireEvent.click(primary(container));
    // What the resume implies is confirmed first (#22): Yes / Edit, with what was pulled beside it.
    await waitFor(() =>
      expect($(container, '.onboard-q__text').textContent).toBe('Looks like your headline is "Senior Product Manager". Right?'),
    );
    expect(Array.from(container.querySelectorAll('.onboard-q .chip')).map((c) => c.textContent)).toEqual(['Yes', 'Edit']);
    expect($(container, '.onboard-q__for').textContent).toBe('Q 1 · Story');
    expect($(container, '.resume-draft').textContent).toContain('Headline: Senior Product Manager');
    fireEvent.click($(container, '.onboard-q .chip'));
    fireEvent.click(primary(container));
    // Years are derived from the role dates, never guessed: the user confirms or leaves them out.
    await waitFor(() => expect($(container, '.onboard-q__text').textContent).toMatch(/^Your role dates add up/));
    const chips = Array.from(container.querySelectorAll('.onboard-q .chip')).map((c) => c.textContent);
    expect(chips).toEqual(['10', 'leave out']);
    assertButtons(container);
  });

  it('Onboarding: a dictated answer is shown cleaned, then saved with its raw text (#38)', async () => {
    const { container } = await boot('#/you/interview', (l) => l.client.run('onboard.start', { components: ['story'] }));
    await waitFor(() => expect($(container, '.onboard-q__text').textContent).toBe('How would you describe yourself in one line?'));
    fireEvent.change($(container, '.onboard-q textarea'), { target: { value: 'um, data platform uh product lead' } });
    fireEvent.click(primary(container));
    await screen.findByText('Cleaned');
    expect(($(container, '.onboard-q textarea') as HTMLTextAreaElement).value).toBe('Data platform product lead');
    expect(live?.calls.some((c) => c.name === 'onboard.answer')).toBe(false);
    fireEvent.click(primary(container));
    await waitFor(() => expect(live?.calls.some((c) => c.name === 'onboard.answer')).toBe(true));
    expect(live?.calls.find((c) => c.name === 'onboard.answer')?.body).toEqual({
      question_id: 'story.headline',
      value: 'Data platform product lead',
      raw: 'um, data platform uh product lead',
    });
  });

  it('You: Re-interview one component runs its questions in place and saves a new version (#25)', async () => {
    const { container } = await boot('#/you/growth');
    const btn = await screen.findByRole('button', { name: 'Re-interview' });
    expect(btn.getAttribute('data-op')).toBe('onboard.start');
    const eyebrowV = () => container.querySelector('[data-screen-label="You"]')?.textContent ?? '';
    await waitFor(() => expect(eyebrowV()).toMatch(/Profile · v2/));
    fireEvent.click(btn);
    await waitFor(() => expect(window.location.hash).toBe('#/you/interview'));
    expect(live?.calls.find((c) => c.name === 'onboard.start')?.body).toEqual({ components: ['growth'] });
    for (let i = 0; i < 6 && !container.querySelector('.btn--primary')?.textContent?.startsWith('Save'); i++) {
      const q = (await waitFor(() => $(container, '.onboard-q__text'))).textContent;
      expect($(container, '.onboard-q__for').textContent).toMatch(/Growth$/);
      fireEvent.click(screen.getByRole('button', { name: "I don't know" }));
      await waitFor(() =>
        expect(primary(container).textContent === 'Save' || container.querySelector('.onboard-q__text')?.textContent !== q).toBe(true),
      );
    }
    await waitFor(() => expect(primary(container).textContent).toBe('Save'));
    assertButtons(container);
    fireEvent.click(primary(container));
    await waitFor(() => expect(window.location.hash).toBe('#/you/growth'));
    await waitFor(() => expect(eyebrowV()).toMatch(/Profile · v3/));
    expect($(container, '.timeline__item.is-current .timeline__v').textContent).toBe('v3');
    expect($(container, '.timeline__item.is-current').textContent).toContain('Onboard: re interview growth');
  });

  it('You > Voice: Learn voice queues a voice run (#76)', async () => {
    await boot('#/you/voice');
    const learn = await screen.findByRole('button', { name: 'Learn voice' });
    expect(learn.getAttribute('data-op')).toBe('runs.start');
    fireEvent.click(learn);
    await waitFor(() => expect(live?.calls.find((c) => c.name === 'runs.start')?.body).toEqual({ skill: 'voice' }));
  });

  it('Craft offers Other with free entry (#74)', async () => {
    const { container } = await boot('#/you/craft');
    fireEvent.click(await screen.findByRole('button', { name: 'Re-interview' }));
    await waitFor(() =>
      expect($(container, '.onboard-q__text').textContent).toBe('What kind of work do you want to do in your next role?'),
    );
    const other = $(container, '.chip--other');
    expect(other.getAttribute('data-op')).toBe('local');
    fireEvent.click(other);
    const field = $(container, '.onboard-q__other') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'Revenue Operations' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await screen.findByRole('button', { name: 'Revenue Operations' });
    fireEvent.click(primary(container));
    await waitFor(() =>
      expect(live?.calls.find((c) => c.name === 'onboard.answer')?.body).toMatchObject({ question_id: 'craft.functions' }),
    );
    const sent = live?.calls.find((c) => c.name === 'onboard.answer')?.body as { value: string[] };
    expect(sent.value).toContain('Revenue Operations');
  });

  it('Voice Skip skips the whole step (#76)', async () => {
    const { container } = await boot('#/you/voice');
    fireEvent.click(await screen.findByRole('button', { name: 'Re-interview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    await waitFor(() =>
      expect(live?.calls.filter((c) => c.name === 'onboard.answer').at(-1)?.body).toMatchObject({ skip: true, skip_component: true }),
    );
    await waitFor(() => expect(primary(container).textContent).toBe('Save'));
  });

  it('You: Recalibrate reuses the calibration step from the current weights; Save shows before / after and a new version (#25)', async () => {
    const { container } = await boot('#/you', async (l) => {
      // Clear the fixture's pending diffs so Recalibrate is the primary.
      const p = (await l.client.run('profile.get', {})) as { status: 'ok'; output: { pending_diffs: { id: string }[] } };
      for (const d of p.output.pending_diffs) await l.client.run('profile.reject_diff', { diff_id: d.id });
    });
    await waitFor(() => expect(primary(container).textContent).toBe('Recalibrate'));
    expect(primary(container).getAttribute('data-op')).toBe('onboard.start');
    expect(container.querySelector('.recalibrate')).toBeNull();
    fireEvent.click(primary(container));
    await waitFor(() => expect(window.location.hash).toBe('#/you/calibrate'));
    // The bars start from the current profile's weights (the engine test checks they equal its rubric).
    const current = await live?.as('human', 'onboard.samples', {});
    expect(live?.calls.find((c) => c.name === 'onboard.start')?.body).toEqual({ calibrate: true });
    await screen.findByText('1 / 12');
    // Nothing answered yet: Next stays off.
    expect(primary(container).disabled).toBe(true);
    const shown = Array.from(container.querySelectorAll('.weights__row span:nth-child(4)')).map((x) => x.textContent);
    const base = current?.status === 'ok' ? (current.output as { weights: Record<string, number> }).weights : {};
    expect(shown).toEqual(Object.values(base).map((x) => String(Math.round(x))));
    fireEvent.click(screen.getByRole('button', { name: 'Y' }));
    for (let i = 2; i <= 12; i++) {
      await screen.findByText(`${i} / 12`);
      fireEvent.keyDown(window, { key: i % 3 ? 'n' : 'y' });
    }
    await waitFor(() => $(container, '.cal-done'));
    fireEvent.click(primary(container));
    await waitFor(() => expect(primary(container).textContent).toBe('Save'));
    const rows = container.querySelectorAll('.weights-diff__row');
    expect(rows).toHaveLength(9);
    expect(container.querySelectorAll('.weights-diff__row[data-changed="true"]').length).toBeGreaterThan(0);
    assertButtons(container);
    fireEvent.click(primary(container));
    await waitFor(() => expect(window.location.hash).toBe('#/you'));
    await waitFor(() => expect(container.querySelector('[data-screen-label="You"]')?.textContent).toMatch(/Profile · v3/));
    const h = await live?.as('human', 'profile.history', {});
    const versions = h?.status === 'ok' ? (h.output as { versions: { reason: string }[] }).versions : [];
    expect(versions.at(-1)?.reason).toBe('onboard: recalibrate');
  });

  it('You: Story opens the kept source resume (#38)', async () => {
    const { container } = await boot('#/you/story', async (l) => {
      const s = (await l.client.run('onboard.ingest_resume', { text: '# Sam Fixture\n\nData platform product lead.' })) as {
        status: 'ok';
        output: { resume: { source_path: string } };
      };
      const path = s.output.resume.source_path;
      const p = (await l.client.run('profile.propose_diff', {
        component: 'story',
        before: {},
        after: { source_path: path },
        evidence: ['test'],
      })) as { status: 'ok'; output: { diff: { id: string } } };
      await l.client.run('profile.apply_diff', { diff_id: p.output.diff.id });
    });
    const btn = await screen.findByRole('button', { name: 'Resume' });
    expect(btn.getAttribute('data-op')).toBe('vault.read');
    fireEvent.click(btn);
    await waitFor(() => expect($(container, '.resume-source__text').textContent).toContain('Data platform product lead.'));
  });

  it('Onboarding: full-sentence questions with an example, which component they fill, and "I don\'t know" (#23)', async () => {
    const { container } = await boot('#/you/interview', (l) => l.client.run('onboard.start', { components: ['company', 'network'] }));
    await waitFor(() => expect($(container, '.onboard-q__text').textContent).toBe('Which company stages appeal to you?'));
    expect($(container, '.onboard-q__for').textContent).toBe('Q 1 · Company');
    const skip = screen.getByRole('button', { name: "I don't know" });
    expect(skip.getAttribute('data-op')).toBe('onboard.answer');
    assertButtons(container);
    fireEvent.click(skip);
    await waitFor(() => expect($(container, '.onboard-q__text').textContent).toBe('How big a company do you want to join, by headcount?'));
    expect(live?.calls.find((c) => c.name === 'onboard.answer')?.body).toEqual({ question_id: 'company.stages', skip: true });
    fireEvent.click(screen.getByRole('button', { name: "I don't know" }));
    await waitFor(() => expect($(container, '.onboard-q__text').textContent).toBe('Which companies would you love to work at?'));
    expect($(container, '.onboard-q__example').textContent).toBe('Example: Anthropic, Stripe, Figma.');
    fireEvent.click(screen.getByRole('button', { name: "I don't know" }));
    await waitFor(() =>
      expect($(container, '.onboard-q__text').textContent).toBe('Where do you already know people who could introduce you?'),
    );
    expect($(container, '.onboard-q__for').textContent).toBe('Q 4 · Network');
  });

  it('Onboarding: a list question keeps chips (Enter, paste, remove) and sends an array (#75)', async () => {
    const { container } = await boot('#/you/interview', (l) => l.client.run('onboard.start', { components: ['company'] }));
    await waitFor(() => expect($(container, '.onboard-q__text').textContent).toBe('Which company stages appeal to you?'));
    fireEvent.click(screen.getByRole('button', { name: "I don't know" }));
    await waitFor(() => expect($(container, '.onboard-q__text').textContent).toBe('How big a company do you want to join, by headcount?'));
    fireEvent.click(screen.getByRole('button', { name: "I don't know" }));
    await waitFor(() => expect($(container, '.onboard-q__text').textContent).toBe('Which companies would you love to work at?'));
    const entry = $<HTMLInputElement>(container, '.onboard-q .chip-input input');
    expect(primary(container).disabled).toBe(true);
    fireEvent.change(entry, { target: { value: 'Anthropic' } });
    fireEvent.keyDown(entry, { key: 'Enter' });
    fireEvent.paste(entry, { clipboardData: { getData: () => 'Stripe, Figma\nanthropic' } });
    expect(Array.from(container.querySelectorAll('.chip-input__chip')).map((c) => c.textContent)).toEqual([
      'Anthropic×',
      'Stripe×',
      'Figma×',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Stripe' }));
    // An entry still being typed counts: Next sends it with the chips.
    fireEvent.change(entry, { target: { value: 'Linear' } });
    assertButtons(container);
    fireEvent.click(primary(container));
    await waitFor(() => expect(live?.calls.filter((c) => c.name === 'onboard.answer')).toHaveLength(3));
    const last = live?.calls.filter((c) => c.name === 'onboard.answer').at(-1);
    expect(last?.status).toBe('ok');
    expect(last?.body).toEqual({ question_id: 'company.dream', value: ['Anthropic', 'Figma', 'Linear'] });
  });

  it('Onboarding: comp is typed exactly or slid, shown as $212.5k, never "300,000k" (#73)', async () => {
    const { container } = await boot('#/you/interview', (l) => l.client.run('onboard.start', { components: ['terms'] }));
    await waitFor(() => expect($(container, '.onboard-q__text').textContent).toBe('What is the lowest base salary you would accept?'));
    const value = () => $(container, '.slider-input__value').textContent;
    expect(value()).toBe('$300k');
    expect(container.textContent).not.toMatch(/\d,\d{3}k/i);
    fireEvent.change(screen.getByRole('textbox', { name: /\(exact\)$/ }), { target: { value: '212500' } });
    expect(value()).toBe('$212.5k');
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowLeft', shiftKey: true });
    expect(value()).toBe('$207.5k');
    expect(container.textContent).not.toMatch(/\d,\d{3}k/i);
    fireEvent.click(primary(container));
    await waitFor(() => expect(live?.calls.some((c) => c.name === 'onboard.answer')).toBe(true));
    expect(live?.calls.find((c) => c.name === 'onboard.answer')?.body).toEqual({ question_id: 'terms.floor', value: 207500 });
  });

  it('You setup: four steps end to end', async () => {
    const { container } = await boot('#/you/setup', (l) => l.client.run('onboard.start', {}));
    await waitFor(() => expect(primary(container).disabled).toBe(true));
    const resume = new File(['# Resume\n\nData product lead. Built a self-serve analytics product.'], 'resume.md', {
      type: 'text/markdown',
    });
    fireEvent.drop($(container, '.dropzone'), { dataTransfer: { files: [resume] } });
    await waitFor(() => expect(container.querySelectorAll('.ob-node.is-lit').length).toBeGreaterThan(4), { timeout: 4000 });
    await waitFor(() => expect(primary(container).style.opacity).toBe('1'), { timeout: 4000 });
    fireEvent.click(primary(container));

    for (let i = 0; i < 40 && !container.querySelector('.calibrate'); i++) {
      const q = (await waitFor(() => $(container, '.onboard-q__text'))).textContent;
      const chip = container.querySelector('.onboard-q .chip');
      const text = container.querySelector('.onboard-q textarea');
      const entry = container.querySelector('.onboard-q .chip-input input');
      // A resume suggestion is pre-selected (#74 titles): clicking it again would clear the answer.
      if (chip && !container.querySelector('.onboard-q .chip[aria-pressed="true"]')) fireEvent.click(chip);
      if (text) fireEvent.change(text, { target: { value: 'Short and direct.' } });
      if (entry) {
        fireEvent.change(entry, { target: { value: 'Acme' } });
        fireEvent.keyDown(entry, { key: 'Enter' });
      }
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

  it('Cmd+K from anywhere: free text goes to the agent; its cards render; Check all runs the op', async () => {
    const { container } = await boot('#/river', undefined, {
      // The fake agent reads the pipeline and answers with the stale roles (recorded stream-json shape).
      askScript: async () =>
        claudeTranscript({
          tools: [{ name: 'mcp__pp__roles_list', result: '{"items":[]}' }],
          reply: await composeReply('Which active roles are going stale?', { client: (live as Live).client, now: now(), roleId: null }),
        }),
    });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByRole('textbox', { name: 'Ask' });
    // A suggestion only prefills the message.
    fireEvent.click(screen.getByText('Which active roles are going stale?'));
    expect((input as HTMLInputElement).value).toBe('Which active roles are going stale?');
    expect(live?.ask.specs).toHaveLength(0);
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    const reply = await waitFor(() => $(container, '.ask__reply[data-state="done"]'), { timeout: 4000 });
    expect(live?.ask.specs[0]?.args[1]).toMatch(/^\[context\] screen: river[^\n]*\n\nWhich active roles are going stale\?$/);
    expect(reply.querySelector('.ask__step[data-state="ok"]')?.textContent).toContain('roles.list');
    await waitFor(() => expect(reply.querySelectorAll('[data-genui="RoleCard"] .role-card').length).toBe(4));
    const check = await waitFor(() => within(reply).getByText('Check all'));
    expect(check.getAttribute('data-op')).toBe('roles.check_freshness');
    fireEvent.click(check);
    await waitFor(() => expect(reply.querySelector('[data-genui="OpButton"][data-done]')).not.toBeNull());
    const checked = live?.calls.find((c) => c.name === 'roles.check_freshness');
    expect((checked?.body as { role_ids?: string[] } | undefined)?.role_ids).toHaveLength(4);
    assertButtons(container);
  });

  it('Ask: "Score my inbox roles" starts a score run through the agent, links it, and the thread resumes (#39)', async () => {
    const { container } = await boot('#/now', undefined, {
      askScript: async (_spec, n) => {
        if (n > 0) return claudeTranscript({ reply: 'root = Reply([t])\nt = Text("Still running")' });
        // The agent calls runs_start through MCP; the Ask MCP server queues it (queue: true).
        const o = await (live as Live).as('agent', 'runs.start', { skill: 'score', queue: true });
        const run = (o as { output: { run: { id: string } } }).output.run;
        return claudeScoreTranscript({ runId: run.id });
      },
    });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByRole('textbox', { name: 'Ask' });
    fireEvent.change(input, { target: { value: 'Score my inbox roles' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    const reply = await waitFor(() => $(container, '.ask__reply[data-state="done"]'), { timeout: 4000 });
    const runLink = $(reply, '.ask__run');
    expect(runLink.getAttribute('data-op')).toBe('nav');
    const runId = runLink.getAttribute('data-run-id') as string;
    const run = await live?.engine.runOp('runs.get', { run_id: runId }, { actor: 'human', now });
    expect(run).toMatchObject({ status: 'ok', output: { run: { op: 'score' } } });
    expect(reply.querySelector('.ask__note')?.textContent).toBe('Checking the inbox.');
    expect(Array.from(reply.querySelectorAll('.ask__step')).map((s) => s.textContent)).toEqual(['✓roles.list', '✓runs.start']);
    await waitFor(() => expect(reply.querySelector('[data-genui="Text"]')?.textContent).toBe('Score run started for 3 inbox roles'));

    // Same thread: the next message resumes the Claude session.
    fireEvent.change(input, { target: { value: 'and now?' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => expect(container.querySelectorAll('.ask__turn[data-state="done"]')).toHaveLength(2), { timeout: 4000 });
    const args = live?.ask.specs[1]?.args ?? [];
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-0001');
    fireEvent.click(runLink);
    await waitFor(() => expect(window.location.hash).toBe(`#/runs/${runId}`));
    assertButtons(container);
  });

  it('Ask: reopening the app after a pp up restart resumes the thread; New thread starts fresh (#69)', async () => {
    const { unmount } = await boot('#/now', undefined, { askScript: () => claudeScoreTranscript() });
    const send = async (text: string, turns: number) => {
      const input = await screen.findByRole('textbox', { name: 'Ask' });
      fireEvent.change(input, { target: { value: text } });
      fireEvent.submit(input.closest('form') as HTMLFormElement);
      await waitFor(() => expect(document.querySelectorAll('.ask__turn[data-state="done"]')).toHaveLength(turns), { timeout: 4000 });
    };
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await send('Score my inbox roles', 1);
    // #88: the app stores the thread id after the turn renders; wait for it instead of reading it once.
    const storedThread = () => window.localStorage.getItem(ASK_THREAD_KEY) ?? '';
    await waitFor(() => expect(storedThread()).toMatch(/^ask_/));
    const thread = storedThread();
    unmount();
    (live as Live).restartAsk();
    render(<App client={(live as Live).client} now={now} pollMs={20} />);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    await send('and now?', 1);
    const args = live?.ask.specs[1]?.args ?? [];
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-0001');
    await waitFor(() => expect(window.localStorage.getItem(ASK_THREAD_KEY)).toBe(thread));
    fireEvent.click($(document.body, '.ask__new'));
    await waitFor(() => expect(window.localStorage.getItem(ASK_THREAD_KEY)).toBeNull());
    await send('fresh', 1);
    expect(live?.ask.specs[2]?.args).not.toContain('--resume');
    await waitFor(() => expect(storedThread()).toMatch(/^ask_/));
    expect(storedThread()).not.toBe(thread);
  });

  it('Ask: a missing runner shows clearly; New thread starts fresh', async () => {
    const { container } = await boot('#/now');
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    const input = await screen.findByRole('textbox', { name: 'Ask' });
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    const err = await waitFor(() => $(container, '.ask__error'));
    expect(err.getAttribute('data-code')).toBe('runner_missing');
    expect(err.textContent).toContain('Runner missing');
    fireEvent.click($(container, '.ask__new'));
    await waitFor(() => expect(container.querySelector('.ask__reply')).toBeNull());
    expect(screen.getByText('Score my inbox roles')).toBeTruthy();
  });

  it('Role: each criterion shows who judged it and how sure (#40)', async () => {
    const id = 'notion_product-lead-data-platform';
    const { container } = await boot(`#/role/${id}`, (l) =>
      l.as('agent', 'roles.score', {
        role_id: id,
        criteria: { c1: 5, c2: 4, c3: 4, c4: 5, c5: 4, c6: 4, c7: 4, c8: 4, c9: 5 },
        criteria_p: { c1: 0.9 },
        facts: { workplace: 'remote', remote_ok: true },
      }),
    );
    const chips = await waitFor(() => {
      const c = Array.from(container.querySelectorAll('.criterion-sources [data-source]'));
      if (c.length !== 9) throw new Error('chips');
      return c;
    });
    expect(chips[0]?.textContent).toBe('C1Agent90%');
    expect(chips.every((c) => c.getAttribute('data-source') === 'Agent')).toBe(true);
    assertButtons(container);
  });

  it('Role: Open posting links to the role URL in a new tab (#34)', async () => {
    const { container } = await boot(`#/role/${R.stripeOnDeck}`);
    const link = await waitFor(() => $<HTMLAnchorElement>(container, 'a.open-posting'));
    const got = await live?.client.run('roles.get', { role_id: R.stripeOnDeck });
    const url = got?.status === 'ok' ? got.output.role.url : null;
    expect(url).toBeTruthy();
    expect(link.getAttribute('href')).toBe(url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('data-op')).toBe('nav');
    expect(link.textContent).toContain('Open posting');
    // The primary stays the stage action (Tailor: the company has a dossier, #61); the link is separate.
    expect(primary(container).textContent).toBe('Tailor');
    // River: Cmd/Ctrl-click a tile opens the posting; a plain click opens the Role screen.
    const opened: unknown[][] = [];
    const orig = window.open;
    window.open = ((...a: unknown[]) => {
      opened.push(a);
      return null;
    }) as typeof window.open;
    try {
      await go('#/river');
      const tile = await waitFor(() => $(container, `.river-tile[data-role="${R.stripeOnDeck}"]`));
      fireEvent.click(tile, { metaKey: true });
      expect(opened).toEqual([[url, '_blank', 'noopener']]);
      expect(window.location.hash).toBe('#/river');
      fireEvent.click(tile);
      await waitFor(() => expect(window.location.hash).toBe(`#/role/${R.stripeOnDeck}`));
    } finally {
      window.open = orig;
    }
  });

  it('Role: package documents render markdown; raw HTML never runs (#35)', async () => {
    const resume =
      '# Resume\n\nI ship **data products** with *taste*.\n\n- Built `pp` tooling\n- See [site](https://example.com) and [bad](javascript:alert)\n\n1. First\n2. Second\n\n> Quote line\n\n<script>window.__pwned = true</script>\n\n<img src="x" onerror="window.__pwned = true">';
    const fit = '# Fit map\n\n| Claim | Source |\n| --- | --- |\n| Data products | Resume |';
    const { container } = await boot(`#/role/${R.datadogActive}`, (l) =>
      l.as('agent', 'apply.tailor', { role_id: R.datadogActive, resume_md: resume, cover_letter_md: 'Hi team.', fit_map_md: fit }),
    );
    fireEvent.click(await screen.findByRole('tab', { name: 'Resume' }));
    const strong = await waitFor(() => $(container, 'strong'));
    expect(strong.textContent).toBe('data products');
    expect($(container, 'em').textContent).toBe('taste');
    expect($(container, 'code').textContent).toBe('pp');
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelectorAll('ol li')).toHaveLength(2);
    expect($(container, 'blockquote').textContent).toContain('Quote line');
    const links = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href]')).filter((a) => !a.classList.contains('open-posting'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com']);
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(links[0]?.getAttribute('rel')).toContain('noopener');
    expect(container.querySelector('script, img')).toBeNull();
    expect(container.textContent).toContain('<script>');
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    fireEvent.click(screen.getByRole('tab', { name: 'Fit map' }));
    const th = await waitFor(() => $(container, 'table th'));
    expect(th.textContent).toBe('Claim');
    expect($(container, 'table td').textContent).toBe('Data products');
    assertButtons(container);
  });

  it('Role: an empty tab shows the stage that fills it and runs it (#36)', async () => {
    const { container } = await boot(`#/role/${R.stripeOnDeck}`, (l) => l.as('agent', 'runs.finish', { run_id: 'rn_0003', status: 'ok' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Resume' }));
    const slot = await waitFor(() => $(container, '.doc-preview .stage-slot'));
    expect(slot.getAttribute('data-stage')).toBe('Tailor');
    expect(slot.textContent).toContain('From Tailor');
    const btn = within(slot).getByRole('button');
    expect(btn.textContent).toBe('Tailor');
    expect(btn.getAttribute('data-op')).toBe('runs.start');
    expect(container.querySelectorAll('[role="tab"] .tab-dot')).toHaveLength(5);
    fireEvent.click(btn);
    await waitFor(() =>
      expect(within($(container, '.doc-preview .stage-slot')).getByRole('button').textContent).toMatch(/^(Tailoring|Queued)$/),
    );
    expect(live?.calls.filter((c) => c.name === 'runs.start').at(-1)?.body).toEqual({ skill: 'tailor', role_id: R.stripeOnDeck });
    fireEvent.click(screen.getByRole('tab', { name: 'Answers' }));
    await waitFor(() => expect($(container, '.doc-preview .stage-slot').getAttribute('data-stage')).toBe('Fill'));
    // People is filled by Connect too; a tab with its document shows the document, not a slot.
    expect($(container, '.stage-slot[data-stage="Connect"]').textContent).toContain('From Connect');
    fireEvent.click(screen.getByRole('tab', { name: 'Dossier' }));
    await waitFor(() => expect(container.querySelector('.doc-preview .stage-slot')).toBeNull());
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
    // The live fixture engine has no Kev install (#40): "Not installed" with the install command.
    await waitFor(() =>
      expect(Array.from(container.querySelectorAll('.backend')).map((b) => b.textContent?.slice(0, 5))).toEqual(['Kevpp', 'Agent']),
    );
    const kevCard = $(container, '.backend[data-status="not_installed"]');
    expect(kevCard.textContent).toContain('pp kev install');
    expect(kevCard.textContent).toContain('Not installed');

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

describe('schedules (#29)', () => {
  it('Settings: each schedule shows its next run and the last scheduled run', async () => {
    const { container } = await boot('#/settings', async (l) => {
      await l.as('agent', 'runs.finish', { run_id: 'rn_0003', status: 'ok' });
      const o = await l.as('schedule', 'runs.start', { skill: 'inbox', schedule: 'inbox' });
      const id = (o as { output: { run: { id: string } } }).output.run.id;
      await l.as('agent', 'runs.finish', { run_id: id, status: 'error', summary: { error: 'interrupted' } });
    });
    const rows = await waitFor(() => {
      const r = Array.from(container.querySelectorAll<HTMLElement>('.schedule'));
      if (r.length !== 3 || r[0]?.getAttribute('data-last') !== 'error') throw new Error('rows');
      return r;
    });
    expect(rows.map((r) => r.querySelector('.schedule__last')?.textContent)).toEqual(['Failed', 'Never', 'Never']);
    expect(rows.map((r) => r.getAttribute('data-job'))).toEqual(['unknown', 'unknown', 'unknown']);
    expect(rows[2]?.querySelector('.schedule__next')?.textContent).toMatch(/^Fri \d\d:\d\d$/);
    assertButtons(container);
  });
});

describe('run status (#21)', () => {
  /** The fixture vault has one open inbox run; close it so the indicator starts idle. */
  const quiet = (l: Live) => l.as('agent', 'runs.finish', { run_id: 'rn_0003', status: 'ok' });
  const rail = (container: HTMLElement) => $(container, '.rail .run-indicator');
  const toast = () => screen.getByRole('status');
  const lastRun = () => live?.engine.launcher.specs.at(-1)?.runId as string;

  it('Scout now: running at once, the button says Scouting, then a toast with the count', async () => {
    const { container } = await boot('#/river', quiet);
    await waitFor(() => expect(primary(container).textContent).toBe('Scout now'));
    expect(rail(container).getAttribute('data-run-state')).toBe('idle');
    fireEvent.click(primary(container));
    await waitFor(() => expect(primary(container).textContent).toBe('Scouting'));
    expect(primary(container).disabled).toBe(true);
    expect(primary(container).getAttribute('data-op')).toBe('runs.start');
    expect(rail(container).getAttribute('data-run-state')).toBe('running');
    expect(rail(container).getAttribute('title')).toBe('Scouting');
    const scout = lastRun();
    const fin = await live?.as('agent', 'runs.finish', {
      run_id: scout,
      status: 'ok',
      summary: { queries_run: 4, added: 12, duplicates: 3 },
    });
    expect(fin?.status).toBe('ok');
    await waitFor(() => expect(toast().textContent).toBe('Scout done · 12 added · 3 duplicates'));
    expect(toast().getAttribute('data-tone')).toBe('ok');
    await waitFor(() => expect(primary(container).textContent).toBe('Scout now'));
    expect(primary(container).disabled).toBe(false);
    // One start, no duplicates while it ran.
    expect(live?.calls.filter((c) => c.name === 'runs.start')).toHaveLength(1);
    // The pipeline (#30) scores the inbox next: the rail shows it until it ends.
    const score = lastRun();
    expect(score).not.toBe(scout);
    await waitFor(() => expect(rail(container).getAttribute('title')).toBe('Scoring'));
    await live?.as('agent', 'runs.finish', { run_id: score, status: 'ok' });
    await waitFor(() => expect(rail(container).getAttribute('data-run-state')).toBe('idle'));
  });

  it('a failed run shows its reason without opening logs; Log opens the run with Retry', async () => {
    const { container } = await boot('#/river', quiet);
    await waitFor(() => expect(primary(container).textContent).toBe('Scout now'));
    fireEvent.click(primary(container));
    await waitFor(() => expect(primary(container).textContent).toBe('Scouting'));
    const id = lastRun();
    await live?.as('schedule', 'runs.finish', {
      run_id: id,
      status: 'error',
      summary: { error: 'tool denied: WebSearch', denied_tools: ['WebSearch'], runner_log: '/tmp/pp-runs/x.log' },
      note: 'tool denied: WebSearch',
    });
    await waitFor(() => expect(toast().textContent).toBe('Scout failed · tool denied: WebSearchLog'));
    expect(toast().getAttribute('data-tone')).toBe('error');
    expect(rail(container).getAttribute('data-run-state')).toBe('error');
    fireEvent.click(within(toast()).getByText('Log'));
    await waitFor(() => expect(window.location.hash).toBe(`#/runs/${id}`));
    const detail = await waitFor(() => $(container, '.run-detail'));
    expect(detail.getAttribute('data-status')).toBe('error');
    expect($(container, '.run-outcome').textContent).toBe('tool denied: WebSearch');
    expect(detail.textContent).toContain('WebSearch');
    expect($(container, '.run-runner-log').textContent).toBe('/tmp/pp-runs/x.log');
    await waitFor(() => expect($(container, '.run-log').textContent).toContain('tool denied: WebSearch'));
    // Opening the run clears the rail's failed mark.
    await waitFor(() => expect(rail(container).getAttribute('data-run-state')).toBe('idle'));
    expect(primary(container).textContent).toBe('Retry');
    expect(primary(container).getAttribute('data-op')).toBe('runs.start');
    assertButtons(container);
    fireEvent.click(primary(container));
    await waitFor(() => expect(live?.calls.filter((c) => c.name === 'runs.start')).toHaveLength(2));
    expect(live?.calls.filter((c) => c.name === 'runs.start').at(-1)?.body).toEqual({ skill: 'scout' });
    await waitFor(() => expect(window.location.hash).toBe(`#/runs/${lastRun()}`));
    await waitFor(() => expect($(container, '.run-detail').getAttribute('data-status')).toBe('running'));
  });

  it('Role: Research shows Researching for that role until the run ends', async () => {
    const { container } = await boot(`#/role/${R.airtableOnDeck}`, quiet);
    await waitFor(() => expect(primary(container).textContent).toBe('Research'));
    fireEvent.click(primary(container));
    await waitFor(() => expect(primary(container).textContent).toBe('Researching'));
    expect(primary(container).disabled).toBe(true);
    await live?.as('agent', 'runs.finish', { run_id: lastRun(), status: 'ok' });
    await waitFor(() => expect(toast().textContent).toBe('Research done'));
    await waitFor(() => expect(primary(container).textContent).not.toBe('Researching'));
  });

  it('River: Score all scores every inbox role in one click, shows Scoring, then a toast', async () => {
    const { container } = await boot('#/river', quiet);
    const btn = () => $<HTMLButtonElement>(container, '.river-col[data-status="inbox"] .river-score');
    await waitFor(() => expect(btn().textContent).toBe('Score all'));
    expect(btn().getAttribute('data-op')).toBe('runs.start');
    fireEvent.click(btn());
    await waitFor(() => expect(btn().textContent).toBe('Scoring'));
    expect(btn().disabled).toBe(true);
    expect(live?.calls.filter((c) => c.name === 'runs.start').at(-1)?.body).toEqual({ skill: 'score' });
    const got = await live?.client.run('runs.get', { run_id: lastRun() });
    expect(got?.status === 'ok' && got.output.run.op).toBe('score');
    // The River's own primary stays Scout now.
    expect(primary(container).textContent).toBe('Scout now');
    await live?.as('agent', 'runs.finish', { run_id: lastRun(), status: 'ok', summary: { scored: 3 } });
    await waitFor(() => expect(toast().textContent).toBe('Score done · 3 scored'));
    await waitFor(() => expect(btn().textContent).toBe('Score all'));
    expect(live?.calls.filter((c) => c.name === 'runs.start')).toHaveLength(1);
  });

  it('Role: Pass archives an inbox role as passed (#77)', async () => {
    const { container } = await boot(`#/role/${R.notionInbox}`, quiet);
    const pass = () => $<HTMLButtonElement>(container, 'button[data-op="roles.archive"]');
    await waitFor(() => expect(pass().textContent).toBe('Pass'));
    assertButtons(container);
    fireEvent.click(pass());
    await waitFor(() => expect(toast().textContent).toBe('Notion passed'));
    expect(live?.calls.filter((c) => c.name === 'roles.archive').map((c) => c.body)).toEqual([
      { role_id: R.notionInbox, reason: 'passed' },
    ]);
    const got = await live?.client.run('roles.get', { role_id: R.notionInbox });
    expect(got?.status === 'ok' && [got.output.role.status, got.output.role.archive_reason]).toEqual(['archived', 'passed']);
    await waitFor(() => expect(window.location.hash).toBe('#/river'));
  });

  it('Role: Pass shows on inbox roles only', async () => {
    const { container } = await boot(`#/role/${R.airtableOnDeck}`, quiet);
    await waitFor(() => expect(primary(container).textContent).toBe('Research'));
    expect(container.querySelector('button[data-op="roles.archive"]')).toBeNull();
  });

  it('Role: Skip on the Connect stage moves the application to Fill and shows Skipped (#78)', async () => {
    const { container } = await boot(`#/role/${R.linearDraft}`, quiet);
    const skip = () => $<HTMLButtonElement>(container, 'button[data-op="apply.skip_connect"]');
    await waitFor(() => expect(skip().textContent).toBe('Skip'));
    assertButtons(container);
    fireEvent.click(skip());
    await waitFor(() => expect(toast().textContent).toBe('Connect skipped'));
    expect(live?.calls.filter((c) => c.name === 'apply.skip_connect').map((c) => c.body)).toEqual([
      { role_id: R.linearDraft, reason: 'user' },
    ]);
    await waitFor(() => expect($(container, '[data-fallback="skipped"]').textContent).toBe('Skipped'));
    await waitFor(() => expect(primary(container).textContent).toBe('Open and fill'));
    expect(container.querySelector('button[data-op="apply.skip_connect"]')).toBeNull();
  });

  it('People: shows the Hiring team fallback when no contact was found (#78)', async () => {
    const { container } = await boot(`#/people/${R.linearDraft}`, async (l) => {
      await quiet(l);
      // Synthetic: no contacts for the role and a placeholder company domain.
      l.engine.db.prepare('DELETE FROM outreach WHERE role_id = ?').run(R.linearDraft);
      l.engine.db.prepare('DELETE FROM contact_link WHERE role_id = ?').run(R.linearDraft);
      l.engine.db.prepare(`UPDATE company SET domain = 'linear.example' WHERE id = 'linear'`).run();
      return l.as('agent', 'people.fallback', {
        role_id: R.linearDraft,
        team_inbox: [{ email: 'recruiting@linear.example', source: 'careers' }],
      });
    });
    await waitFor(() => expect($(container, '[data-fallback="team_inbox"]').textContent).toBe('Hiring team'));
    expect($(container, 'button[data-op="apply.skip_connect"]').textContent).toBe('Skip');
    assertButtons(container);
  });

  /** #98, synthetic: a VP on the hiring team (2nd degree, likely pattern email) and a 1st-degree mutual elsewhere. */
  const hopperLike = (mutualEmail: boolean) => async (l: Live) => {
    await quiet(l);
    const db = l.engine.db;
    db.prepare('DELETE FROM outreach WHERE role_id = ?').run(R.linearDraft);
    db.prepare('DELETE FROM contact_link WHERE role_id = ?').run(R.linearDraft);
    const person = db.prepare(
      `INSERT INTO contact (id, name, headline, linkedin_url, email, source, notes, email_source, email_confidence) VALUES (?, ?, ?, NULL, ?, 'linkedin', NULL, ?, ?)`,
    );
    person.run('ct_rowan', 'Rowan Vale', 'VP Product', 'rowan.vale@linear.example', 'pattern', 0.6);
    person.run(
      'ct_kit',
      'Kit Moss',
      'Account Manager at Otherco',
      ...(mutualEmail ? ['kit@otherco.example', 'gmail', 1] : [null, null, null]),
    );
    db.prepare(
      `INSERT INTO contact_link (id, contact_id, company_id, role_id, degree, tier, via_contact_id, is_hiring_team) VALUES ('cl_rowan', 'ct_rowan', 'linear', ?, '2', 'bridge', 'ct_kit', 1)`,
    ).run(R.linearDraft);
  };

  it('People: a reachable hiring leader defaults to a direct note; the weak bridge is the alternative (#98)', async () => {
    const { container } = await boot(`#/people/${R.linearDraft}`, hopperLike(false));
    const direct = await waitFor(() => $(container, '.connect-path[data-path="direct"]'));
    expect(direct.getAttribute('data-chosen')).toBe('true');
    expect(direct.getAttribute('data-recommended')).toBe('true');
    expect(direct.textContent).toContain('To Rowan');
    expect($(direct, '.connect-path__reason').textContent).toBe('Hiring team · Email likely');
    const bridge = $(container, '.connect-path[data-path="bridge"]');
    expect(bridge.textContent).toContain('Via Kit');
    expect($(bridge, '.connect-path__reason').textContent).toBe('Other company · No email');
    // No email for the mutual while the target is reachable: no switch to the bridge.
    expect(bridge.getAttribute('data-blocked')).toBe('true');
    expect(container.querySelector('button[data-op="people.set_path"]')).toBeNull();
    expect(primary(container).textContent).toBe('Draft for Rowan');
    assertButtons(container);
  });

  it('People: Use switches to the bridge before drafting (#98)', async () => {
    const { container } = await boot(`#/people/${R.linearDraft}`, hopperLike(true));
    const use = await waitFor(() => $<HTMLButtonElement>(container, '.connect-path[data-path="bridge"] button[data-op="people.set_path"]'));
    expect(use.textContent).toBe('Use');
    expect(primary(container).textContent).toBe('Draft for Rowan');
    assertButtons(container);
    fireEvent.click(use);
    await waitFor(() => expect($(container, '.connect-path[data-path="bridge"]').getAttribute('data-chosen')).toBe('true'));
    expect(live?.calls.filter((c) => c.name === 'people.set_path').map((c) => c.body)).toEqual([
      { contact_id: 'ct_rowan', role_id: R.linearDraft, path: 'bridge' },
    ]);
    await waitFor(() => expect(primary(container).textContent).toBe('Draft for Kit'));
    // The recommendation stays direct; Use now switches back.
    expect($(container, '.connect-path[data-path="direct"]').getAttribute('data-recommended')).toBe('true');
    expect($(container, '.connect-path[data-path="direct"] button[data-op="people.set_path"]').textContent).toBe('Use');
  });

  it('People: a direct note and a bridge intro both listed, each under its recipient (#98)', async () => {
    const note = { hook: 'Hi, your team is rebuilding search.', proof: 'I led a search rebuild end to end.', ask: 'Open to a short call?' };
    const { container } = await boot(`#/people/${R.linearDraft}`, async (l) => {
      await hopperLike(true)(l);
      await l.as('agent', 'outreach.draft', { contact_id: 'ct_rowan', role_id: R.linearDraft, tier: 'cold_hiring', ...note });
      return l.as('agent', 'outreach.draft', { contact_id: 'ct_rowan', role_id: R.linearDraft, tier: 'bridge', ...note });
    });
    await waitFor(() => expect(container.querySelectorAll('.outreach-item')).toHaveLength(2));
    const items = Array.from(container.querySelectorAll('.outreach-item')).map((el) => [
      el.querySelector('.outreach-item__to')?.textContent,
      el.querySelector('.outreach-item__about')?.textContent ?? null,
    ]);
    expect(items.sort()).toEqual([
      ['Kit Moss', 'About Rowan Vale'],
      ['Rowan Vale', null],
    ]);
    // Both paths show their draft; the person row for Rowan shows the direct note.
    expect($(container, '.connect-path[data-path="direct"]').textContent).toContain('Drafted');
    expect($(container, '.connect-path[data-path="bridge"]').textContent).toContain('Drafted');
    assertButtons(container);
    // Opening the bridge intro shows it to Kit, about Rowan.
    const bridgeItem = Array.from(container.querySelectorAll<HTMLButtonElement>('.outreach-item')).find((el) =>
      el.textContent?.includes('About Rowan'),
    ) as HTMLButtonElement;
    fireEvent.click(bridgeItem);
    await waitFor(() => expect(container.textContent).toContain('You  →  Kit Moss  →  Rowan Vale'));
  });

  it('Role -> Answers: Add questions saves the pasted questions and queues a fill run that uses them (#81)', async () => {
    const { container } = await boot(`#/role/${R.linearDraft}`, quiet);
    await waitFor(() => expect(primary(container).textContent).toBe('Connect'));
    // Off the Answers tab: no box.
    expect(container.querySelector('button[data-op="apply.set_questions"]')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Answers' }));
    const box = await waitFor(() => screen.getByRole('textbox', { name: 'Questions' }));
    expect(within($(container, '.add-questions')).getByText('Add questions')).toBeTruthy();
    const run = () => $<HTMLButtonElement>(container, 'button[data-op="apply.set_questions"]');
    expect(run().textContent).toBe('Run');
    expect(run().disabled).toBe(true);
    assertButtons(container);
    fireEvent.change(box, { target: { value: 'Why Linear?\nWhat would you change about Insights?' } });
    expect(run().disabled).toBe(false);
    fireEvent.click(run());
    await waitFor(() => expect(toast().textContent).toBe('2 questions saved'));
    expect(live?.calls.filter((c) => c.name === 'apply.set_questions').map((c) => c.body)).toEqual([
      { role_id: R.linearDraft, questions_text: 'Why Linear?\nWhat would you change about Insights?' },
    ]);
    // One op: it queued the fill run itself; the headless runner got the pasted questions, not a portal crawl.
    expect(live?.calls.filter((c) => c.name === 'runs.start')).toHaveLength(0);
    const spec = live?.engine.launcher.specs.at(-1);
    expect(spec?.args[1]).toContain('# Fill');
    expect(spec?.args[1]).toContain(`vault.read { path: "applications/${R.linearDraft}/questions.md" }`);
    expect((box as HTMLTextAreaElement).value).toBe('');
    await waitFor(() => expect(run().disabled).toBe(true));
    expect(run().textContent).not.toBe('Run');
  });

  it('Role -> Answers: an answer saved from Ask shows Saved from Ask (#81)', async () => {
    const { container } = await boot(`#/role/${R.linearDraft}`, async (l) => {
      await quiet(l);
      await l.as('agent', 'apply.fill', {
        role_id: R.linearDraft,
        answers: [{ question: 'Why Linear?', kind: 'written', answer: 'Speed is the product.' }],
      });
      return l.as('agent', 'apply.fill', {
        role_id: R.linearDraft,
        source: 'ask',
        answers: [{ question: 'What would you change?', kind: 'written', answer: 'Ship insights faster.' }],
      });
    });
    fireEvent.click(await waitFor(() => screen.getByRole('tab', { name: 'Answers' })));
    const tag = await waitFor(() => $(container, '.answer-source[data-source="ask"]'));
    expect(tag.textContent).toBe('Saved from Ask');
    expect(container.querySelectorAll('.answer-source')).toHaveLength(1);
    const text = container.textContent ?? '';
    // The tag sits under the Ask answer's question, not the fill one.
    expect(text.indexOf('What would you change?')).toBeLessThan(text.indexOf('Saved from Ask'));
    expect(text.indexOf('Saved from Ask')).toBeLessThan(text.indexOf('Ship insights faster.'));
  });

  it('Role: no Add questions before draft-ready (#81)', async () => {
    const { container } = await boot(`#/role/${R.airtableOnDeck}`, quiet);
    fireEvent.click(await waitFor(() => screen.getByRole('tab', { name: 'Answers' })));
    await waitFor(() => expect(primary(container).textContent).toBe('Research'));
    expect(container.querySelector('button[data-op="apply.set_questions"]')).toBeNull();
  });

  it('Role: no Skip off the Connect stage', async () => {
    const { container } = await boot(`#/role/${R.airtableOnDeck}`, quiet);
    await waitFor(() => expect(primary(container).textContent).toBe('Research'));
    expect(container.querySelector('button[data-op="apply.skip_connect"]')).toBeNull();
  });

  it('Role: Open and fill queues the fill assist; after apply.fill_done the primary is Open portal (#106)', async () => {
    const { container } = await boot(`#/role/${R.linearDraft}`, async (l) => {
      await quiet(l);
      return l.as('human', 'apply.skip_connect', { role_id: R.linearDraft, reason: 'user' });
    });
    await waitFor(() => expect(primary(container).textContent).toBe('Open and fill'));
    assertButtons(container);
    fireEvent.click(primary(container));
    await waitFor(() =>
      expect(live?.calls.filter((c) => c.name === 'runs.start').map((c) => c.body)).toEqual([
        { skill: 'fill', role_id: R.linearDraft, assist: true },
      ]),
    );
    const spec = live?.engine.launcher.specs.at(-1);
    expect(spec?.args).toContain('--chrome');
    expect(spec?.args[spec.args.indexOf('--allowedTools') + 1]).toContain('mcp__claude-in-chrome__file_upload');
    expect(spec?.args[1]).toContain('apply.fill_done');
    await waitFor(() => expect(primary(container).disabled).toBe(true));
    // The run answers, renders, uploads + fills in the portal tab, stops before Submit and reports.
    await live?.as('agent', 'apply.fill', {
      role_id: R.linearDraft,
      answers: [{ question: 'Why Linear?', kind: 'written', answer: 'Speed is the product.' }],
    });
    expect(primary(container).textContent).not.toBe('Open portal');
    await live?.as('agent', 'apply.render_documents', { role_id: R.linearDraft, formats: ['pdf'] });
    const done = await live?.as('agent', 'apply.fill_done', { role_id: R.linearDraft, filled: ['Why Linear?'], uploaded: ['resume'] });
    expect(done?.status).toBe('ok');
    await live?.as('agent', 'runs.finish', { run_id: spec?.runId, status: 'ok' });
    await waitFor(() => expect(primary(container).textContent).toBe('Open portal'));
    expect(primary(container).getAttribute('data-op')).toBe('nav');
    assertButtons(container);
  });

  it('Role: at Submit with no fill assist yet, the primary is Open and fill (#106)', async () => {
    const { container } = await boot(`#/role/${R.vercelDraft}`, quiet);
    await waitFor(() => expect(primary(container).textContent).toBe('Open and fill'));
  });

  it('Role -> Resume / Cover: Download PDF or DOCX renders the file and downloads it from /api/files (#106)', async () => {
    const clicked: string[] = [];
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(`${this.getAttribute('href')} ${this.download}`);
    });
    try {
      const { container } = await boot(`#/role/${R.linearDraft}`, quiet);
      await waitFor(() => expect(primary(container).textContent).toBe('Connect'));
      // Not on the Dossier tab.
      expect(container.querySelector('button[data-op="apply.render_documents"]')).toBeNull();
      fireEvent.click(screen.getByRole('tab', { name: 'Resume' }));
      const btn = (label: string) =>
        Array.from(container.querySelectorAll<HTMLButtonElement>('button[data-op="apply.render_documents"]')).find(
          (b) => b.textContent === label,
        );
      await waitFor(() => expect(btn('PDF')).toBeTruthy());
      expect(within($(container, '.downloads')).getByText('Download')).toBeTruthy();
      assertButtons(container);
      fireEvent.click(btn('PDF') as HTMLButtonElement);
      await waitFor(() => expect(clicked).toHaveLength(1));
      expect(live?.calls.filter((c) => c.name === 'apply.render_documents').map((c) => c.body)).toEqual([
        { role_id: R.linearDraft, formats: ['pdf'], docs: ['resume'] },
      ]);
      expect(clicked[0]).toBe(`/api/files?path=${encodeURIComponent(`files/${R.linearDraft}/resume.pdf`)} resume.pdf`);
      fireEvent.click(screen.getByRole('tab', { name: 'Cover' }));
      await waitFor(() => expect(btn('DOCX')?.disabled).toBe(false));
      fireEvent.click(btn('DOCX') as HTMLButtonElement);
      await waitFor(() => expect(clicked).toHaveLength(2));
      expect(clicked[1]).toBe(`/api/files?path=${encodeURIComponent(`files/${R.linearDraft}/cover_letter.docx`)} cover_letter.docx`);
    } finally {
      spy.mockRestore();
    }
  });

  it('River: an inbox tile passes from its menu (#77)', async () => {
    const { container } = await boot('#/river', quiet);
    const inbox = () => $(container, '.river-col[data-status="inbox"]');
    const tilePass = () => $<HTMLButtonElement>(inbox(), `.inbox-tile:has([data-role="${R.notionInbox}"]) .tile-pass`);
    await waitFor(() => expect(tilePass().textContent).toBe('Pass'));
    expect(tilePass().getAttribute('data-op')).toBe('roles.archive');
    expect(container.querySelector('.river-col[data-status="active"] .tile-pass')).toBeNull();
    assertButtons(container);
    fireEvent.click(tilePass());
    await waitFor(() => expect(toast().textContent).toBe('Notion passed'));
    await waitFor(() => expect(inbox().querySelector(`[data-role="${R.notionInbox}"]`)).toBeNull());
    expect(live?.calls.filter((c) => c.name === 'roles.archive').map((c) => c.body)).toEqual([
      { role_id: R.notionInbox, reason: 'passed' },
    ]);
  });

  it('River: Shift-click selects inbox tiles, then Pass N passes them all (#77)', async () => {
    const { container } = await boot('#/river', quiet);
    const inbox = () => $(container, '.river-col[data-status="inbox"]');
    const tiles = () => Array.from(inbox().querySelectorAll<HTMLButtonElement>('.river-tile'));
    await waitFor(() => expect(tiles()).toHaveLength(3));
    const [a, b] = tiles() as [HTMLButtonElement, HTMLButtonElement];
    const ids = [a.getAttribute('data-role'), b.getAttribute('data-role')];
    fireEvent.click(a, { shiftKey: true });
    fireEvent.click(b, { shiftKey: true });
    await waitFor(() => expect($(inbox(), '.river-pass').textContent).toBe('Pass 2'));
    expect(a.getAttribute('aria-pressed')).toBe('true');
    expect(window.location.hash).toBe('#/river');
    // Shift-click again deselects; Clear drops the selection.
    fireEvent.click(b, { shiftKey: true });
    await waitFor(() => expect($(inbox(), '.river-pass').textContent).toBe('Pass 1'));
    fireEvent.click($(inbox(), '.river-pass-clear'));
    await waitFor(() => expect(inbox().querySelector('.river-pass')).toBeNull());
    fireEvent.click(a, { shiftKey: true });
    fireEvent.click(b, { shiftKey: true });
    await waitFor(() => expect($(inbox(), '.river-pass').textContent).toBe('Pass 2'));
    assertButtons(container);
    fireEvent.click($(inbox(), '.river-pass'));
    await waitFor(() => expect(toast().textContent).toBe('2 passed'));
    await waitFor(() => expect(tiles()).toHaveLength(1));
    expect(live?.calls.filter((c) => c.name === 'roles.archive').map((c) => c.body)).toEqual(
      ids.map((role_id) => ({ role_id, reason: 'passed' })),
    );
    expect(inbox().querySelector('.river-pass')).toBeNull();
  });

  it('Role: an inbox role scores in one click; an all-inbox run also shows Scoring', async () => {
    const { container } = await boot(`#/role/${R.notionInbox}`, quiet);
    await waitFor(() => expect(primary(container).textContent).toBe('Score'));
    fireEvent.click(primary(container));
    await waitFor(() => expect(primary(container).textContent).toBe('Scoring'));
    expect(primary(container).disabled).toBe(true);
    expect(live?.calls.filter((c) => c.name === 'runs.start').at(-1)?.body).toEqual({ skill: 'score', role_id: R.notionInbox });
    await live?.as('agent', 'runs.finish', { run_id: lastRun(), status: 'ok' });
    await waitFor(() => expect(primary(container).textContent).toBe('Score'));
    // A score run for every inbox role (River, a schedule, the pipeline) covers this role too.
    await live?.as('schedule', 'runs.start', { skill: 'score' });
    await waitFor(() => expect(primary(container).textContent).toBe('Scoring'), { timeout: 3000 });
  });

  it('runs started elsewhere (a schedule) show on the rail; Runs lists them, Settings shows the latest', async () => {
    const { container } = await boot('#/settings', quiet);
    await waitFor(() => $(container, '.settings-runs .run-row'));
    const started = await live?.as('schedule', 'runs.start', { skill: 'inbox' });
    expect(started?.status).toBe('ok');
    await waitFor(() => expect(rail(container).getAttribute('data-run-state')).toBe('running'), { timeout: 3000 });
    expect(rail(container).getAttribute('title')).toBe('Reading inbox');
    const row = await waitFor(() => $(container, '.settings-runs .run-row[data-status="running"]'));
    expect(row.textContent).toContain('Inbox');
    fireEvent.click(rail(container));
    await waitFor(() => expect(window.location.hash).toBe('#/runs'));
    await waitFor(() => expect(container.querySelectorAll('.run-list .run-row').length).toBeGreaterThan(1));
    expect($(container, '.run-list .run-row').getAttribute('data-status')).toBe('running');
    assertButtons(container);
  });

  it('pipeline (#30): a scout chains a score run; Runs shows the chain both ways', async () => {
    let scout = '';
    let score = '';
    const { container } = await boot('#/runs', async (l) => {
      await quiet(l);
      const o = await l.as('human', 'runs.start', { skill: 'scout' });
      scout = (o as { output: { run: { id: string } } }).output.run.id;
      const fin = await l.as('agent', 'runs.finish', { run_id: scout, status: 'ok', summary: { added: 2 } });
      score = (fin as { output: { run: { summary_json: { triggered: string[] } } } }).output.run.summary_json.triggered[0] as string;
    });
    const row = await waitFor(() => $(container, `.run-list .run-row[data-run-id="${score}"]`));
    expect(row.getAttribute('data-status')).toBe('running');
    expect(row.textContent).toContain('after Scout');
    await go(`#/runs/${scout}`);
    const then = await waitFor(() => $(container, '.run-chain[data-chain="then"]'));
    expect(then.getAttribute('data-run-id')).toBe(score);
    expect(then.textContent).toContain('Score');
    assertButtons(container);
    fireEvent.click(within(then).getByRole('button'));
    await waitFor(() => expect(window.location.hash).toBe(`#/runs/${score}`));
    const from = await waitFor(() => $(container, '.run-chain[data-chain="from"]'));
    expect(from.getAttribute('data-run-id')).toBe(scout);
    expect(from.textContent).toContain('Scout');
  });

  it('pp up restart: an interrupted run reads as failed with the reason', async () => {
    const { container } = await boot('#/runs', async (l) => {
      await quiet(l);
      const o = await l.as('human', 'runs.start', { skill: 'tailor', role_id: R.stripeOnDeck });
      const id = (o as { output: { run: { id: string } } }).output.run.id;
      await l.as('schedule', 'runs.finish', { run_id: id, status: 'error', summary: { error: 'interrupted' } });
    });
    const row = await waitFor(() => $(container, '.run-list .run-row'));
    expect(row.getAttribute('data-status')).toBe('error');
    expect(row.textContent).toContain('interrupted');
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
