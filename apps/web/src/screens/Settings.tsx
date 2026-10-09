import {
  DAY_NAMES,
  EMAIL_VERIFIER_KEY_ENV,
  EMAIL_VERIFIER_PROVIDERS,
  type EmailVerifierProvider,
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
import { ToneChips } from '../components/controls';
import { BackendCard, HardExclusions, LOCKED_LABELS, PolicyGrid, ScheduleRow } from '../components/shell';
import { C, eyebrow, mono } from '../components/theme';
import { Screen } from '../layout';
import { go } from '../router';
import { RunRow } from './Runs';

type ScheduleKey = keyof PolicyConfig['schedules'];
const SCHEDULES: ReadonlyArray<[ScheduleKey, string]> = [
  ['inbox', 'Inbox'],
  ['freshness', 'Freshness'],
  ['scout_score', 'Scout + score'],
];

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

/** Email check providers (#99), in EMAIL_VERIFIER_PROVIDERS order. */
const VERIFIER_LABEL: Record<EmailVerifierProvider, string> = {
  none: 'MX only',
  neverbounce: 'NeverBounce',
  zerobounce: 'ZeroBounce',
  hunter: 'Hunter',
};

/** The config.update patch for the email check: the env var name only, never a key. */
export function verifierPatch(provider: EmailVerifierProvider, keyEnv: string): { provider: EmailVerifierProvider; keyEnv?: string } {
  return provider === 'none' ? { provider } : { provider, keyEnv: keyEnv.trim() || EMAIL_VERIFIER_KEY_ENV[provider] };
}

/** OS job states that mean the schedule will not fire on its own (#29). */
const NO_JOB: ReadonlySet<ScheduleJobState> = new Set(['missing', 'stale']);

export function Settings() {
  const { config, thresholds, setThresholds, now, showToast, runs } = useApp();
  const act = useAct();
  const backends = useOp('system.backends', {});
  // Last scheduled run + OS job per schedule (#29); refetched after every write (Save syncs the jobs).
  const status = useOp('schedules.status', {});
  const [schedules, setSchedules] = useState(config.schedules);
  const [saved, setSaved] = useState<Record<ScheduleKey, string>>(config.schedules);
  // #99: the email check's provider and the environment variable that holds its key.
  const [provider, setProvider] = useState<EmailVerifierProvider>(config.email_verifier?.provider ?? 'none');
  const [keyEnv, setKeyEnv] = useState(config.email_verifier?.keyEnv ?? '');
  useEffect(() => {
    setProvider(config.email_verifier?.provider ?? 'none');
    setKeyEnv(config.email_verifier?.keyEnv ?? '');
  }, [config.email_verifier]);
  useEffect(() => {
    setSchedules(config.schedules);
    setSaved((s) => ({ ...s, ...Object.fromEntries(Object.entries(config.schedules).filter(([, v]) => v !== 'off')) }));
  }, [config.schedules]);

  const t = now();
  const save = async () => {
    const o = await act('config.update', {
      patch: {
        policy: { auto: thresholds.auto, second_opinion: thresholds.second_opinion },
        schedules,
        email_verifier: verifierPatch(provider, keyEnv),
      },
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
        <div className="settings-email">
          <div style={{ ...eyebrow(), marginBottom: 14 }}>Email check</div>
          <ToneChips
            tones={EMAIL_VERIFIER_PROVIDERS.map((p) => VERIFIER_LABEL[p])}
            recommended={-1}
            selected={EMAIL_VERIFIER_PROVIDERS.indexOf(provider)}
            onSelect={(i) => setProvider(EMAIL_VERIFIER_PROVIDERS[i] as EmailVerifierProvider)}
          />
          {provider !== 'none' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={mono(11, C.muted)}>Key variable</span>
              <input
                name="email_verifier_key_env"
                value={keyEnv}
                placeholder={EMAIL_VERIFIER_KEY_ENV[provider]}
                spellCheck={false}
                onChange={(e) => setKeyEnv(e.target.value)}
                style={{
                  ...mono(13),
                  color: C.fg,
                  height: 32,
                  minWidth: 260,
                  padding: '0 10px',
                  background: C['bg-2'],
                  border: `1px solid ${C['line-2']}`,
                  borderRadius: 8,
                }}
              />
            </label>
          )}
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
