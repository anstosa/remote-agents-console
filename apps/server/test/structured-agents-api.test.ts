import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { DiscoveryService } from '../src/discovery/service.js';
import { WorktreeLaunchStore } from '../src/worktrees/store.js';
import { StructuredAgents, type StructuredProcesses } from '../src/transports/structured-agents.js';
import type { StructuredEvent } from '../src/transports/structured.js';
import { authenticatedHeaders, testAuthService } from './helpers/auth.js';
import { testConfig, testProject } from './helpers/config.js';
import { paneLister, processInspector, socketFinder } from './helpers/discovery-stubs.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const report = { loaded: true as const, sandbox: { engaged: false, reason: 'not sandboxed' }, version: '1.4.0' };

// A scripted structured Agent: it records what it is asked to do and emits the events a test
// scripts. It reports in as soon as it starts unless told to stay silent.
function fakeAgent({ reports = true, exits = false } = {}) {
  const delivered: string[] = [];
  let emit: (event: StructuredEvent) => void = () => {};
  let closed = false;
  const processes: StructuredProcesses = {
    start: async (_launch, events) => {
      emit = events;
      if (reports) queueMicrotask(() => emit({ type: 'report', report }));
      if (exits) setTimeout(() => emit({ type: 'exited' }), 10);
      return { holder: { agentId: _launch.id, socket: '/tmp/holder.sock', pane: '%9' }, connection: { deliver: async prompt => { delivered.push(prompt); return 'started'; }, close: () => {} } };
    },
    stderr: async () => 'pi: could not load its extension',
    stop: async () => { closed = true; }
  };
  return { processes, delivered, emit: (event: StructuredEvent) => emit(event), closed: () => closed };
}

