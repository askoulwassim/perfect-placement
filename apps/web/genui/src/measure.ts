/*
 * Measurements for the verdict: tokens (OpenUI Lang vs equivalent JSON, ids vs inline data),
 * tokens until the first card can render, and parser cost while streaming.
 *
 * JSON baseline = the usual JSON-UI tree {"component": X, "props": {...}} (Vercel json-render / C1 style),
 * compact (no whitespace), which is the cheapest JSON a model would reasonably stream.
 */

import {
  createLibrary as createCoreLibrary,
  createParser,
  createStreamingParser,
  defineComponent as defineCoreComponent,
  type ElementNode,
  jsonToOpenUI,
} from '@openuidev/lang-core';
import { CRITERIA } from '@perfect-placement/contracts';
import { z } from 'zod';
import type { GenuiData } from './data.js';
import { askLibrary, CARD_TYPES, diffSides } from './library.js';
import type { Scenario } from './replies.js';
import { countTokens, tokenPieces } from './tokens.js';

// ---------------------------------------------------------------- inline-data library (measurement only)
// Same components, but the model would have to emit every fact itself. No renderers: serialization only.

const def = <T extends z.ZodObject>(name: string, props: T) => defineCoreComponent({ name, description: name, props, component: null });
const IText = def('Text', z.object({ text: z.string() }));
const IRoleCard = def(
  'RoleCard',
  z.object({
    id: z.string(),
    company: z.string(),
    title: z.string(),
    status: z.string(),
    total: z.number().nullable(),
    band: z.string().nullable(),
    workplace: z.string(),
  }),
);
const IScoreRadar = def('ScoreRadar', z.object({ criteria: z.array(z.number()) }));
const IContactCard = def(
  'ContactCard',
  z.object({ id: z.string(), name: z.string(), headline: z.string().nullable(), tier: z.string().nullable() }),
);
const IProfileDiff = def(
  'ProfileDiff',
  z.object({ id: z.string(), component: z.string(), before: z.array(z.string()), after: z.array(z.string()), impact: z.string() }),
);
const IItem = z.union([IText.ref, IRoleCard.ref, IScoreRadar.ref, IContactCard.ref, IProfileDiff.ref]);
const IGroup = def('Group', z.object({ label: z.string(), items: z.array(IItem) }));
const IReply = def('Reply', z.object({ items: z.array(z.union([IGroup.ref, IItem])) }));
export const inlineLibrary = createCoreLibrary({
  components: [IReply, IGroup, IText, IRoleCard, IScoreRadar, IContactCard, IProfileDiff],
  root: 'Reply',
});

// ---------------------------------------------------------------- tree helpers

const isElement = (v: unknown): v is ElementNode => typeof v === 'object' && v !== null && (v as ElementNode).type === 'element';

const mapChildren = (props: Record<string, unknown>, f: (n: ElementNode) => ElementNode) =>
  Object.fromEntries(Object.entries(props).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => (isElement(x) ? f(x) : x)) : v]));

export function parseReply(openui: string): ElementNode {
  const res = createParser(askLibrary.toJSONSchema(), 'Reply').parse(openui);
  if (!res.root || res.meta.errors.length) throw new Error(`reply does not parse: ${JSON.stringify(res.meta.errors)}`);
  return res.root;
}

/** Replace id props with the facts the card shows (what an inline-data model would have to write). */
export function hydrate(node: ElementNode, data: GenuiData): ElementNode {
  const p = node.props as Record<string, string | undefined>;
  const el = (props: Record<string, unknown>): ElementNode => ({ ...node, props });
  switch (node.typeName) {
    case 'RoleCard': {
      const role = data.role(p.roleId ?? '');
      if (!role) return node;
      const s = data.latestScore(role.id);
      const company = data.company(role.company_id)?.name ?? role.company_id;
      return el({
        id: role.id,
        company,
        title: role.title,
        status: role.status,
        total: s?.total ?? null,
        band: s?.band ?? null,
        workplace: role.workplace,
      });
    }
    case 'ScoreRadar': {
      const s = data.latestScore(p.roleId ?? '');
      return s ? el({ criteria: CRITERIA.map((k) => s[k]) }) : node;
    }
    case 'ContactCard': {
      const ct = data.contact(p.contactId ?? '');
      return ct ? el({ id: ct.id, name: ct.name, headline: ct.headline, tier: data.tier(ct.id, p.roleId) ?? null }) : node;
    }
    case 'ProfileDiff': {
      const d = data.diff(p.diffId ?? '');
      return d ? el({ id: d.id, component: d.component_key, ...diffSides(d), impact: d.impact }) : node;
    }
    default:
      return el(mapChildren(node.props, (n) => hydrate(n, data)));
  }
}

type JsonUi = { component: string; props: Record<string, unknown> };
export function toJsonUi(node: ElementNode): JsonUi {
  return {
    component: node.typeName,
    props: Object.fromEntries(
      Object.entries(node.props).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => (isElement(x) ? toJsonUi(x) : x)) : v]),
    ),
  };
}

/** Hand-rolled compact JSON a team could define without OpenUI: [Type, ...positional args]. */
export function toJsonTuple(node: ElementNode): unknown[] {
  return [
    node.typeName,
    ...Object.values(node.props).map((v) => (Array.isArray(v) ? v.map((x) => (isElement(x) ? toJsonTuple(x) : x)) : v)),
  ];
}

