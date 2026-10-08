// STAND-IN for lane D's ContactAvatar + name (COMPONENT_ALIASES.ContactCard). Replace with the real component in Wave 2.
import { type ContactTier, TIER_RING, tokens } from '@perfect-placement/contracts';
import { c, card, eyebrow } from './style.js';

export interface ContactCardProps {
  id: string;
  name: string;
  headline: string | null;
  tier: ContactTier | null;
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

export function ContactCard({ id, name, headline, tier }: ContactCardProps) {
  const ring = tier ? TIER_RING[tier] : { color: 'dim' as const, dashed: true };
  return (
    <div
      data-genui="ContactCard"
      data-contact-id={id}
      data-tier={tier ?? 'none'}
      style={{ ...card, display: 'flex', gap: tokens.space[4] }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: '50%',
          border: `2px ${ring.dashed ? 'dashed' : 'solid'} ${c(ring.color)}`,
          display: 'grid',
          placeItems: 'center',
          fontFamily: tokens.font.mono,
        }}
      >
        {initials(name)}
      </div>
      <div>
        <div style={{ fontWeight: 600 }}>{name}</div>
        {headline ? <div style={eyebrow}>{headline}</div> : null}
      </div>
    </div>
  );
}
