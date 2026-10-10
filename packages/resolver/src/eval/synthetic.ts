import { type Answer, CRITERIA, CRITERION_LABELS, INBOX_CLASSES, type Question } from '@perfect-placement/contracts';
import { createLlmBackend, type LlmCall } from '../backends/llm.js';
import { createSystemOneBackend, type SystemOneRequest, type SystemOneResponse } from '../backends/systemone.js';
import type { EvalCase } from './harness.js';

/*
 * Synthetic eval data + mocked backends. No real roles, people or emails.
 * The mocks go through the real adapters (System One HTTP adapter for Kev, LLM backend parser), so a
 * synthetic run exercises the same code path a live run does; only the transport is faked.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEVEL_TEXT: Record<string, string[]> = {
  c1: ['buried under many layers', 'a layer or two from strategy', 'reports to the CEO and owns the call'],
  c2: ['maintains a mature surface', 'mix of new and maintenance', 'builds a new product from scratch'],
  c3: ['purely internal tooling', 'indirect revenue tie', 'customer-facing and tied to revenue'],
  c4: ['AI bolted on, shallow data', 'solid data with an AI component', 'data and AI are the core product'],
  c5: ['an indifferent domain', 'an interesting domain', 'frontier AI infrastructure'],
  c6: ['base below the floor', 'base meets the floor', 'base well above target with equity'],
  c7: ['unknown leadership', 'competent leadership', 'founders with a strong track record'],
  c8: ['a dead-end scope', 'steady growth', 'a steep, expanding scope'],
  c9: ['pure delivery, no ownership', 'adjacent role with real ownership', 'PM-core with full product ownership'],
};

const levelText = (c: string, v: number): string => {
  const t = LEVEL_TEXT[c] as string[];
  return t[v <= 2 ? 0 : v === 3 ? 1 : 2] as string;
};

export function criterionQuestion(c: string, instructions?: string): Question {
  return {
    id: c,
    type: 'score',
    instructions: instructions ?? `Rate "${CRITERION_LABELS[c as keyof typeof CRITERION_LABELS]}" for this role, 1 poor to 5 ideal.`,
    min: 1,
    max: 5,
  };
}

export const INBOX_QUESTION: Question = {
  id: 'class',
  type: 'choice',
  instructions: 'What is this email about the application?',
  options: [...INBOX_CLASSES],
};

const EMAILS: Record<string, string[]> = {
  confirmation: [
    'Thank you for applying to {co}. We received your application for {title}.',
    'Your application to {co} has been submitted.',
  ],
  interview_request: [
    'We would love to schedule a 30 minute call about the {title} role at {co}.',
    'Please pick a time for your first interview with {co}.',
  ],
  offer: ['We are delighted to extend an offer for {title} at {co}.', 'Attached is your offer letter from {co}.'],
  rejection: [
    'After careful review, {co} will not be moving forward with your application.',
    'We have decided to pursue other candidates for {title}.',
  ],
  outreach_reply: ['Happy to chat about {co}. Thursday works for me.', 'Thanks for reaching out, glad to connect.'],
  other: ['Your weekly job alert: 12 new roles.', '{co} newsletter: product updates for October.'],
};

/** Synthetic labelled cases: `roles` roles x 9 criteria, plus `emails` inbox classifications. */
export function syntheticCases(opts: { seed?: number; roles?: number; emails?: number } = {}): EvalCase[] {
  const rnd = mulberry32(opts.seed ?? 7);
  const cases: EvalCase[] = [];
  for (let i = 0; i < (opts.roles ?? 20); i++) {
    const co = `Synthetic Co ${String.fromCharCode(65 + (i % 26))}${i}`;
    const truth = Object.fromEntries(CRITERIA.map((c) => [c, 1 + Math.floor(rnd() * 5)]));
    const state = [
      `Company: ${co}`,
      'Title: Principal Product Manager, Data Platform',
      ...CRITERIA.map((c) => `- ${levelText(c, truth[c] as number)}`),
    ].join('\n');
    for (const c of CRITERIA) {
      cases.push({
        id: `syn-role-${i}-${c}`,
        source: 'synthetic',
        kind: 'roles.criterion',
        impact: 'low',
        group: `syn-role-${i}`,
        state,
        question: criterionQuestion(c),
        expected: truth[c] as number,
      });
    }
  }
  for (let i = 0; i < (opts.emails ?? 30); i++) {
    const cls = INBOX_CLASSES[Math.floor(rnd() * INBOX_CLASSES.length)] as string;
    const tpl = (EMAILS[cls] as string[])[Math.floor(rnd() * 2)] as string;
    const state = `From: no-reply@example.com\nSubject: Update\n\n${tpl.replace('{co}', `Synthetic Co ${i}`).replace('{title}', 'Staff PM')}`;
    cases.push({
      id: `syn-mail-${i}`,
      source: 'synthetic',
      kind: 'inbox.classify',
      impact: 'medium',
      state,
      question: INBOX_QUESTION,
      expected: cls,
    });
  }
  return cases;
}

// ----------------------------------------------------------------------------- mocks

/** Accuracy + calibration profile of a mocked backend. */
export interface MockProfile {
  seed: number;
  /** Probability the pick equals the label. */
  accuracy: number;
  /** 0 = p carries no signal, 1 = p tracks correctness tightly. */
  sharpness: number;
  latencyMs: number;
}

type Oracle = Map<string, Map<string, Answer['value']>>;

const stateKey = (state: unknown): string => (typeof state === 'string' ? state : JSON.stringify(state));

export function buildOracle(cases: EvalCase[]): Oracle {
  const o: Oracle = new Map();
  for (const c of cases) {
    const k = stateKey(c.state);
    const m = o.get(k) ?? new Map();
    m.set(c.question.id, c.expected);
    o.set(k, m);
  }
  return o;
}

