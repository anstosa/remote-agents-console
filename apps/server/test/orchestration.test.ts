import { describe, expect, it } from 'vitest';
import type { ValidatedConfig } from '../src/config/schema.js';
import type { DashboardPayload } from '../src/dashboard/updates.js';
import type { Agent, Worktree } from '../src/domain/models.js';
import { stated } from './helpers/agent.js';
import { OrchestrationService, type OrchestrationDependencies } from '../src/orchestration/service.js';

const cora: Worktree = { id: 'cora', projectId: 'proj', label: 'Cora', path: '/worktrees/cora', identity: '/worktrees/cora', available: true, pinned: true, main: true, detached: false, locked: false, commands: { build: 'docker compose build' }, projectUrl: 'https://cora.external.example.com' };
const dave: Worktree = { id: 'dave', projectId: 'proj', label: 'Dave', path: '/worktrees/dave', identity: '/worktrees/dave', available: true, pinned: false, main: false, detached: false, locked: false, projectUrl: 'https://dave.example.com', projectPort: 4000 };
const config: ValidatedConfig = {
  name: 'Remote Agents',
  remoteServers: [{ url: new URL('https://remote.example.com') }],
  listen: { host: '127.0.0.1', port: 8787 },
  publicOrigin: new URL('https://agents.example.com'),
  trustedProxyIps: new Set(),
  pollIntervalMs: 500,
  projects: []
};
const socket = { fingerprint: 'socket', path: '/tmp/tmux', device: 1, inode: 2 };
const activeAgent: Agent = stated({ id: 'agent-cora', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: cora.identity, branch: 'feature/cora', title: 'Ready', projectId: cora.projectId, worktreeId: cora.id, projectUrl: cora.projectUrl, projectProxied: false, gitStatus: { files: 2, staged: 0, unstaged: 2, untracked: 0, conflicted: 0 } });

// the active Agent's Transport as orchestration reads it: what it shows of its answer and its latest lines
const reads = (recent = 'terminal', older = false) => ({
  target: async (agentId: string) => agentId === activeAgent.id ? { agent: activeAgent } : undefined,
  latestAnswer: async () => undefined,
  recentLines: async () => ({ text: recent, older })
}) as never;

// build one fully structural dependency set
function dependencies(overrides: Partial<OrchestrationDependencies> = {}): OrchestrationDependencies {
  const dashboard: DashboardPayload = {
    generation: 1,
    places: [],
    adapters: {},
    agents: [{ ...activeAgent, unread: false }],
    projects: [{ id: 'proj', label: 'Proj', available: true, worktrees: [
      { id: cora.id, projectId: 'proj', label: cora.label, path: cora.path, available: true, pinned: true, main: true, detached: false, locked: false, order: 0, branch: 'feature/cora' },
      { id: dave.id, projectId: 'proj', label: dave.label, path: dave.path, available: true, pinned: false, main: false, detached: false, locked: false, order: 1, branch: 'main' }
    ] }],
    cleanupPending: 0,
    reviewTour: { available: false, reason: 'generator_unavailable' },
    reviews: []
  };
  return {
    config,
    loadDashboard: async () => dashboard,
    discovery: { target: async agentId => agentId === activeAgent.id ? { agent: activeAgent, socket } : undefined, worktreesNow: () => [cora, dave] },
    prompts: {
      transportFor: async () => reads(),
      submitFrom: async () => 'prompt-queued-1234',
      inFlight: () => undefined,
      listQueued: async () => [],
      updateQueued: async (_agentId, promptId, text) => ({ id: promptId, text, createdAt: '2026-08-13T00:00:00.000Z' }),
      moveQueued: async () => [],
      removeQueued: async () => true,
      answerQuestion: async () => true,
      cancel: async () => 'ok',
      close: async () => true
    },
    promptHistory: { list: async () => [] },
    worktreeCommands: {
      actions: worktree => worktree.commands?.build === undefined ? [] : ['build'],
      state: async () => ({}),
      start: async () => 'started',
      log: async () => undefined
    },
    workspaceFiles: { preview: async (_workspace, path) => ({ path, size: 12, binary: false, truncated: false, content: 'abcdefghijkl' }) },
    pullRequests: { available: async () => ({ enabled: true, pullRequests: [] }), actionsUrl: async () => undefined, switch: async () => 'switched' as const },
    newTasks: { available: async () => ({ enabled: true }), start: async () => true },
    loadInstances: async () => [{ id: config.publicOrigin.origin, name: config.name, url: config.publicOrigin.origin, local: true }, { id: 'https://remote.example.com', name: 'Remote', url: 'https://remote.example.com', local: false }],
    launchWorktree: async () => true,
    launchScratch: async () => true,
    ...overrides
  };
}

