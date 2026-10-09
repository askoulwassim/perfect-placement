import type { AskChatErrorCode, AskChatEvent } from '@perfect-placement/contracts';
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from 'react';
import { GenuiReply } from '../../genui/src';
import { useAct, useApp } from '../client/context';
import { Btn } from '../components/Btn';
import { WhoDecidesGlyph } from '../components/glyphs';
import { AskSuggestion, CommandBar } from '../components/shell';
import { C, mono } from '../components/theme';
import { go } from '../router';

/*
 * Ask (Cmd+K) is a real agent session (#39): every message goes to `pp up` (`POST /api/ask`), which runs
 * one turn of the configured runner with the pp MCP server and streams it back. Text renders as generated
 * UI (genui/, OpenUI Lang, the app's own cards); tool calls show as compact lines; runs the agent starts
 * link to run status and are watched like any other run. The thread lives in App, so closing Ask keeps
 * the conversation; New thread starts fresh. Suggestions only prefill a message, or run their primary op.
 */

export type AskStep =
  | { kind: 'tool'; id: string; label: string; state: 'running' | 'ok' | 'error' }
  | { kind: 'run'; runId: string; skill: string }
  | { kind: 'note'; text: string };

export interface AskTurn {
  q: string;
  steps: AskStep[];
  /** Reply text since the last tool call: prose, then OpenUI Lang from `root =`. */
  text: string;
  streaming: boolean;
  error: { code: AskChatErrorCode; message: string } | null;
}

export interface AskSession {
  threadId: string | null;
  turns: AskTurn[];
}

export const NEW_ASK: AskSession = { threadId: null, turns: [] };

type Sugg = { text: string; op: 'local' | 'runs.start'; needsRole?: boolean };
const SUGG: readonly Sugg[] = [
  { text: 'Score my inbox roles', op: 'local' },
  { text: 'Which active roles are going stale?', op: 'local' },
  { text: 'scout now', op: 'runs.start' },
  { text: 'find people for this role', op: 'local', needsRole: true },
];

const ERROR_LABEL: Record<AskChatErrorCode, string> = {
  runner_missing: 'Runner missing',
  not_logged_in: 'Not signed in',
  runner_failed: 'Agent failed',
  busy: 'Still answering',
  invalid_input: 'Bad message',
  unavailable: 'No agent',
};

/** Prose before the first `root =` line, and the OpenUI Lang from it on. */
export function splitReply(text: string): { prose: string; lang: string } {
  const m = /^\s*root\s*=/m.exec(text);
  if (!m) return { prose: text.trim(), lang: '' };
  return { prose: text.slice(0, m.index).trim(), lang: text.slice(m.index).trimStart() };
}

