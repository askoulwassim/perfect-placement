import type { AskRequest } from '@perfect-placement/contracts';
import { describe, expect, it } from 'vitest';
import { BackendUnavailableError } from '../errors.js';
import { createKevBackend, KEV_DEFAULT_BASE_URL, toSystemOneRequest } from './systemone.js';

const REQ: AskRequest = {
  decision: 'inbox.classify',
  impact: 'medium',
  state: 'Thank you for applying to Example Co.',
  questions: [
    { id: 'class', type: 'choice', instructions: 'What is this email?', options: ['confirmation', 'interview_request', 'other'] },
    { id: 'from_ats', type: 'noulli', instructions: 'Is this sent by an applicant tracking system?' },
    { id: 'urgency', type: 'score', instructions: 'How urgent?', min: 1, max: 3 },
  ],
};

const OK_BODY = {
  model: 'kev-0.8b',
  answers: {
    class: {
      type: 'choice',
      choice: 'confirmation',
      confidence: 0.9,
      probabilities: { confirmation: 0.93, interview_request: 0.05, other: 0.02 },
    },
    from_ats: { type: 'noul', noul: 0.12 },
    urgency: { type: 'score', score: 0.4, confidence: 0.7, probabilities: { '0': 0.7, '1': 0.2, '2': 0.1 } },
  },
  usage: { input_tokens: 50, output_tokens: 10 },
};

function recorder(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = responses.shift();
    if (!r) throw new Error('no more responses');
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noSleep = async () => {};

describe('System One wire mapping', () => {
  it('maps contract questions to the System One request', () => {
    const body = toSystemOneRequest(REQ, 'kev-latest', 'kev');
    expect(body).toEqual({
      state: REQ.state,
      model: 'kev-latest',
      questions: {
        class: {
          type: 'choice',
          instructions: 'What is this email?',
          criteria: { confirmation: 'confirmation', interview_request: 'interview request', other: 'other' },
        },
        from_ats: { type: 'noul', instructions: 'Is this sent by an applicant tracking system?' },
        urgency: { type: 'score', instructions: 'How urgent?', criteria: ['1', '2', '3'] },
      },
    });
  });

  it('passes object state through unchanged', () => {
    const body = toSystemOneRequest({ ...REQ, state: { subject: 'Hi', body: 'x' } }, 'kev-latest', 'kev');
    expect(body.state).toEqual({ subject: 'Hi', body: 'x' });
  });

  it('rejects score questions outside 2..10 levels so the resolver falls back', () => {
    expect(() =>
      toSystemOneRequest({ ...REQ, questions: [{ id: 's', type: 'score', instructions: '', min: 0, max: 100 }] }, 'kev-latest', 'kev'),
    ).toThrow(BackendUnavailableError);
  });
});

describe('Kev backend over HTTP', () => {
  it('posts to /v1/systemone with a bearer key and maps answers', async () => {
    const { f, calls } = recorder([json(OK_BODY)]);
    const kev = createKevBackend({ apiKey: 'test-key', fetch: f, sleep: noSleep });
    const res = await kev.ask(REQ);
    expect(calls[0]?.url).toBe(`${KEV_DEFAULT_BASE_URL}/v1/systemone`);
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe('Bearer test-key');
    expect(JSON.parse(String(calls[0]?.init.body)).model).toBe('kev-latest');
    expect(res.answers).toEqual([
      expect.objectContaining({ id: 'class', value: 'confirmation', p: 0.93 }),
      expect.objectContaining({ id: 'from_ats', value: false, p: 0.88 }),
      expect.objectContaining({ id: 'urgency', value: 1, p: 0.7 }),
    ]);
  });

  it('retries 429 and 529, then succeeds', async () => {
    const { f, calls } = recorder([json({}, 429), json({}, 529), json(OK_BODY)]);
    const kev = createKevBackend({ apiKey: 'k', fetch: f, sleep: noSleep });
    await expect(kev.ask(REQ)).resolves.toBeTruthy();
    expect(calls).toHaveLength(3);
  });

  it('does not retry 401 or 422', async () => {
    for (const status of [401, 422]) {
      const { f, calls } = recorder([json({}, status), json(OK_BODY)]);
      const kev = createKevBackend({ apiKey: 'k', fetch: f, sleep: noSleep });
      await expect(kev.ask(REQ)).rejects.toMatchObject({ name: 'BackendUnavailableError', status });
      expect(calls).toHaveLength(1);
    }
  });

  it('fails fast when unreachable', async () => {
    const { f, calls } = recorder([new TypeError('fetch failed')]);
    const kev = createKevBackend({ apiKey: 'k', fetch: f, sleep: noSleep });
    await expect(kev.ask(REQ)).rejects.toBeInstanceOf(BackendUnavailableError);
    expect(calls).toHaveLength(1);
  });

  it('rejects a choice outside the options and a missing answer', async () => {
    const bad = { ...OK_BODY, answers: { ...OK_BODY.answers, class: { type: 'choice', choice: 'banana', probabilities: { banana: 1 } } } };
    const kev = createKevBackend({ apiKey: 'k', fetch: recorder([json(bad)]).f, sleep: noSleep });
    await expect(kev.ask(REQ)).rejects.toThrow(/not in options/);
    const missing = { ...OK_BODY, answers: { class: OK_BODY.answers.class } };
    const kev2 = createKevBackend({ apiKey: 'k', fetch: recorder([json(missing)]).f, sleep: noSleep });
    await expect(kev2.ask(REQ)).rejects.toThrow(/no answer/);
  });

  it('health is ok on 200 and not ok on 401 or network error', async () => {
    expect((await createKevBackend({ apiKey: 'k', fetch: recorder([json({ data: [] })]).f }).health()).ok).toBe(true);
    expect((await createKevBackend({ apiKey: 'k', fetch: recorder([json({}, 401)]).f }).health()).ok).toBe(false);
    expect((await createKevBackend({ apiKey: 'k', fetch: recorder([new Error('x')]).f }).health()).ok).toBe(false);
  });
});

describe('Kev backend defaults', () => {
  it('uses the local base URL, kev-latest, no auth header by default', async () => {
    const { f, calls } = recorder([json(OK_BODY)]);
    const kev = createKevBackend({ fetch: f, sleep: noSleep });
    await kev.ask(REQ);
    expect(calls[0]?.url).toBe('http://127.0.0.1:8009/v1/systemone');
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
    expect(JSON.parse(String(calls[0]?.init.body)).model).toBe('kev-latest');
  });

  it('falls back to the rounded score when probabilities are absent', async () => {
    const body = { answers: { ...OK_BODY.answers, urgency: { type: 'score', score: 1.6, confidence: 0.4 } } };
    const kev = createKevBackend({ fetch: recorder([json(body)]).f, sleep: noSleep });
    const res = await kev.ask(REQ);
    expect(res.answers[2]).toMatchObject({ id: 'urgency', value: 3, p: 0.4 });
  });

  it('health treats a 404 on /v1/models as up', async () => {
    expect((await createKevBackend({ fetch: recorder([json({}, 404)]).f }).health()).ok).toBe(true);
  });
});
