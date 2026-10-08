import { groundGlow } from '@perfect-placement/contracts';
import { useCallback, useEffect, useState } from 'react';
import { ClientProvider, useApp, useOp } from './client/context';
import type { OpClient } from './client/types';
import { Toast } from './components/controls';
import { AskPill, MobileFrame, NavRail, type NavTarget, TabBar } from './components/shell';
import { C, F } from './components/theme';
import { LayoutCtx } from './layout';
import { useMobile } from './lib/useMobile';
import { go, href, type Route, useRoute } from './router';
import { Ask } from './screens/Ask';
import { NeedsYou } from './screens/NeedsYou';
import { Now } from './screens/Now';
import { Onboarding } from './screens/Onboarding';
import { OutreachScreen } from './screens/Outreach';
import { PeopleScreen } from './screens/People';
import { River } from './screens/River';
import { RoleScreen } from './screens/Role';
import { Settings } from './screens/Settings';
import { You } from './screens/You';

export function App({ client, now, pollMs }: { client: OpClient; now?: () => Date; pollMs?: number }) {
  return (
    <ClientProvider client={client} now={now} pollMs={pollMs}>
      <Shell />
    </ClientProvider>
  );
}

function Shell() {
  const route = useRoute();
  const mobile = useMobile();
  const { toast } = useApp();
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

  const need = sum.data?.needs_you ?? 0;
  const railActive = route.screen === 'outreach-draft' ? 'people' : route.screen;
  const onboarding = route.screen === 'onboarding';
  const ask = askOpen && <Ask roleId={roleId} onClose={() => setAskOpen(false)} />;

  return (
    <LayoutCtx.Provider value={{ mobile, slot }}>
      <div style={{ minHeight: '100vh', background: `${groundGlow}, ${C.bg}`, color: C.fg, fontFamily: F.ui }}>
        {mobile ? (
          <MobileFrame
            primary={<div ref={setSlot} />}
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
            <ScreenFor route={onboarding || route.screen === 'settings' ? { screen: 'now' } : route} />
          </MobileFrame>
        ) : (
          <div style={{ display: 'flex', minHeight: '100vh' }}>
            {!onboarding && <NavRail active={railActive} needsBadge={need > 0} onNavigate={navigate} />}
            <main style={{ flex: 1, minWidth: 0, padding: '32px 48px 140px', maxWidth: 1440 }}>
              <ScreenFor route={route} />
            </main>
          </div>
        )}
        <Toast text={toast} />
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
      return <You />;
    case 'onboarding':
      return <Onboarding key={route.calibrate ? 'cal' : 'ob'} calibrate={route.calibrate} />;
    case 'settings':
      return <Settings />;
  }
}
