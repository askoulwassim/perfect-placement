import type { ArchiveReason, RoleStatus } from '@perfect-placement/contracts';
import type { DragEvent, MouseEvent, ReactNode } from 'react';
import { Btn } from './Btn';
import { ReasonChip, STATUS_HEX, STATUS_LABEL } from './controls';
import { type Fresh, RoleTile, WhoDecidesGlyph, type WhoKind } from './glyphs';
import { C, display, ellipsis, eyebrow, mono, tab } from './theme';

export interface TileData {
  id: string;
  letter: string;
  fresh: Fresh;
  title: string;
  co: string;
  fit: number | null;
  band: string;
  /** The job posting (#34): Cmd/Ctrl-click a tile, card or dot opens it in a new tab. */
  url?: string | null;
  /** #105: "In progress" for a picked (on-deck) role, shown on the Now card. */
  tag?: string | null;
}

/**
 * Plain click opens the Role screen; Cmd/Ctrl-click opens the posting when there is one; Shift-click
 * selects the tile when the column allows it (Inbox: multi-select, #77).
 */
function openTile(e: MouseEvent, r: TileData, onOpen?: () => void, onSelect?: () => void) {
  if (e.shiftKey && onSelect) onSelect();
  else if ((e.metaKey || e.ctrlKey) && r.url) window.open(r.url, '_blank', 'noopener');
  else onOpen?.();
}

// ------------------------------------------------------------ RoleCard (top picks)

/** #105: the "In progress" line on a picked role's card. */
function CardTag({ text }: { text: string }) {
  return (
    <span className="role-card__tag" style={{ display: 'block', marginTop: 4, ...eyebrow(STATUS_HEX['on-deck'], 9.5) }}>
      {text}
    </span>
  );
}

export function RoleCard({ r, onOpen, mobile }: { r: TileData; onOpen?: () => void; mobile?: boolean }) {
  if (mobile)
    return (
      <Btn
        op={null}
        className="role-card"
        data-role={r.id}
        onClick={(e) => openTile(e, r, onOpen)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: 12,
          background: C.panel,
          border: `1px solid ${C.line}`,
          borderRadius: 12,
          minHeight: 64,
          color: C.fg,
          textAlign: 'left',
          width: '100%',
        }}
      >
        <RoleTile letter={r.letter} fresh={r.fresh} size={40} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 14, fontWeight: 600, ...ellipsis }}>{r.title}</span>
          <span style={{ display: 'block', fontSize: 12, color: C.muted }}>{r.co}</span>
          {r.tag && <CardTag text={r.tag} />}
        </span>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: r.band }} />
        <span style={display(26, 800, 'normal')}>{r.fit ?? '—'}</span>
      </Btn>
    );
  return (
    <Btn
      op={null}
      className="role-card"
      data-role={r.id}
      onClick={(e) => openTile(e, r, onOpen)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '16px 18px',
        background: C.panel,
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        transition: 'border-color .15s',
        color: C.fg,
        textAlign: 'left',
        width: '100%',
      }}
      hover={{ borderColor: C['emerald-2'], background: C['panel-2'] }}
    >
      <RoleTile letter={r.letter} fresh={r.fresh} size={48} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 16, fontWeight: 600, ...ellipsis }}>{r.title}</span>
        <span style={{ display: 'block', fontSize: 13, color: C.muted, marginTop: 3 }}>{r.co}</span>
        {r.tag && <CardTag text={r.tag} />}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 10, height: 10, borderRadius: '50%', background: r.band }} />
        <span style={{ ...display(38), ...tab, lineHeight: 1 }}>{r.fit ?? '—'}</span>
      </span>
    </Btn>
  );
}

// ------------------------------------------------------------ RiverTile / RiverDot

export type RiverTileState = 'default' | 'dimmed' | 'dragging' | 'bounce' | 'stacked';

interface DragProps {
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: () => void;
  onOpen?: () => void;
}

