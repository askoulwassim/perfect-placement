import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

describe('Markdown (#35)', () => {
  it('renders structure and escapes raw HTML instead of running it', () => {
    const { container } = render(
      <Markdown source={'# Synthetic Title\n\n**Bold** and *em*.\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>'} />,
    );
    expect(container.querySelector('h1')?.textContent).toBe('Synthetic Title');
    expect(container.querySelector('strong')?.textContent).toBe('Bold');
    expect(container.querySelector('script, img')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('links only http(s) and mailto, in a new tab', () => {
    const { container } = render(
      <Markdown source={'[site](https://example.com/a) [mail](mailto:a@example.com) [bad](javascript:alert(1)) https://example.org/b'} />,
    );
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://example.com/a', 'mailto:a@example.com', 'https://example.org/b']);
    for (const a of container.querySelectorAll('a')) expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.textContent).toContain('bad');
  });
});
