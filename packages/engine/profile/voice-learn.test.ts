import type { OpContext } from '@perfect-placement/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine, tickingClock } from '../testing/index.js';
import { sampleProblem } from './voice-learn.js';

/* Learn voice (#76): synthetic writing only; the run's Gmail and LinkedIn reads are the agent's, never called here. */

const clock = tickingClock();
const ctx = (actor: OpContext['actor'] = 'agent'): OpContext => ctxAt(actor, {}, clock);
let e: FixtureEngine | undefined;
afterEach(() => {
  e?.cleanup();
  e = undefined;
});

const GOOD = [
  'Quick one before Friday. The pilot worked, the rollout plan did not. I would rather fix the plan than ship it late.',
  'Short answer: yes. Longer answer: only if we cut scope first, and I think we should.',
];

describe('profile.propose_voice (#76)', () => {
  it('proposes style, traits and samples as a pending Voice diff; only a human applies it', async () => {
    e = openFixtureEngine();
    const out = okOut(
      await e.runOp(
        'profile.propose_voice',
        {
          style: 'plain',
          traits: ['short sentences', 'opens with the point'],
          samples: GOOD,
          sources: { gmail_sent: 24, linkedin_posts: 0 },
        },
        ctx(),
      ),
    );
    expect(out.dropped).toBe(0);
    expect(out.diff).toMatchObject({ component_key: 'voice', status: 'pending' });
    expect(out.diff.evidence_json).toEqual(['Learned from your own writing (Learn voice)', '24 sent emails read', '0 LinkedIn posts read']);
    const after = out.diff.diff_json.after;
    expect(after.samples).toHaveLength(4); // the two kept samples first, then the learned ones
    expect(after.samples.slice(2)).toEqual(GOOD);
    expect(after).toMatchObject({ style: 'plain', traits: ['short sentences', 'opens with the point'], learned_from: { gmail_sent: 24 } });

    // An agent (even confident) never applies it.
    expect(await e.runOp('profile.apply_diff', { diff_id: out.diff.id }, ctxAt('agent', { confidence: 0.99 }, clock))).toMatchObject({
      status: 'error',
      code: 'human_only',
    });
    okOut(await e.runOp('profile.apply_diff', { diff_id: out.diff.id }, ctx('human')));
    const p = okOut(await e.runOp('profile.get', {}, ctx('human')));
    const voice = p.components.find((c: { key: string }) => c.key === 'voice').data_json;
    expect(voice.samples).toHaveLength(4);
    expect(voice.style).toBe('plain');
  });

  it("refuses samples that carry someone else's details or dashes; caps samples at the Voice limit", async () => {
    expect(sampleProblem('Hi Sam, thanks for the intro yesterday, I will follow up with the deck next week.')).toMatch(/greeting/);
    expect(sampleProblem('Send it to sam.lee@example.com before Friday and we can review the plan together.')).toMatch(/email/);
    expect(sampleProblem('Call me at +1 555 010 0000 when you land and we can walk through the numbers.')).toMatch(/phone/);
    expect(sampleProblem('Details are on https://example.com/plan if you want the long version of this story.')).toMatch(/link/);
    expect(sampleProblem('Thanks @dana for the push on this, the plan is much tighter now than last week.')).toMatch(/handle/);
    expect(sampleProblem('The pilot worked — the rollout plan did not, and that is the part we fix first.')).toMatch(/dash/);
    expect(sampleProblem('Too short.')).toMatch(/shorter/);
    expect(sampleProblem(GOOD[0] as string)).toBeNull();

    e = openFixtureEngine();
    const bad = await e.runOp(
      'profile.propose_voice',
      {
        samples: [GOOD[0], 'Hi Sam, thanks for the intro yesterday, I will follow up with the deck next week.'],
        sources: { gmail_sent: 3 },
      },
      ctx(),
    );
    expect(bad).toMatchObject({ status: 'error', code: 'invalid_input' });
    expect(JSON.stringify(bad)).toContain('sample 2 has a greeting');
    const more = [...GOOD, 'Here is where I land: ship the small version now, learn for two weeks, then decide on the big one.'];
    const out = okOut(await e.runOp('profile.propose_voice', { samples: more, sources: { gmail_sent: 9 } }, ctx()));
    expect(out.diff.diff_json.after.samples).toHaveLength(5);
    expect(out.dropped).toBe(0);
    okOut(await e.runOp('profile.apply_diff', { diff_id: out.diff.id }, ctx('human')));
    // Voice is full: a new sample is dropped, and with nothing else new there is no diff.
    const full = okOut(
      await e.runOp(
        'profile.propose_voice',
        {
          samples: ['Fair question. The honest answer is that we guessed, and now we have the data to stop guessing.'],
          sources: { gmail_sent: 2 },
        },
        ctx(),
      ),
    );
    expect(full).toEqual({ diff: null, dropped: 1 });
    // Nothing new: no diff.
    const none = okOut(await e.runOp('profile.propose_voice', { style: 'punchy', sources: { gmail_sent: 1 } }, ctx()));
    expect(none).toEqual({ diff: null, dropped: 0 });
  });

  it('a voice run is queued like any skill run (Learn voice)', async () => {
    e = openFixtureEngine();
    const r = okOut(await e.runOp('runs.start', { skill: 'voice' }, ctx('human')));
    expect(r.run.op).toBe('voice');
  });
});