// ---------------------------------------------------------------- first card

const findCards = (node: ElementNode | null, out: ElementNode[] = []): ElementNode[] => {
  if (!node) return out;
  if ((CARD_TYPES as readonly string[]).includes(node.typeName)) out.push(node);
  for (const v of Object.values(node.props)) if (Array.isArray(v)) for (const x of v) if (isElement(x)) findCards(x, out);
  return out;
};

const resolves = (n: ElementNode, data: GenuiData): boolean => {
  const p = n.props as Record<string, string | undefined>;
  if (n.typeName === 'RoleCard') return !!data.role(p.roleId ?? '');
  if (n.typeName === 'ScoreRadar') return !!data.latestScore(p.roleId ?? '');
  if (n.typeName === 'ContactCard') return !!data.contact(p.contactId ?? '');
  if (n.typeName === 'ProfileDiff') return !!data.diff(p.diffId ?? '');
  return false;
};

/** Stream token by token through the OpenUI streaming parser; return tokens until a card can render, and parse cost. */
export function openuiFirstCard(openui: string, data: GenuiData) {
  const parser = createStreamingParser(askLibrary.toJSONSchema(), 'Reply');
  const pieces = tokenPieces(openui);
  let first = -1;
  let parseMs = 0;
  pieces.forEach((piece, i) => {
    const t0 = performance.now();
    const res = parser.push(piece);
    parseMs += performance.now() - t0;
    if (first < 0 && findCards(res.root).some((n) => !n.partial && resolves(n, data))) first = i + 1;
  });
  return { tokensToFirstCard: first, parseMs, chunks: pieces.length };
}

/** Best case for JSON: a partial-JSON parser renders a card the moment its object closes. */
export function jsonFirstCard(json: string): number {
  let end = Number.POSITIVE_INFINITY;
  for (const type of CARD_TYPES) {
    const start = json.indexOf(`{"component":"${type}"`);
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    for (let i = start; i < json.length; i++) {
      const ch = json[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        end = Math.min(end, i + 1);
        break;
      }
    }
  }
  let chars = 0;
  const pieces = tokenPieces(json);
  for (let i = 0; i < pieces.length; i++) {
    chars += (pieces[i] as string).length;
    if (chars >= end) return i + 1;
  }
  return pieces.length;
}

// ---------------------------------------------------------------- per scenario

export interface ScenarioMeasure {
  id: string;
  tokens: { openuiRef: number; jsonRef: number; openuiInline: number; jsonInline: number; tupleRef: number };
  /** Fraction of JSON tokens saved by OpenUI Lang. */
  saving: { ref: number; inline: number };
  /** Tokens saved by ids instead of inline data, within OpenUI Lang. */
  refVsInline: number;
  firstCard: { openui: number; json: number };
  parseMs: number;
  chunks: number;
  text: { openuiRef: string; jsonRef: string; openuiInline: string; jsonInline: string; tupleRef: string };
}

export function measureScenario(s: Scenario, data: GenuiData): ScenarioMeasure {
  const tree = parseReply(s.openui);
  const inlineTree = hydrate(tree, data);
  const text = {
    openuiRef: s.openui,
    jsonRef: JSON.stringify(toJsonUi(tree)),
    openuiInline: jsonToOpenUI(inlineTree, inlineLibrary),
    jsonInline: JSON.stringify(toJsonUi(inlineTree)),
    tupleRef: JSON.stringify(toJsonTuple(tree)),
  };
  const tokens = {
    openuiRef: countTokens(text.openuiRef),
    jsonRef: countTokens(text.jsonRef),
    openuiInline: countTokens(text.openuiInline),
    jsonInline: countTokens(text.jsonInline),
    tupleRef: countTokens(text.tupleRef),
  };
  const fc = openuiFirstCard(s.openui, data);
  return {
    id: s.id,
    tokens,
    saving: { ref: 1 - tokens.openuiRef / tokens.jsonRef, inline: 1 - tokens.openuiInline / tokens.jsonInline },
    refVsInline: 1 - tokens.openuiRef / tokens.openuiInline,
    firstCard: { openui: fc.tokensToFirstCard, json: jsonFirstCard(text.jsonRef) },
    parseMs: fc.parseMs,
    chunks: fc.chunks,
    text,
  };
}

/** Fixed per-request overhead: the generated system prompt vs a JSON-schema prompt with the same rules. */
export function promptOverhead(openuiPrompt: string) {
  const jsonPrompt = [
    'You answer questions about the user job search in the Ask panel. Reply only with cards.',
    'Reply with one JSON object {"component": name, "props": {...}} matching this JSON Schema. Root component: Reply.',
    JSON.stringify(askLibrary.toJSONSchema()),
    'Reference roles, contacts and diffs by the ids given in context. Never restate titles, scores or names.',
    'At most one Text line per reply. No em dashes. No tips.',
  ].join('\n');
  return { openui: countTokens(openuiPrompt), json: countTokens(jsonPrompt) };
}

/** Wall-clock estimate (no API key in the spike): first token latency + tokens / output speed. */
export const LATENCY_ASSUMPTIONS = { firstTokenMs: 600, tokensPerSecond: 60 } as const;
export const estimateMs = (tokens: number) => LATENCY_ASSUMPTIONS.firstTokenMs + (1000 * tokens) / LATENCY_ASSUMPTIONS.tokensPerSecond;
