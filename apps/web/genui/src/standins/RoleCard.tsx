// STAND-IN for lane D's RoleCard (contracts ui.ts COMPONENTS.RoleCard). Replace with the real component in Wave 2.
import { BAND_COLOR, type Band, type RoleStatus, STATUS_COLOR, tokens } from '@perfect-placement/contracts';
import { c, card, chip, eyebrow } from './style.js';

export interface RoleCardProps {
  id: string;
  company: string;
  title: string;
  status: RoleStatus;
  total: number | null;
  band: Band | null;
  workplace: string;
}

export function RoleCard({ id, company, title, status, total, band, workplace }: RoleCardProps) {
  return (
    <article data-genui="RoleCard" data-role-id={id} style={{ ...card, display: 'flex', gap: tokens.space[6], alignItems: 'center' }}>
      <div style={{ flex: 1 }}>
        <div style={eyebrow}>{company}</div>
        <div style={{ fontSize: tokens.type.title.size, fontWeight: tokens.type.title.weight }}>{title}</div>
        <div style={{ display: 'flex', gap: tokens.space[2], marginTop: tokens.space[2] }}>
          <span style={chip(STATUS_COLOR[status])}>{status}</span>
          <span style={chip('dim')}>{workplace}</span>
        </div>
      </div>
      <div
        data-band={band ?? 'none'}
        style={{
          fontFamily: tokens.font.display,
          fontSize: tokens.type['card-number'].size,
          fontWeight: 800,
          color: band ? c(BAND_COLOR[band]) : c('dim'),
        }}
      >
        {total === null ? '--' : Math.round(total)}
      </div>
    </article>
  );
}
