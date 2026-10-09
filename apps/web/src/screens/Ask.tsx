import { useEffect, useRef, useState } from 'react';
import { composeReply, GenuiReply, scriptedStream } from '../../genui/src';
import { useAct, useApp } from '../client/context';
import { WhoDecidesGlyph } from '../components/glyphs';
import { AskSuggestion, CommandBar } from '../components/shell';
import { C, mono } from '../components/theme';

/*
 * Ask (Cmd+K). Replies are generated UI (genui/, OpenUI Lang) rendered with the app's own cards,
 * streamed into the CommandBar. Query understanding is the agent's job; locally a few intents
 * compose a reply from op reads (genui/src/compose.ts). Scout keeps the prototype's run row.
 */

type Reply = { kind: 'genui'; q: string; text: string; streaming: boolean } | { kind: 'scout'; q: string };

const SUGG = [
  ['Which active roles are going stale?', 'local'],
  ['scout now', 'runs.start'],
  ['check freshness', 'local'],
  ['find people for this role', 'local'],
] as const;

/** Local replies stream at a model-like pace. */
const PACE = { tokensPerSecond: 240, chunkTokens: 3 } as const;

export function Ask({ roleId, onClose }: { roleId: string | null; onClose: () => void }) {
  const { client, now, watchRun } = useApp();
  const act = useAct();
  const [query, setQuery] = useState('');
  const [reply, setReply] = useState<Reply | null>(null);
  const [shown, setShown] = useState(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const scoutKey = reply?.kind === 'scout' ? reply.q : '';
  useEffect(() => {
    if (!scoutKey) return;
    setShown(0);
    const id = setInterval(() => setShown((n) => (n >= 4 ? n : n + 1)), 260);
    return () => clearInterval(id);
  }, [scoutKey]);

  const run = async (text: string) => {
    const tx = text.trim();
    if (!tx) return;
    setQuery('');
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    if (tx.toLowerCase().includes('scout')) {
      const o = await act('runs.start', { skill: 'scout' });
      if (o.status === 'ok') watchRun(o.output.run);
      setReply({ kind: 'scout', q: tx });
      return;
    }
    const full = await composeReply(tx, { client, now: now(), roleId });
    if (ctrl.signal.aborted) return;
    let acc = '';
    setReply({ kind: 'genui', q: tx, text: '', streaming: true });
    for await (const chunk of scriptedStream(full, { ...PACE, signal: ctrl.signal })) {
      acc += chunk;
      setReply({ kind: 'genui', q: tx, text: acc, streaming: true });
    }
    if (!ctrl.signal.aborted) setReply({ kind: 'genui', q: tx, text: full, streaming: false });
  };

  const body = reply && (
    <div
      className="ask__reply"
      data-state={reply.kind === 'genui' && reply.streaming ? 'streaming' : 'done'}
      style={{
        background: C.panel,
        border: `1px solid ${C['line-2']}`,
        borderRadius: 12,
        padding: 18,
        maxHeight: '60vh',
        overflow: 'auto',
        animation: 'ppIn .25s ease',
      }}
    >
      <div style={{ ...mono(12, C.muted), marginBottom: 14 }}>› {reply.q}</div>
      {reply.kind === 'genui' && <GenuiReply response={reply.text} isStreaming={reply.streaming} />}
      {reply.kind === 'scout' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 14, background: C['bg-2'], borderRadius: 10 }}>
          <WhoDecidesGlyph kind="auto" />
          <span style={mono(13)}>role-scout</span>
          <div style={{ flex: 1, height: 4, borderRadius: 4, background: C.line, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.min(100, shown * 25)}%`, background: C.emerald, transition: 'width .25s' }} />
          </div>
          <span style={mono(12, C.muted)}>{Math.min(100, shown * 25)}%</span>
        </div>
      )}
    </div>
  );

  return (
    <CommandBar
      query={query}
      onQuery={setQuery}
      onSubmit={() => void run(query)}
      onClose={onClose}
      reply={body}
      suggestions={SUGG.filter(([text]) => !text.includes('people') || roleId).map(([text, op]) => (
        <AskSuggestion key={text} text={text} op={op} onRun={() => void run(text)} />
      ))}
    />
  );
}
