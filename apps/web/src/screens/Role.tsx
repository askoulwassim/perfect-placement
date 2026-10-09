import type { Skill } from '@perfect-placement/contracts';
import { useState } from 'react';
import { useAct, useApp, useOp } from '../client/context';
import { Btn } from '../components/Btn';
import { AffinityChip, SecondaryButton, STATUS_LABEL, StatusChip } from '../components/controls';
import { FreshnessRing, RoleTile } from '../components/glyphs';
import { InlineMarkdown, Markdown } from '../components/Markdown';
import { CriterionSources, ScoreRadar, StageRail } from '../components/meters';
import { BestPathPill, ConnectFallbackBar, ContactAvatar, TIER_ORDER, TIER_VIS } from '../components/people';
import { C, display, eyebrow, mono, tab } from '../components/theme';
import { Screen, useLayout } from '../layout';
import { ago, compRange, humanize } from '../lib/format';
import { bestPath, draftFor, initials } from '../lib/people';
import { criteriaOf, freshOf, sourcesOf } from '../lib/role';
import { activeLabel, scoreInput, scoreRunFor } from '../lib/runs';
import { STAGE_SKILL, STAGES, stageOf } from '../lib/stage';
import { answerLines, DOC_SKELETON, type DocLine, tile } from '../lib/view';
import { go } from '../router';

const TABS = [
  ['dossier', 'Dossier'],
  ['resume', 'Resume'],
  ['cover_letter', 'Cover'],
  ['fit_map', 'Fit map'],
  ['answers', 'Answers'],
] as const;
type Tab = (typeof TABS)[number][0];
/** The stage (index into STAGES) that fills each tab (#36). */
const TAB_STAGE: Record<Tab, number> = { dossier: 0, resume: 1, cover_letter: 1, fit_map: 1, answers: 3 };

