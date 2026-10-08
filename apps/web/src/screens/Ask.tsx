import { FRESHNESS_SCOPE } from '@perfect-placement/contracts';
import { useEffect, useState } from 'react';
import { useAct, useApp } from '../client/context';
import { PrimaryButton } from '../components/controls';
import { RoleTile, WhoDecidesGlyph } from '../components/glyphs';
import { ContactAvatar, TIER_VIS } from '../components/people';
import type { TileData } from '../components/roles';
import { AskSuggestion, CommandBar } from '../components/shell';
import { C, ellipsis, mono, tab } from '../components/theme';
import { ago } from '../lib/format';
import { initials, type Person, sortPeople } from '../lib/people';
import { freshOf } from '../lib/role';
import { tile } from '../lib/view';
import { go } from '../router';

/*
 * Ask (Cmd+K). Replies render as the app's own cards. Query understanding is the agent's job
 * (lane J renders generated replies); on fixtures three intents route locally, as in the prototype.
 */

type Stale = TileData & { checked: string; after?: 'open' | 'closed' };
type Reply =
  | { kind: 'stale'; q: string; rows: Stale[]; checked: boolean }
  | { kind: 'scout'; q: string }
  | { kind: 'people'; q: string; people: Person[]; roleId: string };

const SUGG = [
  ['Which active roles are going stale?', 'local'],
  ['scout now', 'runs.start'],
  ['check freshness', 'local'],
  ['find people for this role', 'people.find'],
] as const;

export function Ask({ roleId, onClose }: { roleId: string | null; onClose: () => void }) {
  const { client, now, config } = useApp();
  const act = useAct();
  const [query, setQuery] = useState('');
  const [reply, setReply] = useState<Reply | null>(null);
  const [shown, setShown] = useState(0);

  const streamKey = reply ? `${reply.kind}:${reply.q}` : '';
  useEffect(() => {
    if (!streamKey) return;
    setShown(0);
    const id = setInterval(() => setShown((n) => (n >= 4 ? n : n + 1)), 260);
    return () => clearInterval(id);
  }, [streamKey]);

  const run = async (text: string) => {
    const tx = text.trim();
    if (!tx) return;
    const l = tx.toLowerCase();
    setQuery('');
    if (l.includes('scout')) {
      await act('runs.start', { skill: 'scout' });
      setReply({ kind: 'scout', q: tx });
      return;
    }
    if (l.includes('people') && roleId) {
      const o = await act('people.find', { role_id: roleId });
      if (o.status === 'ok') setReply({ kind: 'people', q: tx, people: sortPeople(o.output.found), roleId });
      return;
    }
    const o = await client.run('roles.list', { status: [...FRESHNESS_SCOPE], limit: 500 });
    if (o.status !== 'ok') return;
    const t = now();
    const rows = o.output.items
      .filter((v) => freshOf(v.role, t) !== 'ok')
      .slice(0, 4)
      .map((v) => ({ ...tile(v, t, config.scoring), checked: v.role.last_checked_at ? ago(v.role.last_checked_at, t) : '—' }));
    setReply({ kind: 'stale', q: tx, rows, checked: false });
  };

  const checkAll = async () => {
    if (reply?.kind !== 'stale') return;
    const o = await act('roles.check_freshness', { role_ids: reply.rows.map((r) => r.id) });
    if (o.status !== 'ok') return;
    const by = new Map(o.output.results.map((r) => [r.role_id, r.freshness]));
    setReply({
      ...reply,
      checked: true,
      rows: reply.rows.map((r) => {
        const f = by.get(r.id);
        return { ...r, fresh: f === 'closed' ? 'closed' : 'ok', after: f === 'closed' ? 'closed' : 'open' };
      }),
    });
  };

  const body = reply && (
    <div
      className="ask__reply"
      style={{
        background: C.panel,
        border: `1px solid ${C['line-2']}`,
        borderRadius: 12,
        padding: 18,
        maxHeight: '60vh',
        overflow: 'auto',
        animation: 'ppIn .25s ease',
      }}
    >
      <div style={{ ...mono(12, C.muted), marginBottom: 14 }}>› {reply.q}</div>
      {reply.kind === 'stale' && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {reply.rows.slice(0, shown).map((x) => (
              <div
                key={x.id}
                className="role-card"
                data-role={x.id}
                data-fresh={x.fresh}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '12px 14px',
                  background: C['bg-2'],
                  borderRadius: 10,
                  animation: 'ppIn .3s ease',
                }}
              >
                <RoleTile letter={x.letter} fresh={x.fresh} size={40} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, ...ellipsis }}>{x.title}</div>
                  <div style={{ fontSize: 12, color: C.muted }}>{x.co}</div>
                </div>
                <span style={{ ...mono(11, x.after ? (x.after === 'closed' ? C.coral : C.emerald) : C.dim), whiteSpace: 'nowrap' }}>
                  {x.after ? (x.after === 'closed' ? 'closed → archive' : 'open') : `checked ${x.checked}`}
                </span>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: x.band }} />
                <span style={{ ...mono(13), ...tab }}>{x.fit ?? ''}</span>
              </div>
            ))}
          </div>
          {shown >= Math.min(4, reply.rows.length) && reply.rows.length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              {!reply.checked ? (
                <PrimaryButton label="Check all" op="roles.check_freshness" onClick={() => void checkAll()} />
              ) : (
                <span style={{ ...mono(12, C.emerald), padding: '10px 0' }}>
                  {reply.rows.length} checked · {reply.rows.filter((r) => r.after === 'closed').length} closed
                </span>
              )}
            </div>
          )}
        </>
      )}
      {reply.kind === 'scout' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: 14, background: C['bg-2'], borderRadius: 10 }}>
          <WhoDecidesGlyph kind="auto" />
          <span style={mono(13)}>role-scout</span>
          <div style={{ flex: 1, height: 4, borderRadius: 4, background: C.line, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.min(100, shown * 25)}%`, background: C.emerald, transition: 'width .25s' }} />
          </div>
          <span style={mono(12, C.muted)}>{Math.min(100, shown * 25)}%</span>
        </div>
      )}
      {reply.kind === 'people' && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {reply.people.slice(0, 4).map((p) => (
              <div
                key={p.contact.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 14px 10px 10px',
                  background: C['bg-2'],
                  borderRadius: 999,
                }}
              >
                <ContactAvatar initials={initials(p.contact.name)} tier={p.link.tier} size={34} />
                <span>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>{p.contact.name}</span>
                  <span style={{ display: 'block', ...mono(10, C.muted) }}>{TIER_VIS[p.link.tier].label}</span>
                </span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
            <PrimaryButton
              label="Open People"
              op={null}
              onClick={() => {
                onClose();
                go({ screen: 'people', roleId: reply.roleId });
              }}
            />
          </div>
        </>
      )}
    </div>
  );

  return (
    <CommandBar
      query={query}
      onQuery={setQuery}
      onSubmit={() => void run(query)}
      onClose={onClose}
      reply={body}
      suggestions={SUGG.filter(([, op]) => op !== 'people.find' || roleId).map(([text, op]) => (
        <AskSuggestion key={text} text={text} op={op} onRun={() => void run(text)} />
      ))}
    />
  );
}
