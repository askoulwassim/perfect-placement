import type { RoleStatus } from '@perfect-placement/contracts';
import type { DragEvent, ReactNode } from 'react';
import { fit } from '../lib/format';
import { freshOf, type RoleView } from '../lib/role';
import { STATUS_LABEL } from './controls';
import { BandDot, type Bands, RoleTile, WhoDecidesGlyph, type WhoKind } from './glyphs';

// -------------------------------------------------------------- RoleCard

export function RoleCard({ view, now, bands, onOpen }: { view: RoleView; now: Date; bands?: Bands; onOpen?: () => void }) {
  const f = fit(view.latest_score?.total);
  return (
    <button type="button" className="role-card" data-op="nav" data-role={view.role.id} onClick={onOpen}>
      <RoleTile letter={view.company.name} fresh={freshOf(view.role, now)} size={48} />
      <span className="role-card__text">
        <span className="eyebrow">{view.company.name}</span>
        <span className="role-card__title">{view.role.title}</span>
      </span>
      <span className="role-card__fit">
        <span className="card-number">{f ?? '--'}</span>
        <BandDot fit={f} bands={bands} />
      </span>
    </button>
  );
}

// ------------------------------------------------------------- RiverTile

export type RiverTileState = 'default' | 'dimmed' | 'dragging' | 'bounce' | 'stacked';

export function RiverTile({
  view,
  now,
  bands,
  stackCount = 0,
  state = 'default',
  zoom = 'tiles',
  draggable,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  view: RoleView;
  now: Date;
  bands?: Bands;
  stackCount?: number;
  state?: RiverTileState;
  zoom?: 'tiles' | 'dots';
  draggable?: boolean;
  onOpen?: () => void;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: () => void;
}) {
  const f = fit(view.latest_score?.total);
  const fresh = freshOf(view.role, now);
  const label = `${view.company.name} ${view.role.title}`;
  if (zoom === 'dots')
    return (
      <button
        type="button"
        className={`river-dot is-${state}`}
        data-op="nav"
        data-role={view.role.id}
        title={label}
        aria-label={label}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onOpen}
      >
        <BandDot fit={f} bands={bands} size={12} />
      </button>
    );
  return (
    <div className={`river-tile-wrap ${stackCount ? 'is-stacked' : ''}`}>
      {stackCount > 0 && <span className="river-tile__stack" aria-hidden="true" />}
      <button
        type="button"
        className={`river-tile is-${state}`}
        data-op="nav"
        data-role={view.role.id}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onOpen}
      >
        <RoleTile letter={view.company.name} fresh={fresh} size={32} />
        <span className="river-tile__text">
          <span className="river-tile__co">{view.company.name}</span>
          <span className="river-tile__title">{view.role.title}</span>
        </span>
        <span className="river-tile__fit">
          {f ?? ''}
          <BandDot fit={f} bands={bands} size={8} />
        </span>
      </button>
      {stackCount > 0 && <span className="held-chip">+{stackCount} held</span>}
    </div>
  );
}

// ----------------------------------------------------------- RiverColumn

export type ColumnState = 'idle' | 'drop-allowed' | 'source';

export function RiverColumn({
  status,
  count,
  state = 'idle',
  children,
  onDrop,
  onDragOver,
}: {
  status: RoleStatus;
  count: number;
  state?: ColumnState;
  children: ReactNode;
  onDrop?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
}) {
  return (
    <section
      className={`river-col is-${state}`}
      data-status={status}
      aria-label={STATUS_LABEL[status]}
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      <header className="river-col__head">
        <span className="eyebrow">{STATUS_LABEL[status]}</span>
        <span className="river-col__count">{count}</span>
      </header>
      <div className="river-col__body">{children}</div>
    </section>
  );
}

// --------------------------------------------------------------- AutoRow

export function AutoRow({
  glyph,
  left,
  object,
  action,
  time,
  undoable,
  undone,
  onUndo,
}: {
  glyph: WhoKind;
  left?: number;
  object: string;
  action: string;
  time: string;
  undoable?: boolean;
  undone?: boolean;
  onUndo?: () => void;
}) {
  return (
    <div className={`auto-row ${undone ? 'is-undone' : ''}`}>
      <WhoDecidesGlyph kind={glyph} left={left} />
      <span className="auto-row__object">{object}</span>
      <span className="auto-row__action">{action}</span>
      <span className="auto-row__time">{time}</span>
      {undoable && !undone && (
        <button type="button" className="auto-row__undo" data-op="decisions.undo" onClick={onUndo}>
          Undo
        </button>
      )}
    </div>
  );
}
