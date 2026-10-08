/*
 * The OpenUI component library for Ask replies (lane J spike).
 *
 * Design choice ("ids, not data"): the model names a role / contact / diff by id and the
 * card hydrates the facts from GenuiData. Titles, scores, tiers and diffs never pass
 * through the model, so it cannot misquote them, and replies stay small.
 *
 * Registered: RoleCard, ScoreRadar, ContactCard (= ContactAvatar + name), ProfileDiff (= DiffBlock),
 * plus three layout pieces: Reply (root), Group, Text.
 */

import { createLibrary, defineComponent, useIsStreaming } from '@openuidev/react-lang';
import type { ProfileDiff as ProfileDiffRow } from '@perfect-placement/contracts';
import { CRITERIA, tokens } from '@perfect-placement/contracts';
import { z } from 'zod';
import { useGenuiData } from './data.js';
import { ContactCard as ContactCardView } from './standins/ContactCard.js';
import { ProfileDiff as ProfileDiffView } from './standins/ProfileDiff.js';
import { RoleCard as RoleCardView } from './standins/RoleCard.js';
import { ScoreRadar as ScoreRadarView } from './standins/ScoreRadar.js';
import { c, eyebrow } from './standins/style.js';

/** Shown while an id is still streaming in, or when it does not resolve once the reply is done. */
function Pending({ kind, id }: { kind: string; id: string }) {
  const streaming = useIsStreaming();
  return (
    <div data-genui={streaming ? 'Pending' : 'Missing'} data-kind={kind} data-id={id} style={{ ...eyebrow, color: c('dim') }}>
      {streaming ? '...' : `No ${kind}`}
    </div>
  );
}

export const Text = defineComponent({
  name: 'Text',
  description: 'One short line of reply text, 3 to 12 words. No em dashes, no tips.',
  props: z.object({ text: z.string() }),
  component: ({ props }) => (
    <p data-genui="Text" style={{ margin: 0, color: c('fg'), fontSize: tokens.type.body.size }}>
      {props.text}
    </p>
  ),
});

export const RoleCard = defineComponent({
  name: 'RoleCard',
  description: 'A role with company, title, status and fit score. Pass the role id exactly as given in context.',
  props: z.object({ roleId: z.string().describe('role id, e.g. linear_product-lead-insights') }),
  component: function RoleCardNode({ props }) {
    const data = useGenuiData();
    const role = data.role(props.roleId);
    if (!role) return <Pending kind="role" id={props.roleId} />;
    const score = data.latestScore(role.id);
    return (
      <RoleCardView
        id={role.id}
        company={data.company(role.company_id)?.name ?? role.company_id}
        title={role.title}
        status={role.status}
        total={score?.total ?? null}
        band={score?.band ?? null}
        workplace={role.workplace}
      />
    );
  },
});

export const ScoreRadar = defineComponent({
  name: 'ScoreRadar',
  description: 'The nine-criterion fit radar for a role. Use when the user asks why a role fits.',
  props: z.object({ roleId: z.string().describe('role id') }),
  component: function ScoreRadarNode({ props }) {
    const score = useGenuiData().latestScore(props.roleId);
    if (!score) return <Pending kind="score" id={props.roleId} />;
    return <ScoreRadarView criteria={CRITERIA.map((k) => score[k])} />;
  },
});

export const ContactCard = defineComponent({
  name: 'ContactCard',
  description: 'A person who can open a door, with their tier ring. Pass roleId to show the tier for that role.',
  props: z.object({ contactId: z.string().describe('contact id, e.g. ct_0001'), roleId: z.string().optional() }),
  component: function ContactCardNode({ props }) {
    const data = useGenuiData();
    const contact = data.contact(props.contactId);
    if (!contact) return <Pending kind="contact" id={props.contactId} />;
    return (
      <ContactCardView id={contact.id} name={contact.name} headline={contact.headline} tier={data.tier(contact.id, props.roleId) ?? null} />
    );
  },
});

export const diffLines = (side: Record<string, unknown>): string[] =>
  Object.entries(side).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' > ') : String(v)}`);

export const diffSides = (d: ProfileDiffRow) => {
  const json = d.diff_json as { before?: Record<string, unknown>; after?: Record<string, unknown> };
  return { before: diffLines(json.before ?? {}), after: diffLines(json.after ?? {}) };
};

export const ProfileDiff = defineComponent({
  name: 'ProfileDiff',
  description: 'A pending profile change, before vs after. Pass the diff id.',
  props: z.object({ diffId: z.string().describe('profile diff id, e.g. pd_0001') }),
  component: function ProfileDiffNode({ props }) {
    const d = useGenuiData().diff(props.diffId);
    if (!d) return <Pending kind="diff" id={props.diffId} />;
    return <ProfileDiffView id={d.id} component={d.component_key} impact={d.impact} {...diffSides(d)} />;
  },
});

const Item = z.union([Text.ref, RoleCard.ref, ScoreRadar.ref, ContactCard.ref, ProfileDiff.ref]);

export const Group = defineComponent({
  name: 'Group',
  description: 'A labelled row of cards, e.g. one role with its radar and people. Label is 1 to 3 words.',
  props: z.object({ label: z.string(), items: z.array(Item) }),
  component: ({ props, renderNode }) => (
    <section data-genui="Group" style={{ display: 'grid', gap: tokens.space[4] }}>
      <div style={eyebrow}>{props.label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space[4], alignItems: 'flex-start' }}>{renderNode(props.items)}</div>
    </section>
  ),
});

export const Reply = defineComponent({
  name: 'Reply',
  description: 'Root of every Ask reply: a vertical stack.',
  props: z.object({ items: z.array(z.union([Group.ref, Item])) }),
  component: ({ props, renderNode }) => (
    <div data-genui="Reply" style={{ display: 'grid', gap: tokens.space[6] }}>
      {renderNode(props.items)}
    </div>
  ),
});

export const askLibrary = createLibrary({
  components: [Reply, Group, Text, RoleCard, ScoreRadar, ContactCard, ProfileDiff],
  root: 'Reply',
});

/** Card types that count as "a card is on screen" for latency measurement. */
export const CARD_TYPES = ['RoleCard', 'ScoreRadar', 'ContactCard', 'ProfileDiff'] as const;

export function askSystemPrompt(): string {
  return askLibrary.prompt({
    preamble: 'You answer questions about the user job search in the Ask panel. Reply only with cards.',
    additionalRules: [
      'Reference roles, contacts and diffs by the ids given in context. Never restate titles, scores or names.',
      'At most one Text line per reply. No em dashes. No tips.',
    ],
    examples: ['root = Reply([t, r])\nt = Text("Linear is your best fit")\nr = RoleCard("linear_product-lead-insights")'],
  });
}
