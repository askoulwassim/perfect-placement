import { CRITERION_LABELS, type Criterion, type Decision } from '@perfect-placement/contracts';
import { useAct, useApp, useOp } from '../client/context';
import { PrimaryButton } from '../components/controls';
import { whoOf } from '../components/glyphs';
import { CountTile, HeroRing } from '../components/meters';
import { AutoRow, RoleCard } from '../components/roles';
import { ScreenHeader } from '../components/shell';
import { valueLabel } from '../lib/decisions';
import { ago } from '../lib/format';
import { useMobile } from '../lib/useMobile';
import { go } from '../router';

export function Now() {
  const { now, config } = useApp();
  const act = useAct();
  const sum = useOp('pipeline.summary', {});
  const queue = useOp('decisions.queue', {});
  const top = useOp('roles.list', { status: ['active'], sort: 'fit', limit: 3 });
  const all = useOp('roles.list', { limit: 500 });
  const t = now();
  const mobile = useMobile();

  const roleName = (id: string) => {
    const v = all.data?.items.find((x) => x.role.id === id);
    return v ? `${v.company.name}, ${v.role.title}` : null;
  };
  const objectOf = (d: Decision) => roleName(d.subject_id) ?? (d.subject_type === 'contact' ? 'Contact' : d.subject_id);
  const actionOf = (d: Decision) => {
    const a = d.answer_json as { id?: string; value?: unknown };
    if (d.kind === 'roles.criterion' && a.id) return `${CRITERION_LABELS[a.id as Criterion] ?? a.id} ${String(a.value)}`;
    return valueLabel(d.kind, a.value);
  };
  const leftOf = (d: Decision) =>
    d.undo_until ? Math.max(0, (Date.parse(d.undo_until) - t.getTime()) / (config.policy.undo_hours * 3_600_000)) : 0;

  const n = sum.data?.needs_you ?? 0;
  return (
    <div className="screen screen--now">
      <ScreenHeader
        title="Now"
        primary={
          n > 0 ? (
            <PrimaryButton label={`Review ${n}`} op={null} onClick={() => go({ screen: 'needs-you' })} />
          ) : (
            <PrimaryButton label="Open River" op={null} onClick={() => go({ screen: 'river' })} />
          )
        }
      />
      <section className="now-hero">
        <button type="button" className="now-hero__ring" data-op="nav" aria-label="Needs you" onClick={() => go({ screen: 'needs-you' })}>
          <HeroRing count={n} fill={sum.data?.auto_share_24h ?? 0} size={mobile ? 200 : 240} />
        </button>
        <div className="now-hero__tiles">
          <CountTile icon="closed" value={sum.data?.closed_today ?? 0} color="coral" label="Closed today" />
          <CountTile icon="draft" value={sum.data?.drafts_ready ?? 0} color="emerald" label="Drafts ready" />
          <CountTile icon="reply" value={sum.data?.replies ?? 0} color="sky" label="Replies" />
        </div>
      </section>
      <div className="now-cols">
        <section className="panel">
          <span className="eyebrow">Auto, 24h</span>
          <div className="auto-list">
            {queue.data?.recent_auto.map((d) => (
              <AutoRow
                key={d.id}
                glyph={whoOf(d.policy_outcome)}
                left={leftOf(d)}
                object={objectOf(d)}
                action={actionOf(d)}
                time={ago(d.resolved_at ?? d.ts, t)}
                undoable={d.policy_outcome === 'auto_undo' && d.status === 'applied' && leftOf(d) > 0}
                undone={d.status === 'undone'}
                onUndo={() => void act('decisions.undo', { decision_id: d.id })}
              />
            ))}
          </div>
        </section>
        <section className="panel panel--plain">
          <span className="eyebrow">Top picks</span>
          <div className="pick-list">
            {top.data?.items.map((v) => (
              <RoleCard key={v.role.id} view={v} now={t} bands={config.scoring} onOpen={() => go({ screen: 'role', roleId: v.role.id })} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
