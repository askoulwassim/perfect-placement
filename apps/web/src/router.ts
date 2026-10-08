import type { Screen } from '@perfect-placement/contracts';
import { useEffect, useState } from 'react';

export type Route =
  | { screen: 'now' | 'needs-you' | 'river' | 'you' | 'onboarding' | 'settings' }
  | { screen: 'role'; roleId: string }
  | { screen: 'people'; roleId: string }
  | { screen: 'outreach-draft'; outreachId: string };

export function parseRoute(hash: string): Route {
  const [head, arg] = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  switch (head) {
    case 'needs-you':
    case 'river':
    case 'you':
    case 'onboarding':
    case 'settings':
      return { screen: head };
    case 'role':
      return arg ? { screen: 'role', roleId: arg } : { screen: 'river' };
    case 'people':
      return arg ? { screen: 'people', roleId: arg } : { screen: 'river' };
    case 'outreach':
      return arg ? { screen: 'outreach-draft', outreachId: arg } : { screen: 'now' };
    default:
      return { screen: 'now' };
  }
}

export function href(r: Route): string {
  switch (r.screen) {
    case 'role':
      return `#/role/${encodeURIComponent(r.roleId)}`;
    case 'people':
      return `#/people/${encodeURIComponent(r.roleId)}`;
    case 'outreach-draft':
      return `#/outreach/${encodeURIComponent(r.outreachId)}`;
    default:
      return `#/${r.screen}`;
  }
}

export function go(r: Route) {
  window.location.hash = href(r);
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const screenOf = (r: Route): Screen => r.screen;
