import { type ParseResult, Renderer } from '@openuidev/react-lang';
import { askLibrary } from './library';

export interface GenuiReplyProps {
  /** OpenUI Lang text, possibly partial while streaming. */
  response: string | null;
  isStreaming: boolean;
  onParseResult?: (result: ParseResult | null) => void;
}

/** A generated Ask reply: OpenUI Lang in, lane D cards out. Rendered inside the CommandBar. */
export function GenuiReply({ response, isStreaming, onParseResult }: GenuiReplyProps) {
  return <Renderer response={response} library={askLibrary} isStreaming={isStreaming} onParseResult={onParseResult} />;
}
