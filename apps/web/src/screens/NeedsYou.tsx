import type { Decision } from '@perfect-placement/contracts';
import { useCallback, useEffect, useState } from 'react';
import { useAct, useApp, useOp } from '../client/context';
import { DecisionCard } from '../components/decision';
import { ProgressDots } from '../components/meters';
import { TIER_VIS } from '../components/people';
import { C, display, X } from '../components/theme';
import { Screen, useLayout } from '../layout';
import { decisionView } from '../lib/view';
import { go } from '../router';

type Handled = 'done' | 'portal';

export function NeedsYou() {
  const { mobile } = useLayout();
  const { showToast } = useApp();
  const queue = useOp('decisions.queue', {});
  const [items, setItems] = useState<Decision[] | null>(null);
  const [handled, setHandled] = useState<Record<string, Handled>>({});
  const [index, setIndex] = useState(0);
  const [changeOpen, setChangeOpen] = useState(false);
  const act = useAct();

  // Freeze the queue on entry so the dots stay put while items resolve.
  useEffect(() => {
    if (!items && queue.data) setItems(queue.data.pending);
  }, [queue.data, items]);

  const list = items ?? [];
  const pendingIds = new Set(queue.data?.pending.map((d) => d.id));
  const isDone = (d: Decision) => !!handled[d.id] || !pendingIds.has(d.id);
  const resolved = list.map(isDone);
  const cleared = items !== null && resolved.every(Boolean);
  const cur = list[index] && !isDone(list[index] as Decision) ? (list[index] as Decision) : list.find((d) => !isDone(d));
  const curIndex = cur ? list.indexOf(cur) : -1;

  const nextOpen = useCallback(
    (fromId: string) => {
      const pos = list.findIndex((x) => x.id === fromId);
      for (let k = 1; k <= list.length; k++) {
        const j = (pos + k) % list.length;
        const d = list[j];
        if (d && d.id !== fromId && !handled[d.id] && pendingIds.has(d.id)) return j;
      }
      return pos;
    },
    [list, handled, pendingIds],
  );

  const finish = useCallback(
    (d: Decision, how: Handled) => {
      setHandled((h) => ({ ...h, [d.id]: how }));
      setChangeOpen(false);
      setIndex(nextOpen(d.id));
    },
    [nextOpen],
  );

  const isSubmit = cur?.kind === 'apply.submit';
  const submitRole = useOp('roles.get', cur && isSubmit ? { role_id: cur.subject_id } : null);

  const accept = useCallback(async () => {
    if (!cur) return;
    if (cur.kind === 'apply.submit') {
      const url = submitRole.data?.application?.portal_url ?? submitRole.data?.role.url;
      if (url) window.open(url, '_blank', 'noopener');
      showToast('Portal opened · you submit');
      finish(cur, 'portal');
      return;
    }
    const o = await act('decisions.resolve', { decision_id: cur.id, action: 'accept' });
    if (o.status === 'ok') finish(cur, 'done');
  }, [cur, act, finish, submitRole.data, showToast]);

  const change = useCallback(
    async (value: string | boolean | number) => {
      if (!cur) return;
      const o = await act('decisions.resolve', { decision_id: cur.id, action: 'change', value });
      if (o.status === 'ok') finish(cur, 'done');
    },
    [cur, act, finish],
  );

  // #99: the user's own check of a candidate address. Valid confirms it (the decision resolves); Invalid
  // drops it and the card stays while other candidates remain.
  const emailCheck = useCallback(
    async (address: string, result: 'valid' | 'invalid') => {
      if (!cur) return;
      const o = await act('people.email_checked', { contact_id: cur.subject_id, address, result });
      if (o.status === 'ok' && !o.output.open) finish(cur, 'done');
    },
    [cur, act, finish],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!list.length) return;
      setIndex((i) => (i + dir + list.length) % list.length);
      setChangeOpen(false);
    },
    [list.length],
  );

  const skip = useCallback(async () => {
    if (!cur) return;
    await act('decisions.resolve', { decision_id: cur.id, action: 'skip' });
    step(1);
  }, [cur, act, step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (e.metaKey || e.ctrlKey || el?.closest('input, textarea, [role="dialog"]') || cleared) return;
      const k = e.key.toLowerCase();
      if (k === 'a') void accept();
      else if (k === 'c') setChangeOpen((v) => !v);
      else if (k === 's') void skip();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [accept, skip, step, cleared]);

  const doneCount = resolved.filter(Boolean).length;
  const primary = cleared
    ? { label: 'Back to Now', op: null, onClick: () => go({ screen: 'now' }) }
    : isSubmit
      ? { label: 'Open portal', op: null, onClick: () => void accept() }
      : { label: 'Accept', op: 'decisions.resolve' as const, onClick: () => void accept(), disabled: !cur };

  return (
    <Screen
      label={mobile ? 'Needs you · mobile' : 'Needs you'}
      eyebrow={`${doneCount} / ${list.length}`}
      title="Needs you"
      primary={primary}
    >
      {!cleared && list.length > 0 && (
        <div style={{ margin: mobile ? '0 0 18px' : '24px 0 28px' }}>
          <ProgressDots count={list.length} index={curIndex} resolved={resolved} gap={mobile ? 8 : 10} onPick={(i) => setIndex(i)} />
        </div>
      )}
      {cur && !cleared && (
        <CurrentCard
          key={cur.id}
          d={queue.data?.pending.find((x) => x.id === cur.id) ?? cur}
          mobile={mobile}
          changeOpen={changeOpen}
          onToggleChange={() => setChangeOpen((v) => !v)}
          onPick={change}
          onSkip={skip}
          onEmailCheck={emailCheck}
        />
      )}
      {cleared && (
        <div
          className="clear-state"
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: mobile ? 22 : 28, marginTop: mobile ? 70 : 90 }}
        >
          <div
            style={{
              width: mobile ? 160 : 200,
              height: mobile ? 160 : 200,
              borderRadius: '50%',
              border: `${mobile ? 10 : 12}px solid ${C.emerald}`,
              boxShadow: mobile ? undefined : `0 0 0 10px ${X.em08}`,
            }}
          />
          <div style={display(mobile ? 48 : 64)}>Clear</div>
        </div>
      )}
    </Screen>
  );
}

