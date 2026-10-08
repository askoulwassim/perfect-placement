import '@perfect-placement/contracts/tokens.css';
import './styles.css';
import { FIXTURE_NOW } from '@perfect-placement/fixtures';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createHttpClient } from './client/http';
import { createMockClient } from './client/mock';

// Fixtures by default. Wave 2: VITE_PP_API=/api switches to the live ops API (`pp up`).
const api = import.meta.env.VITE_PP_API as string | undefined;
const fixtureNow = () => new Date(FIXTURE_NOW);
const client = api ? createHttpClient(api) : createMockClient({ now: fixtureNow });

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <App client={client} now={api ? undefined : fixtureNow} />
    </StrictMode>,
  );
