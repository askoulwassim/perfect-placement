import { PROFILE_COMPONENT_KEYS, PROFILE_COMPONENT_KIND, type ProfileComponentKey } from '@perfect-placement/contracts';
import { useState } from 'react';
import { useAct, useApp, useOp } from '../client/context';
import { Btn } from '../components/Btn';
import { Constellation, DiffBlock, KIND_HEX, KIND_LABEL, type NodeData, ProfileNode, VersionTimeline } from '../components/profile';
import { C, display, eyebrow, mono, X } from '../components/theme';
import { Screen, useLayout } from '../layout';
import { COMPONENT_NAME, chipText, DEFAULT_FIELDS, type DefaultField, defaultsInput, defaultsText } from '../lib/profile';
import { timeline } from '../lib/view';
import { go } from '../router';

export function You({ component }: { component?: ProfileComponentKey } = {}) {
  const { mobile } = useLayout();
  const { showToast } = useApp();
  const act = useAct();
  const profile = useOp('profile.get', {});
  const history = useOp('profile.history', {});
  const [selected, setSelected] = useState<ProfileComponentKey | null>(component ?? null);

  const comps = profile.data?.components ?? [];
  const diffs = [...(profile.data?.pending_diffs ?? [])].sort(
    (a, b) => PROFILE_COMPONENT_KEYS.indexOf(a.component_key) - PROFILE_COMPONENT_KEYS.indexOf(b.component_key),
  );
  const nodes: NodeData[] = PROFILE_COMPONENT_KEYS.map((key) => ({
    key,
    name: COMPONENT_NAME[key],
    kind: PROFILE_COMPONENT_KIND[key],
    conf: Math.round((comps.find((c) => c.key === key)?.confidence ?? 0) * 100),
    pending: diffs.some((d) => d.component_key === key),
  }));
  const sel = selected ? comps.find((c) => c.key === selected) : undefined;
  const selDiff = selected ? diffs.find((d) => d.component_key === selected) : undefined;
  const versions = history.data?.versions ?? [];
  const tl = timeline(versions);

  const accept = async (id: string) => {
    const o = await act('profile.apply_diff', { diff_id: id });
    if (o.status === 'ok') showToast('Diff accepted');
  };
  const primary = selDiff
    ? { label: 'Accept diff', op: 'profile.apply_diff' as const, onClick: () => void accept(selDiff.id) }
    : diffs.length > 0
      ? { label: `Review ${diffs.length} diff`, op: null, onClick: () => setSelected(diffs[0]?.component_key ?? null) }
      : { label: 'Recalibrate', op: null, onClick: () => go({ screen: 'onboarding', calibrate: true }) };

  const dj = selDiff?.diff_json as { before?: Record<string, unknown>; after?: Record<string, unknown> } | undefined;
  const before = chipText(dj?.before ?? {});
  const after = chipText(dj?.after ?? {});
  const reject = selDiff ? () => void act('profile.reject_diff', { diff_id: selDiff.id }) : undefined;
  const chips = sel ? chipText(sel.data_json) : [];
  // The kept source resume (#38), linked from Story.
  const source = selected === 'story' && typeof sel?.data_json.source_path === 'string' ? sel.data_json.source_path : null;
  const weight = sel?.weight != null ? Math.round(sel.weight * 100) : null;
  const pick = (k: string) => setSelected(k === selected ? null : (k as ProfileComponentKey));
  const header = { eyebrow: `Profile · v${versions.length || 1}`, title: 'You' };

  if (mobile)
    return (
      <Screen label="You · mobile" {...header} primary={primary}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '16px 8px' }}>
          {nodes.map((n) => (
            <ProfileNode key={n.key} n={n} size={60} selected={selected === n.key} onClick={() => pick(n.key)} />
          ))}
        </div>
        {sel && selected && (
          <div style={{ marginTop: 22, background: C.panel, border: `1px solid ${C['line-2']}`, borderRadius: 12, padding: 18 }}>
            <div style={display(24, 800, 'normal')}>{COMPONENT_NAME[selected]}</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
              {chips.map((c) => (
                <span key={c} style={{ background: C['panel-2'], borderRadius: 999, padding: '5px 10px', fontSize: 12 }}>
                  {c}
                </span>
              ))}
            </div>
            {source && <ResumeSource path={source} />}
            {selected === 'terms' && <Defaults data={sel.data_json.application_defaults} mobile />}
            {selDiff && <DiffBlock compact before={before} after={after} />}
            <VersionTimeline compact versions={tl} />
          </div>
        )}
      </Screen>
    );

  return (
    <Screen label="You" {...header} primary={primary}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 32, marginTop: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 760px', minWidth: 760 }}>
          <Constellation nodes={nodes} selected={selected} onSelect={pick} />
        </div>
        <div
          className="side-panel"
          style={{
            background: C.panel,
            border: `1px solid ${C['line-2']}`,
            borderRadius: 12,
            padding: 26,
            minHeight: 420,
            flex: '0 1 380px',
            minWidth: 320,
          }}
        >
          {!sel && (
            <>
              <div style={{ ...eyebrow(), marginBottom: 14 }}>Kind</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 30 }}>
                {(['filter', 'weighted', 'asset'] as const).map((k) => (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 14 }}>
                    <span
                      style={{ width: 18, height: 18, borderRadius: '50%', border: `3px solid ${KIND_HEX[k]}`, boxSizing: 'border-box' }}
                    />
                    {KIND_LABEL[k]}
                  </div>
                ))}
              </div>
              {diffs.length > 0 && (
                <>
                  <div style={{ ...eyebrow(C.gold), marginBottom: 12 }}>Pending</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {diffs.map((d) => (
                      <Btn
                        key={d.id}
                        op="local"
                        onClick={() => setSelected(d.component_key)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          background: 'transparent',
                          border: '1px solid rgba(226,182,90,0.4)',
                          color: C.fg,
                          borderRadius: 10,
                          padding: '12px 14px',
                          fontSize: 14,
                        }}
                        hover={{ background: X.gold08 }}
                      >
                        {COMPONENT_NAME[d.component_key]}
                        <span style={{ color: C.gold }}>→</span>
                      </Btn>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          {sel && selected && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div>
                  <div style={display(32, 800, '-0.03em')}>{COMPONENT_NAME[selected]}</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                    <span
                      style={{
                        border: `1px solid ${KIND_HEX[sel.kind]}`,
                        color: KIND_HEX[sel.kind],
                        borderRadius: 999,
                        padding: '3px 10px',
                        ...eyebrow(KIND_HEX[sel.kind], 10.5),
                      }}
                    >
                      {KIND_LABEL[sel.kind]}
                    </span>
                    <span style={mono(12, C.muted)}>{Math.round(sel.confidence * 100)}%</span>
                  </div>
                </div>
                <Btn
                  op="local"
                  aria-label="Close"
                  onClick={() => setSelected(null)}
                  style={{ background: 'none', border: 0, color: C.dim, fontSize: 20, lineHeight: 1 }}
                  hover={{ color: C.fg }}
                >
                  ×
                </Btn>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 22 }}>
                {chips.map((c) => (
                  <span key={c} style={{ background: C['panel-2'], borderRadius: 999, padding: '6px 12px', fontSize: 13 }}>
                    {c}
                  </span>
                ))}
              </div>
              {source && <ResumeSource path={source} />}
              {selected === 'terms' && <Defaults data={sel.data_json.application_defaults} />}
              {weight != null && (
                <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '86px 1fr 26px', gap: 12, alignItems: 'center' }}>
                    <span style={mono(11, C.muted)}>Weight</span>
                    <div style={{ height: 4, borderRadius: 4, background: C.line, position: 'relative' }}>
                      <div
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: 0,
                          bottom: 0,
                          width: `${Math.min(100, weight * 4)}%`,
                          background: C.emerald,
                          borderRadius: 4,
                        }}
                      />
                    </div>
                    <span style={{ ...mono(12), textAlign: 'right' }}>{weight}</span>
                  </div>
                </div>
              )}
              {selDiff && <DiffBlock before={before} after={after} onReject={reject} />}
              <div style={{ ...eyebrow(), margin: '28px 0 14px' }}>History</div>
              <VersionTimeline versions={tl} />
            </>
          )}
        </div>
      </div>
    </Screen>
  );
}

