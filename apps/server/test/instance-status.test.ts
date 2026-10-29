import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/domain/models.js';
import { resolveAttention } from '../src/adapters/attention.js';
import { instanceAttention, RemoteInstanceStatusPoller, validInstanceStatusRequest } from '../src/instance-status.js';

const secret = 'status-secret-with-at-least-thirty-two-bytes';
const remote = { url: new URL('https://framework.example') };
const agent = (title: string, unread = false, overrides: Partial<Agent> = {}) => ({
  id: 'socket:%1',
  pane: { paneId: '%1', sessionId: '$1', socketFingerprint: 'socket' },
  home: '/workspace',
  title,
  kind: 'codex' as const,
  attention: resolveAttention({ kind: 'codex', title, hasQuestion: overrides.question !== undefined }),
  unread,
  ...overrides
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('instance attention', () => {
  it('reports active work as working even when a completion remains unread', () => {
    expect(instanceAttention({ agents: [agent('⠋ Working', true)] })).toBe('working');
  });

  it('prioritizes questions over active work', () => {
    const question = { id: 'question-1', text: 'Deploy?', choices: ['Yes', 'No'], source: 'structured' as const, pane: { targetPaneId: '%2' } };

    expect(instanceAttention({ agents: [agent('⠋ Working'), agent('Ready', false, { question })] })).toBe('question');
  });

  it('presents a latest-message question while canonical attention remains finished', () => {
    expect(instanceAttention({ agents: [agent('Ready', false, { attention: 'finished', hasMessageQuestion: true })] })).toBe('question');
  });

  it('retains completed attention until it is read', () => {
    expect(instanceAttention({ agents: [agent('Ready', true)] })).toBe('completed');
    expect(instanceAttention({ agents: [agent('Ready')] })).toBe('idle');
  });
});

describe('remote instance status', () => {
  it('signs fresh requests and accepts working peer responses', async () => {
    let requestHeaders = new Headers();
    const fetchStatus = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ name: 'Framework', icon: 'heart', attention: 'working' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchStatus);

    await expect(new RemoteInstanceStatusPoller(secret).statuses([remote])).resolves.toEqual([{ url: remote.url.origin, name: 'Framework', icon: 'heart', attention: 'working' }]);

    const timestamp = requestHeaders.get('x-rac-status-timestamp');
    const signature = requestHeaders.get('x-rac-status-signature');
    const requestedAt = Number(timestamp);
    expect(validInstanceStatusRequest(secret, remote.url.origin, timestamp, signature, requestedAt)).toBe(true);
    expect(validInstanceStatusRequest(`${secret}-wrong`, remote.url.origin, timestamp, signature, requestedAt)).toBe(false);
    expect(validInstanceStatusRequest(secret, remote.url.origin, timestamp, signature, requestedAt + 30_001)).toBe(false);
  });

  it('queries published bootstrap metadata from older peers', async () => {
    const fetchStatus = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      // serve the legacy status and identity surfaces
      if (url.pathname === '/api/instance-status') return new Response(JSON.stringify({ attention: 'idle' }), { status: 200 });
      return new Response(JSON.stringify({ server: { name: 'Framework', icon: 'heart', url: remote.url.origin, remotes: [] } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchStatus);

    await expect(new RemoteInstanceStatusPoller(secret).statuses([remote])).resolves.toEqual([{ url: remote.url.origin, name: 'Framework', icon: 'heart', attention: 'idle' }]);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it('shares in-flight and cached remote polls', async () => {
    let now = 1_800_000_000_000;
    let release!: (response: Response) => void;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchStatus = vi.fn(async () => await new Promise<Response>(resolve => { release = resolve; }));
    vi.stubGlobal('fetch', fetchStatus);
    const poller = new RemoteInstanceStatusPoller(secret);

    const first = poller.statuses([remote]);
    const second = poller.statuses([remote]);
    await vi.waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(1));
    release(new Response(JSON.stringify({ name: 'Framework', attention: 'completed' }), { status: 200 }));

    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ url: remote.url.origin, name: 'Framework', attention: 'completed' }],
      [{ url: remote.url.origin, name: 'Framework', attention: 'completed' }]
    ]);
    await expect(poller.statuses([remote])).resolves.toEqual([{ url: remote.url.origin, name: 'Framework', attention: 'completed' }]);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    now += 5_001;
    fetchStatus.mockResolvedValueOnce(new Response(JSON.stringify({ name: 'Framework', attention: 'question' }), { status: 200 }));
    await expect(poller.statuses([remote])).resolves.toEqual([{ url: remote.url.origin, name: 'Framework', attention: 'question' }]);
    expect(fetchStatus).toHaveBeenCalledTimes(2);

    now += 5_001;
    fetchStatus.mockRejectedValueOnce(new TypeError('peer unavailable'));
    await expect(poller.statuses([remote])).resolves.toEqual([{ url: remote.url.origin, name: 'Framework', attention: 'unavailable' }]);
  });

  it('marks redirects, oversized bodies, and malformed payloads unavailable', async () => {
    const redirected = { url: new URL('https://redirected.example') };
    const oversized = { url: new URL('https://oversized.example') };
    const malformed = { url: new URL('https://malformed.example') };
    const fetchStatus = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      const origin = new URL(String(input)).origin;
      if (origin === redirected.url.origin) throw new TypeError('redirect rejected');
      if (origin === oversized.url.origin) return new Response('x'.repeat(1_025), { status: 200, headers: { 'content-length': '1025' } });
      return new Response(JSON.stringify({ attention: 'unknown' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchStatus);

    await expect(new RemoteInstanceStatusPoller(secret).statuses([redirected, oversized, malformed])).resolves.toEqual([
      { url: redirected.url.origin, name: 'redirected.example', attention: 'unavailable' },
      { url: oversized.url.origin, name: 'oversized.example', attention: 'unavailable' },
      { url: malformed.url.origin, name: 'malformed.example', attention: 'unavailable' }
    ]);
  });
});
