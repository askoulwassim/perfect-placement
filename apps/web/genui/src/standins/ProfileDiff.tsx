// STAND-IN for lane D's DiffBlock (COMPONENT_ALIASES.ProfileDiff). Replace with the real component in Wave 2.
import { IMPACT_COLOR, type Impact, tokens } from '@perfect-placement/contracts';
import { c, card, chip, eyebrow } from './style.js';

export interface ProfileDiffProps {
  id: string;
  component: string;
  before: readonly string[];
  after: readonly string[];
  impact: Impact;
}

export function ProfileDiff({ id, component, before, after, impact }: ProfileDiffProps) {
  return (
    <div data-genui="ProfileDiff" data-diff-id={id} style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={eyebrow}>{component}</span>
        <span style={chip(IMPACT_COLOR[impact])}>{impact}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.space[4], marginTop: tokens.space[2] }}>
        <ul style={{ margin: 0, paddingLeft: 16, color: c('coral') }}>
          {before.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
        <ul style={{ margin: 0, paddingLeft: 16, color: c('emerald') }}>
          {after.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
