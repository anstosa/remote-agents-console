import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { DiscoveryService } from '../src/discovery/service.js';
import { WorktreeLaunchStore } from '../src/worktrees/store.js';
import { PromptHistoryService } from '../src/prompt-history/service.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { StructuredAgents, type HolderRef, type StructuredLaunch, type StructuredProcesses } from '../src/transports/structured-agents.js';
import type { Delivery, ModelInfo, ModelSetting, StructuredConnection, StructuredEvent } from '../src/transports/structured.js';
import type { QuestionAnswer } from '../src/transports/transport.js';
import { WorktreeNoteService } from '../src/notes/service.js';
import type { AllowedModel } from '../src/adapters/types.js';
import { piAdapter } from '../src/adapters/pi.js';
import { authenticatedHeaders, testAuthService } from './helpers/auth.js';
import { testConfig, testProject } from './helpers/config.js';
import { paneLister, processInspector, socketFinder } from './helpers/discovery-stubs.js';

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

// the pinned Pi's report, so a fake is on the pin unless a test says otherwise
const report = { loaded: true as const, sandbox: { engaged: false, reason: 'not sandboxed' }, version: piAdapter.pinned()!.version };

// A scripted structured Agent: it records what it is asked to do and emits the events a test
// scripts. It reports in as soon as it starts unless told to stay silent. Its Conversation and
// model operations succeed (unless it `refuses` them) and report what changed, as a client does.
// A switch lands on `switchedTo` (the Conversation's own model), and `unavailable` models are refused.
// Each delivery answers with the next of `dispositions`, then `started`; a steer waits as pending
// until the Agent takes it or a cancel returns it, and a cancel aborts the Turn before it answers.
// `lines` is how many lines the console has read from its process, which a reattach (after a
// console restart) resumes from; `attaches` lists the holders it was reattached to. A reattach
// reports `attached` (as a client reading its state afresh does), or finds the holder `gone`.
function fakeAgent({ reports = true, exits = false, refuses = false, models = [] as ModelInfo[], switchedTo = undefined as ModelSetting | undefined, unavailable = [] as string[], version = report.version, attaching = Promise.resolve(), dropped = 0, attached = [] as StructuredEvent[], gone = false } = {}) {
  const delivered: string[] = [];
  const launches: StructuredLaunch[] = [];
  const operations: string[] = [];
  const dispositions: Delivery[] = [];
  const answers: Array<[string, QuestionAnswer]> = [];
  let pending: string[] = [];
  let emit: (event: StructuredEvent) => void = () => {};
  let closed = false;
  let conversations = 0;
  let cancels = 0;
  let lines = 0;
  const attaches: HolderRef[] = [];
  const connection = (): StructuredConnection => ({
    deliver: async prompt => { delivered.push(prompt); return dispositions.shift() ?? 'started'; },
    newConversation: async () => { operations.push('new'); if (refuses) return false; emit({ type: 'conversation', id: `new-${conversations += 1}` }); return true; },
    switchConversation: async reference => { operations.push(`switch ${reference}`); if (refuses) return false; emit({ type: 'conversation', id: 'switched' }); if (switchedTo !== undefined) emit({ type: 'model', current: switchedTo }); return true; },
    renameConversation: async name => { operations.push(`rename ${name}`); if (refuses) return false; emit({ type: 'conversation', id: 'named', name }); return true; },
    models: async () => models,
    setModel: async setting => { operations.push(`model ${setting.model} ${setting.effort}`); if (refuses || unavailable.includes(setting.model)) return false; emit({ type: 'model', current: setting }); return true; },
    steer: async prompt => { pending = [...pending, prompt]; emit({ type: 'steers', pending }); return true; },
    cancel: async () => {
      cancels += 1;
      const returned = pending;
      pending = [];
      emit({ type: 'steers', pending });
      emit({ type: 'turn', turn: { type: 'aborted' } });
      return returned;
    },
    answer: async (id, answer) => { answers.push([id, answer]); emit({ type: 'question-closed', id }); return true; },
    // a closed connection hears its process go, as a holder's socket closing says
    close: () => { const closing = emit; queueMicrotask(() => closing({ type: 'exited' })); }
  });
  const processes: StructuredProcesses = {
    start: async (launch, events) => {
      emit = events;
      launches.push(launch);
      if (reports) queueMicrotask(() => emit({ type: 'report', report: { ...report, version } }));
      if (exits) setTimeout(() => emit({ type: 'exited' }), 10);
      return { holder: { agentId: launch.id, socket: '/tmp/holder.sock', pane: '%9' }, connection: connection(), cursor: () => lines, raw: () => [{ from: 'agent' as const, line: '{"type":"agent_start"}' }] };
    },
    attach: async (holder, _kind, events) => {
      attaches.push(holder);
      await attaching;
      if (gone) return undefined;
      emit = events;
      queueMicrotask(() => { for (const event of attached) events(event); });
      return { holder, connection: connection(), cursor: () => lines, dropped };
    },
    stderr: async () => 'pi: could not load its extension',
    stop: async () => { closed = true; }
  };
  return { processes, delivered, launches, attaches, operations, dispositions, answers, steers: () => pending, cancels: () => cancels, emit: (event: StructuredEvent) => emit(event), closed: () => closed, read: (count: number) => { lines = count; } };
}

