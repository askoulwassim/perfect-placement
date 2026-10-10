import type { Run, RunStatus } from '@perfect-placement/contracts';
import { useAct, useApp, useOp } from '../client/context';
import { Btn } from '../components/Btn';
import { C, ellipsis, eyebrow, mono } from '../components/theme';
import { Screen, useLayout } from '../layout';
import { ago } from '../lib/format';
import { duration, isActive, retryInput, runLabel, runOutcome, runTabs, summaryOf, triggeredBy, wasRetried } from '../lib/runs';
import { go } from '../router';

/* Runs (#21): every skill run with its state, outcome and log. List from runs.list, detail from runs.get. */

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  ok: 'Done',
  partial: 'Partial',
  error: 'Failed',
};
export const RUN_STATUS_HEX: Record<RunStatus, string> = {
  queued: C.gold,
  running: C.emerald,
  ok: C.emerald,
  partial: C.gold,
  error: C.coral,
};

/** The status a run shows: its status, or Retried for a failed run the engine retried (#122). */
export const runStatusLabel = (r: Run): string => (wasRetried(r) ? 'Retried' : RUN_STATUS_LABEL[r.status]);

export function RunStatusChip({ status, label }: { status: RunStatus; label?: string }) {
  const c = label === 'Retried' ? C.gold : RUN_STATUS_HEX[status];
  return (
    <span
      className="run-status"
      data-status={status}
      data-retried={label === 'Retried' ? 'true' : undefined}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...eyebrow(c, 10), whiteSpace: 'nowrap' }}
    >
      <span
        className={isActive(status) ? 'run-pulse' : undefined}
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: status === 'queued' ? 'transparent' : c,
          border: `1.5px solid ${c}`,
        }}
      />
      {label ?? RUN_STATUS_LABEL[status]}
    </span>
  );
}

/** One run as a row (Runs list, Settings). */
export function RunRow({ run, now, onOpen }: { run: Run; now: Date; onOpen: () => void }) {
  const { mobile } = useLayout();
  const from = triggeredBy(run);
  // Chained runs (#30) read "after Scout"; then the role, if any.
  const scope = [from ? `after ${from.label}` : null, summaryOf(run).role_id ?? summaryOf(run).company_id].filter(Boolean).join(' · ');
  return (
    <Btn
      op={null}
      className="run-row"
      data-run-id={run.id}
      data-status={run.status}
      data-retried={wasRetried(run) ? 'true' : undefined}
      onClick={onOpen}
      style={{
        display: 'grid',
        gridTemplateColumns: mobile ? '90px minmax(0,1fr) 40px' : '110px 96px minmax(0,1fr) minmax(0,1.4fr) 56px',
        gap: 14,
        alignItems: 'center',
        width: '100%',
        minHeight: 52,
        padding: '8px 4px',
        background: 'transparent',
        border: 0,
        borderBottom: `1px solid ${C.line}`,
        color: C.fg,
        textAlign: 'left',
        fontSize: 14,
      }}
      hover={{ background: C.panel }}
    >
      <span style={{ fontWeight: 600 }}>{runLabel(run)}</span>
      {!mobile && <RunStatusChip status={run.status} label={runStatusLabel(run)} />}
      {!mobile && <span style={{ ...mono(12, C.muted), ...ellipsis }}>{scope}</span>}
      <span style={{ color: run.status === 'error' ? C.coral : C.muted, ...ellipsis }}>
        {mobile ? `${runStatusLabel(run)} · ${runOutcome(run)}` : runOutcome(run)}
      </span>
      <span style={{ ...mono(12, C.dim), textAlign: 'right' }}>{ago(run.started_at, now)}</span>
    </Btn>
  );
}

export function Runs({ runId }: { runId?: string | undefined }) {
  return runId ? <RunDetail runId={runId} /> : <RunList />;
}

function RunList() {
  const { now } = useApp();
  const list = useOp('runs.list', { limit: 50 });
  const items = list.data?.items ?? [];
  const t = now();
  return (
    <Screen label="Runs" eyebrow={`${items.length} recent`} title="Runs" back={() => go({ screen: 'settings' })}>
      <div className="run-list" style={{ maxWidth: 1000, marginTop: 28 }}>
        {items.map((r) => (
          <RunRow key={r.id} run={r} now={t} onOpen={() => go({ screen: 'runs', runId: r.id })} />
        ))}
        {list.data && !items.length && <div style={{ color: C.muted, padding: '16px 4px' }}>No runs</div>}
      </div>
    </Screen>
  );
}

