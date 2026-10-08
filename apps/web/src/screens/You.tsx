import { PROFILE_COMPONENT_KEYS, type ProfileComponentKey } from '@perfect-placement/contracts';
import { useState } from 'react';
import { useAct, useOp } from '../client/context';
import { Chip, PrimaryButton } from '../components/controls';
import { Constellation, DiffBlock, ProfileNode, VersionTimeline } from '../components/profile';
import { ScreenHeader } from '../components/shell';
import { humanize } from '../lib/format';
import { COMPONENT_NAME, chipsOf, numericFields } from '../lib/profile';
import { useMobile } from '../lib/useMobile';
import { go } from '../router';

export function You() {
  const act = useAct();
  const profile = useOp('profile.get', {});
  const history = useOp('profile.history', {});
  const [selected, setSelected] = useState<ProfileComponentKey | null>(null);
  const mobile = useMobile();

  const comps = profile.data?.components ?? [];
  const diffs = profile.data?.pending_diffs ?? [];
  const pendingKeys = diffs.map((d) => d.component_key);
  const ordered = PROFILE_COMPONENT_KEYS.map((key) => ({ key, confidence: comps.find((c) => c.key === key)?.confidence ?? 0 }));
  const sel = selected ? comps.find((c) => c.key === selected) : undefined;
  const selDiff = selected ? diffs.find((d) => d.component_key === selected) : undefined;

  const versions = (history.data?.versions ?? []).map((v, i) => ({
    v: `v${i + 1}`,
    event: humanize(v.reason),
    date: v.created_at.slice(5, 10),
  }));

  const primary = selDiff ? (
    <PrimaryButton label="Accept diff" op="profile.apply_diff" onClick={() => void act('profile.apply_diff', { diff_id: selDiff.id })} />
  ) : diffs.length > 0 ? (
    <PrimaryButton label={`Review ${diffs.length} diff`} op={null} onClick={() => setSelected(diffs[0]?.component_key ?? null)} />
  ) : (
    <PrimaryButton label="Recalibrate" op={null} onClick={() => go({ screen: 'onboarding' })} />
  );

  const dj = selDiff?.diff_json as { before?: Record<string, unknown>; after?: Record<string, unknown> } | undefined;

  return (
    <div className="screen screen--you">
      <ScreenHeader title="You" primary={primary} />
      <div className={`you-layout ${sel ? 'has-panel' : ''}`}>
        <Constellation
          size={mobile ? 340 : 560}
          components={ordered}
          selected={selected}
          pending={pendingKeys}
          onSelect={(k) => setSelected(k === selected ? null : k)}
        />
        {sel && selected && (
          <aside className="side-panel" aria-label={COMPONENT_NAME[selected]}>
            <header className="side-panel__head">
              <ProfileNode componentKey={selected} confidence={sel.confidence} pending={!!selDiff} size={48} />
              <span className="panel-title">{COMPONENT_NAME[selected]}</span>
            </header>
            <div className="chip-row">
              {chipsOf(Object.fromEntries(Object.entries(sel.data_json).filter(([, v]) => typeof v !== 'number'))).map((c) => (
                <Chip key={`${c.label}${c.value ?? ''}`} variant="fact" label={c.label} value={c.value} />
              ))}
            </div>
            {numericFields(sel.data_json).map(([k, v]) => (
              <label key={k} className="slider">
                <span className="eyebrow">{humanize(k)}</span>
                <input type="range" min={0} max={v >= 1000 ? 500000 : 100} value={v} readOnly disabled />
                <span className="slider__val">{v >= 1000 ? `${Math.round(v / 1000)}k` : v}</span>
              </label>
            ))}
            {selDiff && dj && (
              <section className="side-panel__diff">
                <span className="eyebrow">Pending</span>
                <DiffBlock
                  before={chipsOf(dj.before ?? {})}
                  after={chipsOf(dj.after ?? {})}
                  onReject={() => void act('profile.reject_diff', { diff_id: selDiff.id })}
                />
                <div className="chip-row">
                  {selDiff.evidence_json.map((e) => (
                    <Chip key={e} variant="evidence" label={e} />
                  ))}
                </div>
              </section>
            )}
            <span className="eyebrow">Versions</span>
            <VersionTimeline versions={versions} />
          </aside>
        )}
      </div>
    </div>
  );
}