// a console with one Project whose only Worktree is a temporary folder, and the Scratch folder beside it
// (`linked` adds a linked Worktree beside it; `deps` replace the app's own services)
async function consoleWith(fake: ReturnType<typeof fakeAgent>, options: { reportTimeoutMs?: number; allowedModels?: AllowedModel[]; linked?: boolean; deps?: Record<string, unknown> } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rac-structured-')));
  dirs.push(root);
  const project = testProject({ path: join(root, 'repo') });
  const allowed = options.allowedModels ?? [];
  const config = testConfig({ scratchDirectory: root, projects: [project], adapters: { pi: { program: '/pinned/pi', args: [], env: {}, launchable: true, ...(allowed.length === 0 ? {} : { allowedModels: allowed }) } } });
  const worktreeStore = new WorktreeLaunchStore({ file: join(root, 'worktrees.json') });
  const worktrees = async (path: string) => path === project.path ? [{ path: project.path, branch: 'refs/heads/main', detached: false, bare: false, locked: false, prunable: false }, ...(options.linked === true ? [{ path: join(root, 'feat'), branch: 'refs/heads/feat', detached: false, bare: false, locked: false, prunable: false }] : [])] : undefined;
  const discovery = new DiscoveryService(socketFinder([]), paneLister([]) as never, processInspector(), { cachedPullRequest: async () => undefined, invalidateRepositories: () => {} } as never, config.adapters, config.projects, worktreeStore, worktrees, root);
  // the console as it starts, over the stores in `root`, driving its structured Agents through `processes`
  const start = async (processes: StructuredProcesses) => {
    const structuredAgents = new StructuredAgents(processes, { file: join(root, 'structured-agents.json'), allowedModels: () => allowed, ...(options.reportTimeoutMs === undefined ? {} : { reportTimeoutMs: options.reportTimeoutMs }) });
    const app = await buildApp(config, { auth: await testAuthService(), discovery, worktreeStore, structuredAgents, promptHistory: new PromptHistoryService(join(root, 'history.json')), queuedPrompts: new QueuedPromptService(join(root, 'queue.json')), notes: new WorktreeNoteService(join(root, 'notes.json')), ...options.deps });
    const headers = await authenticatedHeaders(app);
    const dashboardAgent = async (id: string) => (await app.inject({ method: 'GET', url: '/api/dashboard', headers })).json().agents.find((agent: { id: string }) => agent.id === id);
    return { app, headers, dashboardAgent, root, structuredAgents };
  };
  const started = await start(fake.processes);
  // stop this console and start another over the same stores, as a deploy does; it reattaches to its Agents' holders through `next`
  const restart = async (next: ReturnType<typeof fakeAgent>) => {
    await started.app.close();
    const console = await start(next.processes);
    const reattached = console.structuredAgents.reattach();
    // a reattach held up by its holder (`attaching`) goes on behind the console that started
    await Promise.race([reattached, new Promise(resolve => setTimeout(resolve, 50))]);
    return { ...console, reattached };
  };
  return { ...started, restart };
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
    // the prompt waits in the queue until the Agent reports in
    expect((await app.inject({ method: 'POST', url: `/api/agents/${starting.id}/prompt`, headers, payload: { prompt: 'Say hello', attachments: [] } })).statusCode).toBe(204);
    expect(fake.delivered).toEqual([]);

    fake.emit({ type: 'report', report });
    expect((await launching).statusCode).toBe(201);
    expect(await dashboardAgent(starting.id)).toMatchObject({ structured: { lifecycle: 'live' } });
    expect(fake.delivered).toEqual(['Say hello']);
    await app.close();
  });

  it('fails an Agent that never reports in, showing its stderr, and dispatches nothing to it', async () => {
    const fake = fakeAgent({ reports: false });
    const { app, headers, dashboardAgent } = await consoleWith(fake, { reportTimeoutMs: 50 });

    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    expect(await dashboardAgent(id)).toMatchObject({ attention: 'finished', structured: { lifecycle: 'failed' } });
    expect((await app.inject({ method: 'GET', url: `/api/agents/${id}/transcript`, headers })).json()).toMatchObject({ stderr: 'pi: could not load its extension' });
    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/prompt`, headers, payload: { prompt: 'Say hello', attachments: [] } })).statusCode).toBe(204);
    await dashboardAgent(id);
    expect(fake.delivered).toEqual([]);
    expect((await app.inject({ method: 'GET', url: `/api/agents/${id}/queued-prompts`, headers })).json().prompts).toMatchObject([{ text: 'Say hello' }]);
    await app.close();
  });

  it('fails an Agent whose process exits before reporting in, without waiting out the report', async () => {
    const fake = fakeAgent({ reports: false, exits: true });
    const { app, headers, dashboardAgent } = await consoleWith(fake);

    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    expect(await dashboardAgent(id)).toMatchObject({ structured: { lifecycle: 'failed', reason: 'Its process exited before reporting in.' } });
    await app.close();
  });

  it('remembers a Pi launch as the Worktree\'s Launch profile, and a restart continues its latest Conversation as Pi', async () => {
    const fake = fakeAgent();
    const { app, headers } = await consoleWith(fake);
    const worktreeOf = async () => (await app.inject({ method: 'GET', url: '/api/dashboard', headers })).json().projects[0].worktrees[0];
    const worktree = await worktreeOf();
    expect(worktree.launch.origin).not.toBe('worktree');

    const id: string = (await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(worktree.id)}/launch`, headers, payload: { kind: 'pi' } })).json().agentId;
    expect((await worktreeOf()).launch).toMatchObject({ kind: 'pi', origin: 'worktree' });
    const restarted = await app.inject({ method: 'POST', url: `/api/agents/${id}/restart`, headers });
    expect(restarted.statusCode).toBe(201);
    expect(fake.launches.at(-1)).toMatchObject({ kind: 'pi', continue: true });
    expect(fake.launches.at(-1)!.model).toBeUndefined();
    await app.close();
  });

  it('shows its raw event stream and its holder window, for debugging', async () => {
    const fake = fakeAgent();
    const { app, headers } = await consoleWith(fake);
    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    expect((await app.inject({ method: 'GET', url: `/api/agents/${id}/raw-events`, headers })).json()).toEqual({ lines: [{ from: 'agent', line: '{"type":"agent_start"}' }] });
    expect((await app.inject({ method: 'GET', url: `/api/agents/${id}/holder-window`, headers })).json()).toEqual({ pane: '%9', text: 'pi: could not load its extension' });
    expect((await app.inject({ method: 'GET', url: '/api/agents/nobody/raw-events', headers })).statusCode).toBe(404);
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

    expect(await dashboardAgent(id)).toMatchObject({ structured: { model: { id: gpt.id, name: 'GPT-5.6', effort: 'medium' }, switchable: true } });
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
    expect(await dashboardAgent(id)).toMatchObject({ structured: { model: { id: gpt.id }, switchable: false } });
    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/model`, headers, payload: { model: gpt.id } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi', model: gpt.id } })).statusCode).toBe(400);
    expect(fake.operations).toEqual([]);
    await app.close();
  });

  it('holds a switched Conversation to the Allowed models, trying each in order, and keeps notices to their Conversation', async () => {
    const fake = fakeAgent({ models: [gpt, opus], switchedTo: { model: 'openai/o1', effort: 'high' }, unavailable: [gpt.id] });
    const { app, headers, root } = await consoleWith(fake, { allowedModels });
    vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'pi'));
    const worktree = (await app.inject({ method: 'GET', url: '/api/dashboard', headers })).json().projects[0].worktrees[0];
    await piSession(join(root, 'pi'), join(root, 'repo'), '01a188d1-e7d9-711a-aba8-381b96066aa5', 'Old work');
    const id: string = (await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(worktree.id)}/launch`, headers, payload: { kind: 'pi' } })).json().agentId;
    fake.emit({ type: 'conversation', id: 'first' });
    fake.emit({ type: 'model', current: { model: opus.id, effort: 'low' } });
    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/model`, headers, payload: { model: opus.id, effort: 'high' } })).statusCode).toBe(204);

    expect((await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(worktree.id)}/conversations/switch`, headers, payload: { kind: 'pi', id: '01a188d1-e7d9-711a-aba8-381b96066aa5' } })).statusCode).toBe(201);
    // the first Allowed model is refused, so the next one is taken
    expect(fake.operations.slice(-2)).toEqual([`model ${gpt.id} medium`, `model ${opus.id} high`]);
    fake.emit({ type: 'history', items: [{ id: 'h1', kind: 'message', role: 'user', text: 'Old prompt' }] });
    const items = (await app.inject({ method: 'GET', url: `/api/agents/${id}/transcript`, headers })).json().items;
    // the first Conversation's Effort mark stays with it
    expect(items.map((item: { text: string }) => item.text)).toEqual(['Old prompt', 'Model → Claude Opus, effort high: openai/o1 is not an Allowed model']);
    await app.close();
  });

  it('keeps a Schedule\'s model only while it is an Allowed model', async () => {
    const fake = fakeAgent();
    const { app, headers } = await consoleWith(fake, { allowedModels });
    const worktree = (await app.inject({ method: 'GET', url: '/api/dashboard', headers })).json().projects[0].worktrees[0];
    const note = (await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(worktree.id)}/notes`, headers, payload: { title: 'Build', text: 'Check the build' } })).json();
    const schedule = (payload: object) => app.inject({ method: 'PUT', url: `/api/worktrees/${encodeURIComponent(worktree.id)}/notes/${note.id}/schedule`, headers, payload: { cron: '0 9 * * *', kind: 'pi', target: { worktreeId: worktree.id }, enabled: true, ...payload } });

    const set = await schedule({ model: opus.id, effort: 'high' });
    expect(set.statusCode).toBe(200);
    expect(set.json().schedule).toMatchObject({ kind: 'pi', model: opus.id, effort: 'high' });
    expect((await schedule({ model: 'openai/gpt-4' })).statusCode).toBe(400);
    expect((await schedule({ effort: 'lots' })).statusCode).toBe(400);
    await app.close();
  });
});

describe('a structured Agent\'s queued prompts', () => {
  // launch a live Agent and send it one prompt, which starts a Turn
  async function working(fake: ReturnType<typeof fakeAgent>) {
    const console = await consoleWith(fake);
    const id: string = (await console.app.inject({ method: 'POST', url: '/api/agents/launch', headers: console.headers, payload: { kind: 'pi' } })).json().agentId;
    const prompt = (text: string) => console.app.inject({ method: 'POST', url: `/api/agents/${id}/prompt`, headers: console.headers, payload: { prompt: text, attachments: [] } });
    const queued = async () => (await console.app.inject({ method: 'GET', url: `/api/agents/${id}/queued-prompts`, headers: console.headers })).json();
    const history = async () => (await console.app.inject({ method: 'GET', url: `/api/agents/${id}/prompt-history`, headers: console.headers })).json().prompts;
    expect((await prompt('First')).statusCode).toBe(204);
    fake.emit({ type: 'turn', turn: { type: 'started' } });
    return { ...console, id, prompt, queued, history };
  }

  it('queues a prompt sent while the Agent works and dispatches it once the Turn settles, filling history from the answer', async () => {
    const fake = fakeAgent();
    const { app, headers, prompt, queued, history, dashboardAgent, id } = await working(fake);

    expect((await prompt('Second')).statusCode).toBe(204);
    expect(fake.delivered).toEqual(['First']);
    expect((await queued()).prompts).toMatchObject([{ text: 'Second' }]);
    expect(await dashboardAgent(id)).toMatchObject({ queuedPromptCount: 1 });

    fake.emit({ type: 'turn', turn: { type: 'settled', message: 'First answered' } });
    await dashboardAgent(id);
    expect(fake.delivered).toEqual(['First', 'Second']);
    expect((await queued()).prompts).toEqual([]);
    expect(await history()).toMatchObject([{ text: 'Second' }, { text: 'First', answer: 'First answered' }]);
    // observed before its Turn starts, Second's Turn has not settled: First's answer is not Second's
    await dashboardAgent(id);
    expect((await history())[0]).toEqual(expect.not.objectContaining({ answer: expect.anything() }));
    fake.emit({ type: 'turn', turn: { type: 'started' } });
    fake.emit({ type: 'turn', turn: { type: 'settled', message: 'Second answered' } });
    await dashboardAgent(id);
    expect(await history()).toMatchObject([{ text: 'Second', answer: 'Second answered' }, { text: 'First', answer: 'First answered' }]);
    // the prompt that waited is marked as coming from the queue
    fake.emit({ type: 'transcript', item: { id: 'm9', kind: 'message', role: 'user', text: 'Second' } });
    const items = (await app.inject({ method: 'GET', url: `/api/agents/${id}/transcript`, headers })).json().items;
    expect(items).toContainEqual({ id: 'm9', kind: 'message', role: 'user', text: 'Second', queued: true });
    await app.close();
  });

  it('leaves the head queued when the Agent refuses it as already working, and sends it on a later observation', async () => {
    const fake = fakeAgent();
    const { app, prompt, queued, dashboardAgent, id } = await working(fake);
    expect((await prompt('Second')).statusCode).toBe(204);

    // the Agent settles and at once starts work of its own, so the dispatched head is refused
    fake.dispositions.push('busy');
    fake.emit({ type: 'turn', turn: { type: 'settled', message: 'done' } });
    await dashboardAgent(id);
    expect(fake.delivered).toEqual(['First', 'Second']);
    expect((await queued()).prompts).toMatchObject([{ text: 'Second' }]);

    await dashboardAgent(id);
    expect(fake.delivered).toEqual(['First', 'Second', 'Second']);
    expect((await queued()).prompts).toEqual([]);
    await app.close();
  });

  it('turns the queue into Notes when the Agent refuses a prompt outright', async () => {
    const fake = fakeAgent();
    const { app, headers, prompt, queued, dashboardAgent, id } = await working(fake);
    expect((await prompt('Second')).statusCode).toBe(204);

    // say the Agent lost its login: it refuses the head, not for now but at all
    fake.dispositions.push('refused');
    fake.emit({ type: 'turn', turn: { type: 'settled', message: 'done' } });
    await dashboardAgent(id);
    const { placeId } = await dashboardAgent(id);
    expect(fake.delivered).toEqual(['First', 'Second']);
    expect((await queued()).prompts).toEqual([]);
    expect(JSON.stringify((await app.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(placeId)}/notes`, headers })).json())).toContain('Second');
    await app.close();
  });

  it('completes a handled prompt at once and sends the next one', async () => {
    const fake = fakeAgent();
    const { app, prompt, queued, history, dashboardAgent, id } = await working(fake);
    expect((await prompt('/rac-status')).statusCode).toBe(204);
    expect((await prompt('Third')).statusCode).toBe(204);

    fake.dispositions.push('handled');
    fake.emit({ type: 'turn', turn: { type: 'settled', message: 'done' } });
    await dashboardAgent(id);
    expect(fake.delivered).toEqual(['First', '/rac-status']);
    await dashboardAgent(id);
    expect(fake.delivered).toEqual(['First', '/rac-status', 'Third']);
    expect((await queued()).prompts).toEqual([]);
    expect((await history()).map((entry: { text: string }) => entry.text)).toEqual(['Third', 'First']);
    await app.close();
  });

  it('cancels a Turn: the Agent halts, its queue becomes Notes, and its unsent steers come back', async () => {
    const fake = fakeAgent();
    const { app, headers, prompt, queued, dashboardAgent, id } = await working(fake);
    expect((await prompt('Second')).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/steer`, headers, payload: { prompt: 'Use tabs' } })).statusCode).toBe(204);

    const cancelled = await app.inject({ method: 'POST', url: `/api/agents/${id}/cancel`, headers });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toEqual({ steers: ['Use tabs'] });
    expect(fake.cancels()).toBe(1);

    const { placeId } = await dashboardAgent(id);
    expect(fake.delivered).toEqual(['First']);
    expect((await queued()).prompts).toEqual([]);
    const notes = (await app.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(placeId)}/notes`, headers })).json();
    expect(JSON.stringify(notes)).toContain('Second');
    await app.close();
  });

  it('pages several open questions in order, answers each by id, and is in question Attention while one is open', async () => {
    const fake = fakeAgent();
    const { app, headers, prompt, dashboardAgent, id } = await working(fake);
    const expiresAt = Date.now() + 60_000;
    fake.emit({ type: 'question', question: { id: 'q1', text: 'Which branch?', field: { kind: 'choice', choices: ['main', 'dev'] } } });
    fake.emit({ type: 'question', question: { id: 'q2', text: 'Commit message?', field: { kind: 'text', multiline: true, prefill: 'Fix' }, expiresAt } });

    const asking = await dashboardAgent(id);
    expect(asking).toMatchObject({ attention: 'question', question: { id: 'q1', text: 'Which branch?', choices: ['main', 'dev'], field: { kind: 'choice', choices: ['main', 'dev'] } } });
    expect(asking.structured.questions.map((question: { id: string }) => question.id)).toEqual(['q1', 'q2']);
    expect(asking.structured.questions[1]).toMatchObject({ field: { kind: 'text', multiline: true, prefill: 'Fix' }, expiresAt });
    // a prompt sent meanwhile waits in the queue
    expect((await prompt('Later')).statusCode).toBe(204);
    expect(fake.delivered).toEqual(['First']);

    const answer = (payload: object) => app.inject({ method: 'POST', url: `/api/agents/${id}/question`, headers, payload });
    expect((await answer({ questionId: 'q1', index: 2 })).statusCode).toBe(404);
    expect((await answer({ questionId: 'q1', index: 1 })).statusCode).toBe(204);
    expect(await dashboardAgent(id)).toMatchObject({ attention: 'question', question: { id: 'q2' } });
    expect((await answer({ questionId: 'q2', dismiss: true })).statusCode).toBe(204);
    expect(fake.answers).toEqual([['q1', 1], ['q2', { dismiss: true }]]);
    const answered = await dashboardAgent(id);
    expect(answered.attention).toBe('working');
    expect(answered.question).toBeUndefined();
    expect((await answer({ questionId: 'q2', text: 'late' })).statusCode).toBe(404);
    await app.close();
  });

  it('shows steers pending apart from the queue, and records each in history with no answer', async () => {
    const fake = fakeAgent();
    const { app, headers, history, queued, dashboardAgent, id } = await working(fake);
    const steer = (text: string) => app.inject({ method: 'POST', url: `/api/agents/${id}/steer`, headers, payload: { prompt: text } });
    expect((await steer('Use tabs')).statusCode).toBe(204);
    expect((await steer('And tests')).statusCode).toBe(204);

    expect(await dashboardAgent(id)).toMatchObject({ queuedPromptCount: 0, structured: { steers: ['Use tabs', 'And tests'] } });
    expect((await queued()).prompts).toEqual([]);
    expect(fake.delivered).toEqual(['First']);
    const entries = await history();
    expect(entries.map((entry: { text: string }) => entry.text)).toEqual(['And tests', 'Use tabs', 'First']);
    expect(entries[0].answer).toBeUndefined();

    // the Turn settles: First's answer lands on First, not on a steer
    fake.emit({ type: 'steers', pending: [] });
    fake.emit({ type: 'turn', turn: { type: 'settled', message: 'Done, with tabs and tests' } });
    await dashboardAgent(id);
    expect((await history()).map((entry: { text: string; answer?: string }) => [entry.text, entry.answer])).toEqual([['And tests', undefined], ['Use tabs', undefined], ['First', 'Done, with tabs and tests']]);
    await app.close();
  });

  it('offers text from the Agent for the composer until the next prompt', async () => {
    const fake = fakeAgent();
    const { app, prompt, dashboardAgent, id } = await working(fake);
    fake.emit({ type: 'draft', text: 'Suggested next step' });
    expect(await dashboardAgent(id)).toMatchObject({ structured: { draft: { id: 1, text: 'Suggested next step' } } });
    fake.emit({ type: 'turn', turn: { type: 'settled', message: 'done' } });
    await dashboardAgent(id);
    expect((await prompt('Something else')).statusCode).toBe(204);
    expect((await dashboardAgent(id)).structured.draft).toBeUndefined();
    await app.close();
  });

  it('offers the Steer capability for Pi only', async () => {
    const fake = fakeAgent();
    const { app, headers } = await consoleWith(fake);
    const adapters = (await app.inject({ method: 'GET', url: '/api/dashboard', headers })).json().adapters;
    expect(adapters.pi).toMatchObject({ steer: true, inlineQuestions: true });
    expect(adapters.claude).toMatchObject({ steer: false });
    await app.close();
  });

  it('keeps an Exited Agent\'s queue and dispatches nothing to it, recording its Turn in flight failed and showing its stderr', async () => {
    const fake = fakeAgent();
    const { app, headers, prompt, queued, history, dashboardAgent, id } = await working(fake);
    expect((await prompt('Second')).statusCode).toBe(204);

    fake.emit({ type: 'exited' });
    expect(await dashboardAgent(id)).toMatchObject({ attention: 'finished', structured: { lifecycle: 'exited' } });
    await dashboardAgent(id);
    expect(fake.delivered).toEqual(['First']);
    expect((await queued()).prompts).toMatchObject([{ text: 'Second' }]);
    expect(await history()).toEqual([expect.not.objectContaining({ answer: expect.anything() })]);
    const transcript = (await app.inject({ method: 'GET', url: `/api/agents/${id}/transcript`, headers })).json();
    expect(transcript.items.at(-1)).toMatchObject({ kind: 'settled', outcome: 'failed' });
    expect(transcript.stderr).toBe('pi: could not load its extension');
    await app.close();
  });

  it('refuses to cancel or steer an Agent that is not working', async () => {
    const fake = fakeAgent();
    const { app, headers, dashboardAgent, id } = await working(fake);
    fake.emit({ type: 'turn', turn: { type: 'settled', message: 'done' } });
    await dashboardAgent(id);
    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/cancel`, headers })).statusCode).toBe(409);
    expect(fake.cancels()).toBe(0);
    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/steer`, headers, payload: { prompt: 'Too late' } })).statusCode).toBe(409);
    expect(fake.steers()).toEqual([]);
    await app.close();
  });
});

