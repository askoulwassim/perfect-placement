import type { AskRequest } from '@perfect-placement/contracts';
import { describe, expect, it } from 'vitest';
import { BackendUnavailableError } from '../errors.js';
import { createHumanBackend } from './human.js';
import { buildPrompt, createLlmBackend, type LlmCall, parseValue } from './llm.js';
import { createRuleBackend } from './rule.js';

const REQ: AskRequest = {
  decision: 'people.classify',
  impact: 'low',
  state: { name: 'Maya R.', headline: 'Director of Product' },
  questions: [
    { id: 'who', type: 'choice', instructions: 'Who is this person for the role?', options: ['hiring_manager', 'peer', 'other'] },
    { id: 'senior', type: 'noulli', instructions: 'Senior to the role?' },
    { id: 'fit', type: 'score', instructions: 'Relevance', min: 1, max: 5 },
  ],
};

describe('LLM backend', () => {
  it('builds a prompt with state and typed questions only', () => {
    const p = buildPrompt(REQ);
    expect(p).toContain('<state>\nname: Maya R.\nheadline: Director of Product\n</state>');
    expect(p).toContain('- id: who | type: choice | options: hiring_manager, peer, other');
    expect(p).toContain('- id: senior | type: yes/no');
    expect(p).toContain('- id: fit | type: score | integer 1 to 5');
  });

  it('parses and coerces values', () => {
    const [who, senior, fit] = REQ.questions as [never, never, never];
    expect(parseValue(who, 'Hiring_Manager')).toBe('hiring_manager');
    expect(parseValue(who, 'ceo')).toBeUndefined();
    expect(parseValue(senior, 'yes')).toBe(true);
    expect(parseValue(senior, 'maybe')).toBeUndefined();
    expect(parseValue(fit, '4')).toBe(4);
    expect(parseValue(fit, '9')).toBeUndefined();
  });

  it('answers from a structured reply', async () => {
    const call: LlmCall = async ({ schema }) => {
      expect(schema).toHaveProperty('properties.answers');
      return JSON.stringify({
        answers: [
          { id: 'who', value: 'peer', p: 0.8 },
          { id: 'senior', value: 'false', p: 0.7 },
          { id: 'fit', value: '3', p: 1.4 },
        ],
      });
    };
    const res = await createLlmBackend({ call }).ask(REQ);
    expect(res.answers).toEqual([
      { id: 'who', value: 'peer', p: 0.8 },
      { id: 'senior', value: false, p: 0.7 },
      { id: 'fit', value: 3, p: 1 },
    ]);
  });

  it('fails the backend on malformed or incomplete replies', async () => {
    await expect(createLlmBackend({ call: async () => 'not json' }).ask(REQ)).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(
      createLlmBackend({ call: async () => JSON.stringify({ answers: [{ id: 'who', value: 'peer', p: 0.8 }] }) }).ask(REQ),
    ).rejects.toThrow(/bad answer for 'senior'/);
    await expect(
      createLlmBackend({
        call: async () => {
          throw new Error('boom');
        },
      }).ask(REQ),
    ).rejects.toBeInstanceOf(BackendUnavailableError);
  });
});

describe('rule backend', () => {
  const now = () => new Date('2026-10-08T12:00:00.000Z');
  const rule = createRuleBackend({ now });
  const req = (state: Record<string, string>, questions: AskRequest['questions']): AskRequest => ({
    decision: 'other',
    impact: 'low',
    state,
    questions,
  });

  it('comp floor and posting age, p = 1', async () => {
    const r = req({ comp_max: '$215,000', comp_floor: '200k', posted_at: '2026-08-01T00:00:00.000Z', stale_after_days: '45' }, [
      { id: 'meets_comp_floor', type: 'noulli', instructions: '' },
      { id: 'posting_stale', type: 'noulli', instructions: '' },
      { id: 'posting_age_days', type: 'score', instructions: '', min: 0, max: 60 },
    ]);
    expect(rule.canAnswer(r)).toBe(true);
    const res = await rule.ask(r);
    expect(res.answers).toEqual([
      { id: 'meets_comp_floor', value: true, p: 1 },
      { id: 'posting_stale', value: true, p: 1 },
      { id: 'posting_age_days', value: 60, p: 1 },
    ]);
  });

  it('cannot answer without data or without a rule', async () => {
    expect(rule.canAnswer(req({ comp_floor: '200000' }, [{ id: 'meets_comp_floor', type: 'noulli', instructions: '' }]))).toBe(false);
    expect(rule.canAnswer(REQ)).toBe(false);
    await expect(rule.ask(REQ)).rejects.toBeInstanceOf(BackendUnavailableError);
  });

  it('accepts custom rules', async () => {
    const custom = createRuleBackend({ now, rules: { is_remote: (_q, s) => (s.workplace ? s.workplace === 'remote' : undefined) } });
    const r = req({ workplace: 'remote' }, [{ id: 'is_remote', type: 'noulli', instructions: '' }]);
    expect((await custom.ask(r)).answers[0]).toEqual({ id: 'is_remote', value: true, p: 1 });
  });
});

describe('human backend', () => {
  it('returns placeholder picks with p = 0', async () => {
    const res = await createHumanBackend().ask(REQ);
    expect(res.answers).toEqual([
      { id: 'who', value: 'other', p: 0 },
      { id: 'senior', value: false, p: 0 },
      { id: 'fit', value: 1, p: 0 },
    ]);
  });
});
