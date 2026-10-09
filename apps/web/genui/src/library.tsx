/*
 * The OpenUI library for Ask replies (lane J, folded into apps/web in Wave 2).
 *
 * Ids, not data: a reply names a role / contact / diff by id and the card fetches the facts
 * through ops (roles.get, contacts.get, profile.get) with the app's client. Titles, scores, tiers
 * and diffs never pass through the model, so it cannot misquote them, and a wrong id renders
 * "No role", never an invented card. Props are the contract's GENUI_PROPS (key order = arg order).
 *
 * Cards are lane D's components (RoleCard, ScoreRadar, ContactAvatar, DiffBlock). `OpButton` is the
 * only control (OpenUI reserves the name Action): a button limited to Ask-safe PRIMARY_ACTIONS ops, never submit or send; whatever
 * the engine routes to a human comes back as `requires_human` and lands in Needs you.
 */

import { createLibrary, defineComponent, useIsStreaming } from '@openuidev/react-lang';
import {
  FORBIDDEN_BUTTON_LABELS,
  GENUI_PROPS,
  isHardHuman,
  OPS,
  type OpInput,
  type OpName,
  PRIMARY_ACTIONS,
  SKILLS,
} from '@perfect-placement/contracts';
import { type CSSProperties, useEffect, useState } from 'react';
import { z } from 'zod';
import { useAct, useApp, useOp } from '../../src/client/context';
import { PrimaryButton } from '../../src/components/controls';
import { ScoreRadar as RadarView } from '../../src/components/meters';
import { ContactAvatar, TIER_VIS } from '../../src/components/people';
import { DiffBlock } from '../../src/components/profile';
import { RoleCard as RoleCardView } from '../../src/components/roles';
import { C, eyebrow, mono } from '../../src/components/theme';
import { initials } from '../../src/lib/people';
import { COMPONENT_NAME, chipText } from '../../src/lib/profile';
import { criteriaOf } from '../../src/lib/role';
import { tile } from '../../src/lib/view';
import { go } from '../../src/router';

/** Ids stream in a few characters at a time; fetch once the id stops changing. */
function useSettled(id: string, ms = 120): string {
  const [v, setV] = useState(id);
  useEffect(() => {
    const t = setTimeout(() => setV(id), ms);
    return () => clearTimeout(t);
  }, [id, ms]);
  return v;
}

/** Shown while an id is still streaming in or loading; "No <kind>" when it does not resolve. */
function Pending({ kind, id, loading }: { kind: string; id: string; loading: boolean }) {
  const streaming = useIsStreaming();
  const wait = streaming || loading;
  return (
    <div data-genui={wait ? 'Pending' : 'Missing'} data-kind={kind} data-id={id} style={{ ...mono(12, C.dim), padding: '6px 0' }}>
      {wait ? '...' : `No ${kind}`}
    </div>
  );
}

export const Text = defineComponent({
  name: 'Text',
  description: 'One short line of reply text, 3 to 12 words. No em dashes, no tips.',
  props: z.object({ text: z.string() }),
  component: ({ props }) => (
    <p data-genui="Text" style={{ margin: 0, fontSize: 15, color: C.fg }}>
      {props.text}
    </p>
  ),
});

export const RoleCard = defineComponent({
  name: 'RoleCard',
  description: 'A role with company, title, freshness and fit. Pass the role id exactly as given in context.',
  props: GENUI_PROPS.RoleCard.extend({ roleId: z.string().describe('role id, e.g. linear_product-lead-insights') }),
  component: function RoleCardNode({ props }) {
    const { now, config } = useApp();
    const id = useSettled(props.roleId);
    const res = useOp('roles.get', id ? { role_id: id } : null);
    if (!res.data || res.data.role.id !== props.roleId)
      return <Pending kind="role" id={props.roleId} loading={res.loading || id !== props.roleId} />;
    const t = tile(res.data, now(), config.scoring);
    return (
      <div data-genui="RoleCard" data-role-id={t.id} data-fresh={t.fresh} style={{ flex: '1 1 320px', minWidth: 0 }}>
        <RoleCardView r={t} onOpen={() => go({ screen: 'role', roleId: t.id })} />
      </div>
    );
  },
});

