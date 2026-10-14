import { useEffect, useState } from 'react';

/** hash 路由：#/overview #/usage #/clients #/keys #/requests #/settings */
export type Route = 'overview' | 'usage' | 'clients' | 'keys' | 'requests' | 'settings';

export const ROUTES: Route[] = ['overview', 'usage', 'clients', 'keys', 'requests', 'settings'];

function parse(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '').split('?')[0];
  return (ROUTES as string[]).includes(raw) ? (raw as Route) : 'overview';
}

export function useHashRoute(): { route: Route; navigate: (r: Route) => void } {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = (r: Route) => {
    window.location.hash = `#/${r}`;
  };

  return { route, navigate };
}
// @zbiti-ai:f:27:8500a0d0
