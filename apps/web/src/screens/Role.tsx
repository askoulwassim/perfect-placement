import { useState } from 'react';
import { useAct, useApp, useOp } from '../client/context';
import { AffinityChip, Chip, PrimaryButton, StatusChip } from '../components/controls';
import { BandDot, FreshnessRing, RoleTile } from '../components/glyphs';
import { ScoreRadar, StageRail } from '../components/meters';
import { BestPathPill, ContactAvatar } from '../components/people';
import { ScreenHeader } from '../components/shell';
import { ago, compRange, fit, humanize } from '../lib/format';
import { bestPath, initials, sortPeople } from '../lib/people';
import { criteriaOf, freshOf } from '../lib/role';
import { STAGE_SKILL, STAGES, stageOf } from '../lib/stage';
import { go } from '../router';

const TABS = [
  { id: 'dossier', label: 'Dossier' },
  { id: 'resume', label: 'Resume' },
  { id: 'cover_letter', label: 'Cover' },
  { id: 'fit_map', label: 'Fit map' },
  { id: 'answers', label: 'Answers' },
] as const;
type Tab = (typeof TABS)[number]['id'];

export function RoleScreen({ roleId }: { roleId: string }) {
  const { now, config } = useApp();
  const act = useAct();
  const res = useOp('roles.get', { role_id: roleId });
  const [tab, setTab] = useState<Tab>('dossier');
  const t = now();

  const data = res.data;
  const app = data?.application ?? null;
  const paths: Partial<Record<Tab, string>> = { ...(app?.package_paths_json ?? {}) };
  if (data?.company.md_path) paths.dossier = data.company.md_path;
  const doc = useOp('vault.read', paths[tab] ? { path: paths[tab] as string } : null);

  if (res.error) return <div className="screen" />;
  if (!data) return <div className="screen" aria-busy="true" />;

  const { role, company, latest_score: score, contacts } = data;
  const f = fit(score?.total);
  const stage = stageOf(role, app);
  const skill = stage >= 0 && stage < 4 ? STAGE_SKILL[stage] : null;
  const best = bestPath(contacts);
  const facts = [
    { label: humanize(role.workplace) },
    compRange(role) && { label: compRange(role) as string },
    role.seniority && { label: role.seniority },
    role.posted_at && { label: 'Posted', value: ago(role.posted_at, t) },
    { label: humanize(role.source) },
    role.location && { label: role.location },
  ].filter(Boolean) as Array<{ label: string; value?: string }>;

  const runStage = async () => {
    if (!skill) return;
    const o = await act('runs.start', { skill, role_id: role.id });
    if (o.status === 'ok' && skill === 'connect') go({ screen: 'people', roleId: role.id });
  };

  const primary =
    stage === 4 ? (
      <PrimaryButton
        label="Open portal"
        op={null}
        onClick={() => {
          const url = app?.portal_url ?? role.url;
          if (url) window.open(url, '_blank', 'noopener');
        }}
      />
    ) : skill ? (
      <PrimaryButton label={STAGES[stage] as string} op="runs.start" onClick={() => void runStage()} />
    ) : null;

  const byTier = sortPeople(contacts);

  return (
    <div className="screen screen--role">
      <ScreenHeader
        title={
          <span className="role-head">
            <RoleTile letter={company.name} fresh={freshOf(role, t)} size={56} />
            <span className="role-head__text">
              <span className="eyebrow">{company.name}</span>
              <span>{role.title}</span>
            </span>
          </span>
        }
        onBack={() => window.history.back()}
        primary={primary}
      />
      <div className="role-meta">
        <span className="fit-number">{f ?? '--'}</span>
        <BandDot fit={f} bands={config.scoring} size={14} />
        <StatusChip status={role.status} />
        <span className="role-meta__fresh">
          <FreshnessRing fresh={freshOf(role, t)} size={22} />
          <span className="eyebrow">{role.last_checked_at ? `Checked ${ago(role.last_checked_at, t)}` : 'Unchecked'}</span>
        </span>
      </div>
      <StageRail stage={stage} />
      <div className="role-grid">
        <section className="panel role-grid__radar">
          {score ? <ScoreRadar criteria={criteriaOf(score)} size={280} /> : <span className="dim">--</span>}
          <AffinityChip value={score?.affinity_mod ?? company.affinity} />
        </section>
        <section className="role-grid__facts">
          {facts.map((x) => (
            <Chip key={`${x.label}${x.value ?? ''}`} variant="fact" label={x.label} value={x.value} />
          ))}
        </section>
        <section className="panel role-grid__people">
          <span className="eyebrow">People</span>
          <button type="button" className="people-mini" data-op="nav" onClick={() => go({ screen: 'people', roleId: role.id })}>
            {byTier.map((p) => (
              <span key={p.contact.id} className={best?.target.contact.id === p.contact.id ? 'is-best' : ''}>
                <ContactAvatar initials={initials(p.contact.name)} tier={p.link.tier} size={36} />
              </span>
            ))}
            {byTier.length === 0 && <span className="dim">0</span>}
          </button>
          {best && <BestPathPill path={best.path} />}
        </section>
      </div>
      <section className="pkg">
        <div className="tabs" role="tablist">
          {TABS.map((x) => (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={tab === x.id}
              className={`tab ${tab === x.id ? 'is-active' : ''}`}
              data-op="local"
              disabled={!paths[x.id]}
              onClick={() => setTab(x.id)}
            >
              {x.label}
            </button>
          ))}
        </div>
        <div className="pkg__doc" role="tabpanel">
          {paths[tab] && doc.data?.markdown ? <MdPreview md={doc.data.markdown} /> : <span className="dim">--</span>}
        </div>
      </section>
    </div>
  );
}

/** Minimal markdown preview: headings, list items, paragraphs. Text only, no HTML injection. */
export function MdPreview({ md }: { md: string }) {
  const blocks = md
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        const key = `${i}-${b.slice(0, 12)}`;
        const h = b.match(/^(#{1,3})\s+(.*)$/);
        if (h) return h[1] === '#' ? <h3 key={key}>{h[2]}</h3> : <h4 key={key}>{h[2]}</h4>;
        if (/^[-*]\s/m.test(b))
          return (
            <ul key={key}>
              {b.split('\n').map((li) => (
                <li key={li}>{li.replace(/^[-*]\s+/, '')}</li>
              ))}
            </ul>
          );
        return <p key={key}>{b}</p>;
      })}
    </div>
  );
}