function RunDetail({ runId }: { runId: string }) {
  const { now, runs, watchRun } = useApp();
  const act = useAct();
  const res = useOp('runs.get', { run_id: runId });
  // The polled copy is fresher than the fetched one while the run is in flight.
  const run = runs.find((r) => r.id === runId) ?? res.data?.run;
  if (!run) return <div data-screen-label="Run" aria-busy={!res.error} />;
  const s = summaryOf(run);
  const t = now();
  // A run the engine already retried (#122) has no Retry: its retry is linked below.
  const again = !isActive(run.status) && !wasRetried(run) ? retryInput(run) : null;
  const primary = again
    ? {
        label: 'Retry',
        op: 'runs.start' as const,
        onClick: async () => {
          const o = await act('runs.start', again);
          if (o.status !== 'ok') return;
          watchRun(o.output.run);
          go({ screen: 'runs', runId: o.output.run.id });
        },
      }
    : null;
  const facts: Array<[string, string]> = [
    ['Started', `${ago(run.started_at, t)} ago`],
    [isActive(run.status) ? 'Elapsed' : 'Took', duration(run, t)],
    ['By', String(s.actor ?? '—')],
    ...(s.role_id ? ([['Role', s.role_id]] as Array<[string, string]>) : []),
    // #107: the Chrome tabs the run used and closed.
    ...(runTabs(run) ? ([['Tabs', runTabs(run) as string]] as Array<[string, string]>) : []),
    // #122: a connector retry says which try it is.
    ...(typeof s.attempt === 'number' ? ([['Try', String(s.attempt)]] as Array<[string, string]>) : []),
  ];
  // The chain (#30): the run that queued this one, and the runs this one queued.
  const from = triggeredBy(run);
  const chain: Array<{ key: string; label: string; id: string }> = [
    ...(from ? [{ key: 'From', label: from.label, id: from.id }] : []),
    // #122: the try this run retries, and the run that retried it.
    ...(s.retry_of ? [{ key: 'Retry of', label: runLabel(run), id: s.retry_of }] : []),
    ...(s.retried ? [{ key: 'Retried', label: runLabel(run), id: s.retried }] : []),
    ...(s.triggered ?? []).map((id) => {
      const next = runs.find((r) => r.id === id);
      return { key: 'Then', label: next ? runLabel(next) : 'Run', id };
    }),
  ];
  return (
    <Screen label="Run" eyebrow={runStatusLabel(run)} title={runLabel(run)} back={() => go({ screen: 'runs' })} primary={primary}>
      <div
        className="run-detail"
        data-status={run.status}
        style={{ maxWidth: 1000, display: 'flex', flexDirection: 'column', gap: 24, marginTop: 24 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
          <RunStatusChip status={run.status} label={runStatusLabel(run)} />
          <span className="run-outcome" style={{ fontSize: 16, fontWeight: 600, color: run.status === 'error' ? C.coral : C.fg }}>
            {runOutcome(run)}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          {facts.map(([k, v]) => (
            <div key={k}>
              <div style={eyebrow(C.dim, 10)}>{k}</div>
              <div style={{ ...mono(13), marginTop: 4 }}>{v}</div>
            </div>
          ))}
          {chain.map((c) => (
            <div key={`${c.key}-${c.id}`} className="run-chain" data-chain={c.key.toLowerCase().replace(/ /g, '-')} data-run-id={c.id}>
              <div style={eyebrow(C.dim, 10)}>{c.key}</div>
              <Btn
                op={null}
                onClick={() => go({ screen: 'runs', runId: c.id })}
                style={{ ...mono(13, C.emerald), marginTop: 4, padding: 0, background: 'transparent', border: 0 }}
                hover={{ textDecoration: 'underline' }}
              >
                {c.label}
              </Btn>
            </div>
          ))}
        </div>
        {s.denied_tools?.length ? (
          <div>
            <div style={{ ...eyebrow(C.coral, 10), marginBottom: 6 }}>Denied</div>
            <div style={mono(13)}>{s.denied_tools.join(', ')}</div>
          </div>
        ) : null}
        {s.runner_log ? (
          <div>
            <div style={{ ...eyebrow(C.dim, 10), marginBottom: 6 }}>Runner output</div>
            <span className="run-runner-log" style={{ ...mono(12, C.muted), wordBreak: 'break-all' }}>
              {s.runner_log}
            </span>
          </div>
        ) : null}
        <div>
          <div style={{ ...eyebrow(), marginBottom: 10 }}>Log</div>
          <pre
            className="run-log"
            style={{
              ...mono(12, C.fg),
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: C['bg-2'],
              border: `1px solid ${C.line}`,
              borderRadius: 10,
              padding: '14px 16px',
              lineHeight: 1.6,
            }}
          >
            {res.data?.log_md?.trim() || '—'}
          </pre>
        </div>
      </div>
    </Screen>
  );
}