function pickNoisy(
  q: Question,
  truth: Answer['value'] | undefined,
  rnd: () => number,
  prof: MockProfile,
): { value: Answer['value']; p: number } {
  const correct = truth !== undefined && rnd() < prof.accuracy;
  let value: Answer['value'];
  if (correct) value = truth as Answer['value'];
  else if (q.type === 'score') {
    const base = typeof truth === 'number' ? truth : 3;
    const step = rnd() < 0.5 ? -1 : 1;
    value = Math.min(q.max, Math.max(q.min, base + step === base ? base + 1 : base + step));
    if (value === truth) value = base === q.max ? base - 1 : base + 1;
  } else if (q.type === 'choice') {
    const others = q.options.filter((o) => o !== truth);
    value = others[Math.floor(rnd() * others.length)] as string;
  } else value = !truth;
  // p: correct answers drift high, wrong ones drift low, mixed by sharpness.
  const signal = correct ? 0.75 + 0.25 * rnd() : 0.4 + 0.3 * rnd();
  const noise = 0.35 + 0.6 * rnd();
  const p = Math.min(0.99, Math.max(0.05, prof.sharpness * signal + (1 - prof.sharpness) * noise));
  return { value, p };
}

/** A fake `fetch` that speaks the System One wire format, answering from the oracle with noise. */
export function mockSystemOneFetch(oracle: Oracle, prof: MockProfile): typeof fetch {
  const rnd = mulberry32(prof.seed);
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as SystemOneRequest;
    const truth = oracle.get(stateKey(body.state));
    const answers: SystemOneResponse['answers'] = {};
    for (const [id, wq] of Object.entries(body.questions)) {
      if (wq.type === 'noul') {
        const q: Question = { id, type: 'noulli', instructions: wq.instructions };
        const { value, p } = pickNoisy(q, truth?.get(id), rnd, prof);
        answers[id] = { type: 'noul', noul: value ? p : 1 - p };
      } else if (wq.type === 'choice') {
        const options = Object.keys(wq.criteria);
        const q: Question = { id, type: 'choice', instructions: wq.instructions, options };
        const { value, p } = pickNoisy(q, truth?.get(id), rnd, prof);
        const rest = (1 - p) / Math.max(1, options.length - 1);
        answers[id] = {
          type: 'choice',
          choice: String(value),
          confidence: p,
          probabilities: Object.fromEntries(options.map((o) => [o, o === value ? p : rest])),
        };
      } else {
        const levels = wq.criteria.map(Number);
        const q: Question = { id, type: 'score', instructions: wq.instructions, min: levels[0] ?? 1, max: levels[levels.length - 1] ?? 5 };
        const { value, p } = pickNoisy(q, truth?.get(id), rnd, prof);
        const idx = levels.indexOf(Number(value));
        const rest = (1 - p) / Math.max(1, levels.length - 1);
        const probabilities = Object.fromEntries(levels.map((_, i) => [String(i), i === idx ? p : rest]));
        answers[id] = { type: 'score', score: idx, confidence: p, probabilities };
      }
    }
    const res: SystemOneResponse = { model: 'mock', answers, latency_ms: prof.latencyMs };
    return new Response(JSON.stringify(res), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

/** A fake LLM transport answering from the oracle with noise (state is found inside the prompt). */
export function mockLlmCall(oracle: Oracle, prof: MockProfile): LlmCall {
  const rnd = mulberry32(prof.seed);
  return async ({ user }) => {
    const stateText = user.slice(user.indexOf('<state>\n') + 8, user.indexOf('\n</state>'));
    const truth = oracle.get(stateText);
    const answers: { id: string; value: string; p: number }[] = [];
    for (const line of user.split('\n')) {
      const m = /^- id: (\S+) \| type: (choice|yes\/no|score)(?: \| (?:options: (.*)|integer (\d+) to (\d+)))?$/.exec(line);
      if (!m) continue;
      const id = m[1] as string;
      const q: Question =
        m[2] === 'choice'
          ? { id, type: 'choice', instructions: '', options: (m[3] ?? '').split(', ') }
          : m[2] === 'score'
            ? { id, type: 'score', instructions: '', min: Number(m[4]), max: Number(m[5]) }
            : { id, type: 'noulli', instructions: '' };
      const { value, p } = pickNoisy(q, truth?.get(id), rnd, prof);
      answers.push({ id, value: String(value), p });
    }
    return JSON.stringify({ answers });
  };
}

/** Default mocked pair: Kev sharper, the LLM more accurate but less calibrated. Latency is simulated. */
export function mockBackends(cases: EvalCase[]) {
  const oracle = buildOracle(cases);
  const simulated = (latencyMs: number) => {
    let t = 0;
    const clock = () => t;
    const delayed =
      <A extends unknown[], R>(fn: (...a: A) => R) =>
      (...a: A): R => {
        t += latencyMs;
        return fn(...a);
      };
    return { clock, delayed };
  };
  const kevT = simulated(700);
  const llmT = simulated(2500);
  const kevFetch = mockSystemOneFetch(oracle, { seed: 22, accuracy: 0.78, sharpness: 0.7, latencyMs: 700 });
  const llm = mockLlmCall(oracle, { seed: 33, accuracy: 0.84, sharpness: 0.35, latencyMs: 2500 });
  return {
    kev: createSystemOneBackend({
      name: 'kev',
      baseUrl: 'http://mock.invalid',
      model: 'kev-latest',
      fetch: kevT.delayed(kevFetch) as typeof fetch,
      clock: kevT.clock,
    }),
    llm: createLlmBackend({ call: llmT.delayed(llm), clock: llmT.clock }),
  };
}