/** The kept source resume: one button opens its extracted text. */
function ResumeSource({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const doc = useOp('vault.read', open ? { path } : null);
  return (
    <div style={{ marginTop: 18 }}>
      <Btn
        op="vault.read"
        className="resume-source"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{
          height: 34,
          padding: '0 16px',
          borderRadius: 999,
          border: `1px solid ${C['line-2']}`,
          background: open ? C['panel-2'] : 'transparent',
          color: C.fg,
          fontSize: 13,
          fontWeight: 600,
        }}
        hover={{ borderColor: C['emerald-2'] }}
      >
        Resume
      </Btn>
      {open && (
        <div
          className="resume-source__text"
          style={{
            marginTop: 12,
            maxHeight: 360,
            overflow: 'auto',
            background: C['bg-2'],
            border: `1px solid ${C.line}`,
            borderRadius: 10,
            padding: 14,
            ...mono(12, C.muted),
            lineHeight: 1.55,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
        >
          {doc.data?.markdown ?? ''}
        </div>
      )}
    </div>
  );
}

/** Application defaults (#42): the standard portal answers Fill reuses; one Save. */
function Defaults({ data, mobile }: { data: unknown; mobile?: boolean }) {
  const act = useAct();
  const { showToast } = useApp();
  const saved = defaultsText((data ?? undefined) as Record<string, unknown> | undefined);
  const [text, setText] = useState(saved);
  const dirty = DEFAULT_FIELDS.some(([f]) => text[f].trim() !== saved[f].trim());
  const save = async () => {
    const o = await act('profile.set_defaults', { defaults: defaultsInput(text) });
    if (o.status === 'ok') showToast('Defaults saved');
  };
  return (
    <div className="app-defaults" style={{ marginTop: 22 }}>
      <div style={{ ...eyebrow(), marginBottom: 12 }}>Application defaults</div>
      <div style={{ display: 'grid', gridTemplateColumns: mobile ? '96px 1fr' : '110px 1fr', gap: '8px 12px', alignItems: 'center' }}>
        {DEFAULT_FIELDS.map(([f, label, hint]) => (
          <label key={f} style={{ display: 'contents' }}>
            <span style={mono(11, C.muted)}>{label}</span>
            <input
              name={f}
              value={text[f]}
              placeholder={hint}
              onChange={(e) => setText((t) => ({ ...t, [f as DefaultField]: e.target.value }))}
              style={{
                minWidth: 0,
                height: 32,
                background: C['bg-2'],
                border: `1px solid ${C['line-2']}`,
                borderRadius: 8,
                color: C.fg,
                padding: '0 10px',
                fontSize: 13,
              }}
            />
          </label>
        ))}
      </div>
      <Btn
        op="profile.set_defaults"
        disabled={!dirty}
        onClick={() => void save()}
        style={{
          marginTop: 12,
          height: 34,
          padding: '0 16px',
          borderRadius: 999,
          border: `1px solid ${C['line-2']}`,
          background: 'transparent',
          color: dirty ? C.fg : C.dim,
          fontSize: 13,
          fontWeight: 600,
        }}
        hover={{ borderColor: C['emerald-2'] }}
      >
        Save
      </Btn>
    </div>
  );
}
