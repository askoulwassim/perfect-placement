import { PROFILE_COMPONENT_KEYS, type ProfileComponentKey, type Screen } from '@perfect-placement/contracts';
import { useEffect, useState } from 'react';

export type Route =
  | { screen: 'now' | 'needs-you' | 'river' | 'settings' }
  /** `component`: open You with that component selected (after a re-interview). */
  | { screen: 'you'; component?: ProfileComponentKey }
  | { screen: 'onboarding'; calibrate?: boolean }
  | { screen: 'role'; roleId: string }
  | { screen: 'people'; roleId: string }
  | { screen: 'outreach-draft'; outreachId: string }
  /** Runs (#21): the list, or one run with its log. Reached from the rail's run indicator and Settings. */
  | { screen: 'runs'; runId?: string };

export function parseRoute(hash: string): Route {
  const [head, arg] = hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  switch (head) {
    case 'needs-you':
    case 'river':
    case 'settings':
      return { screen: head };
    case 'you':
      return arg && (PROFILE_COMPONENT_KEYS as readonly string[]).includes(arg)
        ? { screen: 'you', component: arg as ProfileComponentKey }
        : { screen: 'you' };
    case 'onboarding':
      return arg === 'calibrate' ? { screen: 'onboarding', calibrate: true } : { screen: 'onboarding' };
    case 'role':
      return arg ? { screen: 'role', roleId: arg } : { screen: 'river' };
    case 'people':
      return arg ? { screen: 'people', roleId: arg } : { screen: 'river' };
    case 'outreach':
      return arg ? { screen: 'outreach-draft', outreachId: arg } : { screen: 'now' };
    case 'runs':
      return arg ? { screen: 'runs', runId: arg } : { screen: 'runs' };
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
    case 'runs':
      return r.runId ? `#/runs/${encodeURIComponent(r.runId)}` : '#/runs';
    case 'you':
      return r.component ? `#/you/${r.component}` : '#/you';
    case 'onboarding':
      return r.calibrate ? '#/onboarding/calibrate' : '#/onboarding';
    default:
      return `#/${r.screen}`;
  }
}

export function go(r: Route) {
  window.location.hash = href(r);
}

/** Navigate without a history entry (a redirect), so Back does not bounce. */
export function replaceRoute(r: Route) {
  window.history.replaceState(window.history.state, '', href(r));
  window.dispatchEvent(new HashChangeEvent('hashchange'));
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

/** The contract screen a route belongs to (Runs is part of Settings). */
export const screenOf = (r: Route): Screen => (r.screen === 'runs' ? 'settings' : r.screen);