describe('a Schedule\'s unattended Run on a structured Agent', () => {
  // a Worktree Note scheduled every minute on Pi, and the scheduler's tick a minute on
  async function scheduled(fake: ReturnType<typeof fakeAgent>) {
    const console = await consoleWith(fake);
    const { app, headers } = console;
    const worktree = (await app.inject({ method: 'GET', url: '/api/dashboard', headers })).json().projects[0].worktrees[0];
    const note = (await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(worktree.id)}/notes`, headers, payload: { title: 'Build', text: 'Check the build' } })).json();
    expect((await app.inject({ method: 'PUT', url: `/api/worktrees/${encodeURIComponent(worktree.id)}/notes/${note.id}/schedule`, headers, payload: { cron: '* * * * *', kind: 'pi', target: { worktreeId: worktree.id }, enabled: true } })).statusCode).toBe(200);
    const tick = () => app.scheduler.tick(new Date(Date.now() + 61_000));
    const lastRun = async () => (await app.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(worktree.id)}/notes`, headers })).json().notes.find((candidate: { id: string }) => candidate.id === note.id).schedule.lastRun;
    await tick();
    return { ...console, tick, lastRun };
  }

  it('launches a Pi Agent, names its Conversation, delivers the Note, and closes it once the Run completes', async () => {
    const fake = fakeAgent();
    const { app, tick, lastRun, dashboardAgent } = await scheduled(fake);
    const running = await lastRun();
    expect(running).toMatchObject({ status: 'running', agentId: expect.any(String) });
    expect(fake.delivered).toEqual(['Check the build']);
    expect(fake.operations).toEqual([expect.stringMatching(/^rename ⏰ Build — /u)]);

    fake.emit({ type: 'turn', turn: { type: 'started' } });
    await tick();
    fake.emit({ type: 'turn', turn: { type: 'settled', message: 'Green' } });
    await tick();
    expect(await lastRun()).toMatchObject({ status: 'completed' });
    expect(fake.closed()).toBe(true);
    expect(await dashboardAgent(running.agentId)).toBeUndefined();
    await app.close();
  });

  it('records failed when its Agent goes Exited, and closes it', async () => {
    const fake = fakeAgent();
    const { app, tick, lastRun, dashboardAgent } = await scheduled(fake);
    const { agentId } = await lastRun();
    fake.emit({ type: 'turn', turn: { type: 'started' } });
    fake.emit({ type: 'exited' });
    await tick();
    expect(await lastRun()).toMatchObject({ status: 'failed', detail: expect.stringContaining('exited') });
    expect(await dashboardAgent(agentId)).toBeUndefined();
    await app.close();
  });

  it('does not wait on a question it asks: the Run records needs-input and closes its Agent', async () => {
    const fake = fakeAgent();
    const { app, tick, lastRun } = await scheduled(fake);
    fake.emit({ type: 'turn', turn: { type: 'started' } });
    fake.emit({ type: 'question', question: { id: 'q1', text: 'Which colour?', field: { kind: 'choice', choices: ['red', 'blue'] } } });
    await tick();
    expect(await lastRun()).toMatchObject({ status: 'needs-input' });
    expect(fake.closed()).toBe(true);
    await app.close();
  });
});