export function Ask({
  roleId,
  screen,
  session,
  onSession,
  onClose,
}: {
  roleId: string | null;
  screen: string | null;
  session: AskSession;
  onSession: Dispatch<SetStateAction<AskSession>>;
  onClose: () => void;
}) {
  const { client, watchRun } = useApp();
  const act = useAct();
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const thread = useRef(session.threadId);
  thread.current = session.threadId;
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const last = (f: (t: AskTurn) => AskTurn) =>
    onSession((s) => ({ ...s, turns: s.turns.map((t, i) => (i === s.turns.length - 1 ? f(t) : t)) }));

  const follow = async (runId: string) => {
    const o = await client.run('runs.get', { run_id: runId });
    if (o.status === 'ok') watchRun(o.output.run);
  };

  const apply = (e: AskChatEvent) => {
    switch (e.type) {
      case 'thread':
        return onSession((s) => ({ ...s, threadId: e.thread_id }));
      case 'text':
        return last((t) => ({ ...t, text: t.text + e.delta }));
      case 'tool':
        return last((t) => ({
          ...t,
          text: '',
          steps: [
            ...t.steps,
            ...(t.text.trim() ? [{ kind: 'note' as const, text: t.text.trim() }] : []),
            { kind: 'tool', id: e.id, label: e.op ?? e.name, state: 'running' },
          ],
        }));
      case 'tool_result':
        return last((t) => ({
          ...t,
          steps: t.steps.map((s) => (s.kind === 'tool' && s.id === e.id ? { ...s, state: e.ok ? 'ok' : 'error' } : s)),
        }));
      case 'run':
        void follow(e.run_id);
        return last((t) => ({ ...t, steps: [...t.steps, { kind: 'run', runId: e.run_id, skill: e.skill }] }));
      case 'error':
        return last((t) => ({ ...t, streaming: false, error: { code: e.code, message: e.message } }));
      case 'done':
        return last((t) => ({ ...t, streaming: false }));
    }
  };

  const begin = (q: string) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    onSession((s) => ({ ...s, turns: [...s.turns, { q, steps: [], text: '', streaming: true, error: null }] }));
    return ctrl;
  };

  const send = async (text: string) => {
    const q = text.trim();
    if (!q) return;
    setQuery('');
    const ctrl = begin(q);
    if (!client.ask) return apply({ type: 'error', code: 'unavailable', message: 'no agent behind this client' });
    const req = {
      message: q,
      ...(thread.current ? { thread_id: thread.current } : {}),
      context: { ...(screen ? { screen } : {}), ...(roleId ? { role_id: roleId } : {}) },
    };
    for await (const e of client.ask(req, ctrl.signal)) {
      if (ctrl.signal.aborted) return;
      apply(e);
    }
    if (!ctrl.signal.aborted) last((t) => (t.streaming ? { ...t, streaming: false } : t));
  };

  /** A suggestion with a primary op runs it at once (no agent turn needed). */
  const scoutNow = async (q: string) => {
    begin(q);
    const o = await act('runs.start', { skill: 'scout' });
    if (o.status === 'ok') {
      watchRun(o.output.run);
      last((t) => ({ ...t, streaming: false, steps: [{ kind: 'run', runId: o.output.run.id, skill: 'scout' }] }));
    } else
      last((t) => ({
        ...t,
        streaming: false,
        error: { code: 'runner_failed', message: o.status === 'error' ? o.message : 'queued for you' },
      }));
  };

  const prefill = (text: string) => {
    setQuery(text);
    input.current?.focus();
  };

  const fresh = () => {
    abort.current?.abort();
    onSession(NEW_ASK);
    input.current?.focus();
  };

  const turns = session.turns;
  const streaming = turns.some((t) => t.streaming);
  const body = turns.length > 0 && (
    <div
      ref={scroller}
      className="ask__reply"
      data-state={streaming ? 'streaming' : 'done'}
      style={{
        background: C.panel,
        border: `1px solid ${C['line-2']}`,
        borderRadius: 12,
        padding: 18,
        maxHeight: '60vh',
        overflow: 'auto',
        animation: 'ppIn .25s ease',
        display: 'grid',
        gap: 18,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: -10 }}>
        <Btn
          op="local"
          className="ask__new"
          onClick={fresh}
          style={{ ...mono(11, C.muted), background: 'none', border: `1px solid ${C['line-2']}`, borderRadius: 6, padding: '3px 8px' }}
          hover={{ color: C.emerald, borderColor: C['emerald-2'] }}
        >
          New thread
        </Btn>
      </div>
      {turns.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: turns only append
        <TurnView key={i} turn={t} />
      ))}
    </div>
  );

  return (
    <CommandBar
      query={query}
      onQuery={setQuery}
      onSubmit={() => void send(query)}
      onClose={onClose}
      inputRef={input}
      reply={body}
      suggestions={SUGG.filter((s) => !s.needsRole || roleId).map((s) => (
        <AskSuggestion
          key={s.text}
          text={s.text}
          op={s.op}
          onRun={() => (s.op === 'runs.start' ? void scoutNow(s.text) : prefill(s.text))}
        />
      ))}
    />
  );
}

function TurnView({ turn }: { turn: AskTurn }) {
  const { prose, lang } = splitReply(turn.text);
  return (
    <div
      className="ask__turn"
      data-state={turn.streaming ? 'streaming' : turn.error ? 'error' : 'done'}
      style={{ display: 'grid', gap: 10 }}
    >
      <div style={mono(12, C.muted)}>› {turn.q}</div>
      {turn.steps.map((s, i) =>
        s.kind === 'note' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: steps only append
          <div key={i} className="ask__note" style={{ fontSize: 13, color: C.muted }}>
            {s.text}
          </div>
        ) : s.kind === 'tool' ? (
          <div
            key={s.id}
            className="ask__step"
            data-state={s.state}
            style={{ display: 'flex', alignItems: 'center', gap: 8, ...mono(12, C.dim) }}
          >
            <span style={{ color: s.state === 'error' ? C.coral : s.state === 'ok' ? C.emerald : C.dim, width: 12 }}>
              {s.state === 'running' ? '·' : s.state === 'ok' ? '✓' : '×'}
            </span>
            <span>{s.label}</span>
          </div>
        ) : (
          <Btn
            key={s.runId}
            op={null}
            className="ask__run"
            data-run-id={s.runId}
            onClick={() => go({ screen: 'runs', runId: s.runId })}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: 14,
              background: C['bg-2'],
              border: 0,
              borderRadius: 10,
              color: C.fg,
              textAlign: 'left',
            }}
            hover={{ background: C.line }}
          >
            <WhoDecidesGlyph kind="auto" />
            <span style={mono(13)}>{s.skill}</span>
            <span style={{ flex: 1 }} />
            <span style={mono(12, C.muted)}>{s.runId}</span>
          </Btn>
        ),
      )}
      {prose && <p style={{ margin: 0, fontSize: 15, color: C.fg }}>{prose}</p>}
      {lang && <GenuiReply response={lang} isStreaming={turn.streaming} />}
      {turn.streaming && !turn.text && !turn.steps.length && <div style={mono(12, C.dim)}>...</div>}
      {turn.error && (
        <div className="ask__error" data-code={turn.error.code} style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 14, color: C.coral }}>{ERROR_LABEL[turn.error.code]}</span>
          <span style={mono(12, C.muted)}>{turn.error.message}</span>
        </div>
      )}
    </div>
  );
}
