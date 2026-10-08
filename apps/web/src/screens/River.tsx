import { type ArchiveReason, type Band, MANUAL_MOVES, type RoleStatus, type Workplace } from '@perfect-placement/contracts';
import { type DragEvent, useMemo, useState } from 'react';
import { useAct, useApp, useOp } from '../client/context';
import { Chip, PrimaryButton, ReasonChip } from '../components/controls';
import type { Fresh } from '../components/glyphs';
import { type ColumnState, RiverColumn, RiverTile, type RiverTileState } from '../components/roles';
import { ScreenHeader } from '../components/shell';
import { freshOf, type RoleView } from '../lib/role';
import { go } from '../router';

/** Held is drawn as a stack on the company's visible tile, never as a drop target (handoff §4). */
export const RIVER_COLUMNS: readonly RoleStatus[] = ['inbox', 'active', 'on-deck', 'draft-ready', 'applied', 'interviews', 'offers'];

const BANDS: ReadonlyArray<[Band, string]> = [
  ['green', 'Green'],
  ['yellow', 'Gold'],
  ['red', 'Coral'],
];
const FRESH: ReadonlyArray<[Fresh, string]> = [
  ['ok', 'Fresh'],
  ['unsure', 'Unsure'],
  ['none', 'Unchecked'],
];
const MODES: ReadonlyArray<[Workplace, string]> = [
  ['remote', 'Remote'],
  ['hybrid', 'Hybrid'],
  ['onsite', 'Onsite'],
];

export const canMove = (from: RoleStatus, to: RoleStatus) => MANUAL_MOVES.some(([a, b]) => a === from && b === to);

const toggle = <T,>(set: readonly T[], v: T) => (set.includes(v) ? set.filter((x) => x !== v) : [...set, v]);

export function River() {
  const { now, config, showToast } = useApp();
  const act = useAct();
  const list = useOp('roles.list', { limit: 500 });
  const sum = useOp('pipeline.summary', {});
  const [bands, setBands] = useState<Band[]>([]);
  const [fresh, setFresh] = useState<Fresh[]>([]);
  const [modes, setModes] = useState<Workplace[]>([]);
  const [companies, setCompanies] = useState<string[]>([]);
  const [showCompanies, setShowCompanies] = useState(false);
  const [zoom, setZoom] = useState<'tiles' | 'dots'>('tiles');
  const [drag, setDrag] = useState<RoleView | null>(null);
  const [bounce, setBounce] = useState<string | null>(null);
  const t = now();

  const all = list.data?.items ?? [];
  const shown = useMemo(
    () =>
      all.filter(
        (v) =>
          (!bands.length || (v.latest_score && bands.includes(v.latest_score.band))) &&
          (!fresh.length || fresh.includes(freshOf(v.role, t))) &&
          (!modes.length || modes.includes(v.role.workplace)) &&
          (!companies.length || companies.includes(v.company.id)),
      ),
    [all, bands, fresh, modes, companies, t],
  );
  const companyList = useMemo(() => [...new Map(all.map((v) => [v.company.id, v.company])).values()], [all]);

  const held = shown.filter((v) => v.role.status === 'held');
  const heldBy = (companyId: string) => held.filter((v) => v.company.id === companyId).length;

  const colState = (s: RoleStatus): ColumnState =>
    !drag ? 'idle' : drag.role.status === s ? 'source' : canMove(drag.role.status, s) ? 'drop-allowed' : 'idle';

  const onDrop = async (e: DragEvent, to: RoleStatus) => {
    e.preventDefault();
    const v = drag;
    setDrag(null);
    if (!v || v.role.status === to) return;
    if (!canMove(v.role.status, to)) {
      setBounce(v.role.id);
      setTimeout(() => setBounce(null), 450);
      return;
    }
    await act('roles.move', { role_id: v.role.id, to });
  };

  const tileState = (v: RoleView, stack: number): RiverTileState =>
    bounce === v.role.id ? 'bounce' : drag?.role.id === v.role.id ? 'dragging' : drag ? 'dimmed' : stack ? 'stacked' : 'default';

  const archivedCount = sum.data?.counts.archived ?? 0;
  const reasons = Object.entries(sum.data?.archived_by_reason ?? {}).filter(([, n]) => n > 0) as Array<[ArchiveReason, number]>;

  return (
    <div className="screen screen--river">
      <ScreenHeader
        title="River"
        primary={
          <PrimaryButton
            label="Scout now"
            op="runs.start"
            onClick={async () => {
              const o = await act('runs.start', { skill: 'scout' });
              if (o.status === 'ok') showToast('Scout started');
            }}
          />
        }
      />
      <div className="filters">
        {BANDS.map(([b, l]) => (
          <Chip key={b} variant="filter" label={l} on={bands.includes(b)} onClick={() => setBands(toggle(bands, b))} />
        ))}
        <span className="filters__sep" />
        {FRESH.map(([f, l]) => (
          <Chip key={f} variant="filter" label={l} on={fresh.includes(f)} onClick={() => setFresh(toggle(fresh, f))} />
        ))}
        <span className="filters__sep" />
        {MODES.map(([m, l]) => (
          <Chip key={m} variant="filter" label={l} on={modes.includes(m)} onClick={() => setModes(toggle(modes, m))} />
        ))}
        <span className="filters__sep" />
        <Chip
          variant="filter"
          label="Company"
          value={companies.length || undefined}
          on={showCompanies || companies.length > 0}
          onClick={() => setShowCompanies((v) => !v)}
        />
        <span className="filters__spacer" />
        <Chip variant="filter" label={zoom === 'tiles' ? 'Tiles' : 'Dots'} onClick={() => setZoom(zoom === 'tiles' ? 'dots' : 'tiles')} />
      </div>
      {showCompanies && (
        <div className="filters filters--sub">
          {companyList.map((c) => (
            <Chip
              key={c.id}
              variant="filter"
              label={c.name}
              on={companies.includes(c.id)}
              onClick={() => setCompanies(toggle(companies, c.id))}
            />
          ))}
        </div>
      )}
      <div className={`river river--${zoom}`}>
        {RIVER_COLUMNS.map((s) => {
          const roles = shown.filter((v) => v.role.status === s);
          // The stack sits on the last visible active tile of a capped company.
          const lastOfCompany = new Map(roles.map((v) => [v.company.id, v.role.id]));
          return (
            <RiverColumn
              key={s}
              status={s}
              count={roles.length + (s === 'active' ? held.length : 0)}
              state={colState(s)}
              onDragOver={(e) => {
                if (drag) e.preventDefault();
              }}
              onDrop={(e) => void onDrop(e, s)}
            >
              {roles.map((v) => {
                const stack = s === 'active' && lastOfCompany.get(v.company.id) === v.role.id ? heldBy(v.company.id) : 0;
                return (
                  <RiverTile
                    key={v.role.id}
                    view={v}
                    now={t}
                    bands={config.scoring}
                    zoom={zoom}
                    stackCount={stack}
                    state={tileState(v, stack)}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', v.role.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDrag(v);
                    }}
                    onDragEnd={() => setDrag(null)}
                    onOpen={() => go({ screen: 'role', roleId: v.role.id })}
                  />
                );
              })}
            </RiverColumn>
          );
        })}
        <section className="river-archived" aria-label="Archived">
          <span className="eyebrow">Archived</span>
          <span className="card-number">{archivedCount}</span>
          <div className="river-archived__reasons">
            {reasons.map(([r, n]) => (
              <ReasonChip key={r} reason={r} count={n} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
