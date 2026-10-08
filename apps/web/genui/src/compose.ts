import { FRESHNESS_SCOPE } from '@perfect-placement/contracts';
import type { OpClient } from '../../src/client/types';
import { sortPeople } from '../../src/lib/people';
import { freshOf } from '../../src/lib/role';

/*
 * Local Ask: turns a typed question into an OpenUI Lang reply from op reads (ids only), in the
 * same shape an agent would write after reading askSystemPrompt(). Keyword intents; an agent
 * session can answer anything else through MCP. Reads only: actions are OpButtons.
 */

const s = (v: string) => JSON.stringify(v);
const list = (ids: readonly string[]) => `[${ids.map(s).join(', ')}]`;

/** Statements in root-first order (OpenUI streams the shell before the cards). */
function reply(items: Array<[name: string, expr: string]>): string {
  return [`root = Reply([${items.map(([n]) => n).join(', ')}])`, ...items.map(([n, e]) => `${n} = ${e}`)].join('\n');
}

export interface ComposeContext {
  client: OpClient;
  now: Date;
  /** The role in focus (Role / People screen, or the last one opened). */
  roleId: string | null;
}

export type Intent = 'stale' | 'people' | 'interviews' | 'profile' | 'top';

export function intentOf(query: string, hasRole: boolean): Intent {
  const q = query.toLowerCase();
  if (hasRole && (q.includes('people') || q.includes('who '))) return 'people';
  if (q.includes('interview')) return 'interviews';
  if (q.includes('profile') || q.includes('diff') || q.includes('changed')) return 'profile';
  if (q.includes('top') || q.includes('best') || q.includes('fit')) return 'top';
  return 'stale';
}

export async function composeReply(query: string, ctx: ComposeContext): Promise<string> {
  const { client, now, roleId } = ctx;
  switch (intentOf(query, !!roleId)) {
    case 'people': {
      const o = await client.run('roles.get', { role_id: roleId as string });
      if (o.status !== 'ok') return reply([['t', 'Text("No role in focus")']]);
      const people = sortPeople(o.output.contacts).slice(0, 4);
      const best = people[0];
      return reply([
        ['t', `Text(${s(`${o.output.contacts.length} people at ${o.output.company.name}`)})`],
        ['g', `Group("People", [${people.map((_, i) => `p${i}`).join(', ')}])`],
        ...people.map((p, i): [string, string] => [`p${i}`, `ContactCard(${s(p.contact.id)}, ${s(o.output.role.id)})`]),
        ...(best
          ? [
              [
                'a',
                `OpButton(${s(`Draft for ${best.contact.name.split(' ')[0]}`)}, "runs.start", ${list([o.output.role.id, best.contact.id])}, "connect")`,
              ] as [string, string],
            ]
          : []),
      ]);
    }
    case 'interviews': {
      const o = await client.run('roles.list', { status: ['interviews'], sort: 'fit', limit: 6 });
      const ids = o.status === 'ok' ? o.output.items.map((v) => v.role.id) : [];
      return reply([
        ['t', `Text(${s(ids.length ? `${ids.length} in interviews` : 'Nothing in interviews')})`],
        ...ids.map((id, i): [string, string] => [`r${i}`, `RoleCard(${s(id)})`]),
      ]);
    }
    case 'profile': {
      const o = await client.run('profile.get', {});
      const diffs = o.status === 'ok' ? o.output.pending_diffs : [];
      const first = diffs[0];
      return reply([
        ['t', `Text(${s(diffs.length ? `${diffs.length} changes wait for you` : 'No pending changes')})`],
        ...diffs.map((d, i): [string, string] => [`d${i}`, `ProfileDiff(${s(d.id)})`]),
        ...(first ? [['a', `OpButton("Accept diff", "profile.apply_diff", ${list([first.id])})`] as [string, string]] : []),
      ]);
    }
    case 'top': {
      const o = await client.run('roles.list', { status: ['active', 'draft-ready'], sort: 'fit', limit: 3 });
      const ids = o.status === 'ok' ? o.output.items.map((v) => v.role.id) : [];
      const [head, ...rest] = ids;
      if (!head) return reply([['t', 'Text("No live roles")']]);
      return reply([
        ['g', `Group("Best fit", [r0, s0])`],
        ['r0', `RoleCard(${s(head)})`],
        ['s0', `ScoreRadar(${s(head)})`],
        ...rest.map((id, i): [string, string] => [`r${i + 1}`, `RoleCard(${s(id)})`]),
      ]);
    }
    case 'stale': {
      const o = await client.run('roles.list', { status: [...FRESHNESS_SCOPE], limit: 500 });
      const ids =
        o.status === 'ok'
          ? o.output.items
              .filter((v) => freshOf(v.role, now) !== 'ok')
              .map((v) => v.role.id)
              .slice(0, 4)
          : [];
      if (!ids.length) return reply([['t', 'Text("Everything is fresh")']]);
      return reply([
        ['t', `Text(${s(`${ids.length} going stale`)})`],
        ...ids.map((id, i): [string, string] => [`r${i}`, `RoleCard(${s(id)})`]),
        ['a', `OpButton("Check all", "roles.check_freshness", ${list(ids)})`],
      ]);
    }
  }
}
