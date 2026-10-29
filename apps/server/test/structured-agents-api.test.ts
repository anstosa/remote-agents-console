import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { DiscoveryService } from '../src/discovery/service.js';
import { WorktreeLaunchStore } from '../src/worktrees/store.js';
import { StructuredAgents, type StructuredLaunch, type StructuredProcesses } from '../src/transports/structured-agents.js';
import type { ModelInfo, StructuredEvent } from '../src/transports/structured.js';
import type { AllowedModel } from '../src/adapters/types.js';
import { authenticatedHeaders, testAuthService } from './helpers/auth.js';
import { testConfig, testProject } from './helpers/config.js';
import { paneLister, processInspector, socketFinder } from './helpers/discovery-stubs.js';

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

const report = { loaded: true as const, sandbox: { engaged: false, reason: 'not sandboxed' }, version: '1.4.0' };

// A scripted structured Agent: it records what it is asked to do and emits the events a test
// scripts. It reports in as soon as it starts unless told to stay silent. Its Conversation and
// model operations succeed (unless it `refuses` them) and report what changed, as a client does.
function fakeAgent({ reports = true, exits = false, refuses = false, models = [] as ModelInfo[] } = {}) {
  const delivered: string[] = [];
  const launches: StructuredLaunch[] = [];
  const operations: string[] = [];
  let emit: (event: StructuredEvent) => void = () => {};
  let closed = false;
  let conversations = 0;
  const processes: StructuredProcesses = {
    start: async (launch, events) => {
      emit = events;
      launches.push(launch);
      if (reports) queueMicrotask(() => emit({ type: 'report', report }));
      if (exits) setTimeout(() => emit({ type: 'exited' }), 10);
      return { holder: { agentId: launch.id, socket: '/tmp/holder.sock', pane: '%9' }, connection: {
        deliver: async prompt => { delivered.push(prompt); return 'started'; },
        newConversation: async () => { operations.push('new'); if (refuses) return false; emit({ type: 'conversation', id: `new-${conversations += 1}` }); return true; },
        switchConversation: async reference => { operations.push(`switch ${reference}`); if (refuses) return false; emit({ type: 'conversation', id: 'switched' }); return true; },
        renameConversation: async name => { operations.push(`rename ${name}`); if (refuses) return false; emit({ type: 'conversation', id: 'named', name }); return true; },
        models: async () => models,
        setModel: async setting => { operations.push(`model ${setting.model} ${setting.effort}`); if (refuses) return false; emit({ type: 'model', current: setting }); return true; },
        close: () => {}
      } };
    },
    stderr: async () => 'pi: could not load its extension',
    stop: async () => { closed = true; }
  };
  return { processes, delivered, launches, operations, emit: (event: StructuredEvent) => emit(event), closed: () => closed };
}

