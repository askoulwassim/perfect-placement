// `pnpm demo`: the Ask panel streaming recorded replies on fixtures at a realistic pace (600 ms TTFT, 60 tok/s).
import { createRoot } from 'react-dom/client';
import { AskPanel } from '../src/AskPanel.js';
import { scriptedAsk } from '../src/ask.js';
import { fixtureData } from '../src/data.js';

const el = document.getElementById('root');
if (el)
  createRoot(el).render(
    <AskPanel
      data={fixtureData()}
      ask={scriptedAsk({ tokensPerSecond: 60, firstTokenMs: 600 })}
      initialQuery="Why is Linear my best fit?"
    />,
  );
