import { useAct, useApp, useOp } from '../client/context';
import { PeopleGraph, PersonRow, TIER_ORDER } from '../components/people';
import { eyebrow } from '../components/theme';
import { Screen, useLayout } from '../layout';
import { bestPath, initials } from '../lib/people';
import { graphLayout } from '../lib/view';
import { go } from '../router';

export function PeopleScreen({ roleId }: { roleId: string }) {
  const { mobile } = useLayout();
  const act = useAct();
  const { showToast, watchRun } = useApp();
  const res = useOp('roles.get', { role_id: roleId });
  const drafts = useOp('outreach.list', { role_id: roleId });

  if (!res.data) return <div data-screen-label="People" aria-busy={!res.error} />;
  const { role, company, contacts } = res.data;
  const people = [...contacts].sort((a, b) => TIER_ORDER.indexOf(a.link.tier) - TIER_ORDER.indexOf(b.link.tier));
  const best = bestPath(people);
  const draftOf = (cid: string) => drafts.data?.items.find((o) => o.contact_id === cid);
  const open = (cid: string) => {
    if (cid === 'co') return go({ screen: 'role', roleId: role.id });
    const o = draftOf(cid);
    if (o) go({ screen: 'outreach-draft', outreachId: o.id });
  };
  const draft = async (contactId: string) => {
    const o = await act('runs.start', { skill: 'connect', role_id: role.id, contact_id: contactId });
    if (o.status !== 'ok') return;
    showToast('Drafting');
    // A connect run names the draft it wrote in summary_json.outreach_id.
    watchRun(o.output.run.id, (run) => {
      const id = (run.summary_json as { outreach_id?: string | null }).outreach_id;
      if (id) go({ screen: 'outreach-draft', outreachId: id });
    });
  };
  const primary = best
    ? {
        label: `Draft for ${best.target.contact.name.split(' ')[0]}`,
        op: 'runs.start' as const,
        onClick: () => void draft(best.target.contact.id),
      }
    : null;
  const header = {
    eyebrow: `${company.name} · ${people.length} people`,
    title: 'People',
    back: () => go({ screen: 'role', roleId: role.id }),
  };
  const rows = people.map((p) => (
    <PersonRow
      key={p.contact.id}
      mobile={mobile}
      id={p.contact.id}
      ini={initials(p.contact.name)}
      name={p.contact.name}
      role={p.contact.headline ?? ''}
      tier={p.link.tier}
      status={draftOf(p.contact.id)?.status ?? 'none'}
      best={best?.target.contact.id === p.contact.id}
      onOpen={() => open(p.contact.id)}
    />
  ));

  if (mobile)
    return (
      <Screen label="People · mobile" {...header} primary={primary}>
        <div className="people-list" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {rows}
        </div>
      </Screen>
    );

  const g = graphLayout(people, { letter: company.name.slice(0, 1), name: company.name });
  return (
    <Screen label="People" {...header} primary={primary}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 32, marginTop: 28 }}>
        <PeopleGraph nodes={g.nodes} edges={g.edges} bestTarget={g.best} onOpen={open} />
        <div style={{ flex: '0 1 340px', minWidth: 300 }}>
          <div style={{ ...eyebrow(), margin: '4px 0 12px 12px' }}>List</div>
          <div className="people-list" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {rows}
          </div>
        </div>
      </div>
    </Screen>
  );
}
