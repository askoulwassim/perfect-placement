import { useState } from 'react';
import { useAct, useOp } from '../client/context';
import { DraftStatusChip, PrimaryButton } from '../components/controls';
import { BestPathPill, ContactAvatar, graphOf, PeopleGraph } from '../components/people';
import { ScreenHeader } from '../components/shell';
import { bestPath, initials, sortPeople } from '../lib/people';
import { useMobile } from '../lib/useMobile';
import { go } from '../router';

export function PeopleScreen({ roleId }: { roleId: string }) {
  const act = useAct();
  const res = useOp('roles.get', { role_id: roleId });
  const drafts = useOp('outreach.list', { role_id: roleId });
  const [selected, setSelected] = useState<string | null>(null);
  const mobile = useMobile();

  if (!res.data) return <div className="screen" aria-busy={!res.error} />;
  const { role, company, contacts } = res.data;
  const people = sortPeople(contacts);
  const best = bestPath(people);
  const { nodes, edges } = graphOf(people);
  const draftOf = (contactId: string) => drafts.data?.items.find((o) => o.contact_id === contactId);

  const openPerson = (id: string) => {
    setSelected(id);
    const o = draftOf(id);
    if (o) go({ screen: 'outreach-draft', outreachId: o.id });
  };

  const draft = async () => {
    const o = await act('runs.start', { skill: 'connect', role_id: role.id });
    if (o.status !== 'ok') return;
    const id = (o.output.run.summary_json as { outreach_id?: string | null }).outreach_id;
    if (id) go({ screen: 'outreach-draft', outreachId: id });
  };

  return (
    <div className="screen screen--people">
      <ScreenHeader
        eyebrow={role.title}
        title={company.name}
        onBack={() => go({ screen: 'role', roleId: role.id })}
        primary={best && <PrimaryButton label={`Draft for ${best.target.contact.name}`} op="runs.start" onClick={() => void draft()} />}
      >
        {best && <BestPathPill path={best.path} />}
      </ScreenHeader>
      <div className="people-layout">
        <section className="panel people-layout__graph">
          <PeopleGraph
            nodes={nodes}
            edges={edges}
            selected={selected}
            best={best ? [best.target.contact.id, ...(best.target.link.via_contact_id ? [best.target.link.via_contact_id] : [])] : []}
            onSelect={openPerson}
            height={mobile ? 320 : 420}
          />
        </section>
        <aside className="people-list">
          {people.map((p) => (
            <button
              key={p.contact.id}
              type="button"
              className={`person ${selected === p.contact.id ? 'is-selected' : ''} ${best?.target.contact.id === p.contact.id ? 'is-best' : ''}`}
              data-op="nav"
              data-contact={p.contact.id}
              onClick={() => openPerson(p.contact.id)}
            >
              <ContactAvatar initials={initials(p.contact.name)} tier={p.link.tier} size={40} />
              <span className="person__text">
                <span className="person__name">{p.contact.name}</span>
                <span className="person__role">{p.contact.headline}</span>
              </span>
              <DraftStatusChip status={draftOf(p.contact.id)?.status ?? 'none'} />
            </button>
          ))}
        </aside>
      </div>
    </div>
  );
}
