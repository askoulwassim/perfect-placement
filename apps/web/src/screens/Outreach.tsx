import type { RunStatus } from '@perfect-placement/contracts';
import { useState } from 'react';
import { useAct, useApp, useOp } from '../client/context';
import { DraftStatusChip, ToneChips } from '../components/controls';
import { ContactAvatar, OutreachBlock, TIER_VIS, TONES } from '../components/people';
import { C, display, eyebrow, mono } from '../components/theme';
import { Screen, useLayout } from '../layout';
import { initials } from '../lib/people';
import { go } from '../router';

export function OutreachScreen({ outreachId }: { outreachId: string }) {
  const { mobile } = useLayout();
  const act = useAct();
  const { showToast, watchRun } = useApp();
  const res = useOp('outreach.get', { outreach_id: outreachId });
  const role = useOp('roles.get', res.data ? { role_id: res.data.outreach.role_id } : null);
  const [tone, setTone] = useState<number | null>(null);
  /** The Gmail draft run (Gmail via agent): null = none started here. */
  const [run, setRun] = useState<RunStatus | null>(null);

  if (!res.data) return <div data-screen-label="Outreach draft" aria-busy={!res.error} />;
  const { outreach, contact, variants } = res.data;
  const tier = TIER_VIS[outreach.tier];
  const t = tone ?? tier.tone;
  const v = variants[t] ?? res.data;
  const blocks = [
    ['Hook', v.hook],
    ['Proof', v.proof],
    ['Ask', v.ask],
  ] as const;
  const words = blocks.reduce((a, [, x]) => a + x.split(/\s+/).filter(Boolean).length, 0);
  const co = role.data?.company.name ?? '';
  const people = role.data?.contacts ?? [];
  const me = people.find((p) => p.contact.id === contact.id);
  const via = me?.link.via_contact_id ? people.find((p) => p.contact.id === me.link.via_contact_id)?.contact.name : undefined;
  const path = ['You', ...(via ? [via] : []), contact.name];

  // The engine has no Gmail client: the button starts a headless connect run scoped to this draft; the
  // agent creates the Gmail draft with its own Gmail tool and records it (outreach.to_gmail). Never sends.
  const primary = {
    label: 'Create Gmail draft',
    op: 'runs.start' as const,
    disabled: outreach.status !== 'drafted' || run === 'running',
    onClick: async () => {
      const o = await act('runs.start', { skill: 'connect', outreach_id: outreach.id });
      if (o.status !== 'ok') return;
      setRun('running');
      showToast('Drafting in Gmail');
      // watchRun polls runs.get, then refreshes every read (the outreach comes back `in_gmail`).
      watchRun(o.output.run.id, (r) => {
        setRun(r.status);
        showToast(r.status === 'ok' ? 'Gmail draft created' : 'Gmail draft failed');
      });
    },
  };
  const runLabel = run === 'running' ? 'Gmail · drafting' : run && run !== 'ok' ? 'Gmail · failed' : 'Gmail · draft only';
  const header = {
    eyebrow: `Outreach · ${tier.label}`,
    title: contact.name,
    back: () => go({ screen: 'people', roleId: outreach.role_id }),
  };

  if (mobile)
    return (
      <Screen label="Outreach · mobile" {...header} primary={primary}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ContactAvatar initials={initials(contact.name)} tier={outreach.tier} size={48} font={13} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{contact.headline}</div>
            <div style={{ ...eyebrow(tier.c, 10), letterSpacing: '.08em', marginTop: 3 }}>{tier.label}</div>
          </div>
        </div>
        <ToneChips mobile tones={TONES} recommended={tier.tone} selected={t} onSelect={setTone} />
        <div style={{ background: C.panel, border: `1px solid ${C['line-2']}`, borderRadius: 12, padding: '4px 18px' }}>
          {blocks.map(([k, x]) => (
            <OutreachBlock key={k} mobile label={k} text={x} />
          ))}
        </div>
      </Screen>
    );

  return (
    <Screen label="Outreach draft" {...header} primary={primary}>
      <div style={{ display: 'grid', gridTemplateColumns: '320px minmax(0,1fr)', gap: 40, marginTop: 28, alignItems: 'start' }}>
        <div
          style={{
            background: C.panel,
            border: `1px solid ${C['line-2']}`,
            borderRadius: 12,
            padding: 26,
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
          }}
        >
          <ContactAvatar initials={initials(contact.name)} tier={outreach.tier} size={72} font={18} />
          <div>
            <div style={display(28, 700, '-0.02em')}>{contact.name}</div>
            <div style={{ fontSize: 14, color: C.muted, marginTop: 4 }}>
              {contact.headline}
              {co ? ` · ${co}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span
              style={{
                border: `1px solid ${tier.c}`,
                color: tier.c,
                borderRadius: 999,
                padding: '4px 12px',
                ...eyebrow(tier.c),
                letterSpacing: '.08em',
              }}
            >
              {tier.label}
            </span>
            <DraftStatusChip status={outreach.status} size={11} pad="4px 10px" />
          </div>
          <div style={{ ...mono(12, C.emerald), paddingTop: 14, borderTop: `1px solid ${C.line}` }}>{path.join('  →  ')}</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <ToneChips tones={TONES} recommended={tier.tone} selected={t} onSelect={setTone} />
          <div
            style={{ background: C.panel, border: `1px solid ${C['line-2']}`, borderRadius: 12, padding: '8px 34px 18px', maxWidth: 780 }}
          >
            {blocks.map(([k, x]) => (
              <OutreachBlock key={k} label={k} text={x} />
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 14, ...mono(11, C.dim) }}>
              <span>{words} words</span>
              <span data-run={run ?? 'none'}>{runLabel}</span>
            </div>
          </div>
        </div>
      </div>
    </Screen>
  );
}
