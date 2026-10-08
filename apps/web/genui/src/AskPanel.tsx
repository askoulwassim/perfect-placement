/*
 * Ask panel shell (spike). Lane D owns the real CommandBar (states collapsed | input | streaming);
 * this shell only shows where the OpenUI <Renderer> slots in. Wave 2: render <AskReply> inside lane D's CommandBar.
 */

import { type ActionEvent, type ParseResult, Renderer } from '@openuidev/react-lang';
import { tokens } from '@perfect-placement/contracts';
import { type FormEvent, useCallback, useRef, useState } from 'react';
import { type GenuiData, GenuiDataContext } from './data.js';
import { askLibrary } from './library.js';
import { c, card, eyebrow } from './standins/style.js';

export type AskFn = (query: string, signal: AbortSignal) => AsyncIterable<string>;

export interface AskReplyProps {
  response: string | null;
  isStreaming: boolean;
  onParseResult?: (result: ParseResult | null) => void;
  onAction?: (event: ActionEvent) => void;
}

/** The generated reply: OpenUI Lang text in, our cards out. */
export function AskReply({ response, isStreaming, onParseResult, onAction }: AskReplyProps) {
  return <Renderer response={response} library={askLibrary} isStreaming={isStreaming} onParseResult={onParseResult} onAction={onAction} />;
}

export interface AskPanelProps {
  data: GenuiData;
  ask: AskFn;
  initialQuery?: string;
  onDone?: (response: string) => void;
  onParseResult?: (result: ParseResult | null) => void;
}

type PanelState = 'input' | 'streaming';

export function AskPanel({ data, ask, initialQuery = '', onDone, onParseResult }: AskPanelProps) {
  const [query, setQuery] = useState(initialQuery);
  const [response, setResponse] = useState<string | null>(null);
  const [state, setState] = useState<PanelState>('input');
  const abort = useRef<AbortController | null>(null);

  const run = useCallback(
    async (q: string) => {
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      setState('streaming');
      setResponse('');
      let text = '';
      for await (const chunk of ask(q, ctrl.signal)) {
        if (ctrl.signal.aborted) return;
        text += chunk;
        setResponse(text);
      }
      setState('input');
      onDone?.(text);
    },
    [ask, onDone],
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim()) void run(query.trim());
  };

  return (
    <GenuiDataContext value={data}>
      <div
        data-genui="AskPanel"
        data-state={state}
        style={{ ...card, background: c('bg-2'), width: tokens.layout.decisionCardMax, display: 'grid', gap: tokens.space[6] }}
      >
        <form onSubmit={submit}>
          <label style={eyebrow} htmlFor="genui-ask">
            Ask
          </label>
          <input
            id="genui-ask"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ ...card, width: '100%', boxSizing: 'border-box', marginTop: tokens.space[2], fontSize: tokens.type['body-lg'].size }}
          />
        </form>
        <AskReply response={response} isStreaming={state === 'streaming'} onParseResult={onParseResult} />
      </div>
    </GenuiDataContext>
  );
}