export function RiverTile({
  r,
  stackCount = 0,
  matched = true,
  bounce,
  selected,
  onSelect,
  onDragStart,
  onDragEnd,
  onOpen,
}: {
  r: TileData;
  stackCount?: number;
  matched?: boolean;
  bounce?: boolean;
  /** Inbox multi-select (#77): set when the column allows selecting. */
  selected?: boolean;
  onSelect?: () => void;
} & DragProps) {
  return (
    <Btn
      op={null}
      className={`river-tile ${bounce ? 'is-bounce' : ''} ${selected ? 'is-selected' : ''}`}
      data-role={r.id}
      {...(onSelect ? { 'aria-pressed': !!selected } : {})}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={(e) => openTile(e, r, onOpen, onSelect)}
      style={{
        position: 'relative',
        display: 'flex',
        gap: 10,
        alignItems: 'center',
        padding: 10,
        background: selected ? 'rgba(226,182,90,0.08)' : C.panel,
        border: `1px solid ${bounce ? C.coral : selected ? C.gold : C.line}`,
        borderRadius: 10,
        cursor: 'grab',
        opacity: matched ? 1 : 0.22,
        boxShadow: stackCount > 0 ? `4px 4px 0 -1px ${C['panel-2']}, 8px 8px 0 -2px ${C.panel}` : 'none',
        animation: bounce ? 'ppBounce .45s ease' : 'none',
        transition: 'opacity .2s',
        color: C.fg,
        textAlign: 'left',
        width: '100%',
      }}
      hover={{ background: C['panel-2'], borderColor: C['emerald-2'] }}
    >
      <RoleTile letter={r.letter} fresh={r.fresh} size={32} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            lineHeight: 1.25,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {r.title}
        </span>
        <span style={{ display: 'block', fontSize: 12, color: C.muted, marginTop: 2, ...ellipsis }}>{r.co}</span>
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
        <span style={{ ...mono(13), ...tab }}>{r.fit ?? ''}</span>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: r.band }} />
      </span>
      {stackCount > 0 && (
        <span
          className="held-chip"
          style={{
            position: 'absolute',
            top: -9,
            right: 8,
            background: C.bg,
            border: `1px solid ${C.gold}`,
            color: C.gold,
            ...mono(10),
            padding: '1px 7px',
            borderRadius: 999,
          }}
        >
          +{stackCount} held
        </span>
      )}
    </Btn>
  );
}

/** An Inbox tile with its menu (#77): Pass shows on hover or focus; Shift-click selects. */
export function InboxTile({ onPass, ...tile }: Parameters<typeof RiverTile>[0] & { onPass: () => void }) {
  // Pass shows on tile hover or keyboard focus via CSS (styles.css), never JS hover state (#101).
  return (
    <div className="inbox-tile" style={{ position: 'relative' }}>
      <RiverTile {...tile} />
      <Btn
        op="roles.archive"
        className="tile-pass"
        aria-label={`Pass ${tile.r.co}`}
        onClick={onPass}
        style={{
          position: 'absolute',
          right: 8,
          bottom: 8,
          height: 22,
          padding: '0 8px',
          borderRadius: 6,
          border: `1px solid ${C['line-2']}`,
          background: C.bg,
          color: C.muted,
          fontSize: 11,
          fontWeight: 600,
          transition: 'opacity .15s',
        }}
        hover={{ borderColor: C.coral, color: C.coral }}
      >
        Pass
      </Btn>
    </div>
  );
}

export function RiverDot({
  r,
  matched = true,
  bounce,
  onDragStart,
  onDragEnd,
  onOpen,
}: { r: TileData; matched?: boolean; bounce?: boolean } & DragProps) {
  return (
    <Btn
      op={null}
      className="river-dot"
      data-role={r.id}
      draggable
      title={`${r.co} · ${r.title} · ${r.fit ?? ''}`}
      aria-label={`${r.co} ${r.title}`}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={(e) => openTile(e, r, onOpen)}
      style={{
        width: 14,
        height: 14,
        borderRadius: '50%',
        border: `2px solid ${C.bg}`,
        boxShadow: `0 0 0 1.5px ${r.band}`,
        padding: 0,
        background: r.band,
        opacity: matched ? 1 : 0.22,
        cursor: 'grab',
        animation: bounce ? 'ppBounce .45s ease' : 'none',
      }}
    />
  );
}

// ------------------------------------------------------------ RiverColumn

export type ColumnState = 'idle' | 'drop-allowed' | 'source';

