import { type HardHumanSubject, isHardHuman, type PolicyConfig, PP_HOME_DEFAULT } from '@perfect-placement/contracts';
import { useEffect, useState } from 'react';
import { useAct, useApp, useOp } from '../client/context';
import { Toggle } from '../components/controls';
import { BackendCard, HardExclusions, PolicyGrid, ScheduleRow } from '../components/shell';
import { C, eyebrow, mono } from '../components/theme';
import { Screen } from '../layout';
import { CUE_IDS } from '../lib/cues';

type ScheduleKey = keyof PolicyConfig['schedules'];
const SCHEDULES: ReadonlyArray<[ScheduleKey, string]> = [
  ['inbox', 'Inbox'],
  ['freshness', 'Freshness'],
  ['scout_score', 'Scout + score'],
];
/** Hard exclusions (wave1-decisions #24): shown locked as "you"; each is checked against the contract. */
const LOCKED: ReadonlyArray<[string, HardHumanSubject]> = [
  ['Submit application', { kind: 'apply.submit' }],
  ['Send email', { op: 'outreach.send' }],
  ['Delete anything', { op: 'roles.delete' }],
  ['Dealbreakers', { component: 'dealbreakers' }],
  ['Comp floor', { component: 'terms', changedKeys: ['comp_floor'] }],
];
export const LOCKED_LABELS = LOCKED.filter(([, s]) => isHardHuman(s)).map(([label]) => label);

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

/** "daily 07:30" | "fri 05:30" -> "Fri 07:30" (next run, UTC). null when paused or unparseable. */
export function nextRun(spec: string, now: Date): string | null {
  const m = spec
    .trim()
    .toLowerCase()
    .match(/^(daily|sun|mon|tue|wed|thu|fri|sat)\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, when, hh, mm] = m;
  const at = new Date(now);
  at.setUTCHours(Number(hh), Number(mm), 0, 0);
  if (when === 'daily') {
    if (at <= now) at.setUTCDate(at.getUTCDate() + 1);
  } else {
    let add = (DAYS.indexOf(when as string) - at.getUTCDay() + 7) % 7;
    if (add === 0 && at <= now) add = 7;
    at.setUTCDate(at.getUTCDate() + add);
  }
  return `${cap(DAYS[at.getUTCDay()] as string)} ${(hh as string).padStart(2, '0')}:${mm}`;
}

/** "daily 07:30" -> "Daily 07:30"; "fri 05:30" -> "Weekly Fri 05:30". */
export const cadence = (spec: string) => {
  const [w, t] = spec.split(/\s+/);
  if (!w || !t) return spec;
  return w === 'daily' ? `Daily ${t}` : `Weekly ${cap(w)} ${t}`;
};

export function Settings() {
  const { config, thresholds, setThresholds, now, showToast, cuesSeen, setCues } = useApp();
  // On while any cue is still to come; flipping it on shows every cue again, off retires them all.
  const cuesOn = !CUE_IDS.every((id) => cuesSeen?.includes(id));
  const act = useAct();
  const backends = useOp('system.backends', {});
  const [schedules, setSchedules] = useState(config.schedules);
  const [saved, setSaved] = useState<Record<ScheduleKey, string>>(config.schedules);
  useEffect(() => {
    setSchedules(config.schedules);
    setSaved((s) => ({ ...s, ...Object.fromEntries(Object.entries(config.schedules).filter(([, v]) => v !== 'off')) }));
  }, [config.schedules]);

  const t = now();
  const save = async () => {
    const o = await act('config.update', {
      patch: { policy: { auto: thresholds.auto, second_opinion: thresholds.second_opinion }, schedules },
    });
    if (o.status === 'ok') showToast('Saved');
  };

  return (
    <Screen
      label="Settings"
      eyebrow={PP_HOME_DEFAULT}
      title="Settings"
      primary={{ label: 'Save', op: 'config.update', onClick: () => void save() }}
    >
      <div style={{ maxWidth: 1000, display: 'flex', flexDirection: 'column', gap: 48, marginTop: 32 }}>
        <div>
          <div style={{ ...eyebrow(), marginBottom: 14 }}>Backends</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 16 }}>
            {backends.data?.items
              .filter((b) => b.name !== 'rule')
              .map((b) => (
                <BackendCard key={b.name} name={cap(b.name)} mode={b.mode} status={b.status} latencyMs={b.latencyMs} />
              ))}
          </div>
        </div>
        <div>
          <div style={{ ...eyebrow(), marginBottom: 14 }}>Policy</div>
          <PolicyGrid thresholds={thresholds} onChange={(x) => setThresholds({ ...thresholds, ...x })} />
          <HardExclusions items={LOCKED_LABELS} />
        </div>
        <div>
          <div style={{ ...eyebrow(), marginBottom: 6 }}>Schedules</div>
          {SCHEDULES.map(([key, name]) => {
            const on = schedules[key] !== 'off';
            const spec = on ? schedules[key] : saved[key];
            return (
              <ScheduleRow
                key={key}
                name={name}
                cadence={cadence(spec)}
                next={nextRun(spec, t) ?? '—'}
                on={on}
                onToggle={(v) => setSchedules({ ...schedules, [key]: v ? saved[key] : 'off' })}
              />
            );
          })}
        </div>
        <div>
          <div style={{ ...eyebrow(), marginBottom: 6 }}>Cues</div>
          <div
            className="cues-row"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              height: 60,
              borderBottom: `1px solid ${C.line}`,
            }}
          >
            <span style={{ fontSize: 15, fontWeight: 600 }}>Show cues</span>
            <Toggle on={cuesOn} label="Show cues" op="config.update" onChange={(v) => void setCues(v ? [] : CUE_IDS)} />
          </div>
        </div>
        <div>
          <div style={{ ...eyebrow(), marginBottom: 14 }}>Data home</div>
          <span
            style={{
              ...mono(14),
              background: C['bg-2'],
              border: `1px solid ${C.line}`,
              borderRadius: 10,
              padding: '12px 16px',
              display: 'inline-block',
            }}
          >
            {PP_HOME_DEFAULT}
          </span>
        </div>
      </div>
    </Screen>
  );
}
