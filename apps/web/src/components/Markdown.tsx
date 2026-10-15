import MarkdownIt from 'markdown-it';
import type { CSSProperties, ReactNode } from 'react';
import { C, display, eyebrow, mono } from './theme';

/*
 * Package documents (#35): markdown-it parses, React renders. `html: false` escapes any raw HTML in a
 * document, and nothing here uses innerHTML, so no document markup ever executes. Links open in a new tab
 * and only http(s) and mailto survive. Styled with the prototype's document tokens (the old Doc lines).
 */

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

type Token = ReturnType<typeof md.parse>[number];
interface MdNode {
  tok: Token;
  children: Array<MdNode | string>;
}

const SAFE_HREF = /^(https?:|mailto:)/i;

function tree(tokens: readonly Token[]): Array<MdNode | string> {
  const root: MdNode = { tok: null as unknown as Token, children: [] };
  const stack: MdNode[] = [root];
  for (const tok of tokens) {
    const top = stack[stack.length - 1] as MdNode;
    if (tok.nesting === 1) {
      const n: MdNode = { tok, children: [] };
      top.children.push(n);
      stack.push(n);
    } else if (tok.nesting === -1) stack.pop();
    else if (tok.type === 'inline') top.children.push(...tree(tok.children ?? []));
    else if (tok.type === 'text') top.children.push(tok.content);
    else top.children.push({ tok, children: [] });
  }
  return root.children;
}

interface Sizes {
  text: number;
  code: number;
}

function render(nodes: ReadonlyArray<MdNode | string>, z: Sizes, compact: boolean, key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    if (typeof n === 'string') return n;
    const kids = () => render(n.children, z, compact, `${k}.`);
    const { tok } = n;
    switch (tok.type) {
      case 'heading_open': {
        const H = tok.tag as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
        const style: CSSProperties =
          H === 'h1'
            ? display(compact ? 20 : 26, 700, compact ? 'normal' : '-0.02em')
            : H === 'h2' || H === 'h3'
              ? { ...eyebrow(C.emerald, compact ? 9.5 : 10), fontWeight: 400, letterSpacing: '.12em', marginTop: compact ? 6 : 10 }
              : { fontSize: z.text, fontWeight: 700 };
        return (
          <H key={k} style={{ margin: 0, ...style }}>
            {kids()}
          </H>
        );
      }
      case 'paragraph_open':
        // Tight list items hide their paragraph wrapper.
        if (tok.hidden) return <span key={k}>{kids()}</span>;
        return (
          <p key={k} style={{ margin: 0, fontSize: z.text, lineHeight: 1.55 }}>
            {kids()}
          </p>
        );
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const style: CSSProperties = {
          margin: 0,
          paddingLeft: 20,
          fontSize: z.text,
          lineHeight: 1.55,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        };
        return tok.type === 'ordered_list_open' ? (
          <ol key={k} start={Number(tok.attrGet('start') ?? 1)} style={style}>
            {kids()}
          </ol>
        ) : (
          <ul key={k} style={style}>
            {kids()}
          </ul>
        );
      }
      case 'list_item_open':
        return <li key={k}>{kids()}</li>;
      case 'blockquote_open':
        return (
          <blockquote
            key={k}
            style={{
              margin: 0,
              paddingLeft: 14,
              borderLeft: `2px solid ${C['line-2']}`,
              color: C.muted,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {kids()}
          </blockquote>
        );
      case 'table_open':
        return (
          <div key={k} style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: z.text - 1 }}>{kids()}</table>
          </div>
        );
      case 'thead_open':
        return <thead key={k}>{kids()}</thead>;
      case 'tbody_open':
        return <tbody key={k}>{kids()}</tbody>;
      case 'tr_open':
        return <tr key={k}>{kids()}</tr>;
      case 'th_open':
        return (
          <th
            key={k}
            style={{ ...eyebrow(C.dim, 10), textAlign: 'left', padding: '6px 12px 8px 0', borderBottom: `1px solid ${C['line-2']}` }}
          >
            {kids()}
          </th>
        );
      case 'td_open':
        return (
          <td key={k} style={{ padding: '8px 12px 8px 0', borderBottom: `1px solid ${C.line}`, verticalAlign: 'top', lineHeight: 1.45 }}>
            {kids()}
          </td>
        );
      case 'strong_open':
        return (
          <strong key={k} style={{ fontWeight: 700, color: C.fg }}>
            {kids()}
          </strong>
        );
      case 'em_open':
        return <em key={k}>{kids()}</em>;
      case 's_open':
        return <s key={k}>{kids()}</s>;
      case 'link_open': {
        const href = String(tok.attrGet('href') ?? ''); // v15 types attrs as string | number
        if (!SAFE_HREF.test(href)) return <span key={k}>{kids()}</span>;
        return (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer" data-op="nav">
            {kids()}
          </a>
        );
      }
      case 'code_inline':
        return (
          <code
            key={k}
            style={{ ...mono(z.code), background: C.panel, border: `1px solid ${C.line}`, borderRadius: 4, padding: '1px 5px' }}
          >
            {tok.content}
          </code>
        );
      case 'fence':
      case 'code_block':
        return (
          <pre
            key={k}
            style={{
              ...mono(z.code),
              margin: 0,
              background: C.panel,
              border: `1px solid ${C.line}`,
              borderRadius: 8,
              padding: '10px 12px',
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {tok.content}
          </pre>
        );
      case 'softbreak':
        return ' ';
      case 'hardbreak':
        return <br key={k} />;
      case 'hr':
        return <div key={k} style={{ height: 1, background: C.line }} />;
      case 'image':
        // No remote fetches from a document: the alt text stands in.
        return tok.content || null;
      default:
        return n.children.length ? <span key={k}>{kids()}</span> : null;
    }
  });
}

/** A package document as rendered markdown blocks (children of the doc preview's flex column). */
export function Markdown({ source, compact }: { source: string; compact?: boolean }) {
  const z: Sizes = compact ? { text: 13, code: 12 } : { text: 15, code: 13 };
  return <>{render(tree(md.parse(source, {})), z, !!compact)}</>;
}

/** One line of inline markdown (bold, italics, links, code) without block wrappers. */
export function InlineMarkdown({ source, compact }: { source: string; compact?: boolean }) {
  const z: Sizes = compact ? { text: 13, code: 12 } : { text: 15, code: 13 };
  return <>{render(tree(md.parseInline(source, {})), z, !!compact)}</>;
}
