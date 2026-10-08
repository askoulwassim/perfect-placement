import { useState } from 'react';
import { useAct, useApp, useOp } from '../client/context';
import { Btn } from '../components/Btn';
import { AffinityChip, STATUS_LABEL, StatusChip } from '../components/controls';
import { FreshnessRing, RoleTile } from '../components/glyphs';
import { ScoreRadar, StageRail } from '../components/meters';
import { BestPathPill, ContactAvatar, TIER_ORDER, TIER_VIS } from '../components/people';
import { C, display, eyebrow, mono, tab } from '../components/theme';
import { Screen, useLayout } from '../layout';
import { ago, compRange, humanize } from '../lib/format';
import { bestPath, initials } from '../lib/people';
import { criteriaOf, freshOf } from '../lib/role';
import { STAGE_SKILL, STAGES, stageOf } from '../lib/stage';
import { type DocLine, docLines, tile } from '../lib/view';
import { go } from '../router';

const TABS = [
  ['dossier', 'Dossier'],
  ['resume', 'Resume'],
  ['cover_letter', 'Cover'],
  ['fit_map', 'Fit map'],
  ['answers', 'Answers'],
] as const;
type Tab = (typeof TABS)[number][0];

export function RoleScreen({ roleId }: { roleId: string }) {
  const { now, config, showToast, watchRun } = useApp();
  const { mobile } = useLayout();
  const act = useAct();
  const res = useOp('roles.get', { role_id: roleId });
  const drafts = useOp('outreach.list', { role_id: roleId });
  const [tabId, setTab] = useState<Tab>('dossier');
  const t = now();

  const data = res.data;
  const app = data?.application ?? null;
  const paths: Partial<Record<Tab, string>> = { ...(app?.package_paths_json ?? {}) };
  if (data?.company.md_path) paths.dossier = data.company.md_path;
  const doc = useOp('vault.read', paths[tabId] ? { path: paths[tabId] as string } : null);

  if (!data) return <div data-screen-label="Role" aria-busy={!res.error} />;

  const { role, company, latest_score: score, contacts } = data;
  const tl = tile(data, t, config.scoring);
  const best = bestPath(contacts);
  const stage = stageOf(role, app, best && drafts.data?.items.find((o) => o.contact_id === best.target.contact.id));
  const skill = stage >= 0 && stage < 4 ? STAGE_SKILL[stage] : null;
  const fresh = freshOf(role, t);
  const freshColor = fresh === 'ok' ? C.emerald : fresh === 'unsure' ? C.gold : fresh === 'closed' ? C.coral : C['line-2'];
  const checked = role.last_checked_at ? ago(role.last_checked_at, t) : '—';
  const facts: Array<[string, string]> = [
    ['Mode', role.workplace],
    ['Comp', compRange(role) ?? '—'],
    ['Level', role.seniority ?? '—'],
    ['Posted', role.posted_at ? ago(role.posted_at, t) : '—'],
    ['Source', humanize(role.source)],
  ];
  const draftOf = (cid: string) => drafts.data?.items.find((o) => o.contact_id === cid);
  const openPerson = (cid: string) => {
    const o = draftOf(cid);
    if (o) go({ screen: 'outreach-draft', outreachId: o.id });
    else go({ screen: 'people', roleId: role.id });
  };

  const primary =
    stage === 4
      ? {
          label: 'Open portal',
          op: null,
          onClick: () => {
            const url = app?.portal_url ?? role.url;
            if (url) window.open(url, '_blank', 'noopener');
            showToast('Portal opened · you submit');
          },
        }
      : skill
        ? {
            label: STAGES[stage] as string,
            op: 'runs.start' as const,
            onClick: async () => {
              const label = STAGES[stage] as string;
              const o = await act('runs.start', { skill, role_id: role.id });
              if (o.status !== 'ok') return;
              watchRun(o.output.run.id, (run) => showToast(run.status === 'error' ? `${label} failed` : `${label} done`));
              if (skill === 'connect') go({ screen: 'people', roleId: role.id });
              else showToast(`${label} started`);
            },
          }
        : { label: 'Open River', op: null, onClick: () => go({ screen: 'river' }) };

  const tabs = (m: boolean) => (
    <div
      role="tablist"
      style={{
        display: 'flex',
        gap: m ? 2 : 4,
        overflowX: m ? 'auto' : undefined,
        borderBottom: `1px solid ${C.line}`,
        marginTop: m ? 26 : 0,
      }}
    >
      {TABS.map(([id, n]) => {
        const on = tabId === id;
        return (
          <Btn
            key={id}
            op="local"
            role="tab"
            aria-selected={on}
            onClick={() => setTab(id)}
            style={{
              background: 'none',
              border: 0,
              borderBottom: `2px solid ${on ? C.emerald : 'transparent'}`,
              color: on ? C.fg : C.muted,
              padding: m ? '12px 10px' : '12px 16px',
              fontSize: m ? 13 : 14,
              fontWeight: 600,
              marginBottom: -1,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              whiteSpace: 'nowrap',
            }}
          >
            {!m && <span style={{ width: 6, height: 6, borderRadius: '50%', background: paths[id] ? C.emerald : C['line-2'] }} />}
            {n}
          </Btn>
        );
      })}
    </div>
  );
  const lines = docLines(paths[tabId] ? doc.data?.markdown : null);
  const bestPill = (m: boolean) =>
    best && (
      <BestPathPill
        mobile={m}
        initials={initials(best.target.contact.name)}
        name={best.target.contact.name}
        tier={best.target.link.tier}
        via={best.path.slice(1, -1)}
        onClick={() => openPerson(best.target.contact.id)}
      />
    );

  if (mobile)
    return (
      <Screen
        label="Role · mobile"
        eyebrow={`${company.name} · ${STATUS_LABEL[role.status]}`}
        title={role.title}
        back={() => window.history.back()}
        primary={primary}
      >
        <StageRail mobile stage={stage} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <RoleTile letter={tl.letter} fresh={tl.fresh} size={52} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{company.name}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
              <StatusChip small status={role.status} />
              <span style={mono(10, C.muted)}>{checked}</span>
            </div>
          </div>
          <div style={display(52, 800, '-0.05em')}>{tl.fit ?? '—'}</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <AffinityChip compact value={score?.affinity_mod ?? company.affinity} />
        </div>
        <div style={{ width: 260, height: 260, margin: '18px auto 26px' }}>
          {score && <ScoreRadar criteria={criteriaOf(score)} size={300} />}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {facts.map(([k, v]) => (
            <span
              key={k}
              style={{
                background: C.panel,
                border: `1px solid ${C.line}`,
                borderRadius: 999,
                padding: '6px 11px',
                fontSize: 12,
                display: 'flex',
                gap: 6,
              }}
            >
              <span style={{ ...eyebrow(C.dim, 9), paddingTop: 2 }}>{k}</span>
              {v}
            </span>
          ))}
        </div>
        {bestPill(true)}
        {tabs(true)}
        <div
          style={{
            marginTop: 14,
            background: C['bg-2'],
            border: `1px solid ${C.line}`,
            borderRadius: 12,
            padding: 18,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <Doc lines={lines} compact />
        </div>
      </Screen>
    );

  return (
    <Screen
      label="Role"
      eyebrow={`${company.name} · ${STATUS_LABEL[role.status]}`}
      title={role.title}
      back={() => window.history.back()}
      primary={primary}
    >
      <StageRail stage={stage} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
        <RoleTile letter={tl.letter} fresh={tl.fresh} size={72} />
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 20, fontWeight: 600 }}>{company.name}</div>
          <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <StatusChip status={role.status} />
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, ...mono(12, C.muted) }}>
              <FreshnessRing color={freshColor} />
              checked {checked}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ width: 14, height: 14, borderRadius: '50%', background: tl.band }} />
          <div className="fit-number" style={{ ...display(84, 800, '-0.05em'), lineHeight: 0.9, ...tab }}>
            {tl.fit ?? '—'}
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.1fr) minmax(0,0.8fr) minmax(0,1fr)', gap: 44, marginTop: 44 }}>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={eyebrow()}>Score</div>
            <AffinityChip value={score?.affinity_mod ?? company.affinity} />
          </div>
          <div style={{ width: '100%', maxWidth: 330, aspectRatio: '1', margin: '30px auto 0' }}>
            {score && <ScoreRadar criteria={criteriaOf(score)} size={320} />}
          </div>
        </div>
        <div>
          <div style={{ ...eyebrow(), marginBottom: 16 }}>Facts</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {facts.map(([k, v]) => (
              <span
                key={k}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  background: C.panel,
                  border: `1px solid ${C.line}`,
                  borderRadius: 999,
                  padding: '8px 14px',
                  fontSize: 14,
                }}
              >
                <span style={eyebrow(C.dim, 10)}>{k}</span>
                {v}
              </span>
            ))}
          </div>
        </div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={eyebrow()}>People</div>
            <Btn
              op={null}
              onClick={() => go({ screen: 'people', roleId: role.id })}
              style={{ background: 'none', border: 0, color: C.muted, fontSize: 13 }}
              hover={{ color: C.emerald }}
            >
              Graph →
            </Btn>
          </div>
          {bestPill(false)}
          {TIER_ORDER.map((tier) => {
            const ps = contacts.filter((p) => p.link.tier === tier);
            return (
              <div key={tier} style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12 }}>
                <div style={{ ...eyebrow(C.dim, 10), width: 104, flex: 'none' }}>{TIER_VIS[tier].label}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {ps.map((p) => (
                    <Btn
                      key={p.contact.id}
                      op={null}
                      title={p.contact.name}
                      data-contact={p.contact.id}
                      onClick={() => openPerson(p.contact.id)}
                      style={{ background: 'none', border: 0, padding: 0, borderRadius: '50%' }}
                      hover={{ filter: 'brightness(1.3)' }}
                    >
                      <ContactAvatar initials={initials(p.contact.name)} tier={p.link.tier} />
                    </Btn>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ marginTop: 52 }}>
        {tabs(false)}
        <div
          style={{
            marginTop: 20,
            maxWidth: 880,
            background: C['bg-2'],
            border: `1px solid ${C.line}`,
            borderRadius: 12,
            padding: '28px 32px',
          }}
        >
          <div style={{ ...mono(11, C.dim), marginBottom: 22 }}>{paths[tabId] ?? '—'}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Doc lines={lines} />
          </div>
        </div>
      </div>
    </Screen>
  );
}

/** Prototype document preview: heading, key, text, chips, skeleton bars. */
export function Doc({ lines, compact }: { lines: readonly DocLine[]; compact?: boolean }) {
  return (
    <>
      {lines.map((l, i) => {
        const k = `${l.t}-${i}`;
        switch (l.t) {
          case 'h':
            return (
              <div key={k} style={display(compact ? 20 : 26, 700, compact ? 'normal' : '-0.02em')}>
                {l.text}
              </div>
            );
          case 's':
            return (
              <div key={k} style={{ fontSize: compact ? 13 : 15, color: C.muted, marginTop: compact ? 0 : -6 }}>
                {l.text}
              </div>
            );
          case 'k':
            return (
              <div key={k} style={{ ...eyebrow(C.emerald, compact ? 9.5 : 10), letterSpacing: '.12em', marginTop: compact ? 6 : 10 }}>
                {l.text}
              </div>
            );
          case 't':
            return (
              <div key={k} style={{ fontSize: compact ? 13 : 15 }}>
                {l.text}
              </div>
            );
          case 'b':
            return <div key={k} style={{ height: compact ? 7 : 8, borderRadius: 4, background: C.line, width: l.w }} />;
          case 'c':
            return (
              <div key={k} style={{ display: 'flex', gap: compact ? 6 : 8, flexWrap: 'wrap' }}>
                {l.chips.map((c) => (
                  <span
                    key={c}
                    style={{
                      border: `1px solid ${C['line-2']}`,
                      borderRadius: 999,
                      padding: compact ? '4px 10px' : '5px 12px',
                      fontSize: compact ? 12 : 13,
                    }}
                  >
                    {c}
                  </span>
                ))}
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}