export const ScoreRadar = defineComponent({
  name: 'ScoreRadar',
  description: 'The nine-criterion fit radar for a role. Use when the user asks why a role fits.',
  props: GENUI_PROPS.ScoreRadar.extend({ roleId: z.string().describe('role id') }),
  component: function ScoreRadarNode({ props }) {
    const id = useSettled(props.roleId);
    const res = useOp('roles.get', id ? { role_id: id } : null);
    const score = res.data?.role.id === props.roleId ? res.data.latest_score : null;
    if (!score) return <Pending kind="score" id={props.roleId} loading={res.loading || id !== props.roleId} />;
    return (
      <div data-genui="ScoreRadar" data-role-id={props.roleId} style={{ width: 200, height: 200, flex: 'none' }}>
        <RadarView criteria={criteriaOf(score)} size={220} />
      </div>
    );
  },
});

export const ContactCard = defineComponent({
  name: 'ContactCard',
  description: 'A person who can open a door, with their tier ring. Pass roleId to show the tier for that role.',
  props: GENUI_PROPS.ContactCard.extend({ contactId: z.string().describe('contact id, e.g. ct_0001'), roleId: z.string().optional() }),
  component: function ContactCardNode({ props }) {
    const id = useSettled(props.contactId);
    const res = useOp('contacts.get', id ? { contact_id: id } : null);
    const data = res.data?.contact.id === props.contactId ? res.data : null;
    const link = data && (data.links.find((l) => l.role_id === props.roleId) ?? (props.roleId ? undefined : data.links[0]));
    if (!data || !link) return <Pending kind="contact" id={props.contactId} loading={res.loading || id !== props.contactId} />;
    return (
      <div
        data-genui="ContactCard"
        data-contact={data.contact.id}
        data-tier={link.tier}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px 10px 10px', background: C['bg-2'], borderRadius: 999 }}
      >
        <ContactAvatar initials={initials(data.contact.name)} tier={link.tier} size={34} />
        <span>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{data.contact.name}</span>
          <span style={{ display: 'block', ...mono(10, C.muted) }}>{TIER_VIS[link.tier].label}</span>
        </span>
      </div>
    );
  },
});

export const ProfileDiff = defineComponent({
  name: 'ProfileDiff',
  description: 'A pending profile change, before vs after. Pass the diff id.',
  props: GENUI_PROPS.ProfileDiff.extend({ diffId: z.string().describe('profile diff id, e.g. pd_0001') }),
  component: function ProfileDiffNode({ props }) {
    const id = useSettled(props.diffId);
    const res = useOp('profile.get', id ? {} : null);
    const d = res.data?.pending_diffs.find((x) => x.id === props.diffId);
    if (!d) return <Pending kind="diff" id={props.diffId} loading={res.loading || id !== props.diffId} />;
    const j = d.diff_json as { before?: Record<string, unknown>; after?: Record<string, unknown> };
    return (
      <div data-genui="ProfileDiff" data-diff={d.id} style={{ flex: '1 1 320px', minWidth: 0 }}>
        <div style={{ ...eyebrow(), marginBottom: 8 }}>{COMPONENT_NAME[d.component_key]}</div>
        <DiffBlock compact before={chipText(j.before ?? {})} after={chipText(j.after ?? {})} />
      </div>
    );
  },
});

// ------------------------------------------------------------------ actions

const PRIMARY_OPS = new Set<string>(
  Object.values(PRIMARY_ACTIONS)
    .flat()
    .map((a) => a.op)
    .filter((op): op is OpName => op !== null),
);
/**
 * Ops an Ask reply may offer: PRIMARY_ACTIONS ops that act on what a reply shows. Never submit or send.
 * Gmail drafts are made by an agent run from the Outreach screen (the engine has no Gmail client).
 */
const CANDIDATES = ['runs.start', 'roles.check_freshness', 'profile.apply_diff'] as const;
export const ASK_ACTION_OPS = CANDIDATES.filter((op) => PRIMARY_OPS.has(op) && !isHardHuman({ op }) && !OPS[op].humanOnly);
type AskOp = (typeof CANDIDATES)[number];

/** Map the id-only OpButton args onto the op's input. */
export function actionInput(op: AskOp, ids: readonly string[], skill?: (typeof SKILLS)[number]): OpInput<AskOp> | null {
  switch (op) {
    case 'runs.start':
      return skill ? { skill, ...(ids[0] ? { role_id: ids[0] } : {}), ...(ids[1] ? { contact_id: ids[1] } : {}) } : null;
    case 'roles.check_freshness':
      return ids.length ? { role_ids: [...ids] } : { all_in_scope: true };
    case 'profile.apply_diff':
      return ids[0] ? { diff_id: ids[0] } : null;
  }
}

