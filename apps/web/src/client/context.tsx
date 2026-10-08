import {
  DEFAULT_CONFIG,
  OPS,
  type OpName,
  type OpOutcome,
  type PolicyConfig,
  type Run,
  type Thresholds,
} from '@perfect-placement/contracts';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { In, OpClient, Out } from './types';

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
  toast: string | null;
  showToast: (t: string) => void;
  /**
   * Follow a run started with `runs.start` (the headless agent does the work out of process):
   * polls `runs.get` until it leaves `running`, then refreshes every read and calls `onDone`.
   */
  watchRun: (runId: string, onDone?: (run: Run) => void) => void;
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
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const showToast = useCallback((t: string) => {
    setToast(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2400);
  }, []);

  const watched = useRef(new Map<string, ((run: Run) => void) | undefined>());
  const [watching, setWatching] = useState(0);
  const watchRun = useCallback((runId: string, onDone?: (run: Run) => void) => {
    watched.current.set(runId, onDone);
    setWatching(watched.current.size);
  }, []);
  useEffect(() => {
    if (!watching) return;
    let busy = false;
    const id = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        for (const [runId, onDone] of [...watched.current]) {
          const o = await client.run('runs.get', { run_id: runId });
          if (o.status === 'ok' && o.output.run.status === 'running') continue;
          watched.current.delete(runId);
          bump();
          if (o.status === 'ok') onDone?.(o.output.run);
        }
      } finally {
        busy = false;
        setWatching(watched.current.size);
      }
    }, pollMs);
    return () => clearInterval(id);
  }, [watching, client, pollMs, bump]);

  useEffect(() => {
    void version;
    let live = true;
    void client.run('config.get', {}).then((o) => {
      if (live && o.status === 'ok') {
        setConfig(o.output);
        setThresholds(o.output.policy);
      }
    });
    return () => {
      live = false;
    };
  }, [client, version]);

  const value = useMemo<Ctx>(
    () => ({ client, version, bump, now: now ?? (() => new Date()), config, thresholds, setThresholds, toast, showToast, watchRun }),
    [client, version, bump, now, config, thresholds, toast, showToast, watchRun],
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
