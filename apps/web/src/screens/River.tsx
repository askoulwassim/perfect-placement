import { type ArchiveReason, MANUAL_MOVES, type RoleStatus } from '@perfect-placement/contracts';
import { type DragEvent, useMemo, useState } from 'react';
import { useAct, useApp, useOp } from '../client/context';
import { Btn } from '../components/Btn';
import { STATUS_HEX, STATUS_LABEL } from '../components/controls';
import { ArchivedColumn, type ColumnState, RiverColumn, RiverDot, RiverTile } from '../components/roles';
import { C, display, eyebrow } from '../components/theme';
import { Screen, useLayout } from '../layout';
import type { RoleView } from '../lib/role';
import { activeLabel, scoreInput, scoreRunFor } from '../lib/runs';
import { tile } from '../lib/view';
import { go } from '../router';

/** Prototype columns, Held included (it is never a drop target). */
export const RIVER_COLUMNS: readonly RoleStatus[] = [
  'inbox',
  'active',
  'held',
  'on-deck',
  'draft-ready',
  'applied',
  'interviews',
  'offers',
];

export const canMove = (from: RoleStatus, to: RoleStatus) => MANUAL_MOVES.some(([a, b]) => a === from && b === to);

type FilterKey = 'band' | 'fresh' | 'company' | 'mode';

