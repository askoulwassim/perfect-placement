import type { Contact, ContactLink } from '@perfect-placement/contracts';
import { buildRoleGraph } from '@perfect-placement/engine/graph';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { graphLayout } from '../lib/view';
import { PeopleGraph } from './people';

/* #131: PeopleGraph renders the engine's graph. Synthetic people only. */

const contact = (id: string, name: string): Contact => ({
  id,
  name,
  headline: null,
  linkedin_url: null,
  email: null,
  source: 'linkedin',
  notes: null,
  email_source: null,
  email_confidence: null,
});
const link = (contactId: string, l: Partial<ContactLink>): ContactLink => ({
  id: `cl_${contactId}`,
  contact_id: contactId,
  company_id: 'blitzco',
  role_id: 'blitzco_pm',
  degree: '2',
  tier: 'bridge',
  via_contact_id: null,
  is_hiring_team: true,
  path: null,
  via_tie_json: null,
  ...l,
});
const known = [contact('ct_m1', 'Ivo Lark'), contact('ct_m2', 'Bea Quill')];
const graph = (people: Array<{ contact: Contact; link: ContactLink }>) =>
  graphLayout(buildRoleGraph({ company: { id: 'blitzco', name: 'Blitzco' }, people, contactById: (id) => known.find((c) => c.id === id) }));

const nodesOf = (el: HTMLElement) => Array.from(el.querySelectorAll('.graph__node')).map((n) => n.getAttribute('data-node'));
const edgesOf = (el: HTMLElement) => Array.from(el.querySelectorAll('.graph__edge')).map((n) => n.getAttribute('data-edge'));

describe('PeopleGraph (#131)', () => {
  it('StackBlitz-like: me, the mutual with no role link, the target and the company; the bridge path highlighted', () => {
    const g = graph([{ contact: contact('ct_t', 'Noa Fenn'), link: link('ct_t', { via_contact_id: 'ct_m1' }) }]);
    const { container } = render(<PeopleGraph nodes={g.nodes} edges={g.edges} bestTarget={g.best} />);
    expect(nodesOf(container)).toEqual(['me', 'ct_m1', 'ct_t', 'co:blitzco']);
    expect(edgesOf(container)).toEqual(['best', 'best', 'best']);
    expect(container.textContent).toContain('Ivo Lark');
    expect(g.best).toBe('ct_t');
  });

  it('several mutuals and targets: one node each, alternatives muted', () => {
    const g = graph([
      { contact: contact('ct_t1', 'Noa Fenn'), link: link('ct_t1', { via_contact_id: 'ct_m1' }) },
      { contact: contact('ct_t2', 'Rui Dax'), link: link('ct_t2', { via_contact_id: 'ct_m2' }) },
      { contact: contact('ct_d', 'Ada Pine'), link: link('ct_d', { degree: '1', tier: 'warm_other', is_hiring_team: false }) },
    ]);
    const { container } = render(<PeopleGraph nodes={g.nodes} edges={g.edges} bestTarget={g.best} />);
    const ids = nodesOf(container);
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    // me->Ada, me->Ivo, me->Bea, Ivo->Noa, Bea->Rui, Noa->co, Rui->co, Ada->co.
    expect(container.querySelectorAll('.graph__edge')).toHaveLength(8);
    expect(edgesOf(container).filter((k) => k === 'best')).toHaveLength(3);
    expect(g.edges.filter((e) => e.muted)).toHaveLength(5);
  });

  it('phone width: fits the frame, no legend, first names', () => {
    const g = graph([{ contact: contact('ct_t', 'Noa Fenn'), link: link('ct_t', { via_contact_id: 'ct_m1' }) }]);
    const { container } = render(<PeopleGraph mobile nodes={g.nodes} edges={g.edges} bestTarget={g.best} />);
    const frame = container.querySelector<HTMLElement>('.people-graph');
    expect(frame?.style.minWidth).toBe('');
    expect(frame?.style.width).toBe('100%');
    expect(nodesOf(container)).toHaveLength(4);
    expect(container.textContent).toContain('Ivo');
    expect(container.textContent).not.toContain('Ivo Lark');
    const lefts = Array.from(container.querySelectorAll<HTMLElement>('.graph__node')).map((n) => Number.parseFloat(n.style.left));
    expect(Math.min(...lefts)).toBeGreaterThan(10);
    expect(Math.max(...lefts)).toBeLessThan(91);
  });
});
