import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Btn, hoverClass } from './Btn';
import { AutoRow, InboxTile } from './roles';
import { C } from './theme';

/*
 * #101: hover highlights (often fg, near white) stuck after a click. Hover was JS state set on
 * mouseenter and cleared only on mouseleave, which the browser does not deliver when a button is
 * disabled under the cursor, hidden, moved after a click, or left during a drag. Hover is now CSS
 * only (under `@media (hover: hover)`), and focus rings use :focus-visible.
 */

// apps/web/src, from this file's directory (vitest gives a file path in import.meta.dirname).
const src = dirname(import.meta.dirname);
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(tsx?|css)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Selectors of every rule with its enclosing @media condition (one nesting level is all we use). */
function rules(css: string): { media: string | null; selector: string }[] {
  const out: { media: string | null; selector: string }[] = [];
  const text = stripComments(css);
  let depth = 0;
  let media: string | null = null;
  let buf = '';
  for (const ch of text) {
    if (ch === '{') {
      const head = buf.trim();
      if (head.startsWith('@media')) media = head;
      else if (!head.startsWith('@') && !/^(from|to|\d+%)/.test(head)) out.push({ media, selector: head });
      depth++;
      buf = '';
    } else if (ch === '}') {
      depth--;
      if (depth === 0) media = null;
      buf = '';
    } else if (ch === ';') buf = '';
    else buf += ch;
  }
  return out;
}

/** A :focus that is not :focus-visible / :focus-within, outside the `:focus:not(:focus-visible)` reset. */
const stickyFocus = (sel: string) => /:focus(?![-\w])(?!:not\(:focus-visible\))/.test(sel);

describe('hover and focus lint (#101)', () => {
  const css = readFileSync(join(src, 'styles.css'), 'utf8');

  it('no :focus rule without :focus-visible', () => {
    expect(stickyFocus('button:focus')).toBe(true);
    expect(stickyFocus('input:focus, a')).toBe(true);
    expect(stickyFocus('button:focus-visible')).toBe(false);
    expect(stickyFocus('.row:focus-within')).toBe(false);
    expect(stickyFocus('button:focus:not(:focus-visible)')).toBe(false);
    for (const f of sources(src).filter((p) => p.endsWith('.css'))) {
      const bad = rules(readFileSync(f, 'utf8'))
        .map((r) => r.selector)
        .filter(stickyFocus);
      expect(bad, f).toEqual([]);
    }
    for (const f of sources(src).filter((p) => /\.tsx?$/.test(p))) {
      const bad = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => /['"`][^'"`]*:focus(?![-\w])(?!:not\(:focus-visible\))/.test(l));
      expect(bad, f).toEqual([]);
    }
  });

  it('every :hover rule is guarded by @media (hover: hover)', () => {
    const hovers = rules(css).filter((r) => r.selector.includes(':hover'));
    expect(hovers.length).toBeGreaterThan(0);
    for (const r of hovers) expect(r.media, r.selector).toMatch(/\(hover:\s*hover\)/);
  });

  it('no JS hover state anywhere in the web app', () => {
    const bad: string[] = [];
    for (const f of sources(src).filter((p) => /\.tsx?$/.test(p))) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((l, i) => {
          if (/\b(onMouseEnter|onMouseLeave|onMouseOver|onMouseOut|onPointerEnter|onPointerLeave|useHover|setHover)\b/.test(l))
            bad.push(`${f}:${i + 1}: ${l.trim()}`);
        });
    }
    expect(bad).toEqual([]);
  });

  it('hover colors come from tokens, never a white literal', () => {
    for (const f of sources(src)) {
      const body = stripComments(readFileSync(f, 'utf8'));
      expect(body.match(/#fff\b|#ffffff\b|['"]white['"]|:\s*white\b/gi), f).toBeNull();
    }
  });
});

describe('Btn hover is CSS, never sticky state (#101)', () => {
  const hover = { borderColor: C['emerald-2'], color: C.fg, opacity: 1 };

  it('injects one guarded rule per hover object', () => {
    const cls = hoverClass(hover);
    expect(cls).toMatch(/^pp-h-/);
    expect(hoverClass({ ...hover })).toBe(cls);
    const sheet = document.getElementById('pp-hover')?.textContent ?? '';
    const rule = sheet.split('\n').find((l) => l.includes(`.${cls}:hover`));
    expect(rule).toContain('@media (hover: hover)');
    expect(rule).toContain(':not(:disabled)');
    expect(rule).toContain(`border-color: ${C['emerald-2']} !important;`);
    expect(rule).toContain('opacity: 1 !important;');
    expect(sheet.split('\n').filter((l) => l.includes(`.${cls}:`))).toHaveLength(1);
  });

  it('hover, click, leave and blur leave the button exactly as it started', async () => {
    const user = userEvent.setup();
    function Host() {
      const [busy, setBusy] = useState(false);
      return (
        <Btn op="local" className="chip" disabled={busy} onClick={() => setBusy(true)} hover={hover} style={{ color: C.muted }}>
          Go
        </Btn>
      );
    }
    const { container } = render(<Host />);
    const btn = container.querySelector('button') as HTMLButtonElement;
    const before = { style: btn.getAttribute('style'), cls: btn.className };
    expect(btn.getAttribute('data-op')).toBe('local');
    await user.hover(btn);
    expect(btn.getAttribute('style')).toBe(before.style);
    expect(btn.className).toBe(before.cls);
    // Click disables it under the cursor: the case that used to strand the hover style.
    await user.click(btn);
    await user.unhover(btn);
    btn.blur();
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('style')?.replace('cursor: default', 'cursor: pointer')).toBe(before.style);
    expect(btn.className).toBe(before.cls);
    expect(btn.className).not.toMatch(/\b(is-)?(hover|hovered|focus|focused)\b/);
    expect(btn.style.color).not.toBe(hexToRgb(C.fg));
  });

  it('Inbox tile Pass and activity row Undo carry no hover state after use', async () => {
    const user = userEvent.setup();
    const tile = { id: 'r1', letter: 'N', fresh: 'ok' as const, title: 'PM', co: 'Notion', fit: 80, band: 'green' };
    const { container } = render(
      <>
        <InboxTile r={tile} onPass={() => {}} />
        <AutoRow glyph="you" object="Notion" action="passed" time="1m" undoable onUndo={() => {}} />
      </>,
    );
    const pass = container.querySelector('.tile-pass') as HTMLButtonElement;
    const undo = container.querySelector('.auto-row__undo') as HTMLButtonElement;
    const row = container.querySelector('.auto-row') as HTMLElement;
    const snap = () => [pass, undo, row, container.querySelector('.inbox-tile') as HTMLElement].map((e) => e.outerHTML);
    const before = snap();
    for (const el of [pass, undo]) {
      await user.hover(el);
      await user.click(el);
      await user.unhover(el);
      el.blur();
    }
    expect(snap()).toEqual(before);
    expect(pass.style.opacity).toBe('');
    expect(row.style.background).toBe('transparent');
  });
});

function hexToRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
