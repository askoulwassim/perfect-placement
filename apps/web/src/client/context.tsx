import {
  DEFAULT_CONFIG,
  DEFAULT_GUIDE,
  type GuideState,
  OPS,
  type OpName,
  type OpOutcome,
  type PolicyConfig,
  type Run,
  type Thresholds,
} from '@perfect-placement/contracts';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { GuideStepId } from '../lib/guide';
import { isActive, matches, type RunScope, runToast } from '../lib/runs';
import { go } from '../router';
import type { In, OpClient, Out } from './types';

export interface GuideCue {
  step: GuideStepId;
  at: string;
}

export interface ToastAction {
  label: string;
  onClick: () => void;
}
export interface ToastState {
  text: string;
  tone: 'ok' | 'error';
  action?: ToastAction;
}
export interface ToastOptions {
  tone?: 'ok' | 'error';
  action?: ToastAction;
  /** How long it stays (ms). Default 2400; errors 6000. */
  ms?: number;
}

/** Recent runs polled for the global indicator and the per-screen button states. */
const RUNS_WINDOW = 20;

interface Ctx {
  client: OpClient;
  /** Bumps after every write so reads refetch. */
  version: number;
  bump: () => void;
  now: () => Date;
  config: PolicyConfig;
  /** Live thresholds (Settings drags recolor every ProbabilityBar before Save). */
  thresholds: Thresholds;
  setThresholds: (t: Thresholds) => void;
  toast: ToastState | null;
  showToast: (t: string, opts?: ToastOptions) => void;
  /**
   * Follow a run started with `runs.start` (the headless agent does the work out of process): it shows
   * as in progress at once, then the runs poll sees it end, refreshes every read, toasts the outcome
   * (counts, or the failure reason with a link to its log) and calls `onDone`.
   */
  watchRun: (run: Run, onDone?: (run: Run) => void) => void;
  /**
   * Recent runs (newest first), polled with `runs.list`: every `pollMs` while one is queued or
   * running, every `10 x pollMs` otherwise (runs started elsewhere: schedules, the CLI, an agent).
   */
  runs: readonly Run[];
  /** The queued or running run a start button is scoped to, if any. */
  activeRun: (scope: RunScope) => Run | undefined;
  /**
   * Getting started flags (#24), from `config.ui.guide`. `null` until config has loaded (no guide shows
   * before we know).
   */
  guide: GuideState | null;
  /** Set guide flags for good: saved in the vault with `config.update`; in memory when that fails (mock). */
  markGuide: (patch: Partial<GuideState>) => void;
  /**
   * The step whose one-sentence cue shows on arrival at `at` (the step's route href): set by the Getting
   * started card, cleared by any click or by leaving that route.
   */
  guideCue: GuideCue | null;
  setGuideCue: (c: GuideCue | null) => void;
}

const AppCtx = createContext<Ctx | null>(null);

export interface ClientProviderProps {
  client: OpClient;
  now?: () => Date;
  /** Run polling interval (ms). */
  pollMs?: number;
  children: ReactNode;
}

