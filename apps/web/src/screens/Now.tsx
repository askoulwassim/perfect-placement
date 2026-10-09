import { CRITERION_LABELS, type Criterion, type Decision } from '@perfect-placement/contracts';
import { useAct, useApp, useOp } from '../client/context';
import { GuideCard } from '../components/Guide';
import { whoOf } from '../components/glyphs';
import { CountTile, HeroRing } from '../components/meters';
import { AutoRow, RoleCard } from '../components/roles';
import { C, eyebrow, mono } from '../components/theme';
import { Screen, useLayout } from '../layout';
import { valueLabel } from '../lib/decisions';
import { humanize } from '../lib/format';
import { dayEyebrow, hhmm, tile } from '../lib/view';
import { go } from '../router';

export function Now() {
  const { now, config, showToast } = useApp();
  const { mobile } = useLayout();
  const act = useAct();
  const sum = useOp('pipeline.summary', {});
  const queue = useOp('decisions.queue', {});
  const top = useOp('roles.list', { status: ['active', 'on-deck', 'draft-ready'], sort: 'fit', limit: 3 });
  const all = useOp('roles.list', { limit: 500 });
  const t = now();

  const roleName = (id: string) => {
    const v = all.data?.items.find((x) => x.role.id === id);
    return v ? `${v.company.name} · ${v.role.title}` : null;
  };
  const objectOf = (d: Decision) => roleName(d.subject_id) ?? humanize(d.subject_type);
  const what = (d: Decision) => {
    const a = d.answer_json as { id?: string; value?: unknown };
    if (d.kind === 'roles.criterion' && a.id) return `${CRITERION_LABELS[a.id as Criterion] ?? a.id} → ${String(a.value)}`;
    if (d.kind === 'freshness.closed') return a.value === false ? 'closed → archived' : 'freshness ok';
    return valueLabel(d.kind, a.value).toLowerCase();
  };
  const leftOf = (d: Decision) =>
    d.undo_until ? Math.max(0, (Date.parse(d.undo_until) - t.getTime()) / (config.policy.undo_hours * 3_600_000)) : 0;

  const need = sum.data?.needs_you ?? 0;
  const rows = queue.data?.recent_auto ?? [];
  const picks = (top.data?.items ?? []).map((v) => tile(v, t, config.scoring));
  const auto = (d: Decision, m?: boolean) => (
    <AutoRow
      key={d.id}
      mobile={m}
      glyph={whoOf(d.policy_outcome)}
      left={leftOf(d)}
      object={objectOf(d)}
      action={what(d)}
      time={hhmm(d.resolved_at ?? d.ts)}
      undoable={d.policy_outcome === 'auto_undo' && d.status === 'applied' && leftOf(d) > 0}
      undone={d.status === 'undone'}
      onUndo={async () => {
        const o = await act('decisions.undo', { decision_id: d.id });
        if (o.status === 'ok') showToast('Undone');
      }}
    />
  );
  const goQueue = () => go({ screen: 'needs-you' });
  const primary =
    need > 0
      ? { label: `Review ${need}`, op: null, onClick: goQueue }
      : { label: 'Open River', op: null, onClick: () => go({ screen: 'river' }) };
  const s = sum.data;

  if (mobile)
    return (
      <Screen label="Now · mobile" eyebrow={dayEyebrow(t)} title="Now" primary={primary}>
        <GuideCard mobile />
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <HeroRing mobile count={need} fill={s?.auto_share_24h ?? 0} onClick={goQueue} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <CountTile compact kind="closed" value={s?.closed_today ?? 0} label="Closed today" />
            <CountTile compact kind="drafts" value={s?.drafts_ready ?? 0} label="Drafts ready" />
            <CountTile compact kind="replies" value={s?.replies ?? 0} label="Replies" />
          </div>
        </div>
        <div style={{ ...eyebrow(C.muted, 10), margin: '28px 0 10px' }}>Top picks</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {picks.map((r) => (
            <RoleCard key={r.id} mobile r={r} onOpen={() => go({ screen: 'role', roleId: r.id })} />
          ))}
        </div>
        <div style={{ ...eyebrow(C.muted, 10), margin: '28px 0 6px' }}>Auto · 24h</div>
        {rows.slice(0, 4).map((d) => auto(d, true))}
      </Screen>
    );

  return (
    <Screen label="Now" eyebrow={dayEyebrow(t)} title="Now" primary={primary}>
      <GuideCard />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 40, alignItems: 'center', marginTop: 40 }}>
        <HeroRing count={need} fill={s?.auto_share_24h ?? 0} onClick={goQueue} />
        <div style={{ flex: 1, minWidth: 420, display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 16 }}>
          <CountTile kind="closed" value={s?.closed_today ?? 0} label="Closed today" />
          <CountTile kind="drafts" value={s?.drafts_ready ?? 0} label="Drafts ready" />
          <CountTile kind="replies" value={s?.replies ?? 0} label="Replies" />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.15fr) minmax(0,1fr)', gap: 48, marginTop: 56 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10, padding: '0 14px' }}>
            <div style={eyebrow()}>Auto · 24h</div>
            <div style={mono(11, C.dim)}>{rows.length}</div>
          </div>
          {rows.map((d) => auto(d))}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ ...eyebrow(), marginBottom: 12 }}>Top picks</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {picks.map((r) => (
              <RoleCard key={r.id} r={r} onOpen={() => go({ screen: 'role', roleId: r.id })} />
            ))}
          </div>
        </div>
      </div>
    </Screen>
  );
}
