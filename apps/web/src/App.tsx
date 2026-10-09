import { groundGlow } from '@perfect-placement/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClientProvider, useApp, useOp } from './client/context';
import type { OpClient } from './client/types';
import { Cue } from './components/Cue';
import { Toast } from './components/controls';
import { AskPill, MobileFrame, NavRail, type NavTarget, RunIndicator, type RunIndicatorState, TabBar } from './components/shell';
import { C, F } from './components/theme';
import { LayoutCtx } from './layout';
import { STEP_CUE, STEP_TARGET, scoredCount } from './lib/guide';
import { activeLabel, isActive, runLabel } from './lib/runs';
import { useMobile } from './lib/useMobile';
import { go, href, type Route, replaceRoute, useRoute } from './router';
import { Ask, type AskSession, NEW_ASK } from './screens/Ask';
import { NeedsYou } from './screens/NeedsYou';
import { Now } from './screens/Now';
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

/** Screens that show You (setup) until a profile exists (Settings and the rest stay reachable). */
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
 * What to render for a route: mobile has no Settings screen (it shows Now), and on a fresh vault the
 * gated screens show You, which is setup until a profile exists (#25). `null` = wait (fresh-or-unknown,
 * not answered yet).
 */
export function shownRoute(route: Route, opts: { mobile: boolean; fresh: boolean | null; lastFresh: boolean | null }): Route | null {
  const r: Route = opts.mobile && route.screen === 'settings' ? { screen: 'now' } : route;
  if (!GATED_SCREENS.includes(r.screen) || opts.lastFresh === false) return r;
  if (opts.fresh === true) return { screen: 'you' };
  return opts.fresh === false ? r : null;
}

function Shell() {
  const route = useRoute();
  const mobile = useMobile();
  const { toast, guide, markGuide, guideCue, setGuideCue, runs } = useApp();
  const fresh = useFresh();
  const sum = useOp('pipeline.summary', {});
  const top = useOp('roles.list', { status: ['active', 'draft-ready'], sort: 'fit', limit: 1 });
  const [askOpen, setAskOpen] = useState(false);
  const [askSession, setAskSession] = useState<AskSession>(NEW_ASK);
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
      go({ screen: t });
    },
    [roleId],
  );

  // Fresh start: the first open (any route) and the gated screens land on You, which is setup step 1.
  const firstAnswer = useRef(true);
  useEffect(() => {
    if (fresh.now === null) return;
    const first = firstAnswer.current;
    firstAnswer.current = false;
    if (fresh.now && route.screen !== 'you' && (first || GATED_SCREENS.includes(route.screen))) replaceRoute({ screen: 'you' });
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
  const shown = shownRoute(route, { mobile, fresh: fresh.now, lastFresh: fresh.last });
  // You running the onboarding steps: setup (no profile yet), a re-interview or a recalibration (#25).
  const flow = shown?.screen === 'you' && (!!shown.flow || fresh.last === true);
  const ask = askOpen && (
    <Ask roleId={roleId} screen={shown?.screen ?? null} session={askSession} onSession={setAskSession} onClose={() => setAskOpen(false)} />
  );

  // Getting started (#24): the steps not read from the pipeline are flags set on arrival, once.
  const scored = sum.data ? scoredCount(sum.data.counts) > 0 : false;
  const shownScreen = shown?.screen ?? null;
  useEffect(() => {
    if (!guide || guide.done) return;
    if (shownScreen === 'settings' && !guide.policy) markGuide({ policy: true });
    if ((shownScreen === 'river' || shownScreen === 'needs-you') && scored && !guide.review) markGuide({ review: true });
  }, [shownScreen, guide, scored, markGuide]);
  // A step's cue lives on the route the card opened; leaving it drops the cue.
  const cueKey = useRef(routeKey);
  useEffect(() => {
    if (cueKey.current === routeKey) return;
    cueKey.current = routeKey;
    if (guideCue && guideCue.at !== routeKey) setGuideCue(null);
  }, [routeKey, guideCue, setGuideCue]);
  const cue = guideCue && guideCue.at === routeKey && shown?.screen === route.screen && !flow && !askOpen ? guideCue.step : null;
  const dismissCue = useCallback(() => setGuideCue(null), [setGuideCue]);

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
            {(!flow || fresh.last === true) && (
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
        {cue && <Cue key={cue} id={cue} label={STEP_CUE[cue]} target={STEP_TARGET[cue]} onDismiss={dismissCue} />}
        {!askOpen && !mobile && !flow && <AskPill onOpen={() => setAskOpen(true)} />}
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
      return <You key={route.flow ?? 'you'} component={route.component} flow={route.flow} />;
    case 'settings':
      return <Settings />;
    case 'runs':
      return <Runs key={route.runId ?? 'list'} runId={route.runId} />;
  }
}