describe('OrchestrationService', () => {
  // integrations must retain their own smaller response limit for raster images
  it.each([
    { maxBytes: 32, size: 68, inline: false },
    { maxBytes: 68, size: 68, inline: true },
    { maxBytes: undefined, size: 65_537, inline: false }
  ])('bounds inline image responses at $maxBytes bytes with a $size-byte file', async ({ maxBytes, size, inline }) => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const bytes = Buffer.concat([png, Buffer.alloc(size - png.length)]);
    const service = new OrchestrationService(dependencies({
      // model the storage boundary returning a complete recognized raster
      workspaceFiles: { preview: async (_workspace, path) => ({ path, size, binary: true, truncated: false, image: { mediaType: 'image/png', base64: bytes.toString('base64') } }) }
    }));
    const result = await service.previewFile({ worktreeId: cora.id, path: 'assets/logo.png', ...(maxBytes === undefined ? {} : { maxBytes }) });
    // keep unexpected operation errors distinct from a bounded metadata response
    if (!result.ok) throw new Error(result.error.message);
    expect('image' in result.value).toBe(inline);
    expect(result.value.truncated).toBe(!inline);
    expect(result.value.size).toBe(size);
  });

  // integration summaries share the UI's question priority without changing execution status
  it('includes prose questions in worktree and scratch attention summaries', async () => {
    const deps = dependencies();
    const dashboard = await deps.loadDashboard();
    const asking = { ...dashboard.agents[0]!, hasMessageQuestion: true as const };
    const scratch = { ...asking, id: 'scratch-agent', worktreeId: undefined, projectId: undefined, displayLabel: 'Scratch', home: '/scratch' };
    const working = { ...asking, id: 'working-agent', worktreeId: dave.id, displayLabel: 'Dave', attention: 'working' as const };
    // provide the same mixed dashboard to each public summary
    const service = new OrchestrationService({ ...deps, loadDashboard: async () => ({ ...dashboard, agents: [working, asking, scratch] }) });

    await expect(service.workspaceSummary()).resolves.toMatchObject({ ok: true, value: {
      worktrees: [expect.objectContaining({ id: cora.id, attention: 'question' }), expect.objectContaining({ id: dave.id, attention: 'working' })],
      scratchAgents: [expect.objectContaining({ id: scratch.id, attention: 'question' })]
    } });
    await expect(service.attentionSummary()).resolves.toMatchObject({ ok: true, value: {
      state: 'question',
      agents: [expect.objectContaining({ id: asking.id, attention: 'question' }), expect.objectContaining({ id: scratch.id, attention: 'question' }), expect.objectContaining({ id: working.id, attention: 'working' })]
    } });
    await expect(service.agentStatus(asking.id)).resolves.toMatchObject({ ok: true, value: { attention: 'finished' } });
  });

  it('maps each interrupt outcome to its result', async () => {
    const cancelled = new OrchestrationService(dependencies({ prompts: { ...dependencies().prompts, cancel: async () => 'ok' } }));
    await expect(cancelled.cancel(activeAgent.id)).resolves.toMatchObject({ ok: true, value: { cancelled: true } });
    const finished = new OrchestrationService(dependencies({ prompts: { ...dependencies().prompts, cancel: async () => 'not-working' } }));
    await expect(finished.cancel(activeAgent.id)).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
    const missing = new OrchestrationService(dependencies({ prompts: { ...dependencies().prompts, cancel: async () => 'unavailable' } }));
    await expect(missing.cancel(activeAgent.id)).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('maps each pull request switch outcome to its result', async () => {
    const switched = new OrchestrationService(dependencies({ pullRequests: { ...dependencies().pullRequests, switch: async () => 'switched' as const } }));
    await expect(switched.switchPullRequest({ agentId: activeAgent.id, number: 7 })).resolves.toMatchObject({ ok: true, value: { switched: true } });
    // a non-'switched' string result must be a conflict, never read as success
    const unavailable = new OrchestrationService(dependencies({ pullRequests: { ...dependencies().pullRequests, switch: async () => 'unavailable' as const } }));
    await expect(unavailable.switchPullRequest({ agentId: activeAgent.id, number: 7 })).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
    const busy = new OrchestrationService(dependencies({ pullRequests: { ...dependencies().pullRequests, switch: async () => 'busy' as const } }));
    await expect(busy.switchPullRequest({ agentId: activeAgent.id, number: 7 })).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
  });

  it('answers an inline question only for a hashed id and an in-range index', async () => {
    const calls: Array<[string, string, number]> = [];
    const deps = dependencies({ prompts: { ...dependencies().prompts, answerQuestion: async (agentId, questionId, index) => { calls.push([agentId, questionId, index]); return questionId === 'i63eEMdg6bcC3vtLXiJd55'; } } });
    const service = new OrchestrationService(deps);
    // the legacy `question-…` id and an out-of-range index are rejected before the facade
    await expect(service.answerQuestion({ agentId: activeAgent.id, questionId: 'question-legacy', index: 0 })).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    await expect(service.answerQuestion({ agentId: activeAgent.id, questionId: 'i63eEMdg6bcC3vtLXiJd55', index: 16 })).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(calls).toHaveLength(0);
    // a valid hashed id passes through; a facade miss becomes not_found
    await expect(service.answerQuestion({ agentId: activeAgent.id, questionId: 'i63eEMdg6bcC3vtLXiJd55', index: 2 })).resolves.toMatchObject({ ok: true, value: { answered: true } });
    await expect(service.answerQuestion({ agentId: activeAgent.id, questionId: 'AAAAAAAAAAAAAAAAAAAAAA', index: 2 })).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(calls).toEqual([[activeAgent.id, 'i63eEMdg6bcC3vtLXiJd55', 2], [activeAgent.id, 'AAAAAAAAAAAAAAAAAAAAAA', 2]]);
  });

  it('merges active agents and inactive worktrees in configured order', async () => {
    const service = new OrchestrationService(dependencies());

    await expect(service.listInstances()).resolves.toMatchObject({ ok: true, version: 'v1', value: [{ local: true, name: 'Remote Agents' }, { local: false, name: 'Remote' }] });
    await expect(service.listAgents()).resolves.toMatchObject({ ok: true, value: [{ id: 'agent-cora', projectUrl: 'https://cora.external.example.com', projectProxied: false }] });
    await expect(service.listWorktrees()).resolves.toMatchObject({
      ok: true,
      value: [
        { id: 'cora', active: true, agentIds: ['agent-cora'], branch: 'feature/cora', order: 0, projectUrl: 'https://cora.external.example.com', projectProxied: false },
        { id: 'dave', active: false, agentIds: [], branch: 'main', order: 1, projectUrl: 'https://dave.example.com', projectProxied: true }
      ]
    });
  });

  it('falls back to durable responses and bounds terminal and file output', async () => {
    const oversized = 'x'.repeat(120 * 1024);
    const service = new OrchestrationService(dependencies({
      prompts: { ...dependencies().prompts, transportFor: async () => reads(oversized, true) },
      promptHistory: { list: async () => [{ id: 'history-12345', text: 'Question', createdAt: '2026-08-13T00:00:00.000Z', answer: 'Durable answer', answeredAt: '2026-08-13T00:01:00.000Z' }] }
    }));

    await expect(service.latestResponse(activeAgent.id)).resolves.toMatchObject({ ok: true, value: { source: 'history', text: 'Durable answer', truncated: false } });
    const log = await service.logTail(activeAgent.id, 300);
    expect(log).toMatchObject({ ok: true, value: { rows: 300, older: true, truncated: true } });
    // verify the facade byte ceiling
    if (log.ok) expect(Buffer.byteLength(log.value.text)).toBe(96 * 1024);
    await expect(service.logTail(activeAgent.id, 301)).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    await expect(service.previewFile({ agentId: activeAgent.id, path: 'README.md', maxBytes: 5 })).resolves.toMatchObject({ ok: true, value: { content: 'abcde', truncated: true } });
  });

  it('blocks secret paths and redacts credential-shaped output', async () => {
    let previews = 0;
    const service = new OrchestrationService(dependencies({
      prompts: { ...dependencies().prompts, transportFor: async () => reads('RAC_SESSION_SECRET=private\nAuthorization: Bearer abcdefghijklmnop\nkey: sk-proj-examplecredential\npassword: hunter2') },
      workspaceFiles: { preview: async (_workspace, path) => { previews += 1; return { path, size: 64, binary: false, truncated: false, content: '"api_key":"sk_examplecredential"' }; } },
      worktreeCommands: {
        actions: () => ['build'],
        state: async () => ({}),
        start: async () => 'started',
        log: async () => ({ action: 'build', active: false, startedAt: '2026-08-13T00:00:00.000Z', output: 'PASSWORD=hunter2' })
      }
    }));

    await expect(service.previewFile({ worktreeId: cora.id, path: '.env' })).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    await expect(service.previewFile({ worktreeId: cora.id, path: '.data/integration-auth.json' })).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(previews).toBe(0);
    await expect(service.previewFile({ worktreeId: cora.id, path: 'src/config.ts' })).resolves.toMatchObject({ ok: true, value: { content: '"api_key":"[REDACTED]"' } });
    await expect(service.logTail(activeAgent.id)).resolves.toMatchObject({ ok: true, value: { text: 'RAC_SESSION_SECRET=[REDACTED]\nAuthorization: [REDACTED]\nkey: [REDACTED TOKEN]\npassword: [REDACTED]' } });
    await expect(service.stackStatus(cora.id)).resolves.toMatchObject({ ok: true, value: { log: { output: 'PASSWORD=[REDACTED]' } } });
    const symlinkService = new OrchestrationService(dependencies({ workspaceFiles: { preview: async () => ({ path: '.env', size: 12, binary: false, truncated: false, content: 'RAC_SESSION_SECRET=private' }) } }));
    await expect(symlinkService.previewFile({ worktreeId: cora.id, path: 'safe-link' })).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('routes prompt and configured stack mutations through shared services', async () => {
    const calls: string[] = [];
    const promptId = 'prompt-123456789';
    const service = new OrchestrationService(dependencies({
      prompts: {
        submitFrom: async (_agentId, prompt) => { calls.push(`queue:${prompt}`); return 'prompt-queued-1234'; },
        inFlight: () => undefined,
        listQueued: async () => [],
        updateQueued: async (_agentId, id, text) => { calls.push(`update:${id}:${text}`); return { id, text, createdAt: '2026-08-13T00:00:00.000Z' }; },
        moveQueued: async (_agentId, id, direction) => { calls.push(`move:${id}:${direction}`); return [{ id, text: 'Edited', createdAt: '2026-08-13T00:00:00.000Z' }]; },
        removeQueued: async (_agentId, id) => { calls.push(`remove:${id}`); return true; },
        answerQuestion: async () => true,
        cancel: async () => 'ok',
        close: async () => true
      },
      worktreeCommands: {
        actions: worktree => worktree.id === cora.id ? ['build'] : [],
        state: async () => ({}),
        start: async (worktreeId, action) => { calls.push(`stack:${worktreeId}:${action}`); return 'started'; },
        log: async () => undefined
      }
    }));

    await expect(service.queuePrompt({ agentId: activeAgent.id, prompt: '!rm -rf /' })).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    await expect(service.queuePrompt({ agentId: activeAgent.id, prompt: 'First' })).resolves.toMatchObject({ ok: true });
    await expect(service.updateQueuedPrompt({ agentId: activeAgent.id, promptId, prompt: 'Edited' })).resolves.toMatchObject({ ok: true, value: { text: 'Edited' } });
    await expect(service.moveQueuedPrompt({ agentId: activeAgent.id, promptId, direction: 'earlier' })).resolves.toMatchObject({ ok: true, value: { prompts: [{ id: promptId }] } });
    await expect(service.removeQueuedPrompt({ agentId: activeAgent.id, promptId })).resolves.toMatchObject({ ok: true });
    await expect(service.runStackAction({ worktreeId: cora.id, action: 'build' })).resolves.toMatchObject({ ok: true });
    await expect(service.runStackAction({ worktreeId: dave.id, action: 'build' })).resolves.toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(calls).toEqual(['queue:First', `update:${promptId}:Edited`, `move:${promptId}:earlier`, `remove:${promptId}`, 'stack:cora:build']);
  });

  // `process` narrows a Stack process action to one process; without it the action is the whole
  // stack's, as before
  it('runs a stack action on one Stack process only when the Worktree declares it', async () => {
    const erin: Worktree = { ...dave, id: 'erin', label: 'Erin', path: '/worktrees/erin', identity: '/worktrees/erin', commands: { processes: { sync: 'ods exec sync', api: 'ods exec api' }, build: 'pnpm build' } };
    const fay: Worktree = { ...dave, id: 'fay', label: 'Fay', path: '/worktrees/fay', identity: '/worktrees/fay', commands: { start: 'docker compose up -d', stop: 'docker compose down' } };
    const calls: string[] = [];
    const service = new OrchestrationService(dependencies({
      discovery: { target: async () => undefined, worktreesNow: () => [cora, dave, erin, fay] },
      worktreeCommands: {
        actions: worktree => worktree.id === erin.id ? ['start', 'stop', 'build', 'restart'] : worktree.id === fay.id ? ['start', 'stop'] : worktree.id === cora.id ? ['build'] : [],
        state: async () => ({}),
        start: async (worktreeId, action, name) => { calls.push(`stack:${worktreeId}:${action}${name === undefined ? '' : `:${name}`}`); return name === 'sync' ? 'busy' : 'started'; },
        log: async () => undefined
      }
    }));

    await expect(service.runStackAction({ worktreeId: erin.id, action: 'restart', process: 'api' })).resolves.toMatchObject({ ok: true });
    await expect(service.runStackAction({ worktreeId: erin.id, action: 'restart' })).resolves.toMatchObject({ ok: true });
    await expect(service.runStackAction({ worktreeId: erin.id, action: 'stop', process: 'sync' })).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
    await expect(service.runStackAction({ worktreeId: erin.id, action: 'start', process: 'web' })).resolves.toMatchObject({ ok: false, error: { code: 'unavailable' } });
    await expect(service.runStackAction({ worktreeId: erin.id, action: 'build', process: 'api' })).resolves.toMatchObject({ ok: false, error: { code: 'unavailable' } });
    await expect(service.runStackAction({ worktreeId: cora.id, action: 'build', process: 'dev' })).resolves.toMatchObject({ ok: false, error: { code: 'unavailable' } });
    // a daemon-style stack's own Start takes no process
    await expect(service.runStackAction({ worktreeId: fay.id, action: 'start', process: 'dev' })).resolves.toMatchObject({ ok: false, error: { code: 'unavailable' } });
    await expect(service.runStackAction({ worktreeId: erin.id, action: 'start', process: '' })).resolves.toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(calls).toEqual(['stack:erin:restart:api', 'stack:erin:restart', 'stack:erin:stop:sync']);
  });

  // Process notices are for the console's own stack menu, not integrations
  it("keeps a Stack process's notices out of the stack state integrations read", async () => {
    const service = new OrchestrationService(dependencies({
      worktreeCommands: {
        actions: () => ['start', 'stop', 'restart'],
        state: async () => ({ running: true, processes: [{ name: 'api', state: 'running', notices: [{ level: 'warning', message: 'static is not running' }] }] }),
        start: async () => 'started',
        log: async () => undefined
      }
    }));

    const status = await service.stackStatus(cora.id);
    expect(status).toMatchObject({ ok: true, value: { processes: [{ name: 'api', state: 'running' }] } });
    expect(status.ok && status.value.processes?.[0]).not.toHaveProperty('notices');

    // the worktree listing reads the dashboard's stack, which carries them
    const dashboard = await dependencies().loadDashboard();
    const withNotices = { ...dashboard, projects: dashboard.projects.map(project => ({ ...project, worktrees: project.worktrees.map(view => view.id === dave.id ? { ...view, stack: { running: false, processes: [{ name: 'api', state: 'exited' as const, exitCode: 1, notices: [{ level: 'warning' as const, message: 'static is not running' }] }] } } : view) })) };
    const listing = new OrchestrationService(dependencies({ loadDashboard: async () => withNotices }));
    const listed = await listing.worktreeStatus(dave.id);
    expect(listed).toMatchObject({ ok: true, value: { stack: { processes: [{ name: 'api', state: 'exited', exitCode: 1 }] } } });
    expect(listed.ok && listed.value.stack?.processes?.[0]).not.toHaveProperty('notices');
  });

  it('deactivates only idle agents in configured worktrees', async () => {
    let agent: Agent = stated({ ...activeAgent, title: '⠋ Working' });
    let closed = 0;
    const service = new OrchestrationService(dependencies({
      discovery: { target: async () => ({ agent, socket }), worktreesNow: () => [cora, dave] },
      prompts: {
        submitFrom: async () => 'prompt-queued-1234',
      inFlight: () => undefined,
        listQueued: async () => [],
        updateQueued: async () => undefined,
        moveQueued: async () => undefined,
        removeQueued: async () => false,
        answerQuestion: async () => false,
        cancel: async () => 'unavailable',
        close: async () => { closed += 1; return true; }
      }
    }));

    await expect(service.deactivate(activeAgent.id)).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(closed).toBe(0);
    agent = stated({ ...activeAgent, title: 'Ready' });
    await expect(service.deactivate(activeAgent.id)).resolves.toMatchObject({ ok: true, value: { deactivated: true } });
    expect(closed).toBe(1);
    agent = { ...activeAgent, home: '/scratch/repo', title: 'Ready' };
    await expect(service.deactivate(activeAgent.id)).resolves.toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(closed).toBe(1);
  });

  it('scoped to some Worktrees, neither lists nor finds the others', async () => {
    const service = new OrchestrationService(dependencies()).scoped(worktree => worktree.id === cora.id);
    await expect(service.listWorktrees()).resolves.toMatchObject({ ok: true, value: [{ id: 'cora' }] });
    await expect(service.worktreeStatus(dave.id)).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    await expect(service.stackStatus(dave.id)).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    await expect(service.previewFile({ worktreeId: dave.id, path: 'README.md' })).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    await expect(service.worktreeStatus(cora.id)).resolves.toMatchObject({ ok: true });
  });
});
