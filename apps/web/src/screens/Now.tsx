import { type AutoGroup, CRITERION_LABELS, type Criterion, type Decision } from '@perfect-placement/contracts';
import { Fragment, useState } from 'react';
import { useAct, useApp, useOp } from '../client/context';
import { GuideCard } from '../components/Guide';
import { whoOf } from '../components/glyphs';
import { CountTile, HeroRing } from '../components/meters';
import { AutoRow, RoleCard } from '../components/roles';
import { C, eyebrow, mono } from '../components/theme';
import { Screen, useLayout } from '../layout';
import { valueLabel } from '../lib/decisions';
import { humanize } from '../lib/format';
import { SOURCE_LABEL } from '../lib/role';
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
  const groups = queue.data?.auto_groups ?? [];
  const byId = new Map(rows.map((d) => [d.id, d]));
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const picks = (top.data?.items ?? []).map((v) => tile(v, t, config.scoring));
  const auto = (d: Decision, m?: boolean, nested?: boolean) => (
    <AutoRow
      key={d.id}
      mobile={m}
      nested={nested}
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
  // #103: one row per role per score run (per run for batch kinds); expand shows the members.
  const BATCH_OBJECT: Partial<Record<string, string>> = { 'people.classify': 'Contacts', 'freshness.closed': 'Postings' };
  const groupObject = (g: AutoGroup) =>
    g.subject_id ? (roleName(g.subject_id) ?? humanize(g.subject_type)) : (BATCH_OBJECT[g.kind] ?? humanize(g.kind));
  const groupWhat = (g: AutoGroup, members: Decision[]) => {
    const by = g.backend === 'mixed' ? 'mixed' : (SOURCE_LABEL[g.backend] ?? g.backend);
    if (g.kind === 'roles.criterion') {
      const n = new Set(members.map((d) => (d.answer_json as { id?: string }).id ?? d.id)).size || g.count;
      return `Scored${g.total === null ? '' : ` ${Math.round(g.total)}`} · ${by} · ${n} criteria`;
    }
    if (g.kind === 'freshness.closed') {
      const closed = members.filter((d) => (d.answer_json as { value?: unknown }).value === false).length;
      return `Checked ${g.count} · ${closed} closed · ${by}`;
    }
    if (g.kind === 'people.classify') return `Classified ${g.count} · ${by}`;
    return `${g.count} decisions · ${by}`;
  };
  const group = (g: AutoGroup, m?: boolean) => {
    const members = g.decision_ids.map((id) => byId.get(id)).filter((d): d is Decision => !!d);
    if (members.length <= 1) return members[0] ? auto(members[0], m) : null;
    const expanded = open.has(g.id);
    const undoable = members.filter((d) => g.undoable_ids.includes(d.id));
    const glyphOf = undoable[0] ?? members[0];
    return (
      <Fragment key={g.id}>
        <AutoRow
          mobile={m}
          glyph={whoOf(glyphOf?.policy_outcome ?? 'auto')}
          left={Math.max(0, ...undoable.map(leftOf))}
          object={groupObject(g)}
          action={groupWhat(g, members)}
          time={hhmm(g.ts)}
          count={g.count}
          expanded={expanded}
          onToggle={() =>
            setOpen((prev) => {
              const next = new Set(prev);
              if (next.has(g.id)) next.delete(g.id);
              else next.add(g.id);
              return next;
            })
          }
          undoOp="decisions.undo_group"
          undoable={g.undoable_ids.length > 0}
          undone={g.undone_count === g.count}
          onUndo={async () => {
            const o = await act('decisions.undo_group', { decision_ids: g.undoable_ids });
            if (o.status === 'ok') showToast(`Undone ${o.output.undone.length}`);
          }}
        />
        {expanded && members.map((d) => auto(d, m, true))}
      </Fragment>
    );
  };
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
        {groups.slice(0, 4).map((g) => group(g, true))}
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
            <div style={mono(11, C.dim)}>{groups.length}</div>
          </div>
          {groups.map((g) => group(g))}
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
