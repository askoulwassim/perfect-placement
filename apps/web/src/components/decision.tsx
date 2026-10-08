import type { Backend, Impact, Thresholds } from '@perfect-placement/contracts';
import { useState } from 'react';
import type { DecisionObject } from '../lib/decisions';
import { humanize } from '../lib/format';
import { Chip, ImpactChip, SecondaryButton } from './controls';
import { Icon, type IconName, RoleTile, WhoDecidesGlyph } from './glyphs';
import { ProbabilityBar } from './meters';
import { DiffBlock, type DiffChip } from './profile';

export interface Evidence {
  label: string;
  detail?: string;
}

const OBJECT_ICON: Record<DecisionObject, IconName> = { role: 'river', mail: 'reply', profile: 'you', contact: 'draft' };

export function DecisionCard({
  object,
  objectTitle,
  objectSub,
  question,
  pick,
  resolver,
  p,
  impact,
  thresholds,
  evidence,
  alts,
  diff,
  changeOpen,
  onToggleChange,
  onChange,
  onSkip,
}: {
  object: DecisionObject;
  objectTitle: string;
  objectSub?: string;
  question: string;
  pick: string;
  resolver: Backend;
  p: number;
  impact: Impact;
  thresholds: Pick<Thresholds, 'auto' | 'second_opinion'>;
  evidence: readonly Evidence[];
  alts: ReadonlyArray<{ label: string; value: string | boolean | number }>;
  diff?: { before: DiffChip[]; after: DiffChip[] };
  changeOpen?: boolean;
  onToggleChange?: () => void;
  onChange?: (value: string | boolean | number) => void;
  onSkip?: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <article className="decision" data-object={object} data-impact={impact}>
      <header className="decision__object">
        {object === 'role' ? (
          <RoleTile letter={objectSub ?? objectTitle} fresh="none" size={40} />
        ) : (
          <span className="decision__icon">
            <Icon name={OBJECT_ICON[object]} />
          </span>
        )}
        <span className="decision__objtext">
          {objectSub && <span className="eyebrow">{objectSub}</span>}
          <span className="decision__objtitle">{objectTitle}</span>
        </span>
        <WhoDecidesGlyph kind="you" />
      </header>
      <h2 className="decision__q">{question}</h2>
      <div className="decision__pick">
        <span className="decision__pickval">{pick}</span>
        <span className="eyebrow">{humanize(resolver)}</span>
      </div>
      <div className="decision__meta">
        <ProbabilityBar p={p} thresholds={thresholds} wide />
        <ImpactChip impact={impact} />
      </div>
      {diff && <DiffBlock before={diff.before} after={diff.after} />}
      {evidence.length > 0 && (
        <div className="chip-row">
          {evidence.map((e) => (
            <Chip
              key={e.label}
              variant="evidence"
              label={e.label}
              value={open === e.label ? e.detail : undefined}
              on={open === e.label}
              onClick={e.detail ? () => setOpen(open === e.label ? null : e.label) : undefined}
            />
          ))}
        </div>
      )}
      {changeOpen && (
        <fieldset className="chip-row decision__alts" aria-label="Change">
          {alts.map((a) => (
            <button
              key={String(a.value)}
              type="button"
              className="chip chip--filter"
              data-op="decisions.resolve"
              onClick={() => onChange?.(a.value)}
            >
              {a.label}
            </button>
          ))}
        </fieldset>
      )}
      <footer className="decision__actions">
        <SecondaryButton label="Change" op="local" kbd="C" onClick={onToggleChange} disabled={alts.length === 0} />
        <SecondaryButton label="Skip" op="decisions.resolve" kbd="S" onClick={onSkip} />
      </footer>
    </article>
  );
}