function CurrentCard({
  d,
  mobile,
  changeOpen,
  onToggleChange,
  onPick,
  onSkip,
  onEmailCheck,
}: {
  d: Decision;
  mobile: boolean;
  changeOpen: boolean;
  onToggleChange: () => void;
  onPick: (v: string | boolean | number) => void;
  onSkip: () => void;
  onEmailCheck: (address: string, result: 'valid' | 'invalid') => void;
}) {
  const { thresholds, now } = useApp();
  const role = useOp('roles.get', d.subject_type === 'role' ? { role_id: d.subject_id } : null);
  const profile = useOp('profile.get', d.subject_type === 'profile_diff' ? {} : null);
  const outreach = useOp('outreach.get', d.subject_type === 'outreach' ? { outreach_id: d.subject_id } : null);
  const contact = useOp('contacts.get', d.subject_type === 'contact' ? { contact_id: d.subject_id } : null);
  const v = decisionView(d, {
    now: now(),
    role: role.data,
    diff: profile.data?.pending_diffs.find((x) => x.id === d.subject_id),
    outreach: outreach.data && {
      name: outreach.data.contact.name,
      headline: outreach.data.contact.headline,
      tierLabel: TIER_VIS[outreach.data.outreach.tier].label,
      hook: outreach.data.hook,
      ask: outreach.data.ask,
    },
    contact: contact.data && {
      name: contact.data.contact.name,
      headline: contact.data.contact.headline,
      source: contact.data.contact.source,
      tierLabel: contact.data.links[0] ? TIER_VIS[contact.data.links[0].tier].label : undefined,
    },
  });
  return (
    <DecisionCard
      v={v}
      mobile={mobile}
      thresholds={thresholds}
      changeOpen={changeOpen}
      onToggleChange={onToggleChange}
      onPick={onPick}
      onSkip={() => void onSkip()}
      onEmailCheck={onEmailCheck}
    />
  );
}