export function RiverColumn({
  status,
  count,
  state,
  dots,
  width,
  children,
  dotChildren,
  onDrop,
  onDragOver,
  action,
}: {
  status: RoleStatus;
  count: number;
  state: ColumnState;
  dots: boolean;
  width: number;
  children?: ReactNode;
  dotChildren?: ReactNode;
  onDrop?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  /** A column action under the header (Inbox: Score all). */
  action?: ReactNode;
}) {
  const color = STATUS_HEX[status];
  const allowed = state === 'drop-allowed';
  return (
    <section
      className={`river-col is-${state}`}
      data-status={status}
      aria-label={STATUS_LABEL[status]}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{
        flex: 'none',
        width,
        minHeight: 540,
        borderRadius: 12,
        padding: '14px 12px',
        background: allowed ? 'rgba(47,211,155,0.07)' : state === 'source' ? C['bg-2'] : 'rgba(9,26,45,0.55)',
        border: `1px dashed ${allowed ? C['emerald-2'] : 'transparent'}`,
        transition: 'background .15s',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10, gap: 6 }}>
        <div style={{ ...eyebrow(color, 10.5), whiteSpace: 'nowrap' }}>{STATUS_LABEL[status]}</div>
        <div style={{ ...display(26, 800, '-0.03em'), ...tab, lineHeight: 1 }}>{count}</div>
      </div>
      <div style={{ height: 3, borderRadius: 3, background: color, opacity: 0.5, marginBottom: action ? 10 : 16 }} />
      {action}
      {!dots && <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{children}</div>}
      {dots && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12, alignItems: 'center' }}>{dotChildren}</div>}
    </section>
  );
}

export function ArchivedColumn({ count, reasons }: { count: number; reasons: ReadonlyArray<[ArchiveReason, number]> }) {
  return (
    <section
      aria-label="Archived"
      className="river-archived"
      style={{
        flex: 'none',
        width: 104,
        borderRadius: 12,
        padding: '14px 12px',
        background: C['bg-2'],
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <div style={eyebrow(C.coral, 10.5)}>Archived</div>
      <div style={{ ...display(40), ...tab, lineHeight: 1 }}>{count}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', marginTop: 8 }}>
        {reasons.map(([r, n]) => (
          <ReasonChip key={r} reason={r} count={n} />
        ))}
      </div>
    </section>
  );
}

// ------------------------------------------------------------ AutoRow

export function AutoRow({
  glyph,
  left,
  object,
  action,
  time,
  undoable,
  undone,
  onUndo,
  mobile,
}: {
  glyph: WhoKind;
  left?: number;
  object: string;
  action: string;
  time: string;
  undoable?: boolean;
  undone?: boolean;
  onUndo?: () => void;
  mobile?: boolean;
}) {
  const canUndo = undoable && !undone;
  // Desktop rows reveal Undo on row hover via CSS (styles.css); mobile always shows it (#101).
  const undoBtn = (visible: boolean) => (
    <Btn
      op="decisions.undo"
      className={visible ? 'auto-row__undo is-shown' : 'auto-row__undo'}
      onClick={onUndo}
      style={{
        background: 'transparent',
        border: `1px solid ${C['line-2']}`,
        color: C.fg,
        borderRadius: 8,
        height: mobile ? 30 : 28,
        padding: '0 10px',
        fontSize: 12,
      }}
      hover={{ borderColor: C['emerald-2'], color: C.emerald, opacity: 1 }}
    >
      Undo
    </Btn>
  );
  if (mobile)
    return (
      <div className="auto-row" style={{ display: 'flex', alignItems: 'center', gap: 12, height: 44, opacity: undone ? 0.45 : 1 }}>
        <WhoDecidesGlyph kind={glyph} left={left} />
        <span style={{ fontSize: 13, fontWeight: 500, flex: 1, minWidth: 0, ...ellipsis }}>{object}</span>
        {canUndo && undoBtn(true)}
        <span style={mono(11, C.dim)}>{time}</span>
      </div>
    );
  return (
    <HoverRow undone={undone}>
      <>
        <WhoDecidesGlyph kind={glyph} left={left} />
        <div style={{ fontSize: 14, fontWeight: 500, minWidth: 0, ...ellipsis }}>{object}</div>
        <div style={{ ...mono(12, C.muted), whiteSpace: 'nowrap' }}>{undone ? 'undone' : action}</div>
        <div style={{ flex: 1 }} />
        {canUndo && undoBtn(false)}
        <div style={{ ...mono(12, C.dim), ...tab, width: 40, textAlign: 'right' }}>{time}</div>
      </>
    </HoverRow>
  );
}

/** A desktop activity row: its hover background is CSS (`.auto-row--hover` in styles.css), not JS state (#101). */
function HoverRow({ undone, children }: { undone?: boolean; children: ReactNode }) {
  return (
    <div
      className={`auto-row auto-row--hover ${undone ? 'is-undone' : ''}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        height: 46,
        padding: '0 14px',
        borderRadius: 10,
        background: 'transparent',
        opacity: undone ? 0.45 : 1,
      }}
    >
      {children}
    </div>
  );
}
