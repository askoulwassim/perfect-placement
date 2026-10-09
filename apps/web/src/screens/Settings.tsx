import {
  DAY_NAMES,
  type HardHumanSubject,
  isHardHuman,
  nextFire,
  type PolicyConfig,
  PP_HOME_DEFAULT,
  parseSchedule,
  type Run,
  type ScheduleJobState,
} from '@perfect-placement/contracts';
import { useEffect, useState } from 'react';
import { useAct, useApp, useOp } from '../client/context';
import { Btn } from '../components/Btn';
import { Toggle } from '../components/controls';
import { BackendCard, HardExclusions, PolicyGrid, ScheduleRow } from '../components/shell';
import { C, eyebrow, mono } from '../components/theme';
import { Screen } from '../layout';
import { CUE_IDS } from '../lib/cues';
import { go } from '../router';
import { RunRow } from './Runs';

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

const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
const two = (n: number) => String(n).padStart(2, '0');
const dayName = (d: number) => cap(DAY_NAMES[d] as string);

/** Next run in local time (the OS job's clock), "Fri 07:30". null when off or unparseable. */
export function nextRun(spec: string, now: Date): string | null {
  const t = nextFire(spec, now);
  return t ? `${dayName(t.getDay())} ${two(t.getHours())}:${two(t.getMinutes())}` : null;
}

/** "daily 07:30" -> "Daily 07:30"; "fri 05:30" -> "Weekly Fri 05:30"; "weekdays 08:00" -> "Weekdays 08:00". */
export const cadence = (spec: string) => {
  const p = parseSchedule(spec);
  const [w, t] = spec.trim().toLowerCase().split(/\s+/);
  if (!p || !w || !t) return spec;
  if (p.daily) return `Daily ${t}`;
  if (w === 'weekdays') return `Weekdays ${t}`;
  if (p.days.length === 1) return `Weekly ${dayName(p.days[0] as number)} ${t}`;
  return `${p.days.map(dayName).join(', ')} ${t}`;
};

/** The last scheduled run's result for its row. */
export const lastResult = (r: Run | null | undefined): string =>
  !r ? 'Never' : r.status === 'ok' ? 'Done' : r.status === 'error' ? 'Failed' : cap(r.status);

/** OS job states that mean the schedule will not fire on its own (#29). */
const NO_JOB: ReadonlySet<ScheduleJobState> = new Set(['missing', 'stale']);

export function Settings() {
  const { config, thresholds, setThresholds, now, showToast, cuesSeen, setCues, runs } = useApp();
  // On while any cue is still to come; flipping it on shows every cue again, off retires them all.
  const cuesOn = !CUE_IDS.every((id) => cuesSeen?.includes(id));
  const act = useAct();
  const backends = useOp('system.backends', {});
  // Last scheduled run + OS job per schedule (#29); refetched after every write (Save syncs the jobs).
  const status = useOp('schedules.status', {});
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
            const st = status.data?.items.find((s) => s.key === key);
            const noJob = on && config.schedules[key] !== 'off' && st !== undefined && NO_JOB.has(st.job);
            return (
              <ScheduleRow
                key={key}
                name={name}
                cadence={cadence(spec)}
                next={noJob ? 'No job' : (nextRun(spec, t) ?? '—')}
                last={lastResult(st?.last_run)}
                lastStatus={st?.last_run?.status ?? 'never'}
                job={st?.job ?? 'unknown'}
                on={on}
                onToggle={(v) => setSchedules({ ...schedules, [key]: v ? saved[key] : 'off' })}
              />
            );
          })}
        </div>
        <div className="settings-runs">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={eyebrow()}>Runs</span>
            <Btn
              op={null}
              onClick={() => go({ screen: 'runs' })}
              style={{ background: 'none', border: 0, padding: 0, color: C.emerald, fontSize: 13, fontWeight: 600 }}
            >
              All runs
            </Btn>
          </div>
          {runs.slice(0, 5).map((r) => (
            <RunRow key={r.id} run={r} now={t} onOpen={() => go({ screen: 'runs', runId: r.id })} />
          ))}
          {!runs.length && <div style={{ color: C.muted, padding: '12px 4px' }}>No runs</div>}
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