// a console with one Project whose only Worktree is a temporary folder, and the Scratch folder beside it
async function consoleWith(fake: ReturnType<typeof fakeAgent>, options: { reportTimeoutMs?: number; allowedModels?: AllowedModel[] } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-structured-')));
  dirs.push(root);
  const project = testProject({ path: join(root, 'repo') });
  const allowed = options.allowedModels ?? [];
  const config = testConfig({ scratchDirectory: root, projects: [project], adapters: { pi: { program: '/pinned/pi', args: [], env: {}, launchable: true, ...(allowed.length === 0 ? {} : { allowedModels: allowed }) } } });
  const worktreeStore = new WorktreeLaunchStore({ file: join(root, 'worktrees.json') });
  const worktrees = async (path: string) => path === project.path ? [{ path: project.path, branch: 'refs/heads/main', detached: false, bare: false, locked: false, prunable: false }] : undefined;
  const discovery = new DiscoveryService(socketFinder([]), paneLister([]) as never, processInspector(), { cachedPullRequest: async () => undefined, invalidateRepositories: () => {} } as never, config.adapters, config.projects, worktreeStore, worktrees, root);
  const structuredAgents = new StructuredAgents(fake.processes, { file: join(root, 'structured-agents.json'), allowedModels: () => allowed, ...(options.reportTimeoutMs === undefined ? {} : { reportTimeoutMs: options.reportTimeoutMs }) });
  const app = await buildApp(config, { auth: await testAuthService(), discovery, worktreeStore, structuredAgents });
  const headers = await authenticatedHeaders(app);
  const dashboardAgent = async (id: string) => (await app.inject({ method: 'GET', url: '/api/dashboard', headers })).json().agents.find((agent: { id: string }) => agent.id === id);
  return { app, headers, dashboardAgent, root, structuredAgents };
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

  it('serves the latest part of a transcript with a count of earlier items, and each item in full on request', async () => {
    const fake = fakeAgent();
    const { app, headers } = await consoleWith(fake);
    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    const output = Array.from({ length: 12 }, (_, line) => `line ${line + 1}`).join('\n');
    fake.emit({ type: 'transcript', item: { id: 'm1', kind: 'message', role: 'user', text: 'Run the tests' } });
    fake.emit({ type: 'transcript', item: { id: 's1', kind: 'tool', name: 'Script', summary: '1 tool calls', state: 'done', source: 'await tools.bash({ command: "pnpm test" })' } });
    fake.emit({ type: 'transcript', item: { id: 't1', kind: 'tool', name: 'Run', summary: 'pnpm test', state: 'done', parentId: 's1', durationMs: 4612, output: `${output}\n` } });

    const latest = (await app.inject({ method: 'GET', url: `/api/agents/${id}/transcript?limit=2`, headers })).json();
    expect(latest.earlier).toBe(1);
    // the list carries a tool's last lines and its line count, not its whole output or source
    expect(latest.items).toEqual([
      { id: 's1', kind: 'tool', name: 'Script', summary: '1 tool calls', state: 'done' },
      { id: 't1', kind: 'tool', name: 'Run', summary: 'pnpm test', state: 'done', parentId: 's1', durationMs: 4612, tail: 'line 8\nline 9\nline 10\nline 11\nline 12', outputLines: 12 }
    ]);
    expect((await app.inject({ method: 'GET', url: `/api/agents/${id}/transcript`, headers })).json()).toMatchObject({ earlier: 0, items: [{ id: 'm1' }, { id: 's1' }, { id: 't1' }] });

    const full = await app.inject({ method: 'GET', url: `/api/agents/${id}/transcript?item=${encodeURIComponent('t1')}`, headers });
    expect(full.json()).toEqual({ item: { id: 't1', kind: 'tool', name: 'Run', summary: 'pnpm test', state: 'done', parentId: 's1', durationMs: 4612, output: `${output}\n` } });
    expect((await app.inject({ method: 'GET', url: `/api/agents/${id}/transcript?item=s1`, headers })).json().item.source).toBe('await tools.bash({ command: "pnpm test" })');
    expect((await app.inject({ method: 'GET', url: `/api/agents/${id}/transcript?item=nowhere`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/agents/${id}/transcript?limit=0`, headers })).statusCode).toBe(400);
    await app.close();
  });

  it('carries the status line: the extension\'s statuses, the context used and the cost so far', async () => {
    const fake = fakeAgent();
    const { app, headers, dashboardAgent } = await consoleWith(fake);
    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    const status = async () => (await app.inject({ method: 'GET', url: `/api/agents/${id}/transcript`, headers })).json().status;
    expect(await status()).toEqual({ extension: [] });

    const before = (await dashboardAgent(id)).structured.revision;
    fake.emit({ type: 'status', key: 'rac-sandbox', text: 'sandbox: on' });
    fake.emit({ type: 'status', key: 'lint', text: 'lint: 2 warnings' });
    fake.emit({ type: 'usage', usage: { cost: 0.0812, contextPercent: 31 } });
    expect((await dashboardAgent(id)).structured.revision).toBeGreaterThan(before);
    expect(await status()).toEqual({ extension: ['sandbox: on', 'lint: 2 warnings'], cost: 0.0812, contextPercent: 31 });

    fake.emit({ type: 'status', key: 'lint' });
    expect(await status()).toEqual({ extension: ['sandbox: on'], cost: 0.0812, contextPercent: 31 });
    // a process that exited shows no extension status
    fake.emit({ type: 'exited' });
    expect(await status()).toEqual({ extension: [], cost: 0.0812, contextPercent: 31 });
    await app.close();
  });

  it('replaces the transcript with a Conversation\'s history, and marks a prompt that came from the queue', async () => {
    const fake = fakeAgent();
    const { app, headers, structuredAgents } = await consoleWith(fake);
    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    const items = async () => (await app.inject({ method: 'GET', url: `/api/agents/${id}/transcript`, headers })).json().items;
    fake.emit({ type: 'transcript', item: { id: 'm1', kind: 'message', role: 'user', text: 'Before' } });
    fake.emit({ type: 'history', items: [{ id: 'h1', kind: 'message', role: 'user', text: 'Earlier' }, { id: 'h2', kind: 'settled', outcome: 'done', cost: 0.01 }] });
    expect(await items()).toEqual([{ id: 'h1', kind: 'message', role: 'user', text: 'Earlier' }, { id: 'h2', kind: 'settled', outcome: 'done', cost: 0.01 }]);

    expect(await structuredAgents.deliver(id, 'From the queue', { queued: true })).toBe('started');
    fake.emit({ type: 'turn', turn: { type: 'started' } });
    fake.emit({ type: 'transcript', item: { id: 'm2', kind: 'message', role: 'user', text: 'From the queue' } });
    fake.emit({ type: 'transcript', item: { id: 'm3', kind: 'message', role: 'user', text: 'A steer', steer: true } });
    expect((await items()).slice(2)).toEqual([{ id: 'm2', kind: 'message', role: 'user', text: 'From the queue', queued: true }, { id: 'm3', kind: 'message', role: 'user', text: 'A steer', steer: true }]);

    // a prompt sent straight from the composer is not marked
    fake.emit({ type: 'turn', turn: { type: 'settled', message: '' } });
    expect(await structuredAgents.deliver(id, 'Typed')).toBe('started');
    fake.emit({ type: 'transcript', item: { id: 'm4', kind: 'message', role: 'user', text: 'Typed' } });
    expect((await items()).at(-1)).toEqual({ id: 'm4', kind: 'message', role: 'user', text: 'Typed' });
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

// a Pi session file as Pi writes it, in the session directory of the folder it was started in
async function piSession(agentDir: string, cwd: string, id: string, name?: string): Promise<string> {
  const directory = join(agentDir, 'sessions', `--${cwd.slice(1).replaceAll('/', '-')}--`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `2026-10-29T10-00-00-000Z_${id}.jsonl`);
  const lines = [{ type: 'session', version: 3, id, timestamp: '2026-10-29T10:00:00.000Z', cwd }, { type: 'message', id: 'a1', parentId: null, timestamp: '2026-10-29T10:00:01.000Z', message: { role: 'user', content: 'Fix the parser', timestamp: 0 } }, ...(name === undefined ? [] : [{ type: 'session_info', id: 'a2', parentId: 'a1', timestamp: '2026-10-29T10:00:02.000Z', name }])];
  await writeFile(path, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
  return path;
}

describe('a structured Agent\'s Named conversations', () => {
  it('lists Named Pi Conversations, one named in a hand-started Pi TUI included, and names, starts and switches them in place while idle', async () => {
    const fake = fakeAgent();
    const { app, headers, dashboardAgent, root } = await consoleWith(fake);
    vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'pi'));
    const worktree = (await app.inject({ method: 'GET', url: '/api/dashboard', headers })).json().projects[0].worktrees[0];
    const handStarted = await piSession(join(root, 'pi'), join(root, 'repo'), '01a188d1-e7d9-711a-aba8-381b96066aa5', 'Fix the parser');
    await piSession(join(root, 'pi'), join(root, 'repo'), '01a188d1-ef8b-711a-aba8-381d336076c6');
    const id: string = (await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(worktree.id)}/launch`, headers, payload: { kind: 'pi' } })).json().agentId;
    fake.emit({ type: 'conversation', id: 'first' });

    const listed = (await app.inject({ method: 'GET', url: `/api/agents/${id}/conversations`, headers })).json().conversations;
    expect(listed).toEqual([expect.objectContaining({ kind: 'pi', id: '01a188d1-e7d9-711a-aba8-381b96066aa5', name: 'Fix the parser', worktreeId: worktree.id, current: false })]);

    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/conversations/name`, headers, payload: { name: 'Ship  it' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: `/api/agents/${id}/conversation`, headers })).json()).toEqual({ name: 'Ship it' });

    // nothing changes Conversation mid-Turn
    fake.emit({ type: 'turn', turn: { type: 'started' } });
    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/conversations/new`, headers })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/conversations/name`, headers, payload: { name: 'Later' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(worktree.id)}/conversations/switch`, headers, payload: { kind: 'pi', id: '01a188d1-e7d9-711a-aba8-381b96066aa5' } })).statusCode).toBe(409);
    expect(fake.operations).toEqual(['rename Ship it']);
    fake.emit({ type: 'turn', turn: { type: 'settled', message: 'done' } });

    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/conversations/new`, headers })).statusCode).toBe(204);
    expect(await dashboardAgent(id)).toMatchObject({ conversationId: 'new-1' });
    // the same Agent switches to the Conversation in place, so its queue and id stay with it
    const switched = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(worktree.id)}/conversations/switch`, headers, payload: { kind: 'pi', id: '01a188d1-e7d9-711a-aba8-381b96066aa5' } });
    expect(switched.statusCode).toBe(201);
    expect(switched.json()).toEqual({ agentId: id });
    expect(fake.operations).toEqual(['rename Ship it', 'new', `switch ${handStarted}`]);
    await app.close();
  });

  it('takes the Agent\'s refusal of a Conversation change as a refusal', async () => {
    const fake = fakeAgent({ refuses: true });
    const { app, headers, dashboardAgent } = await consoleWith(fake);
    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    fake.emit({ type: 'conversation', id: 'first' });

    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/conversations/new`, headers })).statusCode).toBe(409);
    expect(await dashboardAgent(id)).toMatchObject({ conversationId: 'first' });
    await app.close();
  });

  it('resumes a listed Pi Conversation by launching a Pi Agent on it', async () => {
    const fake = fakeAgent();
    const { app, headers, dashboardAgent, root } = await consoleWith(fake, { allowedModels: [{ model: 'openai/gpt-5.6' }] });
    vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'pi'));
    const worktree = (await app.inject({ method: 'GET', url: '/api/dashboard', headers })).json().projects[0].worktrees[0];
    await piSession(join(root, 'pi'), join(root, 'repo'), '01a188d1-e7d9-711a-aba8-381b96066aa5', 'Fix the parser');

    const resumed = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(worktree.id)}/conversations/switch`, headers, payload: { kind: 'pi', id: '01a188d1-e7d9-711a-aba8-381b96066aa5' } });
    expect(resumed.statusCode).toBe(201);
    expect(await dashboardAgent(resumed.json().agentId)).toMatchObject({ kind: 'pi', worktreeId: worktree.id });
    // a resume runs on the Conversation's own model, so no model is chosen for it
    expect(fake.launches).toEqual([expect.objectContaining({ resume: '01a188d1-e7d9-711a-aba8-381b96066aa5' })]);
    expect(fake.launches[0]!.model).toBeUndefined();
    await app.close();
  });
});

