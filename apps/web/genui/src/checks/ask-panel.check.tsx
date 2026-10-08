import { act } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { AskPanel } from '../AskPanel.js';
import { scriptedAsk } from '../ask.js';
import { fixtureData } from '../data.js';
import { routeAsk } from '../replies.js';
import { tokenPieces } from '../tokens.js';
import { all, type Mounted, mount } from './render.js';

let m: Mounted | undefined;
afterEach(() => m?.unmount());

async function ask(query: string) {
  let done: (text: string) => void = () => {};
  const finished = new Promise<string>((r) => {
    done = r;
  });
  m = await mount(<AskPanel data={fixtureData()} ask={scriptedAsk({ split: tokenPieces })} initialQuery={query} onDone={(t) => done(t)} />);
  const form = m.el.querySelector('form');
  const t0 = performance.now();
  await act(async () => {
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  const text = await act(async () => finished);
  return { el: m.el, text, ms: performance.now() - t0 };
}

describe('Ask panel: scripted stream rendered as cards on fixtures', () => {
  test('routes questions to recorded replies', () => {
    expect(routeAsk('what is in interviews?').id).toBe('interviews');
    expect(routeAsk('compare figma and ramp').id).toBe('compare');
    expect(routeAsk('what changed in my profile').id).toBe('profile');
  });

  test('interviews question streams into two RoleCards', async () => {
    const { el, text } = await ask('What is in interviews?');
    expect(text).toBe(routeAsk('interviews').openui);
    const titles = all(el, 'RoleCard').map((e) => e.textContent);
    expect(titles).toHaveLength(2);
    expect(titles[0]).toContain('Staff PM, Data Platform');
    expect(titles[1]).toContain('Principal PM, AI Agents');
    expect(el.querySelector('[data-genui="AskPanel"]')?.getAttribute('data-state')).toBe('input');
  });

  test('compare question composes groups of RoleCard + ScoreRadar', async () => {
    const { el } = await ask('Compare Figma and Ramp');
    expect(all(el, 'Group')).toHaveLength(2);
    expect(all(el, 'RoleCard')).toHaveLength(2);
    expect(all(el, 'ScoreRadar')).toHaveLength(2);
  });

  test('client-side cost of streaming a full reply stays small', async () => {
    const { ms } = await ask('Why is Linear my best fit?');
    console.log(`best-fit: full scripted stream + render (no network delay): ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(2000);
  });
});
