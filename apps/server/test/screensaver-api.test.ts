import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { screensaverPreviewIdentity } from '../src/screensaver/identity.js';
import { testConfig } from './helpers/config.js';

const previewUrl = (id: string, identity: string): string => `/api/agents/${id}/screensaver?identity=${encodeURIComponent(identity)}`;

describe('screensaver content API', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  // close the isolated server after each assertion
  afterEach(async () => { await app?.close(); });

  // require browser control and return the service contract without mutation
  it('serves authenticated Agent content and rejects missing Agents', async () => {
    // return one current Agent and no invented fallback
    const identity = screensaverPreviewIdentity({ id: 'agent-1', transport: 'tmux', pane: { socketFingerprint: 'socket', paneId: '%1', sessionId: '$1' }, conversationId: 'conversation' }, 'response');
    const read = async (id: string, expected: string) => id === 'agent-1' && expected === identity ? { identity, kind: 'response' as const, text: 'Done', available: true } : undefined;
    app = await buildApp(testConfig({ screensaver: { enabled: true, idleMinutes: 0 } }), {
      auth: { unsign: (cookie?: string) => cookie === undefined ? undefined : { id: 'session', csrf: 'csrf' }, get: (session?: unknown) => session } as never,
      control: { connect: () => true, reservationGeneration: () => 'generation' } as never,
      discovery: { worktreesNow: () => [], projectsNow: () => [], dashboard: async () => ({ generation: 1, agents: [], projects: [], places: [] }) } as never,
      launch: { agentHome: () => '/home/operator', launchResolutions: async () => new Map() } as never,
      screensaverContent: { read } as never
    });

    const anonymous = await app.inject({ method: 'GET', url: previewUrl('agent-1', identity), headers: { host: 'agents.example.com' } });
    const invalid = await app.inject({ method: 'GET', url: '/api/agents/agent-1/screensaver', headers: { host: 'agents.example.com', cookie: '__Host-rac=signed' } });
    const shown = await app.inject({ method: 'GET', url: previewUrl('agent-1', identity), headers: { host: 'agents.example.com', cookie: '__Host-rac=signed' } });
    const missing = await app.inject({ method: 'GET', url: previewUrl('missing', identity), headers: { host: 'agents.example.com', cookie: '__Host-rac=signed' } });

    expect(anonymous.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(400);
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toEqual({ identity, kind: 'response', text: 'Done', available: true });
    expect(missing.statusCode).toBe(404);
  });

  // disabled policy omits the endpoint work even for the controlling browser
  it('does not read previews while screensaver mode is disabled', async () => {
    const identity = screensaverPreviewIdentity({ id: 'agent-1', transport: 'structured', conversationId: 'conversation' }, 'response');
    let reads = 0;
    app = await buildApp(testConfig({ screensaver: { enabled: false, idleMinutes: 1 } }), {
      auth: { unsign: (cookie?: string) => cookie === undefined ? undefined : { id: 'session', csrf: 'csrf' }, get: (session?: unknown) => session } as never,
      control: { connect: () => true, reservationGeneration: () => 'generation' } as never,
      discovery: { worktreesNow: () => [], projectsNow: () => [], dashboard: async () => ({ generation: 1, agents: [], projects: [], places: [] }) } as never,
      launch: { agentHome: () => '/home/operator' } as never,
      screensaverContent: { read: async () => { reads += 1; return undefined; } } as never
    });

    const response = await app.inject({ method: 'GET', url: previewUrl('agent-1', identity), headers: { host: 'agents.example.com', cookie: '__Host-rac=signed' } });

    expect(response.statusCode).toBe(404);
    expect(reads).toBe(0);
  });

  // keep per-Agent polling off the full dashboard lifecycle
  it('reads state from the selected Transport without refreshing the dashboard', async () => {
    let dashboardReads = 0;
    const raw = { id: 'agent-1', transport: 'tmux', panel: 'terminal', home: '/pane/root', title: 'Agent', kind: 'codex', attention: 'finished', placeId: 'place-a', conversationId: 'conversation', recoveryProcessKey: 'process' } as const;
    // model dashboard-only Place enrichment and an inferred Inline question
    const placeA = { ...raw, home: '/canonical/a', worktreeId: 'worktree-a', attention: 'question' as const };
    const placeB = { ...raw, home: '/canonical/b', placeId: 'place-b', worktreeId: 'worktree-b', attention: 'question' as const };
    let published: typeof placeA | typeof placeB | undefined = placeA;
    const previewOutput = vi.fn(async (_id: string, rows: number) => ({ text: `last ${rows}`, colors: [{ from: 5, to: 6, foreground: 2 }] }));
    // expose only the read-only Transport surface used by the endpoint
    const transportFor = async () => ({
      // return current state without dashboard discovery
      target: async () => ({ agent: raw }),
      // publish only adapter-bounded, already styled output
      previewOutput,
      // keep unused response reads absent
      latestAnswer: async () => undefined
    });
    app = await buildApp(testConfig({ screensaver: { enabled: true, idleMinutes: 0 } }), {
      auth: { unsign: (cookie?: string) => cookie === undefined ? undefined : { id: 'session', csrf: 'csrf' }, get: (session?: unknown) => session } as never,
      control: { connect: () => true, reservationGeneration: () => 'generation' } as never,
      discovery: {
        worktreesNow: () => [],
        projectsNow: () => [],
        // detect any accidental full dashboard observation
        dashboard: async () => { dashboardReads += 1; return { generation: dashboardReads, adapters: {}, agents: published === undefined ? [] : [published], projects: [], places: [] }; }
      } as never,
      launch: { agentHome: () => '/home/operator', launchResolutions: async () => new Map() } as never,
      prompts: { transportFor, observe: async () => undefined, retireDeparted: async () => undefined } as never
    });

    const firstDashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: '__Host-rac=signed' } });
    expect(firstDashboard.statusCode, firstDashboard.body).toBe(200);
    const retiredIdentity: string = firstDashboard.json().agents[0].previewIdentity;
    published = placeB;
    const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: '__Host-rac=signed' } });
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    const identity: string = dashboard.json().agents[0].previewIdentity;
    expect(identity).not.toBe(retiredIdentity);
    const baseline = dashboardReads;
    const retired = await app.inject({ method: 'GET', url: previewUrl('agent-1', retiredIdentity), headers: { host: 'agents.example.com', cookie: '__Host-rac=signed' } });
    const shown = await app.inject({ method: 'GET', url: previewUrl('agent-1', identity), headers: { host: 'agents.example.com', cookie: '__Host-rac=signed' } });

    expect(retired.statusCode).toBe(404);
    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toEqual({ identity, kind: 'output', text: 'last 7', available: true, colors: [{ from: 5, to: 6, foreground: 2 }] });
    expect(dashboardReads).toBe(baseline);
    expect(previewOutput).toHaveBeenCalledTimes(1);

    published = undefined;
    await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: 'agents.example.com', cookie: '__Host-rac=signed' } });
    const removed = await app.inject({ method: 'GET', url: previewUrl('agent-1', identity), headers: { host: 'agents.example.com', cookie: '__Host-rac=signed' } });
    expect(removed.statusCode).toBe(404);
    expect(previewOutput).toHaveBeenCalledTimes(1);
  });

  // do not publish a preview admitted under a retired control reservation
  it('discards an in-flight preview after takeover', async () => {
    const identity = screensaverPreviewIdentity({ id: 'agent-1', transport: 'structured', conversationId: 'conversation' }, 'response');
    let generation = 'first';
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    app = await buildApp(testConfig({ screensaver: { enabled: true, idleMinutes: 0 } }), {
      auth: { unsign: (cookie?: string) => cookie === undefined ? undefined : { id: 'session', csrf: 'csrf' }, get: (session?: unknown) => session } as never,
      control: { connect: () => true, reservationGeneration: () => generation } as never,
      discovery: { worktreesNow: () => [], projectsNow: () => [], dashboard: async () => ({ generation: 1, agents: [], projects: [], places: [] }) } as never,
      launch: { agentHome: () => '/home/operator' } as never,
      screensaverContent: { read: async () => { started(); await held; return { identity, kind: 'response', text: 'private bytes', available: true }; } } as never
    });

    const response = app.inject({ method: 'GET', url: previewUrl('agent-1', identity), headers: { host: 'agents.example.com', cookie: '__Host-rac=signed' } });
    await entered;
    generation = 'second';
    release();

    expect((await response).statusCode).toBe(423);
    expect((await response).body).not.toContain('private bytes');
  });
});
