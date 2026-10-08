import '@perfect-placement/contracts/tokens.css';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createHttpClient, DEFAULT_API_BASE } from './client/http';
import type { OpClient } from './client/types';

/*
 * Live ops by default: same-origin `/api` when `pp up` serves the build, or the Vite proxy in dev.
 * `VITE_PP_API` points at another base. `vite --mode mock` previews the read-only fixtures instead.
 */
async function boot() {
  let client: OpClient;
  let now: (() => Date) | undefined;
  if (import.meta.env.MODE === 'mock') {
    const [{ createMockClient }, { FIXTURE_NOW }] = await Promise.all([import('./client/mock'), import('@perfect-placement/fixtures')]);
    now = () => new Date(FIXTURE_NOW);
    client = createMockClient({ now });
  } else client = createHttpClient((import.meta.env.VITE_PP_API as string | undefined) || DEFAULT_API_BASE);

  const root = document.getElementById('root');
  if (root)
    createRoot(root).render(
      <StrictMode>
        <App client={client} now={now} />
      </StrictMode>,
    );
}

void boot();
