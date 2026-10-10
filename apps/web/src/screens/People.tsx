import { useAct, useApp, useOp } from '../client/context';
import { ConnectFallbackBar, DraftList, PathChoice, PeopleGraph, PersonRow, TIER_ORDER } from '../components/people';
import { eyebrow } from '../components/theme';
import { Screen, useLayout } from '../layout';
import { bestPath, draftFor, draftOnPath, emailTag, initials, linkedinState, recipientOf } from '../lib/people';
import { activeLabel } from '../lib/runs';
import { stageOf } from '../lib/stage';
import { graphLayout } from '../lib/view';
import { go } from '../router';

export function PeopleScreen({ roleId }: { roleId: string }) {
  const { mobile } = useLayout();
  const act = useAct();
  const { watchRun, activeRun, showToast } = useApp();
  const res = useOp('roles.get', { role_id: roleId });
  const drafts = useOp('outreach.list', { role_id: roleId });
  // #82: did the agent really read LinkedIn for this role? From the latest people.find run.
  const finds = useOp('runs.list', { op: 'people.find', limit: 200 });

  if (!res.data) return <div data-screen-label="People" aria-busy={!res.error} />;
  const { role, company, contacts } = res.data;
  const people = [...contacts].sort((a, b) => TIER_ORDER.indexOf(a.link.tier) - TIER_ORDER.indexOf(b.link.tier));
  const best = bestPath(people);
  // #131: every person in the search is a node (mutuals included), from the engine's graph.
  const g = graphLayout(res.data.graph);
  const draftOf = (cid: string) => draftFor(drafts.data?.items, cid);
  const open = (cid: string) => {
    if (cid === g.co) return go({ screen: 'role', roleId: role.id });
    const o = draftOf(cid);
    if (o) go({ screen: 'outreach-draft', outreachId: o.id });
  };
  const draft = async (contactId: string) => {
    const o = await act('runs.start', { skill: 'connect', role_id: role.id, contact_id: contactId });
    if (o.status !== 'ok') return;
    // A connect run names the draft it wrote in summary_json.outreach_id.
    watchRun(o.output.run, (run) => {
      const id = (run.summary_json as { outreach_id?: string | null }).outreach_id;
      if (id) go({ screen: 'outreach-draft', outreachId: id });
    });
  };
  const drafting = best && activeRun({ skill: 'connect', role_id: role.id, contact_id: best.target.contact.id });
  const primary = best
    ? {
        // #98: named for who the note goes to (the mutual on a bridge).
        label: drafting ? activeLabel(drafting) : `Draft for ${recipientOf(best.target).name.split(' ')[0]}`,
        op: 'runs.start' as const,
        disabled: !!drafting,
        onClick: () => void draft(best.target.contact.id),
      }
    : null;
  const header = {
    eyebrow: `${company.name} · ${people.length} people`,
    title: 'People',
    back: () => go({ screen: 'role', roleId: role.id }),
  };
  // #78: the no-contact fallback used, and Skip while the role is on the Connect stage.
  const bestDraft = best ? draftOf(best.target.contact.id) : null;
  const onConnect = stageOf(role, res.data.application, bestDraft, !!company.md_path) === 2;
  const fallback = (
    <ConnectFallbackBar
      mobile={mobile}
      fallback={res.data.connect?.fallback ?? null}
      onSkip={
        onConnect
          ? async () => {
              const o = await act('apply.skip_connect', { role_id: role.id, reason: 'user' });
              if (o.status === 'ok') showToast('Connect skipped');
            }
          : null
      }
    />
  );
  // #98: direct vs bridge for the best target. Use picks the path the primary drafts; the other path's
  // draft stays (each draft is filed under its recipient), so both can exist.
  const bestPaths = best?.target.paths ?? null;
  const pathChoice =
    best && bestPaths ? (
      <PathChoice
        mobile={mobile}
        paths={bestPaths}
        status={(path) => draftOnPath(drafts.data?.items, best.target.contact.id, path)?.status ?? 'none'}
        onPick={async (path) => {
          await act('people.set_path', { contact_id: best.target.contact.id, role_id: role.id, path });
        }}
      />
    ) : null;
  // #98: every draft for the role, per recipient (a bridge intro names the target it is about).
  const draftList = drafts.data?.items.length ? (
    <DraftList
      mobile={mobile}
      items={drafts.data.items.map((o) => ({
        id: o.id,
        recipient: o.recipient_name,
        about: o.about_name,
        status: o.status,
      }))}
      onOpen={(id) => go({ screen: 'outreach-draft', outreachId: id })}
    />
  ) : null;
  const li = finds.data ? linkedinState(finds.data.items, role.id) : null;
  const linkedin = li ? (
    <div className="people-linkedin" data-linkedin={li.read ? 'read' : 'not-read'} style={{ ...eyebrow(), margin: '4px 0 12px 12px' }}>
      {li.label}
      {li.read ? null : <span data-reason={li.reason}>{` · ${li.reason}`}</span>}
    </div>
  ) : null;
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
      email={emailTag(p.contact)}
      onOpen={() => open(p.contact.id)}
    />
  ));

  if (mobile)
    return (
      <Screen label="People · mobile" {...header} primary={primary}>
        {fallback}
        {g.nodes.length > 2 && <PeopleGraph mobile nodes={g.nodes} edges={g.edges} bestTarget={g.best} onOpen={open} />}
        {pathChoice}
        {linkedin}
        <div className="people-list" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {rows}
        </div>
        {draftList}
      </Screen>
    );

  return (
    <Screen label="People" {...header} primary={primary}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 32, marginTop: 28 }}>
        <PeopleGraph nodes={g.nodes} edges={g.edges} bestTarget={g.best} onOpen={open} />
        <div style={{ flex: '0 1 340px', minWidth: 300 }}>
          {fallback}
          {pathChoice}
          {linkedin}
          <div style={{ ...eyebrow(), margin: '4px 0 12px 12px' }}>List</div>
          <div className="people-list" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {rows}
          </div>
          {draftList}
        </div>
      </div>
    </Screen>
  );
}