describe('a structured Agent across a console restart', () => {
  it('reattaches from the lines read through its last idle point, so a Turn in flight completes into history and the queue moves on', async () => {
    const fake = fakeAgent();
    const { app, headers, restart } = await consoleWith(fake);
    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    const prompt = (console: { app: typeof app; headers: typeof headers }, text: string) => console.app.inject({ method: 'POST', url: `/api/agents/${id}/prompt`, headers: console.headers, payload: { prompt: text, attachments: [] } });
    await prompt({ app, headers }, 'First');
    fake.emit({ type: 'turn', turn: { type: 'started' } });
    fake.read(7);
    fake.emit({ type: 'turn', turn: { type: 'settled', message: 'First answered' } });
    await app.inject({ method: 'GET', url: '/api/dashboard', headers });
    expect(fake.delivered).toEqual(['First']);
    await prompt({ app, headers }, 'Second');
    // the console reads on into the next Turn, but would reconnect from the last idle point
    fake.read(12);
    fake.emit({ type: 'turn', turn: { type: 'started' } });
    await prompt({ app, headers }, 'Third');

    const next = fakeAgent();
    const restarted = await restart(next);
    expect(next.attaches).toEqual([expect.objectContaining({ agentId: id, read: 7 })]);
    expect(next.launches).toEqual([]);
    // the holder replays Second's Turn from its start, and it settles after the restart
    next.emit({ type: 'turn', turn: { type: 'started' } });
    next.emit({ type: 'transcript', item: { id: 'm1', kind: 'message', role: 'user', text: 'Second' } });
    expect(await restarted.dashboardAgent(id)).toMatchObject({ attention: 'working', structured: { lifecycle: 'live' } });
    next.emit({ type: 'turn', turn: { type: 'settled', message: 'Second answered' } });
    await restarted.dashboardAgent(id);
    expect(next.delivered).toEqual(['Third']);
    const history = (await restarted.app.inject({ method: 'GET', url: `/api/agents/${id}/prompt-history`, headers: restarted.headers })).json().prompts;
    expect(history).toMatchObject([{ text: 'Third' }, { text: 'Second', answer: 'Second answered' }, { text: 'First', answer: 'First answered' }]);
    await restarted.app.close();
  });

  it('says a question may be waiting unseen when the holder could not replay every line, and keeps saying so over a reloaded history', async () => {
    const fake = fakeAgent();
    const { app, headers, restart } = await consoleWith(fake);
    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    const next = fakeAgent({ dropped: 40 });
    const restarted = await restart(next);
    next.emit({ type: 'history', items: [{ id: 'h0', kind: 'message', role: 'user', text: 'Reply slowly' }] });
    const items = (await restarted.app.inject({ method: 'GET', url: `/api/agents/${id}/transcript`, headers: restarted.headers })).json().items;
    expect(items).toEqual([{ id: 'h0', kind: 'message', role: 'user', text: 'Reply slowly' }, expect.objectContaining({ kind: 'notice', tone: 'warning', text: expect.stringContaining('missed 40 lines') })]);
    await restarted.app.close();
  });

  it('restarts an Agent found idle on another Pi than the pin once it reattaches', async () => {
    const fake = fakeAgent({ version: '0.0.1' });
    const { app, headers, root, restart } = await consoleWith(fake);
    const conversation = '01a188d1-e7d9-711a-aba8-381b96066aa5';
    vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'pi'));
    await piSession(join(root, 'pi'), root, conversation);
    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    fake.emit({ type: 'conversation', id: conversation });

    // idle on an old Pi: the state it reads afresh on reattach finds it idle, so it restarts on the pin
    const idle = fakeAgent({ attached: [{ type: 'conversation', id: conversation }] });
    const restarted = await restart(idle);
    await vi.waitFor(() => expect(idle.launches).toEqual([expect.objectContaining({ id, resume: conversation })]));
    await vi.waitFor(async () => expect(await restarted.dashboardAgent(id)).toMatchObject({ structured: { lifecycle: 'live' } }));
    await restarted.app.close();
  });

  it('marks an Agent whose holder is gone after a restart Exited, with its stderr, and starts nothing', async () => {
    const fake = fakeAgent();
    const { app, headers, restart } = await consoleWith(fake);
    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    const gone = fakeAgent({ gone: true });
    const restarted = await restart(gone);
    expect(await restarted.dashboardAgent(id)).toMatchObject({ structured: { lifecycle: 'exited' } });
    expect((await restarted.app.inject({ method: 'GET', url: `/api/agents/${id}/transcript`, headers: restarted.headers })).json()).toMatchObject({ stderr: 'pi: could not load its extension' });
    expect(gone.launches).toEqual([]);
    await restarted.app.close();
  });

  it('shows an Exited Agent\'s stderr again after a restart, and reattaches nothing to it', async () => {
    const fake = fakeAgent();
    const { app, headers, restart } = await consoleWith(fake);
    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    fake.emit({ type: 'exited' });
    await app.inject({ method: 'GET', url: '/api/dashboard', headers });

    const next = fakeAgent();
    const restarted = await restart(next);
    expect(next.attaches).toEqual([]);
    expect(await restarted.dashboardAgent(id)).toMatchObject({ structured: { lifecycle: 'exited' } });
    expect((await restarted.app.inject({ method: 'GET', url: `/api/agents/${id}/transcript`, headers: restarted.headers })).json()).toMatchObject({ stderr: 'pi: could not load its extension' });
    await restarted.app.close();
  });

  it('holds an Agent being reattached as live: a prompt sent meanwhile waits in its queue and never relaunches it', async () => {
    const fake = fakeAgent();
    const { app, headers, restart } = await consoleWith(fake);
    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    let attached = () => {};
    const next = fakeAgent({ attaching: new Promise<void>(resolve => { attached = resolve; }) });
    const restarted = await restart(next);
    expect(await restarted.dashboardAgent(id)).toMatchObject({ structured: { lifecycle: 'live' } });
    expect((await restarted.app.inject({ method: 'POST', url: `/api/agents/${id}/prompt`, headers: restarted.headers, payload: { prompt: 'Hello', attachments: [] } })).statusCode).toBe(204);
    attached();
    await restarted.reattached;
    await restarted.dashboardAgent(id);
    expect(next.launches).toEqual([]);
    expect(next.delivered).toEqual(['Hello']);
    await restarted.app.close();
  });

  it('restarts an Agent on a Pi other than the pinned one at its next idle point, on its Conversation, keeping its id and queue', async () => {
    const conversation = '01a188d1-e7d9-711a-aba8-381b96066aa5';
    const fake = fakeAgent({ version: '1.3.9' });
    const { app, headers, root, restart } = await consoleWith(fake);
    vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'pi'));
    await piSession(join(root, 'pi'), root, conversation);
    const id: string = (await app.inject({ method: 'POST', url: '/api/agents/launch', headers, payload: { kind: 'pi' } })).json().agentId;
    fake.emit({ type: 'conversation', id: conversation });
    await app.inject({ method: 'POST', url: `/api/agents/${id}/prompt`, headers, payload: { prompt: 'First', attachments: [] } });
    fake.emit({ type: 'turn', turn: { type: 'started' } });
    await app.inject({ method: 'POST', url: `/api/agents/${id}/prompt`, headers, payload: { prompt: 'Second', attachments: [] } });

    // a deploy moves the pin on while the old Pi works
    const next = fakeAgent();
    const restarted = await restart(next);
    next.emit({ type: 'turn', turn: { type: 'started' } });
    next.emit({ type: 'transcript', item: { id: 'm1', kind: 'message', role: 'user', text: 'First' } });
    next.emit({ type: 'conversation', id: conversation });
    await restarted.dashboardAgent(id);
    expect(next.launches).toEqual([]);
    next.emit({ type: 'turn', turn: { type: 'settled', message: 'First answered' } });
    await vi.waitFor(() => expect(next.launches).toEqual([expect.objectContaining({ id, resume: conversation })]));
    expect(next.closed()).toBe(true);
    await vi.waitFor(async () => expect(await restarted.dashboardAgent(id)).toMatchObject({ structured: { lifecycle: 'live' } }));
    await restarted.dashboardAgent(id);
    expect(next.delivered).toEqual(['Second']);
    // the old process's exit after its restart is not the Agent's: the Turn it finished keeps its answer
    const history = (await restarted.app.inject({ method: 'GET', url: `/api/agents/${id}/prompt-history`, headers: restarted.headers })).json().prompts;
    expect(history).toMatchObject([{ text: 'Second' }, { text: 'First', answer: 'First answered' }]);
    await restarted.app.close();
  });
});

