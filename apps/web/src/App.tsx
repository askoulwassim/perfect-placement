import { useCallback, useEffect, useState } from 'react';
import { ClientProvider, useApp, useOp } from './client/context';
import type { OpClient } from './client/types';
import { Toast } from './components/controls';
import { NavRail, type NavTarget, TabBar } from './components/shell';
import { go, type Route, useRoute } from './router';
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

export function App({ client, now }: { client: OpClient; now?: () => Date }) {
  return (
    <ClientProvider client={client} now={now}>
      <Shell />
    </ClientProvider>
  );
}

function Shell() {
  const route = useRoute();
  const { toast } = useApp();
  const sum = useOp('pipeline.summary', {});
  const [askOpen, setAskOpen] = useState(false);
  const [lastRole, setLastRole] = useState<string | null>(null);

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

  const navigate = useCallback((t: NavTarget) => {
    if (t === 'ask') setAskOpen(true);
    else go({ screen: t });
  }, []);

  const needs = sum.data?.needs_you ?? 0;
  const active = askOpen ? 'ask' : route.screen;
  return (
    <div className="app">
      <NavRail active={active} needsBadge={needs} onNavigate={navigate} />
      <main className="main">
        <ScreenFor route={route} />
      </main>
      <TabBar active={active} needsBadge={needs} onNavigate={navigate} />
      <Ask
        open={askOpen}
        roleId={route.screen === 'role' || route.screen === 'people' ? route.roleId : lastRole}
        onClose={() => setAskOpen(false)}
      />
      <Toast text={toast} />
    </div>
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
      return <Onboarding />;
    case 'settings':
      return <Settings />;
  }
}
