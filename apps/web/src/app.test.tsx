import { FORBIDDEN_BUTTON_LABELS, OP_NAMES, OPS, type OpName } from '@perfect-placement/contracts';
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
    [`#/role/${R.stripeOnDeck}`, 'Research'],
    [`#/role/${R.notionInbox}`, 'Score'],
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

  it('You -> Terms: Application defaults save once with one op (#42)', async () => {
    const { container } = await boot('#/you/terms');
    const box = await waitFor(() => $(container, '.app-defaults'));
    const save = within(box).getByText('Save') as HTMLButtonElement;
    expect(save.getAttribute('data-op')).toBe('profile.set_defaults');
    expect(save.disabled).toBe(true);
    fireEvent.change($<HTMLInputElement>(box, 'input[name="sponsorship"]'), { target: { value: 'no' } });
    fireEvent.change($<HTMLInputElement>(box, 'input[name="authorized_countries"]'), { target: { value: 'United States, Canada' } });
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

  it('Onboarding: Voice keeps several writing samples (add, remove)', async () => {
    const { container } = await boot('#/onboarding', (l) => l.client.run('onboard.start', { components: ['voice'] }));
    await waitFor(() => expect($(container, '.onboard-q__text').textContent).toBe('Style'));
    fireEvent.click($(container, '.onboard-q .chip'));
    fireEvent.click(primary(container));
    await waitFor(() => expect($(container, '.onboard-q__text').textContent).toBe('Writing samples'));
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
    await waitFor(() => expect(primary(container).textContent).toBe('Start'));
    expect(container.querySelector('.onboard-q__text')).toBeNull();
    fireEvent.click(primary(container));
    await waitFor(() => expect(window.location.hash).toBe('#/you/voice'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy());
    expect(container.textContent).toContain('Sample three, pending.');
    expect(opsCalled()).toContain('onboard.confirm');
  });

  it('Onboarding: the resume upload is kept and parsed by a run; derived years are confirmed (#38)', async () => {
    const { container } = await boot('#/onboarding', (l) => l.client.run('onboard.start', {}));
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
    // Years are derived from the role dates, never guessed: the user confirms or leaves them out.
    await waitFor(() => expect($(container, '.onboard-q__text').textContent).toBe('Years'));
    const chips = Array.from(container.querySelectorAll('.onboard-q .chip')).map((c) => c.textContent);
    expect(chips).toEqual(['10', 'leave out']);
    assertButtons(container);
  });

  it('Onboarding: a dictated answer is shown cleaned, then saved with its raw text (#38)', async () => {
    const { container } = await boot('#/onboarding', (l) => l.client.run('onboard.start', { components: ['story'] }));
    await waitFor(() => expect($(container, '.onboard-q__text').textContent).toBe('Headline'));
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
    const { container } = await boot(`#/role/${R.stripeOnDeck}`, quiet);
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
