import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/domain/models.js';
import { resolveAttention } from '../src/adapters/attention.js';
import { instanceAttention, RemoteInstanceStatusPoller, validPeerRequest } from '../src/instance-status.js';

const secret = 'status-secret-with-at-least-thirty-two-bytes';
const remote = { url: new URL('https://framework.example') };
const heart = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="20" fill="#f38ba8"/></svg>';
const heartHash = 'lSxGd7vzK6UvvUIlS6950IzQ8fnMvk0EBAMnDfXCtAg';
const leaf = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#a6e3a1"/></svg>';
const leafHash = 'QC2kBz3Jyj-dnHJOd1-Xt2HT80T_BmczAwvEHvoik_0';
const activeHash = '3K_n-GYjCooDNWMIpjQiM_8QoWd51ECIrCojOBmhK78';
// answer the signed status and artwork surfaces of one peer
const peer = (status: () => object, artwork: () => Response | Promise<Response>) => vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.pathname === '/api/instance-status') return new Response(JSON.stringify(status()), { status: 200 });
  if (url.pathname === '/api/instance-icon') return await artwork();
  return new Response('', { status: 404 });
});
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

    await expect(new RemoteInstanceStatusPoller(secret).statuses([remote])).resolves.toEqual([{ url: remote.url.origin, name: 'Framework', attention: 'working' }]);

    const timestamp = requestHeaders.get('x-rac-status-timestamp');
    const signature = requestHeaders.get('x-rac-status-signature');
    const requestedAt = Number(timestamp);
    expect(validPeerRequest(secret, 'status', remote.url.origin, timestamp, signature, requestedAt)).toBe(true);
    expect(validPeerRequest(`${secret}-wrong`, 'status', remote.url.origin, timestamp, signature, requestedAt)).toBe(false);
    expect(validPeerRequest(secret, 'status', remote.url.origin, timestamp, signature, requestedAt + 30_001)).toBe(false);
  });

  it('fetches the announced artwork once, signed for artwork only, and publishes its hash', async () => {
    const fetchPeer = peer(() => ({ name: 'Framework', icon: 'heart', iconHash: heartHash, attention: 'idle' }), () => new Response(heart, { status: 200 }));
    vi.stubGlobal('fetch', fetchPeer);
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const poller = new RemoteInstanceStatusPoller(secret);

    await expect(poller.statuses([remote])).resolves.toEqual([{ url: remote.url.origin, name: 'Framework', iconHash: heartHash, attention: 'idle' }]);
    expect(poller.artwork(heartHash)).toBe(heart);
    now += 5_001;
    await expect(poller.statuses([remote])).resolves.toEqual([{ url: remote.url.origin, name: 'Framework', iconHash: heartHash, attention: 'idle' }]);
    const artworkCalls = fetchPeer.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/api/instance-icon');
    expect(artworkCalls).toHaveLength(1);

    const artworkHeaders = new Headers(artworkCalls[0]![1]?.headers);
    expect(artworkCalls[0]![1]?.redirect).toBe('error');
    const timestamp = artworkHeaders.get('x-rac-status-timestamp');
    const signature = artworkHeaders.get('x-rac-status-signature');
    expect(validPeerRequest(secret, 'icon', remote.url.origin, timestamp, signature, now)).toBe(true);
    expect(validPeerRequest(secret, 'status', remote.url.origin, timestamp, signature, now)).toBe(false);
  });

  it('refetches when the hash changes and serves only the current artwork', async () => {
    let announced = heartHash;
    const fetchPeer = peer(() => ({ name: 'Framework', iconHash: announced, attention: 'idle' }), () => new Response(announced === heartHash ? heart : leaf, { status: 200 }));
    vi.stubGlobal('fetch', fetchPeer);
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const poller = new RemoteInstanceStatusPoller(secret);

    await poller.statuses([remote]);
    announced = leafHash;
    now += 5_001;

    await expect(poller.statuses([remote])).resolves.toEqual([{ url: remote.url.origin, name: 'Framework', iconHash: leafHash, attention: 'idle' }]);
    expect(poller.artwork(leafHash)).toBe(leaf);
    expect(poller.artwork(heartHash)).toBeUndefined();
  });

  it('renders terminal for active or oversized artwork without refetching it, and retries artwork that is not the announced hash', async () => {
    const oversizedBody = `<svg>${' '.repeat(262_144)}</svg>`;
    const bodies: Record<string, string> = { 'https://active.example': '<svg onload="alert(1)"></svg>', 'https://oversized.example': oversizedBody, 'https://mismatched.example': heart };
    const hashes: Record<string, string> = { 'https://active.example': activeHash, 'https://oversized.example': createHash('sha256').update(oversizedBody).digest('base64url'), 'https://mismatched.example': leafHash };
    const servers = Object.keys(bodies).map(origin => ({ url: new URL(origin) }));
    const fetchPeer = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/instance-status') return new Response(JSON.stringify({ name: 'Peer', iconHash: hashes[url.origin], attention: 'idle' }), { status: 200 });
      return new Response(bodies[url.origin], { status: 200 });
    });
    vi.stubGlobal('fetch', fetchPeer);
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const poller = new RemoteInstanceStatusPoller(secret);
    const artworkFetches = (origin: string) => fetchPeer.mock.calls.filter(([input]) => new URL(String(input)).origin === origin && new URL(String(input)).pathname === '/api/instance-icon').length;

    await expect(poller.statuses(servers)).resolves.toEqual(servers.map(server => ({ url: server.url.origin, name: 'Peer', attention: 'idle' })));
    now += 120_000;
    bodies['https://mismatched.example'] = leaf;
    await expect(poller.statuses(servers)).resolves.toEqual([
      { url: 'https://active.example', name: 'Peer', attention: 'idle' },
      { url: 'https://oversized.example', name: 'Peer', attention: 'idle' },
      { url: 'https://mismatched.example', name: 'Peer', iconHash: leafHash, attention: 'idle' }
    ]);

    expect(poller.artwork(activeHash)).toBeUndefined();
    expect([artworkFetches('https://active.example'), artworkFetches('https://oversized.example'), artworkFetches('https://mismatched.example')]).toEqual([1, 1, 2]);
  });

  it('rejects artwork built to make validation slow without stalling the poll', async () => {
    const hostile = [`<svg${' '.repeat(260_000)}`, `<svg ${'a'.repeat(260_000)}>`];
    const servers = hostile.map((_, index) => ({ url: new URL(`https://hostile-${index}.example`) }));
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const body = hostile[servers.findIndex(server => server.url.origin === url.origin)]!;
      if (url.pathname === '/api/instance-status') return new Response(JSON.stringify({ name: 'Peer', iconHash: createHash('sha256').update(body).digest('base64url'), attention: 'idle' }), { status: 200 });
      return new Response(body, { status: 200 });
    }));
    const started = performance.now();

    await expect(new RemoteInstanceStatusPoller(secret).statuses(servers)).resolves.toEqual(servers.map(server => ({ url: server.url.origin, name: 'Peer', attention: 'idle' })));
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('accepts artwork larger than a status response and keeps a byte-order mark in its hash', async () => {
    const large = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${'<rect width="1" height="1"/>'.repeat(400)}</svg>`;
    const marked = `\uFEFF${heart}`;
    const artworks = { 'https://large.example': large, 'https://marked.example': marked } as Record<string, string>;
    const servers = Object.keys(artworks).map(origin => ({ url: new URL(origin) }));
    const hash = (svg: string) => createHash('sha256').update(svg).digest('base64url');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/instance-status') return new Response(JSON.stringify({ name: 'Peer', iconHash: hash(artworks[url.origin]!), attention: 'idle' }), { status: 200 });
      return new Response(artworks[url.origin], { status: 200 });
    }));
    const poller = new RemoteInstanceStatusPoller(secret);

    await expect(poller.statuses(servers)).resolves.toEqual(servers.map(server => ({ url: server.url.origin, name: 'Peer', iconHash: hash(artworks[server.url.origin]!), attention: 'idle' })));
    expect(poller.artwork(hash(large))).toBe(large);
  });

  it('retries artwork the peer failed to serve after a pause', async () => {
    let artworkStatus = 503;
    const fetchPeer = peer(() => ({ name: 'Framework', iconHash: heartHash, attention: 'idle' }), () => new Response(heart, { status: artworkStatus }));
    vi.stubGlobal('fetch', fetchPeer);
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const poller = new RemoteInstanceStatusPoller(secret);

    await expect(poller.statuses([remote])).resolves.toEqual([{ url: remote.url.origin, name: 'Framework', attention: 'idle' }]);
    artworkStatus = 200;
    now += 5_001;
    await expect(poller.statuses([remote])).resolves.toEqual([{ url: remote.url.origin, name: 'Framework', attention: 'idle' }]);
    now += 60_000;
    await expect(poller.statuses([remote])).resolves.toEqual([{ url: remote.url.origin, name: 'Framework', iconHash: heartHash, attention: 'idle' }]);
    expect(fetchPeer.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/api/instance-icon')).toHaveLength(2);
  });

  it('keeps the last verified artwork while a new hash waits to be fetched', async () => {
    let announced = heartHash;
    let artworkStatus = 200;
    const fetchPeer = peer(() => ({ name: 'Framework', iconHash: announced, attention: 'idle' }), () => new Response(announced === heartHash ? heart : leaf, { status: artworkStatus }));
    vi.stubGlobal('fetch', fetchPeer);
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const poller = new RemoteInstanceStatusPoller(secret);

    await poller.statuses([remote]);
    announced = leafHash;
    artworkStatus = 503;
    now += 5_001;
    await expect(poller.statuses([remote])).resolves.toEqual([{ url: remote.url.origin, name: 'Framework', iconHash: heartHash, attention: 'idle' }]);
    expect(poller.artwork(heartHash)).toBe(heart);

    artworkStatus = 200;
    now += 60_000;
    await expect(poller.statuses([remote])).resolves.toEqual([{ url: remote.url.origin, name: 'Framework', iconHash: leafHash, attention: 'idle' }]);
    expect(poller.artwork(leafHash)).toBe(leaf);
  });

  it('keeps the verified artwork while the peer is unavailable', async () => {
    let up = true;
    const fetchPeer = peer(() => ({ name: 'Framework', iconHash: heartHash, attention: 'idle' }), () => new Response(heart, { status: 200 }));
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => { if (!up) throw new TypeError('peer unavailable'); return await fetchPeer(input, init); }));
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const poller = new RemoteInstanceStatusPoller(secret);

    await poller.statuses([remote]);
    up = false;
    now += 5_001;

    await expect(poller.statuses([remote])).resolves.toEqual([{ url: remote.url.origin, name: 'Framework', iconHash: heartHash, attention: 'unavailable' }]);
    expect(poller.artwork(heartHash)).toBe(heart);
  });

  it('queries published bootstrap names from older peers and leaves them the terminal icon', async () => {
    const fetchStatus = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      // serve the legacy status and identity surfaces
      if (url.pathname === '/api/instance-status') return new Response(JSON.stringify({ attention: 'idle' }), { status: 200 });
      return new Response(JSON.stringify({ server: { name: 'Framework', icon: 'heart', url: remote.url.origin, remotes: [] } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchStatus);

    await expect(new RemoteInstanceStatusPoller(secret).statuses([remote])).resolves.toEqual([{ url: remote.url.origin, name: 'Framework', attention: 'idle' }]);
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
