import { FRESHNESS_SCOPE } from '@perfect-placement/contracts';
import { useEffect, useState } from 'react';
import { useAct, useApp } from '../client/context';
import { PrimaryButton } from '../components/controls';
import { RoleCard } from '../components/roles';
import { CommandBar } from '../components/shell';
import { freshOf, type RoleView } from '../lib/role';
import { go } from '../router';

/*
 * Ask (Cmd+K). Replies render as the app's own cards, never long text. Query understanding is
 * the agent's job (lane J renders generated replies); on fixtures we route a few intents locally.
 */

type Reply = { kind: 'stale'; roles: RoleView[] } | { kind: 'roles'; roles: RoleView[] } | { kind: 'people'; roleId: string };

const SUGGESTIONS = [
  { id: 'scout', label: 'Scout now', match: /scout|find roles|new roles/ },
  { id: 'fresh', label: 'Check freshness', match: /fresh|stale|closed|open/ },
  { id: 'people', label: 'Find people', match: /people|who|contact|connect/ },
] as const;

export function Ask({ open, roleId, onClose }: { open: boolean; roleId: string | null; onClose: () => void }) {
  const { client, now, config, showToast } = useApp();
  const act = useAct();
  const [query, setQuery] = useState('');
  const [reply, setReply] = useState<Reply | null>(null);
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setReply(null);
    }
  }, [open]);

  // Stream cards in one by one.
  useEffect(() => {
    if (!reply || reply.kind === 'people') return;
    setShown(0);
    const id = setInterval(() => setShown((n) => (n >= reply.roles.length ? n : n + 1)), 140);
    return () => clearInterval(id);
  }, [reply]);

  const ask = async (q: string) => {
    const t = now();
    const text = q.toLowerCase();
    if (/stale|fresh|closed|going/.test(text)) {
      const o = await client.run('roles.list', { status: [...FRESHNESS_SCOPE], limit: 500 });
      if (o.status === 'ok') setReply({ kind: 'stale', roles: o.output.items.filter((v) => freshOf(v.role, t) !== 'ok').slice(0, 4) });
      return;
    }
    if (/people|who|contact/.test(text) && roleId) {
      setReply({ kind: 'people', roleId });
      return;
    }
    const o = await client.run('roles.list', { limit: 500 });
    if (o.status === 'ok')
      setReply({
        kind: 'roles',
        roles: o.output.items.filter((v) => `${v.company.name} ${v.role.title}`.toLowerCase().includes(text.trim())).slice(0, 4),
      });
  };

  const runSuggestion = async (id: (typeof SUGGESTIONS)[number]['id']) => {
    if (id === 'scout') {
      const o = await act('runs.start', { skill: 'scout' });
      if (o.status === 'ok') showToast('Scout started');
    } else if (id === 'fresh') {
      const o = await act('roles.check_freshness', { all_in_scope: true });
      if (o.status === 'ok') showToast(`${o.output.results.length} checked`);
    } else if (id === 'people' && roleId) {
      const o = await act('people.find', { role_id: roleId });
      if (o.status === 'ok') setReply({ kind: 'people', roleId });
    }
  };

  const q = query.toLowerCase();
  const suggestions = SUGGESTIONS.filter(
    (s) => (s.id !== 'people' || roleId) && (!q || s.match.test(q) || s.label.toLowerCase().includes(q)),
  );

  const t = now();
  const cards = reply && reply.kind !== 'people' ? reply.roles.slice(0, shown) : [];

  return (
    <CommandBar
      open={open}
      query={query}
      onQuery={setQuery}
      onSubmit={() => void ask(query)}
      onClose={onClose}
      streaming={!!reply && reply.kind !== 'people' && shown < reply.roles.length}
      suggestions={suggestions.map((s) => (
        <button
          key={s.id}
          type="button"
          className="chip chip--filter"
          data-op={s.id === 'scout' ? 'runs.start' : s.id === 'fresh' ? 'roles.check_freshness' : 'people.find'}
          onClick={() => void runSuggestion(s.id)}
        >
          {s.label}
        </button>
      ))}
      reply={
        reply && (
          <>
            {cards.map((v) => (
              <RoleCard
                key={v.role.id}
                view={v}
                now={t}
                bands={config.scoring}
                onOpen={() => {
                  onClose();
                  go({ screen: 'role', roleId: v.role.id });
                }}
              />
            ))}
            {reply.kind === 'stale' && reply.roles.length > 0 && (
              <div className="ask__action">
                <PrimaryButton
                  label="Check all"
                  op="roles.check_freshness"
                  onClick={async () => {
                    const o = await act('roles.check_freshness', { role_ids: reply.roles.map((v) => v.role.id) });
                    if (o.status === 'ok') {
                      const again = await client.run('roles.list', { status: [...FRESHNESS_SCOPE], limit: 500 });
                      if (again.status === 'ok') {
                        const ids = new Set(reply.roles.map((v) => v.role.id));
                        setReply({ kind: 'roles', roles: again.output.items.filter((v) => ids.has(v.role.id)) });
                      }
                    }
                  }}
                />
              </div>
            )}
            {reply.kind === 'people' && (
              <div className="ask__action">
                <PrimaryButton
                  label="Open People"
                  op={null}
                  onClick={() => {
                    onClose();
                    go({ screen: 'people', roleId: reply.roleId });
                  }}
                />
              </div>
            )}
          </>
        )
      }
    />
  );
}