export function RoleScreen({ roleId }: { roleId: string }) {
  const { now, config, showToast, watchRun, activeRun, runs } = useApp();
  const { mobile } = useLayout();
  const act = useAct();
  const res = useOp('roles.get', { role_id: roleId });
  const drafts = useOp('outreach.list', { role_id: roleId });
  const [tabId, setTab] = useState<Tab>('dossier');
  const [pasted, setPasted] = useState('');
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
  const stage = stageOf(role, app, best && draftFor(drafts.data?.items, best.target.contact.id), !!company.md_path);
  const skill = stage >= 0 && stage < 4 ? STAGE_SKILL[stage] : null;
  // Connect runs are per person (People shows them); Research, Tailor and Fill are per role.
  const runOf = (s: Skill | null | undefined) =>
    s && s !== 'connect'
      ? activeRun({ skill: s, role_id: role.id, ...(s === 'research' ? { company_id: role.company_id } : {}) })
      : undefined;
  const inFlight = runOf(skill);
  const start = async (s: Skill) => {
    const o = await act('runs.start', { skill: s, role_id: role.id });
    if (o.status !== 'ok') return;
    watchRun(o.output.run);
    if (s === 'connect') go({ screen: 'people', roleId: role.id });
  };
  /** An empty tab or section: the stage that fills it and that stage's button, or its queued or running state (#36). */
  const slot = (i: number, m: boolean) => {
    const s = STAGE_SKILL[i] ?? null;
    const run = runOf(s);
    return (
      <div className="stage-slot" data-stage={STAGES[i]} style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, ...eyebrow(C.muted, m ? 9.5 : 10) }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', border: `1.5px solid ${i === stage ? C.emerald : C['line-2']}` }} />
          From {STAGES[i]}
        </span>
        {s && stage >= 0 && (
          <SecondaryButton
            op="runs.start"
            height={m ? 32 : 34}
            label={run ? activeLabel(run) : (STAGES[i] as string)}
            disabled={!!run}
            onClick={() => start(s)}
            style={{ fontSize: m ? 12 : 13 }}
          />
        )}
      </div>
    );
  };
  // #78: Skip is always available on the Connect stage (the application moves to Fill); the fallback used shows.
  const skipConnect =
    stage === 2
      ? async () => {
          const o = await act('apply.skip_connect', { role_id: role.id, reason: 'user' });
          if (o.status === 'ok') showToast('Connect skipped');
        }
      : null;
  const fallbackBar = (m: boolean) => <ConnectFallbackBar mobile={m} fallback={data.connect?.fallback ?? null} onSkip={skipConnect} />;
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
  const draftOf = (cid: string) => draftFor(drafts.data?.items, cid);
  const openPerson = (cid: string) => {
    const o = draftOf(cid);
    if (o) go({ screen: 'outreach-draft', outreachId: o.id });
    else go({ screen: 'people', roleId: role.id });
  };

  // An inbox role is unscored (#31): scoring comes first. Its run, or an all-inbox score run, shows "Scoring".
  const scoring = role.status === 'inbox' ? scoreRunFor(runs, role.id) : undefined;
  const primary =
    role.status === 'inbox'
      ? {
          label: scoring ? activeLabel(scoring) : 'Score',
          op: 'runs.start' as const,
          disabled: !!scoring,
          onClick: async () => {
            const o = await act('runs.start', scoreInput(role.id));
            if (o.status === 'ok') watchRun(o.output.run);
          },
        }
      : stage === 4
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
              label: inFlight ? activeLabel(inFlight) : (STAGES[stage] as string),
              op: 'runs.start' as const,
              disabled: !!inFlight,
              onClick: () => start(skill),
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
            {!m && (
              // Same read as the Stage rail: filled = done, emerald ring = its stage is current.
              <span
                className="tab-dot"
                data-state={paths[id] ? 'done' : TAB_STAGE[id] === stage ? 'current' : 'future'}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: paths[id] ? C.emerald : 'transparent',
                  boxShadow: `inset 0 0 0 1.5px ${paths[id] || TAB_STAGE[id] === stage ? C.emerald : C['line-2']}`,
                }}
              />
            )}
            {n}
          </Btn>
        );
      })}
    </div>
  );
  const md = paths[tabId] ? doc.data?.markdown : null;
  // No file yet (or it went missing): the stage that fills it, then skeleton bars. While it loads: bars only.
  const empty = !paths[tabId] || doc.data?.markdown === null;
  // #81: the paste fallback. Questions a fill run cannot read (other tabs, steps, a login) are pasted here; one op
  // saves them and queues a fill run that answers them.
  const fillRun = runOf('fill');
  const addQuestions = async () => {
    const o = await act('apply.set_questions', { role_id: role.id, questions_text: pasted });
    if (o.status !== 'ok') return;
    setPasted('');
    if (o.output.run) watchRun(o.output.run);
    showToast(`${o.output.count} ${o.output.count === 1 ? 'question' : 'questions'} saved`);
  };
  const questionsBox = (m: boolean) =>
    tabId === 'answers' &&
    role.status === 'draft-ready' && (
      <div className="add-questions" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: m ? 6 : 10 }}>
        <span style={eyebrow(C.muted, m ? 9.5 : 10)}>Add questions</span>
        <textarea
          aria-label="Questions"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          rows={m ? 3 : 4}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: 'transparent',
            border: `1.5px solid ${C['line-2']}`,
            borderRadius: 12,
            color: C.fg,
            fontSize: m ? 14 : 15,
            padding: m ? '10px 12px' : '12px 16px',
            fontFamily: 'inherit',
            resize: 'vertical',
          }}
        />
        <div style={{ display: 'flex' }}>
          <SecondaryButton
            op="apply.set_questions"
            height={m ? 32 : 34}
            label={fillRun ? activeLabel(fillRun) : 'Run'}
            disabled={!pasted.trim() || !!fillRun}
            onClick={() => void addQuestions()}
            style={{ fontSize: m ? 12 : 13 }}
          />
        </div>
      </div>
    );
  const body = (m: boolean) => (
    <>
      {questionsBox(m)}
      {empty && slot(TAB_STAGE[tabId], m)}
      {md && tabId !== 'answers' ? <Markdown source={md} compact={m} /> : <Doc lines={md ? answerLines(md) : DOC_SKELETON} compact={m} />}
    </>
  );
  // Pass (#77): an inbox role the human will not pursue. Archived with reason passed; River next.
  const passBtn = (m: boolean) =>
    role.status === 'inbox' && (
      <SecondaryButton
        op="roles.archive"
        label="Pass"
        height={m ? 26 : 30}
        style={{ fontSize: m ? 12 : 13, borderRadius: 999 }}
        hover={{ borderColor: C.coral, color: C.coral }}
        onClick={async () => {
          const o = await act('roles.archive', { role_id: role.id, reason: 'passed' });
          if (o.status !== 'ok') return;
          showToast(`${company.name} passed`);
          go({ screen: 'river' });
        }}
      />
    );
  const posting = (m: boolean) =>
    role.url && (
      <a
        className="open-posting"
        href={role.url}
        target="_blank"
        rel="noopener noreferrer"
        data-op="nav"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          border: `1px solid ${C['line-2']}`,
          borderRadius: 999,
          padding: m ? '3px 10px' : '5px 12px',
          fontSize: m ? 12 : 13,
          fontWeight: 600,
        }}
      >
        Open posting ↗
      </a>
    );
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
              {posting(true)}
              {passBtn(true)}
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
        {score && <CriterionSources items={sourcesOf(score)} />}
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
        {fallbackBar(true)}
        {tabs(true)}
        <div
          className="doc-preview"
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
          {body(true)}
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
            {posting(false)}
            {passBtn(false)}
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
          {score && <CriterionSources items={sourcesOf(score)} />}
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
          {fallbackBar(false)}
          {!contacts.length && slot(2, false)}
          {!!contacts.length &&
            TIER_ORDER.map((tier) => {
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
          className="doc-preview"
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{body(false)}</div>
        </div>
      </div>
    </Screen>
  );
}

/** Prototype document preview for the grouped Answers file (#42) and skeleton bars; text is inline markdown. */
export function Doc({ lines, compact }: { lines: readonly DocLine[]; compact?: boolean }) {
  return (
    <>
      {lines.map((l, i) => {
        const k = `${l.t}-${i}`;
        switch (l.t) {
          case 'h':
            return (
              <div key={k} style={display(compact ? 20 : 26, 700, compact ? 'normal' : '-0.02em')}>
                <InlineMarkdown source={l.text} compact={compact} />
              </div>
            );
          case 's':
            return (
              <div key={k} style={{ fontSize: compact ? 13 : 15, color: C.muted, marginTop: compact ? 0 : -6 }}>
                <InlineMarkdown source={l.text} compact={compact} />
              </div>
            );
          case 'k':
            return (
              <div key={k} style={{ ...eyebrow(C.emerald, compact ? 9.5 : 10), letterSpacing: '.12em', marginTop: compact ? 6 : 10 }}>
                <InlineMarkdown source={l.text} compact={compact} />
              </div>
            );
          case 't':
            return (
              <div key={k} style={{ fontSize: compact ? 13 : 15 }}>
                <InlineMarkdown source={l.text} compact={compact} />
              </div>
            );
          case 'p':
            return (
              <span
                key={k}
                className="answer-source"
                data-source={l.source}
                style={{
                  alignSelf: 'flex-start',
                  border: `1px solid ${C['emerald-2']}`,
                  color: C.emerald,
                  borderRadius: 999,
                  padding: compact ? '2px 8px' : '3px 10px',
                  fontSize: compact ? 11 : 12,
                  fontWeight: 600,
                }}
              >
                Saved from Ask
              </span>
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