export function ClientProvider({ client, now, pollMs = 2000, children }: ClientProviderProps) {
  const [version, setVersion] = useState(0);
  const [config, setConfig] = useState<PolicyConfig>(DEFAULT_CONFIG);
  const [thresholds, setThresholds] = useState<Thresholds>(DEFAULT_CONFIG.policy);
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const showToast = useCallback((t: string, opts: ToastOptions = {}) => {
    const tone = opts.tone ?? 'ok';
    setToast({ text: t, tone, ...(opts.action ? { action: opts.action } : {}) });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), opts.ms ?? (tone === 'error' ? 6000 : 2400));
  }, []);

  // ---- runs: one poll loop for the indicator, button states, done/failed toasts and watchers.
  const [runs, setRuns] = useState<readonly Run[]>([]);
  const runsRef = useRef<readonly Run[]>([]);
  /** Runs seen queued or running (by a poll or a watchRun): their end is toasted. */
  const inFlight = useRef(new Set<string>());
  const watched = useRef(new Map<string, ((run: Run) => void) | undefined>());
  const [kick, setKick] = useState(0);
  const putRuns = useCallback((rs: readonly Run[]) => {
    runsRef.current = rs;
    setRuns(rs);
  }, []);
  const watchRun = useCallback(
    (run: Run, onDone?: (run: Run) => void) => {
      watched.current.set(run.id, onDone);
      if (isActive(run.status)) inFlight.current.add(run.id);
      putRuns([run, ...runsRef.current.filter((r) => r.id !== run.id)]);
      setKick((k) => k + 1);
    },
    [putRuns],
  );
  const ended = useCallback(
    (run: Run) => {
      inFlight.current.delete(run.id);
      const onDone = watched.current.get(run.id);
      watched.current.delete(run.id);
      const t = runToast(run);
      showToast(t.text, {
        tone: t.tone,
        ...(t.tone === 'error' ? { action: { label: 'Log', onClick: () => go({ screen: 'runs', runId: run.id }) } } : {}),
      });
      onDone?.(run);
    },
    [showToast],
  );
  useEffect(() => {
    void kick;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const o = await client.run('runs.list', { limit: RUNS_WINDOW });
      if (!live) return;
      if (o.status === 'ok') {
        const list = [...o.output.items];
        // A watched run outside the window (or not listed yet): fetch it on its own.
        for (const id of watched.current.keys()) {
          if (list.some((r) => r.id === id)) continue;
          const g = await client.run('runs.get', { run_id: id });
          if (!live) return;
          if (g.status === 'ok') list.unshift(g.output.run);
          else if (g.status === 'error' && g.code === 'not_found') watched.current.delete(id);
        }
        const done = list.filter((r) => !isActive(r.status) && inFlight.current.has(r.id));
        for (const r of list) if (isActive(r.status)) inFlight.current.add(r.id);
        putRuns(list);
        if (done.length) {
          bump();
          for (const r of done) ended(r);
        }
      }
      const busy = runsRef.current.some((r) => isActive(r.status)) || watched.current.size > 0;
      timer = setTimeout(() => void tick(), busy ? pollMs : pollMs * 10);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [client, pollMs, bump, ended, putRuns, kick]);
  const activeRun = useCallback((scope: RunScope) => runs.find((r) => isActive(r.status) && matches(r, scope)), [runs]);

  // Guide flags live apart from `config` so saving one never resets a screen's unsaved config edits.
  const [guide, setGuide] = useState<GuideState | null>(null);
  const guideRef = useRef<GuideState | null>(null);
  /** True once a save failed (mock, offline): the in-memory flags are then the truth. */
  const guideLocal = useRef(false);
  const guideSaving = useRef(0);
  const [guideCue, setGuideCue] = useState<GuideCue | null>(null);
  const putGuide = useCallback((g: GuideState) => {
    guideRef.current = g;
    setGuide(g);
  }, []);
  const markGuide = useCallback(
    (patch: Partial<GuideState>) => {
      const cur = guideRef.current ?? DEFAULT_GUIDE;
      if (Object.entries(patch).every(([k, v]) => cur[k as keyof GuideState] === v)) return;
      const next = { ...cur, ...patch };
      putGuide(next);
      // Not through useAct: no refetch, no toast. The mock refuses writes; the flags stay in memory.
      guideSaving.current++;
      void client
        .run('config.update', { patch: { ui: { guide: patch } } })
        .finally(() => {
          guideSaving.current--;
        })
        .then((o) => {
          if (o.status !== 'ok') guideLocal.current = true;
        });
    },
    [client, putGuide],
  );

  useEffect(() => {
    void version;
    let live = true;
    void client.run('config.get', {}).then((o) => {
      if (live && o.status === 'ok') {
        setConfig(o.output);
        setThresholds(o.output.policy);
        const stored = o.output.ui?.guide ?? DEFAULT_GUIDE;
        // The vault wins, unless a save is in flight or failed (mock): then flags set in memory are kept.
        const cur = guideRef.current;
        const keep = cur && (guideLocal.current || guideSaving.current > 0);
        putGuide(
          keep ? { policy: cur.policy || stored.policy, review: cur.review || stored.review, done: cur.done || stored.done } : stored,
        );
      }
    });
    return () => {
      live = false;
    };
  }, [client, version, putGuide]);

  const value = useMemo<Ctx>(
    () => ({
      client,
      version,
      bump,
      now: now ?? (() => new Date()),
      config,
      thresholds,
      setThresholds,
      toast,
      showToast,
      watchRun,
      runs,
      activeRun,
      guide,
      markGuide,
      guideCue,
      setGuideCue,
    }),
    [client, version, bump, now, config, thresholds, toast, showToast, watchRun, runs, activeRun, guide, markGuide, guideCue],
  );
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error('ClientProvider missing');
  return c;
}

export interface OpState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
}

/** Read op, refetched after every write. Pass `null` as input to skip. */
export function useOp<N extends OpName>(name: N, input: In<N> | null): OpState<Out<N>> {
  const { client, version } = useApp();
  const key = input === null ? null : JSON.stringify(input);
  const [state, setState] = useState<OpState<Out<N>>>({ data: undefined, error: null, loading: key !== null });
  useEffect(() => {
    void version;
    if (key === null) return;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    void client.run(name, JSON.parse(key) as In<N>).then((o) => {
      if (!live) return;
      if (o.status === 'ok') setState({ data: o.output, error: null, loading: false });
      else setState({ data: undefined, error: o.status === 'error' ? o.code : 'requires_human', loading: false });
    });
    return () => {
      live = false;
    };
  }, [client, name, key, version]);
  return state;
}

export const TOAST_FOR: Record<string, string> = {
  requires_human: 'Queued for you',
  forbidden_transition: 'Not allowed',
  human_only: 'Yours to do',
  unimplemented: 'Not available',
  backend_unavailable: 'Offline',
};

/**
 * Write op. One call per button. Refreshes every read after a write (so the Needs-you badge and
 * queue pick up a `requires_human` decision) and toasts non-ok outcomes.
 */
export function useAct() {
  const { client, bump, showToast } = useApp();
  return useCallback(
    async <N extends OpName>(name: N, input: In<N>): Promise<OpOutcome<Out<N>>> => {
      const o = await client.run(name, input);
      if (!OPS[name]?.readOnly || o.status === 'requires_human') bump();
      if (o.status === 'requires_human') showToast(TOAST_FOR.requires_human as string);
      if (o.status === 'error') showToast(TOAST_FOR[o.code] ?? 'Failed');
      return o;
    },
    [client, bump, showToast],
  );
}