describe('an Exited structured Agent', () => {
  const conversation = '01a188d1-e7d9-711a-aba8-381b96066aa5';
  // a live Agent at the Scratch folder on a saved Pi Conversation, working on `First` with
  // `Second` and `Third` queued, whose process then exits
  async function exited(fake: ReturnType<typeof fakeAgent>) {
    const console = await consoleWith(fake);
    vi.stubEnv('PI_CODING_AGENT_DIR', join(console.root, 'pi'));
    await piSession(join(console.root, 'pi'), console.root, conversation);
    const id: string = (await console.app.inject({ method: 'POST', url: '/api/agents/launch', headers: console.headers, payload: { kind: 'pi' } })).json().agentId;
    fake.emit({ type: 'conversation', id: conversation });
    const prompt = (text: string) => console.app.inject({ method: 'POST', url: `/api/agents/${id}/prompt`, headers: console.headers, payload: { prompt: text, attachments: [] } });
    const queued = async () => (await console.app.inject({ method: 'GET', url: `/api/agents/${id}/queued-prompts`, headers: console.headers })).json().prompts;
    expect((await prompt('First')).statusCode).toBe(204);
    fake.emit({ type: 'turn', turn: { type: 'started' } });
    await prompt('Second');
    await prompt('Third');
    fake.emit({ type: 'exited' });
    expect(await console.dashboardAgent(id)).toMatchObject({ structured: { lifecycle: 'exited' } });
    return { ...console, id, prompt, queued };
  }

  it('resumes on its Conversation with the same id, and its held queue drains in order', async () => {
    const fake = fakeAgent();
    const { app, headers, dashboardAgent, id, queued } = await exited(fake);

    expect((await app.inject({ method: 'POST', url: `/api/agents/${id}/resume`, headers })).statusCode).toBe(204);
    expect(fake.launches.at(-1)).toMatchObject({ id, resume: conversation });
    expect(await dashboardAgent(id)).toMatchObject({ structured: { lifecycle: 'live' } });
    await dashboardAgent(id);
    expect(fake.delivered).toEqual(['First', 'Second']);
    fake.emit({ type: 'turn', turn: { type: 'started' } });
    fake.emit({ type: 'turn', turn: { type: 'settled', message: 'done' } });
    await dashboardAgent(id);
    expect(fake.delivered).toEqual(['First', 'Second', 'Third']);
    expect(await queued()).toEqual([]);
    await app.close();
  });

  it('resumes when the operator sends it a prompt, which joins the end of its queue', async () => {
    const fake = fakeAgent();
    const { app, dashboardAgent, id, prompt, queued } = await exited(fake);

    expect((await prompt('Fourth')).statusCode).toBe(204);
    // the prompt is queued at once and the Agent resumes behind it
    await vi.waitFor(async () => expect(await dashboardAgent(id)).toMatchObject({ structured: { lifecycle: 'live' } }));
    expect(fake.launches.at(-1)).toMatchObject({ id, resume: conversation });
    await dashboardAgent(id);
    expect(fake.delivered).toEqual(['First', 'Second']);
    expect((await queued()).map((queued: { text: string }) => queued.text)).toEqual(['Third', 'Fourth']);
    await app.close();
  });

  it('resumes onto a Conversation switched to from the Named list, keeping its id', async () => {
    const fake = fakeAgent();
    const { app, headers, dashboardAgent, root } = await consoleWith(fake);
    vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'pi'));
    const worktree = (await app.inject({ method: 'GET', url: '/api/dashboard', headers })).json().projects[0].worktrees[0];
    const id: string = (await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(worktree.id)}/launch`, headers, payload: { kind: 'pi' } })).json().agentId;
    fake.emit({ type: 'exited' });
    const chosen = '01a188d1-e7d9-711a-aba8-381b96066aa6';
    await piSession(join(root, 'pi'), join(root, 'repo'), chosen, 'Fix the parser');

    const switched = await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(worktree.id)}/conversations/switch`, headers, payload: { kind: 'pi', id: chosen } });
    expect(switched.statusCode).toBe(201);
    expect(switched.json()).toEqual({ agentId: id });
    expect(fake.launches.at(-1)).toMatchObject({ id, resume: chosen });
    expect(await dashboardAgent(id)).toMatchObject({ structured: { lifecycle: 'live' } });
    await app.close();
  });

  it('blocks Remove of its Worktree only while live, and is closed by the Remove once Exited', async () => {
    const fake = fakeAgent();
    const removed: string[] = [];
    const worktreeManagement = { removal: async () => ({ ok: true, facts: { main: false, detached: false, locked: false, branch: 'feat', dirtyCount: 0, pushed: true, merged: true, ahead: 0, behind: 0 } }), removeCheckout: async (worktree: { id: string }) => { removed.push(worktree.id); return { ok: true }; } };
    const { app, headers, dashboardAgent } = await consoleWith(fake, { linked: true, deps: { worktreeManagement } });
    const feat = (await app.inject({ method: 'GET', url: '/api/dashboard', headers })).json().projects[0].worktrees.find((worktree: { main: boolean }) => !worktree.main);
    const id: string = (await app.inject({ method: 'POST', url: `/api/worktrees/${encodeURIComponent(feat.id)}/launch`, headers, payload: { kind: 'pi' } })).json().agentId;
    const removal = async () => (await app.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(feat.id)}/removal`, headers })).json();

    expect(await removal()).toMatchObject({ blockers: ['a running agent'] });
    expect((await app.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(feat.id)}`, headers })).statusCode).toBe(409);
    fake.emit({ type: 'exited' });
    expect(await removal()).toMatchObject({ blockers: [] });
    expect((await app.inject({ method: 'DELETE', url: `/api/worktrees/${encodeURIComponent(feat.id)}`, headers })).statusCode).toBe(200);
    expect(removed).toEqual([feat.id]);
    expect(fake.closed()).toBe(true);
    expect(await dashboardAgent(id)).toBeUndefined();
    await app.close();
  });

  it('closes: its holder is stopped, it leaves the dashboard, and its queue becomes Notes', async () => {
    const fake = fakeAgent();
    const { app, headers, dashboardAgent, id } = await exited(fake);
    const { placeId } = await dashboardAgent(id);

    expect((await app.inject({ method: 'DELETE', url: `/api/agents/${id}`, headers })).statusCode).toBe(204);
    expect(fake.closed()).toBe(true);
    expect(await dashboardAgent(id)).toBeUndefined();
    const notes = JSON.stringify((await app.inject({ method: 'GET', url: `/api/worktrees/${encodeURIComponent(placeId)}/notes`, headers })).json());
    expect(notes).toContain('Second');
    expect(notes).toContain('Third');
    await app.close();
  });
});