const forbidden = (label: string) => FORBIDDEN_BUTTON_LABELS.some((bad) => label.trim().toLowerCase().startsWith(bad.toLowerCase()));

export const OpButton = defineComponent({
  name: 'OpButton',
  description: `One button that runs one op on what the reply shows. Label 1 to 3 words. op is one of ${ASK_ACTION_OPS.join(', ')}. ids: role ids for roles.check_freshness; [roleId, contactId?] for runs.start (with skill); [diffId] for profile.apply_diff. Never submit or send.`,
  props: z.object({
    label: z.string(),
    op: z.enum(CANDIDATES),
    ids: z.array(z.string()).optional(),
    skill: z.enum(SKILLS).optional(),
  }),
  component: function ActionNode({ props }) {
    const streaming = useIsStreaming();
    const act = useAct();
    const [done, setDone] = useState<string | null>(null);
    const allowed = (ASK_ACTION_OPS as readonly string[]).includes(props.op) && !forbidden(props.label);
    const input = allowed ? actionInput(props.op, props.ids ?? [], props.skill) : null;
    if (!input || streaming) return null;
    const row: CSSProperties = { display: 'flex', justifyContent: 'flex-end', marginTop: 4 };
    if (done)
      return (
        <div data-genui="OpButton" data-done={done} style={row}>
          <span style={{ ...mono(12, C.emerald), padding: '10px 0' }}>{done}</span>
        </div>
      );
    const run = async () => {
      const o = await act(props.op, input as never);
      if (o.status === 'requires_human') return setDone('Queued for you');
      if (o.status !== 'ok') return;
      const out = o.output as { results?: Array<{ freshness: string }> };
      setDone(
        props.op === 'roles.check_freshness' && out.results
          ? `${out.results.length} checked · ${out.results.filter((r) => r.freshness === 'closed').length} closed`
          : 'Done',
      );
    };
    return (
      <div data-genui="OpButton" style={row}>
        <PrimaryButton label={props.label} op={props.op} onClick={() => void run()} />
      </div>
    );
  },
});

// ------------------------------------------------------------------ layout

const Item = z.union([Text.ref, RoleCard.ref, ScoreRadar.ref, ContactCard.ref, ProfileDiff.ref, OpButton.ref]);

export const Group = defineComponent({
  name: 'Group',
  description: 'A labelled row of cards, e.g. one role with its radar and people. Label is 1 to 3 words.',
  props: z.object({ label: z.string(), items: z.array(Item) }),
  component: ({ props, renderNode }) => (
    <section data-genui="Group" style={{ display: 'grid', gap: 10 }}>
      <div style={eyebrow()}>{props.label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>{renderNode(props.items)}</div>
    </section>
  ),
});

export const Reply = defineComponent({
  name: 'Reply',
  description: 'Root of every Ask reply: a vertical stack.',
  props: z.object({ items: z.array(z.union([Group.ref, Item])) }),
  component: ({ props, renderNode }) => (
    <div data-genui="Reply" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {renderNode(props.items)}
    </div>
  ),
});

export const askLibrary = createLibrary({
  components: [Reply, Group, Text, RoleCard, ScoreRadar, ContactCard, ProfileDiff, OpButton],
  root: 'Reply',
});

/** Card types (not layout or controls). */
export const CARD_TYPES = ['RoleCard', 'ScoreRadar', 'ContactCard', 'ProfileDiff'] as const;

/** System prompt for an agent that writes Ask replies (MCP / agent session). */
export function askSystemPrompt(): string {
  return askLibrary.prompt({
    preamble: 'You answer questions about the user job search in the Ask panel. Reply only with cards.',
    additionalRules: [
      'Reference roles, contacts and diffs by the ids given in context. Never restate titles, scores or names.',
      'At most one Text line and at most one OpButton per reply. No em dashes. No tips.',
      'Never offer to submit an application or send an email.',
    ],
    examples: ['root = Reply([t, r])\nt = Text("Linear is your best fit")\nr = RoleCard("linear_product-lead-insights")'],
  });
}