// a console with one Project whose only Worktree is a temporary folder, and the Scratch folder beside it
async function consoleWith(fake: ReturnType<typeof fakeAgent>, options: { reportTimeoutMs?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-structured-')));
  dirs.push(root);
  const project = testProject({ path: join(root, 'repo') });
  const config = testConfig({ scratchDirectory: root, projects: [project], adapters: { pi: { program: '/pinned/pi', args: [], env: {}, launchable: true } } });
  const worktreeStore = new WorktreeLaunchStore({ file: join(root, 'worktrees.json') });
  const worktrees = async (path: string) => path === project.path ? [{ path: project.path, branch: 'refs/heads/main', detached: false, bare: false, locked: false, prunable: false }] : undefined;
  const discovery = new DiscoveryService(socketFinder([]), paneLister([]) as never, processInspector(), { cachedPullRequest: async () => undefined, invalidateRepositories: () => {} } as never, config.adapters, config.projects, worktreeStore, worktrees, root);
  const structuredAgents = new StructuredAgents(fake.processes, { file: join(root, 'structured-agents.json'), ...options });
  const app = await buildApp(config, { auth: await testAuthService(), discovery, worktreeStore, structuredAgents });
  const headers = await authenticatedHeaders(app);
  const dashboardAgent = async (id: string) => (await app.inject({ method: 'GET', url: '/api/dashboard', headers })).json().agents.find((agent: { id: string }) => agent.id === id);
  return { app, headers, dashboardAgent, root };
}

describe('a structured Agent over HTTP', () => {
  it('launches at a Place, takes a prompt once it reports in, and is working until its Turn settles', async () => {
    const fake = fakeAgent();
    const { app, headers, dashboardAgent, root } = await consoleWith(fake);

    const launched = await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } });
    expect(launched.statusCode).toBe(201);
    const id: string = launched.json().agentId;
    expect(await dashboardAgent(id)).toMatchObject({ kind: 'pi', transport: 'structured', panel: 'transcript', home: root, attention: 'finished', structured: { lifecycle: 'live' } });
    expect((await dashboardAgent(id)).pane).toBeUndefined();

    const prompted = await app.inject({ method: 'POST', url: `/api/agents/${id}/prompt`, headers, payload: { prompt: 'Say hello', attachments: [] } });
    expect(prompted.statusCode).toBe(204);
    expect(fake.delivered).toEqual(['Say hello']);

    const before = (await dashboardAgent(id)).structured.revision;
    fake.emit({ type: 'turn', turn: { type: 'started' } });
    fake.emit({ type: 'transcript', item: { id: 'm1', kind: 'message', role: 'user', text: 'Say hello' } });
    // the transcript Panel reads the transcript again whenever the revision moves
    expect((await dashboardAgent(id)).structured.revision).toBeGreaterThan(before);
    fake.emit({ type: 'transcript', item: { id: 't1', kind: 'tool', name: 'read', summary: 'README.md', state: 'running' } });
    expect(await dashboardAgent(id)).toMatchObject({ attention: 'working' });
    // a second prompt mid-Turn is refused, not delivered
    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/prompt`, headers, payload: { prompt: 'And again', attachments: [] } })).statusCode).toBe(409);

    fake.emit({ type: 'transcript', item: { id: 't1', kind: 'tool', name: 'read', summary: 'README.md', state: 'done' } });
    fake.emit({ type: 'transcript', item: { id: 'm2', kind: 'message', role: 'assistant', text: 'Hello!' } });
    fake.emit({ type: 'turn', turn: { type: 'settled', message: 'Hello!' } });
    expect(await dashboardAgent(id)).toMatchObject({ attention: 'finished' });
    expect(fake.delivered).toEqual(['Say hello']);

    const transcript = await app.inject({ method: 'GET', url: `/api/agents/${id}/transcript`, headers });
    expect(transcript.statusCode).toBe(200);
    expect(transcript.json().items).toEqual([
      { id: 'm1', kind: 'message', role: 'user', text: 'Say hello' },
      { id: 't1', kind: 'tool', name: 'read', summary: 'README.md', state: 'done' },
      { id: 'm2', kind: 'message', role: 'assistant', text: 'Hello!' }
    ]);
    await app.close();
  });

  it('delivers nothing to an Agent that has not reported in yet', async () => {
    const fake = fakeAgent({ reports: false });
    const { app, headers, dashboardAgent } = await consoleWith(fake);

    const launching = app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } });
    let starting: { id: string } | undefined;
    while (starting === undefined) starting = (await app.inject({ method: 'GET', url: '/api/dashboard', headers })).json().agents.find((agent: { structured?: { lifecycle: string } }) => agent.structured?.lifecycle === 'starting');
    expect((await app.inject({ method: 'POST', url: `/api/agents/${starting.id}/prompt`, headers, payload: { prompt: 'Say hello', attachments: [] } })).statusCode).toBe(409);
    expect(fake.delivered).toEqual([]);

    fake.emit({ type: 'report', report });
    expect((await launching).statusCode).toBe(201);
    expect(await dashboardAgent(starting.id)).toMatchObject({ structured: { lifecycle: 'live' } });
    await app.close();
  });

  it('fails an Agent that never reports in, showing its stderr, and dispatches nothing to it', async () => {
    const fake = fakeAgent({ reports: false });
    const { app, headers, dashboardAgent } = await consoleWith(fake, { reportTimeoutMs: 50 });

    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    expect(await dashboardAgent(id)).toMatchObject({ attention: 'finished', structured: { lifecycle: 'failed' } });
    expect((await app.inject({ method: 'GET', url: `/api/agents/${id}/transcript`, headers })).json()).toMatchObject({ stderr: 'pi: could not load its extension' });
    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/prompt`, headers, payload: { prompt: 'Say hello', attachments: [] } })).statusCode).toBe(409);
    expect(fake.delivered).toEqual([]);
    await app.close();
  });

  it('fails an Agent whose process exits before reporting in, without waiting out the report', async () => {
    const fake = fakeAgent({ reports: false, exits: true });
    const { app, headers, dashboardAgent } = await consoleWith(fake);

    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    expect(await dashboardAgent(id)).toMatchObject({ structured: { lifecycle: 'failed', reason: 'Its process exited before reporting in.' } });
    await app.close();
  });

  it('launches in a Worktree, where the Agent is that Worktree\'s', async () => {
    const fake = fakeAgent();
    const { app, headers, dashboardAgent } = await consoleWith(fake);
    const worktree = (await app.inject({ method: 'GET', url: '/api/dashboard', headers })).json().projects[0].worktrees[0];

    const launched = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(worktree.id)}/launch`, headers, payload: { kind: 'pi' } });
    expect(launched.statusCode).toBe(201);
    expect(await dashboardAgent(launched.json().agentId)).toMatchObject({ kind: 'pi', worktreeId: worktree.id, placeId: worktree.id });
    await app.close();
  });

  it('closes an Agent, which leaves the dashboard', async () => {
    const fake = fakeAgent();
    const { app, headers, dashboardAgent } = await consoleWith(fake);
    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;

    expect((await app.inject({ method: 'DELETE', url: `/api/agents/${id}`, headers })).statusCode).toBe(204);
    expect(fake.closed()).toBe(true);
    expect(await dashboardAgent(id)).toBeUndefined();
    await app.close();
  });
});
