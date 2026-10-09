import { useEffect, useMemo, useState } from 'react';
import { useApp, useOp } from '../client/context';
import { currentStep, type GuideStep, guideSteps } from '../lib/guide';
import { go, href } from '../router';
import { Btn } from './Btn';
import { PolicySummary } from './shell';
import { C, eyebrow, mono, X } from './theme';

/** The Getting started steps from real state, or null while any input is still unknown. */
export function useGuideSteps(mobile = false): GuideStep[] | null {
  const { guide, runs } = useApp();
  // Nothing to read once the path is finished (or before the flags are known).
  const on = !!guide && !guide.done;
  const profile = useOp('profile.get', on ? {} : null);
  const sum = useOp('pipeline.summary', on ? {} : null);
  const scoutRuns = useOp('runs.list', on ? { op: 'scout', limit: 20 } : null);
  const top = useOp('roles.list', on ? { status: ['active'], sort: 'fit', limit: 1 } : null);
  const known = on && sum.data && scoutRuns.data && !profile.loading;
  return useMemo(() => {
    if (!known || !guide || !sum.data || !scoutRuns.data) return null;
    // Live run state (the runs poll) over the last fetch.
    const live = runs.filter((r) => r.op === 'scout');
    const scouts = [...live, ...scoutRuns.data.items.filter((r) => !live.some((l) => l.id === r.id))];
    return guideSteps({
      profile: !!profile.data,
      flags: guide,
      scouts,
      counts: sum.data.counts,
      topRole: top.data?.items[0]?.role.id ?? null,
      needsYou: sum.data.needs_you,
      mobile,
    });
  }, [known, guide, runs, profile.data, sum.data, scoutRuns.data, top.data, mobile]);
}

/**
 * Getting started (#24): the ordered path on Now until every step is done, then gone for good
 * (`config.ui.guide.done`). Each step opens its screen, where one sentence explains it. On the phone,
 * Policy opens a read-only summary in the card instead (#65); opening it completes the step.
 */
export function GuideCard({ mobile }: { mobile?: boolean }) {
  const { guide, markGuide, setGuideCue, thresholds } = useApp();
  const steps = useGuideSteps(!!mobile);
  const [policyOpen, setPolicyOpen] = useState(false);
  const finished = !!steps && steps.every((s) => s.done);
  useEffect(() => {
    if (finished && guide && !guide.done) markGuide({ done: true });
  }, [finished, guide, markGuide]);
  if (!steps || !guide || guide.done || finished) return null;
  const cur = currentStep(steps);
  const open = (s: GuideStep) => {
    if (s.inline) {
      setPolicyOpen(!policyOpen);
      markGuide({ policy: true });
      return;
    }
    setGuideCue({ step: s.id, at: href(s.route) });
    go(s.route);
  };
  return (
    <section
      aria-label="Getting started"
      className="guide"
      style={{
        marginTop: mobile ? 8 : 32,
        marginBottom: mobile ? 20 : 0,
        border: `1px solid ${C.line}`,
        borderRadius: 16,
        padding: mobile ? '14px 14px 8px' : '18px 20px 12px',
        background: X.em04,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <div style={eyebrow()}>Getting started</div>
        <div style={mono(11, C.dim)}>
          {steps.filter((s) => s.done).length}/{steps.length}
        </div>
      </div>
      <ol
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'grid',
          gridTemplateColumns: mobile ? '1fr' : 'repeat(3,minmax(0,1fr))',
          gap: 6,
        }}
      >
        {steps.map((s, i) => {
          const now = s.id === cur?.id;
          return (
            <li key={s.id}>
              <Btn
                op={s.inline ? 'local' : null}
                aria-expanded={s.inline ? policyOpen : undefined}
                data-step={s.id}
                data-done={s.done ? 'true' : 'false'}
                aria-current={now ? 'step' : undefined}
                onClick={() => open(s)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  background: now ? X.em08 : 'none',
                  border: `1px solid ${now ? C.emerald : 'transparent'}`,
                  borderRadius: 10,
                  padding: '9px 10px',
                  color: s.done ? C.muted : C.fg,
                  fontSize: 14,
                  fontWeight: now ? 700 : 500,
                  textAlign: 'left',
                }}
                hover={{ background: X.em08 }}
              >
                <span
                  aria-hidden
                  style={{
                    ...mono(11, s.done ? C.bg : now ? C.emerald : C.dim),
                    width: 20,
                    height: 20,
                    flex: 'none',
                    borderRadius: 999,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: s.done ? C.emerald : 'none',
                    border: `1px solid ${s.done || now ? C.emerald : C.line}`,
                  }}
                >
                  {s.done ? '✓' : i + 1}
                </span>
                <span style={{ flex: 1, minWidth: 0, textDecoration: s.done ? 'line-through' : 'none' }}>{s.label}</span>
                {now && s.state && <span style={mono(11, s.state === 'Failed' ? C.coral : C.emerald)}>{s.state}</span>}
              </Btn>
              {s.inline && policyOpen && <PolicySummary thresholds={thresholds} />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
