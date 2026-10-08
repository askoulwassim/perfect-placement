import type { Decision } from '@perfect-placement/contracts';
import { useCallback, useEffect, useState } from 'react';
import { useAct, useApp, useOp } from '../client/context';
import { PrimaryButton, STATUS_LABEL } from '../components/controls';
import { DecisionCard, type Evidence } from '../components/decision';
import { HeroRing, ProgressDots } from '../components/meters';
import type { DiffChip } from '../components/profile';
import { ScreenHeader } from '../components/shell';
import { altsOf, objectOf, pickOf, SHORT_Q, valueLabel } from '../lib/decisions';
import { ago, humanize } from '../lib/format';
import { TIER_LABEL } from '../lib/people';
import { COMPONENT_NAME, chipsOf } from '../lib/profile';

type Handled = 'done' | 'skipped' | 'portal';

export function NeedsYou() {
  const queue = useOp('decisions.queue', {});
  const [snapshot, setSnapshot] = useState<Decision[] | null>(null);
  const [handled, setHandled] = useState<Record<string, Handled>>({});
  const [index, setIndex] = useState(0);
  const [changeOpen, setChangeOpen] = useState(false);
  const act = useAct();

  // Freeze the queue on entry so the dots stay stable while items resolve.
  useEffect(() => {
    if (!snapshot && queue.data) setSnapshot(queue.data.pending);
  }, [queue.data, snapshot]);

  const items = snapshot ?? [];
  const stillPending = new Set(queue.data?.pending.map((d) => d.id));
  const open = items.filter((d) => !handled[d.id] && stillPending.has(d.id));
  const current = items[index] && !handled[items[index].id] && stillPending.has(items[index].id) ? items[index] : open[0];
  const curIndex = current ? items.indexOf(current) : -1;

  const advance = useCallback(
    (id: string, how: Handled) => {
      setHandled((h) => ({ ...h, [id]: how }));
      setChangeOpen(false);
      const pos = items.findIndex((x) => x.id === id);
      const rest = open.filter((x) => x.id !== id);
      const after = rest.find((x) => items.indexOf(x) > pos) ?? rest[0];
      setIndex(after ? items.indexOf(after) : 0);
    },
    [items, open],
  );

  const isSubmit = current?.kind === 'apply.submit';
  const portal = useOp('roles.get', current && isSubmit ? { role_id: current.subject_id } : null);

  const accept = useCallback(async () => {
    if (!current) return;
    if (current.kind === 'apply.submit') {
      const url = portal.data?.application?.portal_url ?? portal.data?.role.url;
      if (url) window.open(url, '_blank', 'noopener');
      advance(current.id, 'portal');
      return;
    }
    const o = await act('decisions.resolve', { decision_id: current.id, action: 'accept' });
    if (o.status === 'ok') advance(current.id, 'done');
  }, [current, act, advance, portal.data]);

  const change = useCallback(
    async (value: string | boolean | number) => {
      if (!current) return;
      const o = await act('decisions.resolve', { decision_id: current.id, action: 'change', value });
      if (o.status === 'ok') advance(current.id, 'done');
    },
    [current, act, advance],
  );

  const skip = useCallback(async () => {
    if (!current) return;
    const o = await act('decisions.resolve', { decision_id: current.id, action: 'skip' });
    if (o.status === 'ok') advance(current.id, 'skipped');
  }, [current, act, advance]);

  const move = useCallback(
    (dir: 1 | -1) => {
      if (!open.length || !current) return;
      const pos = open.indexOf(current);
      const next = open[(pos + dir + open.length) % open.length];
      if (next) setIndex(items.indexOf(next));
      setChangeOpen(false);
    },
    [open, current, items],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (e.metaKey || e.ctrlKey || el?.closest('input, textarea, [role="dialog"]')) return;
      const k = e.key.toLowerCase();
      if (k === 'a') void accept();
      else if (k === 'c') setChangeOpen((v) => !v);
      else if (k === 's') void skip();
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [accept, skip, move]);

  const clear = snapshot !== null && !current;
  return (
    <div className="screen screen--needs">
      <ScreenHeader
        title="Needs you"
        primary={
          isSubmit ? (
            <PrimaryButton label="Open portal" op={null} onClick={() => void accept()} />
          ) : (
            <PrimaryButton label="Accept" op="decisions.resolve" disabled={!current} onClick={() => void accept()} />
          )
        }
      >
        {items.length > 0 && (
          <ProgressDots count={items.length} index={curIndex} resolved={items.map((d) => !!handled[d.id] || !stillPending.has(d.id))} />
        )}
      </ScreenHeader>
      {clear && (
        <div className="clear-state">
          <HeroRing count={0} fill={1} size={200} />
          <span className="panel-title">Clear</span>
        </div>
      )}
      {current && (
        <CurrentCard
          key={current.id}
          d={current}
          changeOpen={changeOpen}
          onToggleChange={() => setChangeOpen((v) => !v)}
          onChange={change}
          onSkip={skip}
        />
      )}
    </div>
  );
}

