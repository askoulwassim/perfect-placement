// Generates dist/tokens.css from the compiled tokens module. Run after tsc.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { tokens } = await import(new URL('../dist/tokens.js', import.meta.url).href);
const lines = [];
const v = (name, value) => lines.push(`  --pp-${name}: ${value};`);

for (const [k, val] of Object.entries(tokens.color)) v(`color-${k}`, val);
for (const [k, val] of Object.entries(tokens.tint)) v(`tint-${k}`, val);
v('ground-glow', tokens.groundGlow);
for (const [k, val] of Object.entries(tokens.font)) v(`font-${k}`, val);
for (const [k, s] of Object.entries(tokens.type)) {
  v(`type-${k}-font`, `var(--pp-font-${s.font})`);
  v(`type-${k}-size`, `${s.size}px`);
  v(`type-${k}-weight`, s.weight);
  if (s.tracking) v(`type-${k}-tracking`, s.tracking);
  if (s.lineHeight) v(`type-${k}-line-height`, s.lineHeight);
}
tokens.space.forEach((px, i) => {
  v(`space-${i}`, `${px}px`);
});
for (const [k, val] of Object.entries(tokens.layout)) v(`layout-${k}`, `${val}px`);
for (const [k, val] of Object.entries(tokens.radius)) v(`radius-${k}`, `${val}px`);
for (const [k, val] of Object.entries(tokens.control)) v(`control-${k}`, `${val}px`);
v('focus-ring', `${tokens.focus.width}px solid ${tokens.focus.color}`);
v('focus-offset', `${tokens.focus.offset}px`);
for (const [k, val] of Object.entries(tokens.motion)) v(`motion-${k}`, val);

const css = `/* Generated from packages/contracts/src/tokens.ts. Do not edit. */\n:root {\n${lines.join('\n')}\n  color-scheme: dark;\n}\n`;
writeFileSync(fileURLToPath(new URL('../dist/tokens.css', import.meta.url)), css);
