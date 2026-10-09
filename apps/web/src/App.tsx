import { groundGlow } from '@perfect-placement/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClientProvider, useApp, useOp } from './client/context';
import type { OpClient } from './client/types';
import { Cue } from './components/Cue';
import { Toast } from './components/controls';
import { AskPill, MobileFrame, NavRail, type NavTarget, RunIndicator, type RunIndicatorState, TabBar } from './components/shell';
import { C, F } from './components/theme';
import { LayoutCtx } from './layout';
import { CUE_TARGET, CUES, cueFor, pendingCue } from './lib/cues';
import { activeLabel, isActive, runLabel } from './lib/runs';
import { useMobile } from './lib/useMobile';
import { go, href, type Route, replaceRoute, useRoute } from './router';
import { Ask } from './screens/Ask';
import { NeedsYou } from './screens/NeedsYou';
import { Now } from './screens/Now';
import { Onboarding } from './screens/Onboarding';
import { OutreachScreen } from './screens/Outreach';
import { PeopleScreen } from './screens/People';
import { River } from './screens/River';
import { RoleScreen } from './screens/Role';
import { Runs } from './screens/Runs';
import { Settings } from './screens/Settings';
import { You } from './screens/You';

export function App({ client, now, pollMs }: { client: OpClient; now?: () => Date; pollMs?: number }) {
  return (
    <ClientProvider client={client} now={now} pollMs={pollMs}>
      <Shell />
    </ClientProvider>
  );
}

/** Screens that show the Onboarding redirect until a profile exists (Settings and the rest stay reachable). */
export const GATED_SCREENS: ReadonlyArray<Route['screen']> = ['now', 'needs-you', 'river'];

/**
 * Fresh vault = no confirmed profile (`profile.get` answers not_found). Re-checked after every write;
 * `null` while the answer for the current version is unknown. `last`: the latest known answer.
 */
function useFresh(): { now: boolean | null; last: boolean | null } {
  const { client, version } = useApp();
  const [known, setKnown] = useState<{ v: number; fresh: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    void client.run('profile.get', {}).then((o) => {
      // Only a definite "no profile" counts; an offline backend never redirects.
      if (live) setKnown({ v: version, fresh: o.status === 'error' && o.code === 'not_found' });
    });
    return () => {
      live = false;
    };
  }, [client, version]);
  return { now: known && known.v === version ? known.fresh : null, last: known ? known.fresh : null };
}

/**
 * What to render for a route: mobile has no Onboarding or Settings screen (they show Now), and on a
 * fresh vault the gated screens show Onboarding. `null` = wait (fresh-or-unknown, not answered yet).
 */
export function shownRoute(route: Route, opts: { mobile: boolean; fresh: boolean | null; lastFresh: boolean | null }): Route | null {
  const r: Route = opts.mobile && (route.screen === 'onboarding' || route.screen === 'settings') ? { screen: 'now' } : route;
  if (!GATED_SCREENS.includes(r.screen) || opts.lastFresh === false) return r;
  if (opts.fresh === true) return { screen: 'onboarding' };
  return opts.fresh === false ? r : null;
}