function CurrentCard({
  d,
  changeOpen,
  onToggleChange,
  onChange,
  onSkip,
}: {
  d: Decision;
  changeOpen: boolean;
  onToggleChange: () => void;
  onChange: (v: string | boolean | number) => void;
  onSkip: () => void;
}) {
  const { thresholds, now } = useApp();
  const object = objectOf(d);
  const role = useOp('roles.get', d.subject_type === 'role' ? { role_id: d.subject_id } : null);
  const profile = useOp('profile.get', object === 'profile' ? {} : null);
  const outreach = useOp('outreach.get', d.subject_type === 'outreach' ? { outreach_id: d.subject_id } : null);
  const contact = useOp('contacts.get', d.subject_type === 'contact' ? { contact_id: d.subject_id } : null);

  let title = '';
  let sub: string | undefined;
  let evidence: Evidence[] = [];
  let diff: { before: DiffChip[]; after: DiffChip[] } | undefined;

  if (role.data) {
    const r = role.data.role;
    title = r.title;
    sub = role.data.company.name;
    if (d.kind === 'freshness.closed')
      evidence = [
        { label: humanize(r.freshness) },
        { label: 'Checked', detail: ago(r.last_checked_at, now()) || 'never' },
        { label: 'Posted', detail: ago(r.posted_at, now()) },
      ];
    else if (d.kind === 'inbox.classify') evidence = [{ label: STATUS_LABEL[r.status] }, { label: 'Gmail', detail: ago(d.ts, now()) }];
    else if (d.kind === 'apply.submit') {
      const paths = role.data.application?.package_paths_json ?? {};
      evidence = Object.keys(paths).map((k) => ({ label: humanize(k) }));
    } else evidence = [{ label: humanize(r.source) }, { label: STATUS_LABEL[r.status] }];
  }
  if (profile.data) {
    const pd = profile.data.pending_diffs.find((x) => x.id === d.subject_id);
    if (pd) {
      title = COMPONENT_NAME[pd.component_key];
      sub = 'Profile';
      const dj = pd.diff_json as { before?: Record<string, unknown>; after?: Record<string, unknown> };
      diff = { before: chipsOf(dj.before ?? {}), after: chipsOf(dj.after ?? {}) };
      evidence = pd.evidence_json.map((e) => ({ label: e }));
    }
  }
  if (outreach.data) {
    title = outreach.data.contact.name;
    sub = TIER_LABEL[outreach.data.outreach.tier];
    evidence = [
      { label: 'Hook', detail: outreach.data.hook },
      { label: 'Ask', detail: outreach.data.ask },
    ];
  }
  if (contact.data) {
    title = contact.data.contact.name;
    sub = contact.data.contact.headline ?? undefined;
    const link = contact.data.links[0];
    evidence = link ? [{ label: TIER_LABEL[link.tier] }, { label: humanize(contact.data.contact.source) }] : [];
  }

  return (
    <DecisionCard
      object={object}
      objectTitle={title}
      objectSub={sub}
      question={SHORT_Q[d.kind]}
      pick={valueLabel(d.kind, pickOf(d))}
      resolver={d.backend}
      p={d.p}
      impact={d.impact}
      thresholds={thresholds}
      evidence={evidence}
      alts={altsOf(d).map((v) => ({ value: v, label: valueLabel(d.kind, v) }))}
      diff={diff}
      changeOpen={changeOpen}
      onToggleChange={onToggleChange}
      onChange={onChange}
      onSkip={onSkip}
    />
  );
}