export function River() {
  const { now, config, showToast, watchRun, activeRun, runs } = useApp();
  const { mobile } = useLayout();
  const act = useAct();
  const list = useOp('roles.list', { limit: 500 });
  const sum = useOp('pipeline.summary', {});
  const [filters, setFilters] = useState<Partial<Record<FilterKey, boolean>>>({});
  const [zoom, setZoom] = useState<'tiles' | 'dots'>('tiles');
  const [drag, setDrag] = useState<RoleView | null>(null);
  const [bounce, setBounce] = useState<string | null>(null);
  const t = now();

  const all = list.data?.items ?? [];
  const live = all.filter((v) => v.role.status !== 'archived');
  // Company filter chip: the company with the most live roles.
  const topCo = useMemo(() => {
    const n = new Map<string, number>();
    for (const v of live) n.set(v.company.name, (n.get(v.company.name) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  }, [live]);
  const match = (v: RoleView) => {
    const tl = tile(v, t, config.scoring);
    return (
      (!filters.band || (tl.fit ?? 0) >= 90) &&
      (!filters.fresh || tl.fresh === 'ok') &&
      (!filters.company || v.company.name === topCo) &&
      (!filters.mode || v.role.workplace === 'remote')
    );
  };

  const colState = (s: RoleStatus): ColumnState =>
    !drag ? 'idle' : drag.role.status === s ? 'source' : canMove(drag.role.status, s) ? 'drop-allowed' : 'idle';

  const onDrop = async (e: DragEvent, to: RoleStatus) => {
    e.preventDefault();
    const v = drag;
    setDrag(null);
    if (!v || v.role.status === to) return;
    if (!canMove(v.role.status, to)) {
      setBounce(v.role.id);
      setTimeout(() => setBounce(null), 460);
      return;
    }
    const o = await act('roles.move', { role_id: v.role.id, to });
    if (o.status === 'ok') showToast(`${v.company.name} → ${STATUS_LABEL[to]}`);
  };

  const held = live.filter((v) => v.role.status === 'held');
  const archivedCount = sum.data?.counts.archived ?? 0;
  const reasons = Object.entries(sum.data?.archived_by_reason ?? {}).filter(([, n]) => n > 0) as Array<[ArchiveReason, number]>;
  // While a scout is queued or running the button shows it ("Scouting") instead of starting another.
  const scouting = activeRun({ skill: 'scout' });
  const primary = {
    label: scouting ? activeLabel(scouting) : 'Scout now',
    op: 'runs.start' as const,
    disabled: !!scouting,
    onClick: async () => {
      const o = await act('runs.start', { skill: 'scout' });
      if (o.status !== 'ok') return;
      watchRun(o.output.run);
    },
  };

  const cols = RIVER_COLUMNS.map((s) => ({ s, roles: live.filter((v) => v.role.status === s) }));

  // Score inbox roles (#31): one click scores every inbox role; the button follows the run.
  const scoring = scoreRunFor(runs);
  const inboxCount = cols[0]?.roles.length ?? 0;
  const scoreAll = (scoring || inboxCount > 0) && (
    <Btn
      op="runs.start"
      className="river-score"
      disabled={!!scoring}
      onClick={async () => {
        const o = await act('runs.start', scoreInput());
        if (o.status === 'ok') watchRun(o.output.run);
      }}
      style={{
        width: '100%',
        height: 30,
        marginBottom: 12,
        borderRadius: 8,
        border: `1px solid ${C['line-2']}`,
        background: 'transparent',
        color: scoring ? C.muted : C.fg,
        fontSize: 12.5,
        fontWeight: 600,
      }}
      hover={{ borderColor: STATUS_HEX.inbox, color: C.fg }}
    >
      {scoring ? activeLabel(scoring) : 'Score all'}
    </Btn>
  );

  if (mobile) {
    const max = Math.max(1, ...cols.map((c) => c.roles.length));
    return (
      <Screen label="River · mobile" eyebrow={`${all.length} roles`} title="River" primary={primary}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {cols.map(({ s, roles }) => (
            <div
              key={s}
              className="river-col"
              data-status={s}
              style={{ display: 'grid', gridTemplateColumns: '96px 1fr 40px', gap: 12, alignItems: 'center', height: 48 }}
            >
              <span style={eyebrow(STATUS_HEX[s], 10)}>{STATUS_LABEL[s]}</span>
              <div style={{ height: 6, borderRadius: 4, background: C.panel }}>
                <div
                  style={{
                    height: '100%',
                    width: `${(roles.length / max) * 100}%`,
                    background: STATUS_HEX[s],
                    borderRadius: 4,
                    opacity: 0.7,
                  }}
                />
              </div>
              <span style={{ ...display(22, 800, 'normal'), textAlign: 'right' }}>{roles.length}</span>
            </div>
          ))}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '96px 1fr 40px',
              gap: 12,
              alignItems: 'center',
              height: 48,
              borderTop: `1px solid ${C.line}`,
            }}
          >
            <span style={eyebrow(C.coral, 10)}>Archived</span>
            <span />
            <span style={{ ...display(22, 800, 'normal'), textAlign: 'right' }}>{archivedCount}</span>
          </div>
        </div>
      </Screen>
    );
  }

  const chips: ReadonlyArray<[FilterKey, string, 'circle' | 'ring' | 'sq']> = [
    ['band', '90+', 'circle'],
    ['fresh', 'Fresh', 'ring'],
    ['company', topCo, 'sq'],
    ['mode', 'Remote', 'sq'],
  ];
  const dragStart = (v: RoleView) => (e: DragEvent) => {
    try {
      e.dataTransfer.setData('text/plain', v.role.id);
      e.dataTransfer.effectAllowed = 'move';
    } catch {
      /* jsdom */
    }
    setDrag(v);
  };

  return (
    <Screen label="River" eyebrow={`${all.length} roles`} title="River" primary={primary}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '28px 0 20px', gap: 16, flexWrap: 'wrap' }}
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {chips.map(([k, label, sh]) => {
            const on = !!filters[k];
            return (
              <Btn
                key={k}
                op="local"
                aria-pressed={on}
                className="filter-chip"
                onClick={() => setFilters({ ...filters, [k]: !on })}
                style={{
                  height: 34,
                  padding: '0 14px',
                  borderRadius: 999,
                  border: `1px solid ${on ? C.gold : C['line-2']}`,
                  background: on ? 'rgba(226,182,90,0.1)' : 'transparent',
                  color: on ? C.gold : C.fg,
                  fontSize: 13,
                  fontWeight: 500,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: sh === 'sq' ? 2 : '50%', background: on ? C.gold : C.dim }} />
                {label}
              </Btn>
            );
          })}
        </div>
        <div style={{ display: 'flex', background: C['bg-2'], border: `1px solid ${C.line}`, borderRadius: 10, padding: 3 }}>
          {(
            [
              ['tiles', 'Tiles'],
              ['dots', 'Dots'],
            ] as const
          ).map(([k, label]) => (
            <Btn
              key={k}
              op="local"
              aria-pressed={zoom === k}
              onClick={() => setZoom(k)}
              style={{
                height: 30,
                padding: '0 14px',
                borderRadius: 7,
                border: 0,
                background: zoom === k ? C['panel-2'] : 'transparent',
                color: zoom === k ? C.fg : C.muted,
                fontSize: 13,
              }}
            >
              {label}
            </Btn>
          ))}
        </div>
      </div>
      <div className="river" style={{ display: 'flex', gap: 10, overflowX: 'auto', padding: '10px 0 16px', alignItems: 'stretch' }}>
        {cols.map(({ s, roles }) => {
          const lastOfCo = new Map(roles.map((v) => [v.company.id, v.role.id]));
          const stackOf = (v: RoleView) =>
            s === 'active' && lastOfCo.get(v.company.id) === v.role.id ? held.filter((h) => h.company.id === v.company.id).length : 0;
          return (
            <RiverColumn
              key={s}
              status={s}
              count={roles.length}
              state={colState(s)}
              dots={zoom === 'dots'}
              width={zoom === 'tiles' ? 218 : 128}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => void onDrop(e, s)}
              action={s === 'inbox' ? scoreAll : undefined}
              dotChildren={roles.map((v) => (
                <RiverDot
                  key={v.role.id}
                  r={tile(v, t, config.scoring)}
                  matched={match(v)}
                  bounce={bounce === v.role.id}
                  onDragStart={dragStart(v)}
                  onDragEnd={() => setDrag(null)}
                  onOpen={() => go({ screen: 'role', roleId: v.role.id })}
                />
              ))}
            >
              {roles.map((v) => (
                <RiverTile
                  key={v.role.id}
                  r={tile(v, t, config.scoring)}
                  matched={match(v)}
                  stackCount={stackOf(v)}
                  bounce={bounce === v.role.id}
                  onDragStart={dragStart(v)}
                  onDragEnd={() => setDrag(null)}
                  onOpen={() => go({ screen: 'role', roleId: v.role.id })}
                />
              ))}
            </RiverColumn>
          );
        })}
        <ArchivedColumn count={archivedCount} reasons={reasons} />
      </div>
    </Screen>
  );
}
