import { type PolicyConfig, PP_HOME_DEFAULT } from '@perfect-placement/contracts';
import { useEffect, useState } from 'react';
import { useAct, useApp, useOp } from '../client/context';
import { PrimaryButton, Toggle } from '../components/controls';
import { BackendCard, PolicyGrid, ScreenHeader } from '../components/shell';

type ScheduleKey = keyof PolicyConfig['schedules'];
const SCHEDULES: ReadonlyArray<[ScheduleKey, string]> = [
  ['inbox', 'Inbox'],
  ['freshness', 'Freshness'],
  ['scout_score', 'Scout + score'],
];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "daily 07:30" | "fri 05:30" -> next run as "Fri 05:30" / "07:30". "off" = paused. */
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
    const target = DAYS.indexOf(when as string);
    let add = (target - at.getUTCDay() + 7) % 7;
    if (add === 0 && at <= now) add = 7;
    at.setUTCDate(at.getUTCDate() + add);
  }
  const day =
    at.getUTCDate() === now.getUTCDate()
      ? 'Today'
      : at.getUTCDate() === now.getUTCDate() + 1
        ? 'Tomorrow'
        : (DAYS[at.getUTCDay()] ?? '').replace(/^./, (c) => c.toUpperCase());
  return `${day} ${hh?.padStart(2, '0')}:${mm}`;
}

export function Settings() {
  const { config, thresholds, setThresholds, now, showToast } = useApp();
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
    <div className="screen screen--settings">
      <ScreenHeader title="Settings" primary={<PrimaryButton label="Save" op="config.update" onClick={() => void save()} />} />
      <div className="settings">
        <section className="settings__block">
          <span className="eyebrow">Backends</span>
          <div className="backends">
            {backends.data?.items.map((b) => (
              <BackendCard key={b.name} name={b.name} mode={b.mode} status={b.status} latencyMs={b.latencyMs} />
            ))}
          </div>
        </section>
        <section className="settings__block">
          <span className="eyebrow">Policy</span>
          <PolicyGrid thresholds={thresholds} onChange={(x) => setThresholds({ ...thresholds, ...x })} />
        </section>
        <section className="settings__block">
          <span className="eyebrow">Schedules</span>
          {SCHEDULES.map(([key, label]) => {
            const on = schedules[key] !== 'off';
            return (
              <div key={key} className="schedule">
                <span className="schedule__name">{label}</span>
                <span className="schedule__next">{on ? nextRun(schedules[key], t) : '--'}</span>
                <Toggle on={on} label={label} onChange={(v) => setSchedules({ ...schedules, [key]: v ? saved[key] : 'off' })} />
              </div>
            );
          })}
        </section>
        <section className="settings__block">
          <span className="eyebrow">Data home</span>
          <code className="mono">{PP_HOME_DEFAULT}</code>
        </section>
      </div>
    </div>
  );
}
