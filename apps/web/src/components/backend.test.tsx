import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BackendCard } from './shell';

const latency = (el: HTMLElement) => el.querySelector('.latency')?.textContent;

describe('BackendCard latency (#100)', () => {
  it('agent session with no measured turns shows n/a, never 0', () => {
    const { container } = render(<BackendCard name="Agent" mode="session" status="ok" latencyMs={null} />);
    expect(latency(container)).toBe('n/a');
  });

  it('agent session with a median shows it, labelled p50', () => {
    const { container } = render(<BackendCard name="Agent" mode="session" status="ok" latencyMs={4200} />);
    expect(latency(container)).toBe('4200ms p50');
  });

  it('a local backend shows its measured ms', () => {
    const { container } = render(<BackendCard name="Kev" mode="local" status="ok" latencyMs={120} />);
    expect(latency(container)).toBe('120ms');
  });
});