function Shell() {
  const route = useRoute();
  const mobile = useMobile();
  const { toast, cuesSeen, markCue, runs } = useApp();
  const fresh = useFresh();
  const sum = useOp('pipeline.summary', {});
  const top = useOp('roles.list', { status: ['active', 'draft-ready'], sort: 'fit', limit: 1 });
  const [askOpen, setAskOpen] = useState(false);
  const [lastRole, setLastRole] = useState<string | null>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  // Close Ask on real navigation only (hashchange can repeat the same route).
  const routeKey = href(route);
  useEffect(() => {
    void routeKey;
    setAskOpen(false);
  }, [routeKey]);
  useEffect(() => {
    if (route.screen === 'role' || route.screen === 'people') setLastRole(route.roleId);
  }, [route]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setAskOpen((v) => !v);
      } else if (e.key === 'Escape') setAskOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const roleId = route.screen === 'role' || route.screen === 'people' ? route.roleId : (lastRole ?? top.data?.items[0]?.role.id ?? null);
  const navigate = useCallback(
    (t: NavTarget) => {
      if (t === 'ask') return setAskOpen(true);
      if (t === 'role' || t === 'people') return roleId && go({ screen: t, roleId });
      if (t === 'onboarding') return go({ screen: 'onboarding' });
      go({ screen: t });
    },
    [roleId],
  );

  // Fresh start: the first open (any route) and the gated screens land on Onboarding step 1.
  const firstAnswer = useRef(true);
  useEffect(() => {
    if (fresh.now === null) return;
    const first = firstAnswer.current;
    firstAnswer.current = false;
    if (fresh.now && route.screen !== 'onboarding' && (first || GATED_SCREENS.includes(route.screen)))
      replaceRoute({ screen: 'onboarding' });
  }, [fresh.now, route]);

  // Global run indicator (#21): in progress, or the latest run failed (until Runs is opened).
  const activeRuns = runs.filter((r) => isActive(r.status));
  const latest = runs[0];
  const [seenFail, setSeenFail] = useState<string | null>(null);
  useEffect(() => {
    if (route.screen === 'runs' && latest) setSeenFail(latest.id);
  }, [route.screen, latest]);
  const runState: RunIndicatorState = activeRuns.length
    ? 'running'
    : latest?.status === 'error' && latest.id !== seenFail
      ? 'error'
      : 'idle';
  const runText =
    runState === 'running'
      ? activeRuns.length === 1
        ? activeLabel(activeRuns[0] as (typeof runs)[number])
        : `${activeRuns.length} runs`
      : runState === 'error' && latest
        ? `${runLabel(latest)} failed`
        : 'Runs';
  const openRuns = () => go(runState === 'error' && latest ? { screen: 'runs', runId: latest.id } : { screen: 'runs' });

  const need = sum.data?.needs_you ?? 0;
  const railActive = route.screen === 'outreach-draft' ? 'people' : route.screen;
  const onboarding = route.screen === 'onboarding';
  const shown = shownRoute(route, { mobile, fresh: fresh.now, lastFresh: fresh.last });
  const ask = askOpen && <Ask roleId={roleId} onClose={() => setAskOpen(false)} />;
  const cue = pendingCue(cueFor(shown?.screen ?? null, askOpen), cuesSeen);
  const dismissCue = useCallback(() => {
    if (cue) markCue(cue);
  }, [cue, markCue]);

  return (
    <LayoutCtx.Provider value={{ mobile, slot }}>
      <div style={{ minHeight: '100vh', background: `${groundGlow}, ${C.bg}`, color: C.fg, fontFamily: F.ui }}>
        {mobile ? (
          <MobileFrame
            primary={<div ref={setSlot} />}
            top={
              runState !== 'idle' && <RunIndicator compact state={runState} count={activeRuns.length} label={runText} onOpen={openRuns} />
            }
            tabbar={
              <TabBar
                active={(t) =>
                  t === 'ask'
                    ? askOpen
                    : t === 'now'
                      ? ['now', 'needs-you', 'role', 'outreach-draft', 'people'].includes(route.screen)
                      : route.screen === t
                }
                onNavigate={navigate}
              />
            }
          >
            {shown && <ScreenFor route={shown} />}
          </MobileFrame>
        ) : (
          <div style={{ display: 'flex', minHeight: '100vh' }}>
            {(!onboarding || fresh.last === true) && (
              <NavRail
                active={railActive}
                needsBadge={need > 0}
                onNavigate={navigate}
                runs={
                  <RunIndicator
                    state={runState}
                    count={activeRuns.length}
                    label={runText}
                    active={route.screen === 'runs'}
                    onOpen={openRuns}
                  />
                }
              />
            )}
            <main style={{ flex: 1, minWidth: 0, padding: '32px 48px 140px', maxWidth: 1440 }}>{shown && <ScreenFor route={shown} />}</main>
          </div>
        )}
        <Toast text={toast?.text ?? null} tone={toast?.tone} action={toast?.action} />
        {cue && <Cue key={cue} id={cue} label={CUES[cue]} target={CUE_TARGET[cue]} onDismiss={dismissCue} />}
        {!askOpen && !mobile && !onboarding && <AskPill onOpen={() => setAskOpen(true)} />}
        {ask}
      </div>
    </LayoutCtx.Provider>
  );
}

function ScreenFor({ route }: { route: Route }) {
  switch (route.screen) {
    case 'now':
      return <Now />;
    case 'needs-you':
      return <NeedsYou />;
    case 'river':
      return <River />;
    case 'role':
      return <RoleScreen key={route.roleId} roleId={route.roleId} />;
    case 'people':
      return <PeopleScreen key={route.roleId} roleId={route.roleId} />;
    case 'outreach-draft':
      return <OutreachScreen key={route.outreachId} outreachId={route.outreachId} />;
    case 'you':
      return <You component={route.component} />;
    case 'onboarding':
      return <Onboarding key={route.calibrate ? 'cal' : 'ob'} calibrate={route.calibrate} />;
    case 'settings':
      return <Settings />;
    case 'runs':
      return <Runs key={route.runId ?? 'list'} runId={route.runId} />;
  }
}
