import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildMime, createDryRunGmail, createGmailApiClient, GMAIL_DRAFTS_ENDPOINT } from './index.js';

describe('mime', () => {
  it('builds a plain-text message and strips header injection', () => {
    const m = buildMime({ to: 'maya@example.com\r\nBcc: x@example.com', subject: 'Hi\nthere', body: 'a\nb' });
    expect(m).toContain('To: maya@example.com Bcc: x@example.com');
    expect(m).not.toMatch(/\r\nBcc:/);
    expect(m).toContain('Subject: Hi there');
    expect(m.endsWith('a\r\nb')).toBe(true);
  });
  it('omits To when there is no email and encodes non-ASCII subjects', () => {
    const m = buildMime({ to: null, subject: 'Café chat', body: 'x' });
    expect(m).not.toContain('To:');
    expect(m).toMatch(/Subject: =\?UTF-8\?B\?/);
  });
});

describe('clients', () => {
  it('dry-run records drafts and never calls a network', async () => {
    const g = createDryRunGmail();
    const r = await g.createDraft({ to: null, subject: 's', body: 'b' });
    expect(r.draftId).toBe('dryrun-1');
    expect(g.drafts).toHaveLength(1);
  });

  it('API client only POSTs to the drafts endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'r-123' }), { status: 200 });
    }) as unknown as typeof fetch;
    const g = createGmailApiClient({ accessToken: async () => 'tok', fetch: fakeFetch });
    const r = await g.createDraft({ to: 'a@example.com', subject: 's', body: 'b' });
    expect(r.draftId).toBe('r-123');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(GMAIL_DRAFTS_ENDPOINT);
    expect(calls[0]?.init.method).toBe('POST');
    const raw = JSON.parse(String(calls[0]?.init.body)).message.raw as string;
    expect(Buffer.from(raw, 'base64url').toString('utf8')).toContain('To: a@example.com');
  });

  it('surfaces API errors', async () => {
    const fakeFetch = (async () => new Response('no', { status: 403 })) as unknown as typeof fetch;
    await expect(
      createGmailApiClient({ accessToken: async () => 't', fetch: fakeFetch }).createDraft({ to: null, subject: 's', body: 'b' }),
    ).rejects.toThrow(/403/);
  });

  it('source has no send path', () => {
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\/send|messages\.send|drafts\.send|sendMessage/);
  });
});