const gpt = { id: 'openai/gpt-5.6', name: 'GPT-5.6', provider: 'openai', inputPrice: 1.25, outputPrice: 10, contextWindow: 400_000, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'] };
const opus = { id: 'openrouter/~anthropic/claude-opus-latest', name: 'Claude Opus', provider: 'openrouter', inputPrice: 5, outputPrice: 25, contextWindow: 200_000, efforts: ['off', 'low', 'medium', 'high'] };
const allowedModels: AllowedModel[] = [{ model: gpt.id, effort: 'medium' }, { model: opus.id }];

describe('a structured Agent\'s Allowed models', () => {
  it('launches a new Conversation on the first Allowed model by default, and only ever on an Allowed model', async () => {
    const fake = fakeAgent({ models: [gpt, opus] });
    const { app, headers } = await consoleWith(fake, { allowedModels });

    expect((await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi', model: opus.id, effort: 'high' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi', effort: 'low' } })).statusCode).toBe(201);
    expect(fake.launches.map(launch => launch.model)).toEqual([{ model: gpt.id, effort: 'medium' }, { model: opus.id, effort: 'high' }, { model: gpt.id, effort: 'low' }]);

    expect((await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi', model: 'openai/gpt-4' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi', model: gpt.id, effort: 'lots' } })).statusCode).toBe(400);
    expect(fake.launches).toHaveLength(3);
    await app.close();
  });

  it('switches model and Effort between Turns, only to an Allowed model, and marks the transcript', async () => {
    const fake = fakeAgent({ models: [gpt, opus] });
    const { app, headers, dashboardAgent } = await consoleWith(fake, { allowedModels });
    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    fake.emit({ type: 'model', current: { model: gpt.id, effort: 'medium' } });

    expect(await dashboardAgent(id)).toMatchObject({ structured: { model: { id: gpt.id, name: 'GPT-5.6', effort: 'medium' }, models: true } });
    expect((await app.inject({ method: 'GET', url: `/api/agents/${id}/models`, headers })).json()).toEqual({ models: [gpt, opus], current: { model: gpt.id, effort: 'medium' } });

    // the entry names no Effort, so the current one carries over
    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/model`, headers, payload: { model: opus.id } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/model`, headers, payload: { model: opus.id, effort: 'high' } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/model`, headers, payload: { model: 'openai/gpt-4' } })).statusCode).toBe(409);
    fake.emit({ type: 'turn', turn: { type: 'started' } });
    const working = await app.inject({ method: 'POST', url: `/api/agents/${id}/model`, headers, payload: { model: gpt.id } });
    expect(working.statusCode).toBe(409);
    expect(working.json()).toEqual({ error: 'Cancel the turn to switch.' });

    expect(fake.operations).toEqual([`model ${opus.id} medium`, `model ${opus.id} high`]);
    const notices = (await app.inject({ method: 'GET', url: `/api/agents/${id}/transcript`, headers })).json().items.filter((item: { kind: string }) => item.kind === 'notice');
    expect(notices.map((item: { text: string }) => item.text)).toEqual(['Model → Claude Opus, effort medium', 'Effort → high']);
    await app.close();
  });

  it('moves a Conversation that resumed on a model no longer allowed to the default, and names Allowed models nothing can reach', async () => {
    const fake = fakeAgent({ models: [gpt] });
    const { app, headers } = await consoleWith(fake, { allowedModels });
    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    fake.emit({ type: 'model', current: { model: 'openai/o1', effort: 'high' } });

    await vi.waitFor(() => expect(fake.operations).toEqual([`model ${gpt.id} medium`]));
    // the resumed Conversation's history, arriving after the marks, keeps them
    fake.emit({ type: 'history', items: [{ id: 'h1', kind: 'message', role: 'user', text: 'Earlier prompt' }] });
    const items = (await app.inject({ method: 'GET', url: `/api/agents/${id}/transcript`, headers })).json().items;
    expect(items.map((item: { text: string }) => item.text)).toEqual([
      'Earlier prompt',
      `Allowed models that match nothing reachable: ${opus.id}. Check the spelling and the login.`,
      'Model → GPT-5.6, effort medium: openai/o1 is not an Allowed model'
    ]);
    expect(items.slice(1).map((item: { tone: string }) => item.tone)).toEqual(['warning', 'warning']);
    await app.close();
  });

  it('runs on the kind\'s own default with no Allowed models, and offers no model to choose', async () => {
    const fake = fakeAgent({ models: [gpt] });
    const { app, headers, dashboardAgent } = await consoleWith(fake);
    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    fake.emit({ type: 'model', current: { model: gpt.id, effort: 'off' } });

    expect(fake.launches[0]!.model).toBeUndefined();
    expect(await dashboardAgent(id)).toMatchObject({ structured: { model: { id: gpt.id }, models: false } });
    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/model`, headers, payload: { model: gpt.id } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi', model: gpt.id } })).statusCode).toBe(400);
    expect(fake.operations).toEqual([]);
    await app.close();
  });
});
