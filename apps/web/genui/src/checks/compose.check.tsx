import type { ParseResult } from '@openuidev/react-lang';
import { afterEach, describe, expect, test } from 'vitest';
import { AskReply } from '../AskPanel.js';
import { fixtureData, GenuiDataContext } from '../data.js';
import { askLibrary, askSystemPrompt } from '../library.js';
import { SCENARIOS } from '../replies.js';
import { tokenPieces } from '../tokens.js';
import { all, type Mounted, mount } from './render.js';

const data = fixtureData();
let m: Mounted | undefined;
afterEach(() => m?.unmount());

const view = (response: string, isStreaming = false, onParseResult?: (r: ParseResult | null) => void) => (
  <GenuiDataContext value={data}>
    <AskReply response={response} isStreaming={isStreaming} onParseResult={onParseResult} />
  </GenuiDataContext>
);

const scenario = (id: string) => SCENARIOS.find((s) => s.id === id)?.openui ?? '';

describe('compose: the four cards registered with OpenUI', () => {
  test('library registers RoleCard, ScoreRadar, ContactCard, ProfileDiff and the prompt lists them', () => {
    expect(Object.keys(askLibrary.components).sort()).toEqual([
      'ContactCard',
      'Group',
      'ProfileDiff',
      'Reply',
      'RoleCard',
      'ScoreRadar',
      'Text',
    ]);
    const prompt = askSystemPrompt();
    for (const n of [
      'RoleCard(roleId: string)',
      'ScoreRadar(roleId: string)',
      'ContactCard(contactId: string, roleId?: string)',
      'ProfileDiff(diffId: string)',
    ])
      expect(prompt).toContain(n);
  });

  test('nested groups render role, radar and people hydrated from fixtures', async () => {
    m = await mount(view(scenario('best-fit')));
    expect(all(m.el, 'Group')).toHaveLength(2);
    const role = all(m.el, 'RoleCard')[0];
    expect(role?.textContent).toContain('Product Lead, Insights');
    expect(role?.textContent).toContain('Linear');
    expect(all(m.el, 'ScoreRadar')).toHaveLength(1);
    expect(all(m.el, 'ContactCard').map((e) => e.getAttribute('data-tier'))).toEqual(['warm_hiring', 'bridge']);
  });

  test('ProfileDiff shows before and after from the diff row', async () => {
    m = await mount(view(scenario('profile')));
    const diffs = all(m.el, 'ProfileDiff');
    expect(diffs).toHaveLength(2);
    expect(diffs[0]?.textContent).toContain('comp_floor: 200000');
    expect(diffs[0]?.textContent).toContain('comp_floor: 215000');
  });

  test('every scenario renders without parse errors', async () => {
    for (const s of SCENARIOS) {
      let last: ParseResult | null = null;
      m = await mount(view(s.openui, false, (r) => (last = r)));
      expect(all(m.el, 'Reply')).toHaveLength(1);
      expect((last as ParseResult | null)?.meta.errors ?? []).toEqual([]);
      m.unmount();
      m = undefined;
    }
  });

  test('an unknown component is dropped and reported; the rest still renders', async () => {
    let last: ParseResult | null = null;
    const src = 'root = Reply([x, r])\nx = PieChart("nope")\nr = RoleCard("linear_product-lead-insights")';
    m = await mount(view(src, false, (res) => (last = res)));
    expect(all(m.el, 'RoleCard')).toHaveLength(1);
    expect((last as ParseResult | null)?.meta.errors.map((e) => e.code)).toContain('unknown-component');
  });

  test('a wrong id never invents a card: Pending while streaming, Missing when done', async () => {
    const src = 'root = Reply([r])\nr = RoleCard("acme_ghost-role")';
    m = await mount(view(src, true));
    expect(all(m.el, 'Pending')).toHaveLength(1);
    await m.rerender(view(src, false));
    expect(all(m.el, 'Missing')).toHaveLength(1);
    expect(all(m.el, 'RoleCard')).toHaveLength(0);
  });

  test('positional args are fragile: swapped ContactCard args resolve to nothing', async () => {
    const src = 'root = Reply([p])\np = ContactCard("linear_product-lead-insights", "ct_0001")';
    m = await mount(view(src));
    expect(all(m.el, 'ContactCard')).toHaveLength(0);
    expect(all(m.el, 'Missing')).toHaveLength(1);
  });

  test('streaming: the shell and first cards appear before the reply is complete', async () => {
    const src = scenario('top-active');
    const pieces = tokenPieces(src);
    const seen: number[] = [];
    let text = '';
    m = await mount(view('', true));
    for (const p of pieces) {
      text += p;
      await m.rerender(view(text, true));
      seen.push(all(m.el, 'RoleCard').length);
    }
    await m.rerender(view(text, false));
    expect(seen.indexOf(1)).toBeGreaterThan(0);
    expect(seen.indexOf(1)).toBeLessThan(pieces.length - 1);
    expect(Math.max(...seen.slice(0, -10))).toBeLessThan(3);
    expect(all(m.el, 'RoleCard')).toHaveLength(3);
  });
});
